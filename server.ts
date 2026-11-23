import express from 'express';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, LiveServerMessage, Modality, ThinkingLevel, Type } from '@google/genai';
import { WebSocket, WebSocketServer } from 'ws';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

interface ServerCoords {
  latitude: number;
  longitude: number;
  accuracy: number;
  heading: number | null;
  speed: number | null;
  updatedAt: number;
}

interface ServerDetection {
  id: string;
  rawClass: string;
  displayLabel: string;
  fineLabel?: string;
  score: number;
  bbox: [number, number, number, number];
  classification: 'positive' | 'negative' | 'neutral';
  thumbnailUrl?: string;
}

interface ServerLinkedNode {
  nodeId: string;
  deviceName: string;
  connectedAt: number;
  lastSeen: number;
  cameraActive: boolean;
  gpsActive: boolean;
  coords: ServerCoords | null;
  previewFrameUrl?: string;
  detections: ServerDetection[];
  fps: number;
  latencyMs: number | null;
}

interface RoomPeer {
  ws: WebSocket;
  role: 'host' | 'camera';
  nodeId: string;
  roomId: string;
}

interface RoomState {
  roomId: string;
  createdAt: number;
  peers: Set<RoomPeer>;
  nodes: Map<string, ServerLinkedNode>;
  rules: unknown | null;
}

const rooms = new Map<string, RoomState>();
const MAX_ROOMS = 200;
const MAX_CAMERA_NODES_PER_ROOM = 16;

function generateRoomId(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function getOrCreateRoom(roomId: string): RoomState {
  const cleanId = roomId.replace(/[^A-Za-z0-9_-]/g, '').toUpperCase().slice(0, 16);
  const existing = rooms.get(cleanId);
  if (existing) return existing;

  // Evict oldest empty/stale room if capacity exceeded
  if (rooms.size >= MAX_ROOMS) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, r] of rooms.entries()) {
      if (r.peers.size === 0 && r.createdAt < oldestTime) {
        oldestTime = r.createdAt;
        oldestKey = k;
      }
    }
    if (oldestKey) rooms.delete(oldestKey);
  }

  const created: RoomState = {
    roomId: cleanId || generateRoomId(),
    createdAt: Date.now(),
    peers: new Set(),
    nodes: new Map(),
    rules: null,
  };
  rooms.set(created.roomId, created);
  return created;
}

function isValidImageDataUrl(val: unknown, maxLen = 260000): val is string {
  if (typeof val !== 'string' || val.length === 0 || val.length > maxLen) return false;
  return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(val);
}

function sanitizeCoords(raw: unknown): ServerCoords | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (
    typeof c.latitude !== 'number' ||
    !Number.isFinite(c.latitude) ||
    c.latitude < -90 ||
    c.latitude > 90 ||
    typeof c.longitude !== 'number' ||
    !Number.isFinite(c.longitude) ||
    c.longitude < -180 ||
    c.longitude > 180
  ) {
    return null;
  }
  return {
    latitude: c.latitude,
    longitude: c.longitude,
    accuracy: typeof c.accuracy === 'number' && Number.isFinite(c.accuracy) ? Math.max(0, c.accuracy) : 0,
    heading: typeof c.heading === 'number' && Number.isFinite(c.heading) ? c.heading : null,
    speed: typeof c.speed === 'number' && Number.isFinite(c.speed) ? c.speed : null,
    updatedAt: typeof c.updatedAt === 'number' && Number.isFinite(c.updatedAt) ? c.updatedAt : Date.now(),
  };
}

function sanitizeDetections(raw: unknown): ServerDetection[] {
  if (!Array.isArray(raw)) return [];
  const out: ServerDetection[] = [];
  for (const item of raw.slice(0, 12)) {
    if (!item || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;
    const classification =
      d.classification === 'positive' || d.classification === 'negative' ? d.classification : 'neutral';
    const bbox =
      Array.isArray(d.bbox) &&
      d.bbox.length === 4 &&
      d.bbox.every((n) => typeof n === 'number' && Number.isFinite(n))
        ? ([d.bbox[0], d.bbox[1], d.bbox[2], d.bbox[3]] as [number, number, number, number])
        : ([0, 0, 0, 0] as [number, number, number, number]);

    out.push({
      id: typeof d.id === 'string' ? d.id.slice(0, 64) : `det-${out.length}`,
      rawClass: typeof d.rawClass === 'string' ? d.rawClass.slice(0, 64) : 'object',
      displayLabel: typeof d.displayLabel === 'string' ? d.displayLabel.slice(0, 80) : 'Object',
      fineLabel: typeof d.fineLabel === 'string' ? d.fineLabel.slice(0, 80) : undefined,
      score: typeof d.score === 'number' && Number.isFinite(d.score) ? Math.max(0, Math.min(1, d.score)) : 0.5,
      bbox,
      classification,
      thumbnailUrl: isValidImageDataUrl(d.thumbnailUrl, 60000) ? d.thumbnailUrl : undefined,
    });
  }
  return out;
}

function broadcastToRoom(room: RoomState, payload: unknown, exceptWs?: WebSocket, onlyRole?: 'host' | 'camera') {
  const encoded = JSON.stringify(payload);
  for (const peer of room.peers) {
    if (peer.ws === exceptWs) continue;
    if (onlyRole && peer.role !== onlyRole) continue;
    if (peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(encoded);
    }
  }
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function formatGeminiError(err: unknown, fallback: string): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : fallback;
  const lower = raw.toLowerCase();
  if (lower.includes('403') || lower.includes('permission_denied')) {
    return {
      status: 403,
      message: `${raw} — Check or select a valid API key in Settings > Secrets.`,
    };
  }
  if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota')) {
    return {
      status: 429,
      message: `${raw} — Quota exceeded or paid model requires a billing-enabled key in Settings > Secrets.`,
    };
  }
  if (lower.includes('404') || lower.includes('not_found')) {
    return { status: 404, message: raw };
  }
  if (lower.includes('400') || lower.includes('invalid')) {
    return { status: 400, message: raw };
  }
  return { status: 500, message: raw || fallback };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '16mb' }));

  app.get('/api/health', (_req, res) => {
    const hasGeminiKey = Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
    );
    res.json({ ok: true, globalProductApiReady: hasGeminiKey, activeRooms: rooms.size });
  });

  app.get('/api/security-status', (_req, res) => {
    const hasGeminiKey = Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
    );
    let connectedPeers = 0;
    for (const r of rooms.values()) {
      connectedPeers += r.peers.size;
    }
    res.json({
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      activeRooms: rooms.size,
      connectedPeers,
      wsMaxPayloadBytes: 512 * 1024,
      geminiConfigured: hasGeminiKey,
      apiKeysIsolatedServerSide: true,
    });
  });

  app.post('/api/rooms', (_req, res) => {
    const roomId = generateRoomId();
    getOrCreateRoom(roomId);
    res.json({ roomId, maxNodes: MAX_CAMERA_NODES_PER_ROOM });
  });

  app.post('/api/identify-products', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'Global Product AI service is not configured. Check GEMINI_API_KEY in Settings > Secrets.',
      });
      return;
    }

    try {
      const body = req.body as {
        imageBase64?: string;
        mimeType?: string;
        positiveRules?: string[];
        negativeRules?: string[];
      };

      if (!body?.imageBase64 || typeof body.imageBase64 !== 'string') {
        res.status(400).json({ error: 'Missing imageBase64 payload.' });
        return;
      }

      const mimeType = body.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
      const positiveList = Array.isArray(body.positiveRules) ? body.positiveRules.slice(0, 40) : [];
      const negativeList = Array.isArray(body.negativeRules) ? body.negativeRules.slice(0, 40) : [];

      const prompt = [
        'Identify every distinct real-world product, brand, or object clearly visible in this camera image.',
        'For packaged goods, beverages, electronics, medicines, cosmetics, tools, or snacks, return the exact commercial product name and brand if readable/recognizable (e.g. "Coca-Cola Can", "iPhone", "Panadol Extra", "Dettol Soap", "MacBook"), otherwise return the exact accurate object name.',
        'Only report items you can clearly see with >= 0.65 confidence; never guess unseen items.',
        'For each item, return box_2d as [ymin, xmin, ymax, xmax] normalized 0 to 1000.',
        positiveList.length > 0 ? `POSITIVE rules: ${positiveList.join(', ')}.` : '',
        negativeList.length > 0 ? `NEGATIVE rules: ${negativeList.join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join(' ');

      const t0 = Date.now();
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: body.imageBase64,
              },
            },
            { text: prompt },
          ],
        },
        config: {
          systemInstruction:
            'You are a high-precision retail and security vision scanner. Only identify clearly visible objects and real-world products with accurate bounding boxes. Never hallucinate or guess.',
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.MINIMAL,
          },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              products: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    productName: {
                      type: Type.STRING,
                      description: 'Exact real-world product or item name.',
                    },
                    brand: {
                      type: Type.STRING,
                      description: 'Brand name if visible, else Generic.',
                    },
                    category: {
                      type: Type.STRING,
                      description: 'Category (e.g., Beverage, Electronics, Medicine, Tool).',
                    },
                    confidence: {
                      type: Type.NUMBER,
                      description: 'Confidence score between 0.0 and 1.0.',
                    },
                    box_2d: {
                      type: Type.ARRAY,
                      items: { type: Type.NUMBER },
                      description: 'Normalized [ymin, xmin, ymax, xmax] coordinates (0-1000).',
                    },
                  },
                },
              },
            },
          },
        },
      });

      const serverMs = Date.now() - t0;
      const rawText = (response.text ?? '{}').trim();
      const parsed = JSON.parse(rawText) as {
        products?: Array<{
          productName?: string;
          brand?: string;
          category?: string;
          confidence?: number;
          box_2d?: number[];
        }>;
      };

      const products = Array.isArray(parsed.products)
        ? parsed.products
            .filter(
              (p) =>
                p &&
                typeof p.productName === 'string' &&
                p.productName.trim().length > 0 &&
                (typeof p.confidence !== 'number' || p.confidence >= 0.6)
            )
            .slice(0, 6)
            .map((p) => {
              const box =
                Array.isArray(p.box_2d) &&
                p.box_2d.length === 4 &&
                p.box_2d.every((n) => typeof n === 'number')
                  ? ([
                      Math.max(0, Math.min(1000, p.box_2d[0])),
                      Math.max(0, Math.min(1000, p.box_2d[1])),
                      Math.max(0, Math.min(1000, p.box_2d[2])),
                      Math.max(0, Math.min(1000, p.box_2d[3])),
                    ] as [number, number, number, number])
                  : undefined;

              return {
                productName: String(p.productName).trim(),
                brand: typeof p.brand === 'string' && p.brand.trim() ? p.brand.trim() : 'Generic',
                category:
                  typeof p.category === 'string' && p.category.trim()
                    ? p.category.trim()
                    : 'Object',
                confidence:
                  typeof p.confidence === 'number'
                    ? Math.max(0, Math.min(1, p.confidence))
                    : 0.85,
                box_2d: box,
              };
            })
        : [];

      res.json({ products, serverMs });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to identify products.';
      const status =
        message.includes('403') || message.includes('PERMISSION_DENIED')
          ? 403
          : message.includes('429') || message.includes('RESOURCE_EXHAUSTED')
          ? 429
          : 500;
      res.status(status).json({ error: message });
    }
  });

  app.get('/api/geo-intelligence', async (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      res.status(400).json({ error: 'Valid lat (-90..90) and lon (-180..180) are required.' });
      return;
    }

    const safeLat = Number(lat.toFixed(5));
    const safeLon = Number(lon.toFixed(5));

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${safeLat}&longitude=${safeLon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,surface_pressure,cloud_cover,weather_code,shortwave_radiation,direct_radiation&hourly=temperature_2m,precipitation_probability,wind_speed_10m&forecast_days=1&timezone=auto`;

    const lamin = Math.max(-90, safeLat - 0.85).toFixed(4);
    const lamax = Math.min(90, safeLat + 0.85).toFixed(4);
    const lomin = Math.max(-180, safeLon - 0.85).toFixed(4);
    const lomax = Math.min(180, safeLon + 0.85).toFixed(4);
    const skyUrl = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
    const satUrl = 'https://api.wheretheiss.at/v1/satellites/25544';

    let elevationMeters: number | null = null;
    let weather: {
      temperatureC: number;
      humidityPct: number;
      windSpeedKmh: number;
      windDirectionDeg: number;
      pressureHpa: number;
      cloudCoverPct: number;
      weatherCode: number;
      shortwaveRadiationWm2: number | null;
      directRadiationWm2: number | null;
    } | null = null;
    let forecast: Array<{
      time: string;
      temperatureC: number;
      precipProb: number;
      windKmh: number;
    }> = [];

    let aircraft: Array<{
      icao24: string;
      callsign: string;
      originCountry: string;
      latitude: number;
      longitude: number;
      altitudeMeters: number;
      velocityKmh: number;
      heading: number;
    }> = [];
    let airspaceNote = 'Live ADS-B airspace feed synced.';

    let satellite: {
      name: string;
      noradId: number;
      latitude: number;
      longitude: number;
      altitudeKm: number;
      velocityKmh: number;
      footprintKm: number;
      visibility: string;
      distanceKmFromUser: number | null;
      bearingDegFromUser: number | null;
      timestamp: number;
    } | null = null;
    let satelliteNote = 'Live LEO orbital ephemeris synced (ISS NORAD 25544).';

    const [weatherRes, skyRes, satRes] = await Promise.allSettled([
      fetch(weatherUrl, { signal: AbortSignal.timeout(5000) }),
      fetch(skyUrl, { signal: AbortSignal.timeout(5000) }),
      fetch(satUrl, { signal: AbortSignal.timeout(5000) }),
    ]);

    if (weatherRes.status === 'fulfilled' && weatherRes.value.ok) {
      try {
        const w = (await weatherRes.value.json()) as {
          elevation?: number;
          current?: Record<string, number>;
          hourly?: {
            time?: string[];
            temperature_2m?: number[];
            precipitation_probability?: number[];
            wind_speed_10m?: number[];
          };
        };
        if (typeof w.elevation === 'number') elevationMeters = w.elevation;
        if (w.current) {
          weather = {
            temperatureC: Number(w.current.temperature_2m ?? 0),
            humidityPct: Number(w.current.relative_humidity_2m ?? 0),
            windSpeedKmh: Number(w.current.wind_speed_10m ?? 0),
            windDirectionDeg: Number(w.current.wind_direction_10m ?? 0),
            pressureHpa: Number(w.current.surface_pressure ?? 1013),
            cloudCoverPct: Number(w.current.cloud_cover ?? 0),
            weatherCode: Number(w.current.weather_code ?? 0),
            shortwaveRadiationWm2:
              typeof w.current.shortwave_radiation === 'number'
                ? Math.round(w.current.shortwave_radiation)
                : null,
            directRadiationWm2:
              typeof w.current.direct_radiation === 'number'
                ? Math.round(w.current.direct_radiation)
                : null,
          };
        }
        const times = w.hourly?.time ?? [];
        const temps = w.hourly?.temperature_2m ?? [];
        const precips = w.hourly?.precipitation_probability ?? [];
        const winds = w.hourly?.wind_speed_10m ?? [];
        const currentHour = new Date().getHours();
        const slots: typeof forecast = [];
        for (let i = 0; i < times.length && slots.length < 8; i += 1) {
          const hour = Number(times[i]?.slice(11, 13) ?? -1);
          if (hour >= currentHour) {
            slots.push({
              time: times[i]?.slice(11, 16) || `${hour}:00`,
              temperatureC: Number(temps[i] ?? 0),
              precipProb: Number(precips[i] ?? 0),
              windKmh: Number(winds[i] ?? 0),
            });
          }
        }
        forecast = slots;
      } catch {
        // Ignore malformed upstream weather payload
      }
    }

    if (skyRes.status === 'fulfilled' && skyRes.value.ok) {
      try {
        const sky = (await skyRes.value.json()) as { states?: unknown[][] | null };
        const states = Array.isArray(sky.states) ? sky.states : [];
        aircraft = states
          .filter(
            (s) =>
              Array.isArray(s) &&
              typeof s[6] === 'number' &&
              typeof s[5] === 'number' &&
              !s[8]
          )
          .slice(0, 12)
          .map((s) => ({
            icao24: String(s[0] || '').trim(),
            callsign: String(s[1] || 'CIVILIAN').trim() || String(s[0] || 'FLT'),
            originCountry: String(s[2] || 'Unknown'),
            latitude: Number(s[6]),
            longitude: Number(s[5]),
            altitudeMeters: typeof s[7] === 'number' ? Math.round(s[7]) : 0,
            velocityKmh: typeof s[9] === 'number' ? Math.round(s[9] * 3.6) : 0,
            heading: typeof s[10] === 'number' ? Math.round(s[10]) : 0,
          }));
        if (aircraft.length === 0) {
          airspaceNote = 'No active civilian ADS-B flights detected within ~90 km radius right now.';
        }
      } catch {
        airspaceNote = 'Airspace feed temporarily unavailable.';
      }
    } else {
      airspaceNote = 'Public ADS-B airspace feed rate-limited or unreachable right now.';
    }

    if (satRes.status === 'fulfilled' && satRes.value.ok) {
      try {
        const s = (await satRes.value.json()) as {
          name?: string;
          id?: number;
          latitude?: number;
          longitude?: number;
          altitude?: number;
          velocity?: number;
          footprint?: number;
          visibility?: string;
          timestamp?: number;
        };
        if (typeof s.latitude === 'number' && typeof s.longitude === 'number') {
          const toRad = (deg: number) => (deg * Math.PI) / 180;
          const R = 6371;
          const dLat = toRad(s.latitude - safeLat);
          const dLon = toRad(s.longitude - safeLon);
          const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(safeLat)) *
              Math.cos(toRad(s.latitude)) *
              Math.sin(dLon / 2) *
              Math.sin(dLon / 2);
          const distKm = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));

          const y = Math.sin(dLon) * Math.cos(toRad(s.latitude));
          const x =
            Math.cos(toRad(safeLat)) * Math.sin(toRad(s.latitude)) -
            Math.sin(toRad(safeLat)) * Math.cos(toRad(s.latitude)) * Math.cos(dLon);
          const bearingDeg = Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);

          satellite = {
            name: String(s.name || 'ISS (ZARYA)').toUpperCase(),
            noradId: typeof s.id === 'number' ? s.id : 25544,
            latitude: Number(s.latitude.toFixed(4)),
            longitude: Number(s.longitude.toFixed(4)),
            altitudeKm: typeof s.altitude === 'number' ? Math.round(s.altitude) : 420,
            velocityKmh: typeof s.velocity === 'number' ? Math.round(s.velocity) : 27580,
            footprintKm: typeof s.footprint === 'number' ? Math.round(s.footprint) : 4500,
            visibility: String(s.visibility || 'daylight'),
            distanceKmFromUser: distKm,
            bearingDegFromUser: bearingDeg,
            timestamp: typeof s.timestamp === 'number' ? s.timestamp * 1000 : Date.now(),
          };
        }
      } catch {
        satelliteNote = 'Satellite ephemeris payload unavailable.';
      }
    } else {
      satelliteNote = 'Public satellite orbital feed unreachable in this network environment.';
    }

    res.json({
      fetchedAt: Date.now(),
      elevationMeters,
      weather,
      forecast,
      aircraft,
      airspaceNote,
      satellite,
      satelliteNote,
    });
  });

  app.post('/api/command-report', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'Command AI service is not configured. Check GEMINI_API_KEY in Settings > Secrets.',
      });
      return;
    }

    try {
      const snapshot = req.body as Record<string, unknown>;
      const prompt = [
        'Analyze this real-time multi-domain sensor fusion snapshot (Computer Vision detections, Linked Mobile Cameras, GPS Coordinates/Activity, Weather & Elevation, Civilian Airspace Flights, Network RTT, and Anomaly Score) and produce a concise Command & Control Decision Support Report.',
        'Ground EVERY statement strictly in the provided telemetry numbers. Never invent sensor hardware or fabricate threats.',
        `Telemetry Snapshot JSON: ${JSON.stringify(snapshot).slice(0, 6000)}`,
      ].join('\n');

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          systemInstruction:
            'You are a precision Command & Control (C2) Sensor Fusion Analyst. Output concise, factual decision support grounded strictly in the provided real telemetry.',
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              overallRiskLevel: {
                type: Type.STRING,
                description: 'Must be LOW, MODERATE, or HIGH.',
              },
              executiveBrief: {
                type: Type.STRING,
                description: '2-sentence fused status summary across Vision, GPS, Weather, Airspace, and Network.',
              },
              sensorFusionInsights: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: '3 to 4 crisp cross-sensor findings.',
              },
              predictiveForecast: {
                type: Type.STRING,
                description: 'Short-horizon outlook based on weather trend, movement speed, and detection patterns.',
              },
              cyberNetworkHealth: {
                type: Type.STRING,
                description: 'Assessment of WebSocket room sync, edge compute speed, and network RTT.',
              },
              recommendedActions: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: '3 actionable operator steps.',
              },
            },
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim()) as Record<string, unknown>;
      const riskRaw = String(parsed.overallRiskLevel || 'LOW').toUpperCase();
      const overallRiskLevel =
        riskRaw === 'HIGH' || riskRaw === 'MODERATE' ? riskRaw : 'LOW';

      res.json({
        id: `rep-${Date.now()}`,
        generatedAt: Date.now(),
        overallRiskLevel,
        executiveBrief: String(parsed.executiveBrief || 'Telemetry fused across active domains.'),
        sensorFusionInsights: Array.isArray(parsed.sensorFusionInsights)
          ? parsed.sensorFusionInsights.slice(0, 5).map(String)
          : [],
        predictiveForecast: String(
          parsed.predictiveForecast || 'Monitoring continuous live telemetry streams.'
        ),
        cyberNetworkHealth: String(
          parsed.cyberNetworkHealth || 'WebSocket hub and edge runtime operating normally.'
        ),
        recommendedActions: Array.isArray(parsed.recommendedActions)
          ? parsed.recommendedActions.slice(0, 4).map(String)
          : [],
      });
    } catch (err) {
      const { status, message } = formatGeminiError(err, 'Failed to generate command report.');
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/chat', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'Gemini chat service is not configured. Check GEMINI_API_KEY in Settings > Secrets.',
      });
      return;
    }

    try {
      const body = req.body as {
        message?: string;
        history?: Array<{ role?: string; text?: string }>;
        model?: string;
        groundingMode?: 'none' | 'search' | 'maps';
        latLng?: { latitude?: number; longitude?: number } | null;
        imageBase64?: string;
        mimeType?: string;
        thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH';
        systemContext?: string;
      };

      const messageText = typeof body?.message === 'string' ? body.message.trim() : '';
      if (!messageText) {
        res.status(400).json({ error: 'Message text is required.' });
        return;
      }

      const allowedModels = new Set([
        'gemini-4-hydrogen',
        'gemini-3.1-flash-lite',
        'gemini-4-neon',
        'gemini-4-carbon',
      ]);
      const model =
        typeof body.model === 'string' && allowedModels.has(body.model)
          ? body.model
          : 'gemini-4-hydrogen';

      const groundingMode =
        body.groundingMode === 'search' || body.groundingMode === 'maps'
          ? body.groundingMode
          : 'none';

      const contents: Array<{
        role: 'user' | 'model';
        parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
      }> = [];

      if (Array.isArray(body.history)) {
        for (const turn of body.history.slice(-16)) {
          if (turn && typeof turn.text === 'string' && turn.text.trim()) {
            contents.push({
              role: turn.role === 'model' ? 'model' : 'user',
              parts: [{ text: turn.text.trim().slice(0, 8000) }],
            });
          }
        }
      }

      const currentParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
      if (typeof body.imageBase64 === 'string' && body.imageBase64.length > 0) {
        const mime =
          body.mimeType === 'image/png' || body.mimeType === 'image/webp'
            ? body.mimeType
            : 'image/jpeg';
        currentParts.push({ inlineData: { mimeType: mime, data: body.imageBase64 } });
      }
      currentParts.push({ text: messageText });
      contents.push({ role: 'user', parts: currentParts });

      const sysInstruction = [
        'You are the GAZVA Vision Guard Tactical Operations & Engineering Copilot.',
        'Be concise, factual, and ground answers in real telemetry or retrieved sources.',
        typeof body.systemContext === 'string' && body.systemContext.trim()
          ? `Live Telemetry Context: ${body.systemContext.trim().slice(0, 1500)}`
          : '',
      ]
        .filter(Boolean)
        .join(' ');

      const config: Record<string, unknown> = {
        systemInstruction: sysInstruction,
      };

      if (model.startsWith('gemini-4-')) {
        const levelMap: Record<string, ThinkingLevel> = {
          LOW: ThinkingLevel.LOW,
          MEDIUM: ThinkingLevel.MEDIUM,
          HIGH: ThinkingLevel.HIGH,
          XHIGH: ThinkingLevel.XHIGH,
        };
        const chosen = body.thinkingLevel ? levelMap[body.thinkingLevel] : ThinkingLevel.LOW;
        // XHIGH is only valid on gemini-4-neon and gemini-4-hydrogen
        const safeLevel =
          chosen === ThinkingLevel.XHIGH && model === 'gemini-4-carbon'
            ? ThinkingLevel.HIGH
            : chosen || ThinkingLevel.LOW;
        config.thinkingConfig = { thinkingLevel: safeLevel };
      }

      if (groundingMode === 'search') {
        config.tools = [{ googleSearch: {} }];
      } else if (groundingMode === 'maps') {
        config.tools = [{ googleMaps: {} }];
        const lat = body.latLng?.latitude;
        const lng = body.latLng?.longitude;
        if (
          typeof lat === 'number' &&
          Number.isFinite(lat) &&
          lat >= -90 &&
          lat <= 90 &&
          typeof lng === 'number' &&
          Number.isFinite(lng) &&
          lng >= -180 &&
          lng <= 180
        ) {
          config.toolConfig = {
            retrievalConfig: {
              latLng: { latitude: lat, longitude: lng },
            },
          };
        }
      }

      const response = await ai.models.generateContent({
        model,
        contents,
        config,
      });

      const sources: Array<{ title: string; uri: string; kind: 'web' | 'maps' }> = [];
      const seenUris = new Set<string>();
      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
      if (Array.isArray(chunks)) {
        for (const chunk of chunks as Array<{
          web?: { uri?: string; title?: string };
          maps?: {
            uri?: string;
            title?: string;
            placeAnswerSources?: { reviewSnippets?: Array<{ googleMapsUri?: string; title?: string }> };
          };
        }>) {
          if (chunk.web?.uri && !seenUris.has(chunk.web.uri)) {
            seenUris.add(chunk.web.uri);
            sources.push({
              title: chunk.web.title || chunk.web.uri,
              uri: chunk.web.uri,
              kind: 'web',
            });
          }
          if (chunk.maps?.uri && !seenUris.has(chunk.maps.uri)) {
            seenUris.add(chunk.maps.uri);
            sources.push({
              title: chunk.maps.title || 'Google Maps Place',
              uri: chunk.maps.uri,
              kind: 'maps',
            });
          }
          const snippets = chunk.maps?.placeAnswerSources?.reviewSnippets;
          if (Array.isArray(snippets)) {
            for (const sn of snippets) {
              if (sn?.googleMapsUri && !seenUris.has(sn.googleMapsUri)) {
                seenUris.add(sn.googleMapsUri);
                sources.push({
                  title: sn.title || 'Maps Review Reference',
                  uri: sn.googleMapsUri,
                  kind: 'maps',
                });
              }
            }
          }
        }
      }

      res.json({
        text: response.text ?? '',
        model,
        groundingMode,
        sources: sources.slice(0, 10),
      });
    } catch (err) {
      const { status, message } = formatGeminiError(err, 'Failed to run Gemini chat.');
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/images', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'Image generation service is not configured. Check GEMINI_API_KEY in Settings > Secrets.',
      });
      return;
    }

    try {
      const body = req.body as {
        prompt?: string;
        model?: string;
        aspectRatio?: string;
        imageSize?: string;
        imageBase64?: string;
        mimeType?: string;
        useSearch?: boolean;
      };

      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) {
        res.status(400).json({ error: 'Image prompt is required.' });
        return;
      }

      const model =
        body.model === 'gemini-nano-banana-2.1'
          ? 'gemini-nano-banana-2.1'
          : 'gemini-3.1-flash-lite-image';

      const allowedRatios = new Set(['1:1', '3:4', '4:3', '9:16', '16:9']);
      const aspectRatio =
        typeof body.aspectRatio === 'string' && allowedRatios.has(body.aspectRatio)
          ? body.aspectRatio
          : '1:1';

      const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
      if (typeof body.imageBase64 === 'string' && body.imageBase64.length > 0) {
        const mime =
          body.mimeType === 'image/png' || body.mimeType === 'image/webp'
            ? body.mimeType
            : 'image/jpeg';
        parts.push({ inlineData: { mimeType: mime, data: body.imageBase64 } });
      }
      parts.push({ text: prompt });

      const imageConfig: Record<string, string> = { aspectRatio };
      if (model === 'gemini-nano-banana-2.1') {
        imageConfig.imageSize = body.imageSize === '2K' ? '2K' : '1K';
      }

      const config: Record<string, unknown> = { imageConfig };
      if (model === 'gemini-nano-banana-2.1' && body.useSearch) {
        config.tools = [
          {
            googleSearch: {
              searchTypes: {
                webSearch: {},
                imageSearch: {},
              },
            },
          },
        ];
      }

      const response = await ai.models.generateContent({
        model,
        contents: { parts },
        config,
      });

      let imageUrl: string | null = null;
      let text = '';
      for (const part of response.candidates?.[0]?.content?.parts ?? []) {
        if (part.inlineData?.data && !imageUrl) {
          const mime = part.inlineData.mimeType ?? 'image/png';
          imageUrl = `data:${mime};base64,${part.inlineData.data}`;
        } else if (part.text) {
          text += part.text;
        }
      }

      if (!imageUrl) {
        res.status(502).json({
          error: text || 'Model returned no image bytes. Refine prompt and try again.',
        });
        return;
      }

      res.json({ imageUrl, text: text.trim(), model });
    } catch (err) {
      const { status, message } = formatGeminiError(err, 'Failed to generate or edit image.');
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/music', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'Music generation service is not configured. Check GEMINI_API_KEY in Settings > Secrets.',
      });
      return;
    }

    try {
      const body = req.body as {
        prompt?: string;
        model?: string;
        imageBase64?: string;
        mimeType?: string;
      };
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) {
        res.status(400).json({ error: 'Music prompt is required.' });
        return;
      }

      const model =
        body.model === 'lyria-3-pro-preview' ? 'lyria-3-pro-preview' : 'lyria-3-clip-preview';

      const contents =
        typeof body.imageBase64 === 'string' && body.imageBase64.length > 0
          ? {
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    data: body.imageBase64,
                    mimeType: body.mimeType === 'image/png' ? 'image/png' : 'image/jpeg',
                  },
                },
              ],
            }
          : prompt;

      const stream = await ai.models.generateContentStream({
        model,
        contents,
      });

      const audioChunks: Buffer[] = [];
      let lyrics = '';
      let mimeType = 'audio/mpeg';

      for await (const chunk of stream) {
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (!parts) continue;
        for (const part of parts) {
          if (part.inlineData?.data) {
            if (audioChunks.length === 0 && part.inlineData.mimeType) {
              mimeType = part.inlineData.mimeType;
            }
            audioChunks.push(Buffer.from(part.inlineData.data, 'base64'));
          }
          if (part.text) {
            lyrics += part.text;
          }
        }
      }

      if (audioChunks.length === 0) {
        res.status(502).json({ error: 'Lyria returned no audio stream chunks.' });
        return;
      }

      const audioBase64 = Buffer.concat(audioChunks).toString('base64');
      res.json({
        audioDataUrl: `data:${mimeType};base64,${audioBase64}`,
        mimeType,
        lyrics: lyrics.trim(),
        model,
      });
    } catch (err) {
      const { status, message } = formatGeminiError(err, 'Failed to generate music.');
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/video', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'Video generation service is not configured. Check GEMINI_API_KEY in Settings > Secrets.',
      });
      return;
    }

    try {
      const body = req.body as {
        prompt?: string;
        aspectRatio?: string;
        duration?: string;
        imageBase64?: string;
        mimeType?: string;
      };
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) {
        res.status(400).json({ error: 'Video prompt is required.' });
        return;
      }

      const aspectRatio = body.aspectRatio === '9:16' ? '9:16' : '16:9';
      const duration =
        body.duration === '8s' || body.duration === '10s' ? body.duration : '5s';

      const input =
        typeof body.imageBase64 === 'string' && body.imageBase64.length > 0
          ? [
              {
                type: 'image' as const,
                mime_type: body.mimeType === 'image/png' ? 'image/png' : 'image/jpeg',
                data: body.imageBase64,
              },
              { type: 'text' as const, text: prompt },
            ]
          : prompt;

      const interaction = await ai.interactions.create(
        {
          model: 'gemini-omni-1.2-flash',
          input,
          background: false,
          store: false,
          stream: false,
          response_format: {
            type: 'video',
            aspect_ratio: aspectRatio,
            duration,
            resolution: '720p',
          },
        },
        { timeout: 300000 }
      );

      const videoPart = interaction.output_video;
      if (!videoPart || (!videoPart.data && !videoPart.uri)) {
        res.status(502).json({ error: 'Omni Flash returned no video output.' });
        return;
      }

      const mimeType = videoPart.mime_type || 'video/mp4';
      const videoDataUrl = videoPart.data ? `data:${mimeType};base64,${videoPart.data}` : null;
      res.json({
        videoDataUrl,
        videoUri: videoPart.uri ?? null,
        mimeType,
        model: 'gemini-omni-1.2-flash',
      });
    } catch (err) {
      const { status, message } = formatGeminiError(err, 'Failed to generate video.');
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/transcribe', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'Transcription service is not configured. Check GEMINI_API_KEY in Settings > Secrets.',
      });
      return;
    }

    try {
      const body = req.body as {
        audioBase64?: string;
        mimeType?: string;
        prompt?: string;
      };
      if (!body?.audioBase64 || typeof body.audioBase64 !== 'string') {
        res.status(400).json({ error: 'Missing audioBase64 payload.' });
        return;
      }

      const mimeType =
        typeof body.mimeType === 'string' && body.mimeType.startsWith('audio/')
          ? body.mimeType
          : 'audio/webm';

      const response = await ai.models.generateContent({
        model: 'gemini-3.5-transcribe',
        contents: {
          parts: [
            { inlineData: { mimeType, data: body.audioBase64 } },
            {
              text:
                typeof body.prompt === 'string' && body.prompt.trim()
                  ? body.prompt.trim()
                  : 'Transcribe this audio accurately with speaker clarity.',
            },
          ],
        },
      });

      res.json({ transcript: (response.text ?? '').trim(), model: 'gemini-3.5-transcribe' });
    } catch (err) {
      const { status, message } = formatGeminiError(err, 'Failed to transcribe audio.');
      res.status(status).json({ error: message });
    }
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 512 * 1024,
  });
  const liveWss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
  });

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', 'http://localhost').pathname;
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/live') {
      liveWss.handleUpgrade(request, socket, head, (ws) => {
        liveWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    let activePeer: RoomPeer | null = null;

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      const type = msg.type;
      if (type === 'ping') {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        }
        return;
      }

      if (type === 'join') {
        const rawRoom = typeof msg.roomId === 'string' ? msg.roomId : '';
        const cleanRoom = rawRoom.replace(/[^A-Za-z0-9_-]/g, '').toUpperCase().slice(0, 16);
        if (!cleanRoom) {
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid room ID.' }));
          return;
        }

        const role = msg.role === 'host' ? 'host' : 'camera';
        const room = getOrCreateRoom(cleanRoom);

        const rawNodeId = typeof msg.nodeId === 'string' ? msg.nodeId : '';
        const nodeId =
          rawNodeId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) ||
          `cam-${crypto.randomBytes(3).toString('hex')}`;
        const deviceName =
          typeof msg.deviceName === 'string' && msg.deviceName.trim()
            ? msg.deviceName.trim().slice(0, 40)
            : `Mobile Cam ${room.nodes.size + 1}`;

        if (role === 'camera' && !room.nodes.has(nodeId) && room.nodes.size >= MAX_CAMERA_NODES_PER_ROOM) {
          ws.send(
            JSON.stringify({
              type: 'error',
              error: `Room limit reached (${MAX_CAMERA_NODES_PER_ROOM} cameras max).`,
            })
          );
          return;
        }

        activePeer = { ws, role, nodeId, roomId: room.roomId };
        room.peers.add(activePeer);

        if (role === 'camera') {
          const existingNode = room.nodes.get(nodeId);
          const node: ServerLinkedNode = existingNode
            ? {
                ...existingNode,
                deviceName,
                lastSeen: Date.now(),
              }
            : {
                nodeId,
                deviceName,
                connectedAt: Date.now(),
                lastSeen: Date.now(),
                cameraActive: false,
                gpsActive: false,
                coords: null,
                detections: [],
                fps: 0,
                latencyMs: null,
              };
          room.nodes.set(nodeId, node);
          broadcastToRoom(room, { type: 'node:joined', node }, ws);
        }

        ws.send(
          JSON.stringify({
            type: 'room:state',
            roomId: room.roomId,
            nodes: Array.from(room.nodes.values()),
            rules: room.rules,
          })
        );
        return;
      }

      if (!activePeer) return;
      const room = rooms.get(activePeer.roomId);
      if (!room) return;

      if (type === 'rules:sync' && activePeer.role === 'host') {
        room.rules = msg.rules ?? null;
        broadcastToRoom(room, { type: 'rules:updated', rules: room.rules }, ws, 'camera');
        return;
      }

      if (activePeer.role !== 'camera') return;
      const node = room.nodes.get(activePeer.nodeId);
      if (!node) return;
      node.lastSeen = Date.now();

      if (type === 'node:status') {
        if (typeof msg.cameraActive === 'boolean') node.cameraActive = msg.cameraActive;
        if (typeof msg.gpsActive === 'boolean') node.gpsActive = msg.gpsActive;
        if (typeof msg.deviceName === 'string' && msg.deviceName.trim()) {
          node.deviceName = msg.deviceName.trim().slice(0, 40);
        }
        if (!node.cameraActive) {
          node.previewFrameUrl = undefined;
          node.detections = [];
          node.fps = 0;
        }
        broadcastToRoom(room, { type: 'node:updated', node }, ws, 'host');
        return;
      }

      if (type === 'camera:frame') {
        const previewFrameUrl = isValidImageDataUrl(msg.previewFrameUrl, 240000)
          ? msg.previewFrameUrl
          : undefined;
        const detections = sanitizeDetections(msg.detections);
        const fps =
          typeof msg.fps === 'number' && Number.isFinite(msg.fps)
            ? Math.max(0, Math.min(120, Math.round(msg.fps)))
            : 0;
        const latencyMs =
          typeof msg.latencyMs === 'number' && Number.isFinite(msg.latencyMs)
            ? Math.max(0, Math.round(msg.latencyMs))
            : null;

        node.cameraActive = true;
        if (previewFrameUrl) node.previewFrameUrl = previewFrameUrl;
        node.detections = detections;
        node.fps = fps;
        node.latencyMs = latencyMs;

        broadcastToRoom(
          room,
          {
            type: 'node:frame',
            nodeId: node.nodeId,
            deviceName: node.deviceName,
            previewFrameUrl: node.previewFrameUrl,
            detections: node.detections,
            fps: node.fps,
            latencyMs: node.latencyMs,
            lastSeen: node.lastSeen,
          },
          ws,
          'host'
        );
        return;
      }

      if (type === 'gps:update') {
        const coords = sanitizeCoords(msg.coords);
        if (!coords) return;
        node.gpsActive = true;
        node.coords = coords;
        broadcastToRoom(
          room,
          {
            type: 'node:gps',
            nodeId: node.nodeId,
            deviceName: node.deviceName,
            coords,
            lastSeen: node.lastSeen,
          },
          ws,
          'host'
        );
      }
    });

    ws.on('close', () => {
      if (!activePeer) return;
      const room = rooms.get(activePeer.roomId);
      if (!room) return;
      room.peers.delete(activePeer);

      if (activePeer.role === 'camera') {
        // Only remove node if no other socket holds the same nodeId
        let stillConnected = false;
        for (const p of room.peers) {
          if (p.role === 'camera' && p.nodeId === activePeer.nodeId) {
            stillConnected = true;
            break;
          }
        }
        if (!stillConnected) {
          room.nodes.delete(activePeer.nodeId);
          broadcastToRoom(room, { type: 'node:left', nodeId: activePeer.nodeId }, undefined, 'host');
        }
      }
    });
  });

  liveWss.on('connection', async (clientWs, req) => {
    const ai = getGeminiClient();
    if (!ai) {
      clientWs.send(
        JSON.stringify({
          error: 'Live API is not configured. Check GEMINI_API_KEY in Settings > Secrets.',
        })
      );
      clientWs.close();
      return;
    }

    const reqUrl = new URL(req.url || '', 'http://localhost');
    const requestedVoice = reqUrl.searchParams.get('voice') || 'Zephyr';
    const validVoices = new Set(['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr']);
    const voiceName = validVoices.has(requestedVoice) ? requestedVoice : 'Zephyr';

    let liveSession: Awaited<ReturnType<typeof ai.live.connect>> | null = null;
    try {
      liveSession = await ai.live.connect({
        model: 'gemini-3.8-live',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction:
            'You are GAZVA Vision Guard Voice Copilot. Respond concisely, clearly, and helpfully to live operator voice commands about perimeter security, GPS tracking, multi-camera hubs, or general questions.',
        },
        callbacks: {
          onopen: () => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ ready: true, voice: voiceName, model: 'gemini-3.8-live' }));
            }
          },
          onmessage: (message: LiveServerMessage) => {
            if (clientWs.readyState !== WebSocket.OPEN) return;
            const content = message.serverContent;
            if (content?.inputTranscription?.text) {
              clientWs.send(JSON.stringify({ inputTranscript: content.inputTranscription.text }));
            }
            if (content?.outputTranscription?.text) {
              clientWs.send(JSON.stringify({ outputTranscript: content.outputTranscription.text }));
            }
            for (const part of content?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) {
                clientWs.send(JSON.stringify({ audio: part.inlineData.data }));
              }
            }
            if (content?.interrupted) {
              clientWs.send(JSON.stringify({ interrupted: true }));
            }
          },
          onerror: (errEvent) => {
            if (clientWs.readyState === WebSocket.OPEN) {
              const errMsg =
                errEvent && typeof errEvent === 'object' && 'message' in errEvent
                  ? String((errEvent as { message?: unknown }).message || 'Live session error')
                  : 'Live voice session encountered an error.';
              clientWs.send(JSON.stringify({ error: errMsg }));
            }
          },
          onclose: () => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.close();
            }
          },
        },
      });
    } catch (err) {
      const { message } = formatGeminiError(err, 'Failed to connect to Gemini Live voice session.');
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ error: message }));
        clientWs.close();
      }
      return;
    }

    clientWs.on('message', (raw) => {
      if (!liveSession) return;
      try {
        const msg = JSON.parse(raw.toString()) as {
          audio?: string;
          video?: string;
          text?: string;
        };
        if (typeof msg.audio === 'string' && msg.audio.length > 0) {
          liveSession.sendRealtimeInput({
            audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' },
          });
        }
        if (typeof msg.video === 'string' && msg.video.length > 0) {
          liveSession.sendRealtimeInput({
            video: { data: msg.video, mimeType: 'image/jpeg' },
          });
        }
        if (typeof msg.text === 'string' && msg.text.trim().length > 0) {
          liveSession.sendRealtimeInput({
            text: msg.text.trim(),
          });
        }
      } catch {
        // Ignore malformed live message
      }
    });

    clientWs.on('close', () => {
      try {
        liveSession?.close();
      } catch {
        // Ignore close error
      }
      liveSession = null;
    });
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`GAZVA Vision Guard server + WebSocket Hub listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
