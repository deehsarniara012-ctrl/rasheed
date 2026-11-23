import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BellOff,
  BellRing,
  Box,
  Camera,
  CameraOff,
  CheckCircle2,
  Cloud,
  Download,
  Globe,
  Home,
  Layers,
  LogIn,
  LogOut,
  MapPin,
  Megaphone,
  Menu,
  Moon,
  QrCode,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Sparkles,
  Sun,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { Alert3DModal, Inspectable3DItem } from './components/Alert3DModal';
import { CameraMonitor } from './components/CameraMonitor';
import { CommandAnalyticsCenter } from './components/CommandAnalyticsCenter';
import { DetectionsLog } from './components/DetectionsLog';
import { GeminiStudioCenter } from './components/GeminiStudioCenter';
import { GeoTracker } from './components/GeoTracker';
import { MobileCameraNode } from './components/MobileCameraNode';
import { MultiCameraHub } from './components/MultiCameraHub';
import { QrScannerModal } from './components/QrScannerModal';
import { RulesPanel } from './components/RulesPanel';
import {
  CloudChatMessage,
  CloudMissionItem,
  saveAiSessionLogToFirestore,
  saveChatMessageToFirestore,
  saveMissionReportToFirestore,
  saveWaypointToFirestore,
  signInWithGoogle,
  signOutGoogle,
  subscribeAuthState,
  subscribeUserChatMessages,
  subscribeUserMissions,
  subscribeUserWaypoints,
} from './lib/firebase';
import { DEFAULT_RULES } from './data/cocoClasses';
import {
  Classification,
  CommandDecisionReport,
  DatabaseStats,
  DetectedItem,
  DetectionLogEntry,
  GeoActivityEvent,
  GeoActivityPoint,
  GeoCoordinates,
  GeoDetectionPin,
  GeoIntelligenceData,
  GlobalProductItem,
  LinkedCameraNode,
  ServerSecurityStatus,
  SimulationScenario,
  SimulationSnapshot,
  TelemetrySample,
  VisionRules,
} from './types/vision';
import {
  dbClearStore,
  dbExportDetectionsCsv,
  dbExportSnapshotJson,
  dbGetStats,
  dbLoadDetections,
  dbLoadReports,
  dbLoadTrailPoints,
  dbLoadWaypoints,
  dbSaveDetections,
  dbSaveReport,
  dbSaveTrailPoint,
  dbSaveWaypoints,
} from './utils/gazvaDb';
import { extractRoomIdFromQrText } from './utils/geoMath';
import { sirenEngine, speakTacticalAlert } from './utils/sirenAudio';

const RULES_STORAGE_KEY = 'gazva_vision_rules_v1';
const HOST_ROOM_STORAGE_KEY = 'gazva_host_room_v1';
const REPORTS_STORAGE_KEY = 'gazva_c2_reports_v1';
const THEME_STORAGE_KEY = 'gazva_theme_v1';

type AppPageId =
  | 'overview'
  | 'vision'
  | 'multicam'
  | 'maps'
  | 'command'
  | 'studio'
  | 'workspace';

const INITIAL_SIMULATION: SimulationSnapshot = {
  running: false,
  scenario: 'patrol',
  step: 0,
  simulatedUnitOffsetM: { east: 0, north: 0, speedKmh: 0 },
  simulatedAircraft: [],
  simulatedTrail: [],
  advisory: 'Simulation standby (isolated from live GPS)',
};

function loadInitialDarkTheme(): boolean {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark') return true;
    if (saved === 'light') return false;
  } catch {
    // Ignore storage read failures
  }
  return false;
}

function loadSavedReports(): CommandDecisionReport[] {
  try {
    const raw = localStorage.getItem(REPORTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CommandDecisionReport[]).slice(0, 10) : [];
  } catch {
    return [];
  }
}

function getInitialHostRoomId(): string {
  try {
    const saved = sessionStorage.getItem(HOST_ROOM_STORAGE_KEY);
    if (saved && /^[A-Z0-9_-]{4,16}$/.test(saved)) return saved;
    const arr = new Uint8Array(4);
    crypto.getRandomValues(arr);
    const code = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    sessionStorage.setItem(HOST_ROOM_STORAGE_KEY, code);
    return code;
  } catch {
    return 'GAZVA808';
  }
}

function getJoinedRoomFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('join');
    return raw ? extractRoomIdFromQrText(raw) : null;
  } catch {
    return null;
  }
}

function loadSavedRules(): VisionRules {
  try {
    const raw = localStorage.getItem(RULES_STORAGE_KEY);
    if (!raw) return DEFAULT_RULES;
    const parsed = JSON.parse(raw) as Partial<VisionRules>;
    return {
      positive: Array.isArray(parsed.positive) ? parsed.positive : DEFAULT_RULES.positive,
      negative: Array.isArray(parsed.negative) ? parsed.negative : DEFAULT_RULES.negative,
      confidenceThreshold:
        typeof parsed.confidenceThreshold === 'number'
          ? parsed.confidenceThreshold
          : DEFAULT_RULES.confidenceThreshold,
      unlistedMode:
        parsed.unlistedMode === 'positive' ||
        parsed.unlistedMode === 'negative' ||
        parsed.unlistedMode === 'neutral'
          ? parsed.unlistedMode
          : DEFAULT_RULES.unlistedMode,
    };
  } catch {
    return DEFAULT_RULES;
  }
}

export default function App() {
  const [activePage, setActivePage] = useState<AppPageId>('overview');
  const [isDarkTheme, setIsDarkTheme] = useState<boolean>(loadInitialDarkTheme);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);

  const [rules, setRules] = useState<VisionRules>(loadSavedRules);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [sirenMuted, setSirenMuted] = useState(false);
  const [voiceAlertsEnabled, setVoiceAlertsEnabled] = useState(true);
  const [isSirenSounding, setIsSirenSounding] = useState(false);
  const [isTestSiren, setIsTestSiren] = useState(false);
  const [activeNegativeLabels, setActiveNegativeLabels] = useState<string[]>([]);

  const [activeDetections, setActiveDetections] = useState<DetectedItem[]>([]);
  const [globalProducts, setGlobalProducts] = useState<GlobalProductItem[]>([]);
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);
  const [avgLatencyMs, setAvgLatencyMs] = useState<number | null>(null);
  const [fps, setFps] = useState<number>(0);

  const [logs, setLogs] = useState<DetectionLogEntry[]>([]);
  const [geoCoords, setGeoCoords] = useState<GeoCoordinates | null>(null);
  const [geoPins, setGeoPins] = useState<GeoDetectionPin[]>([]);
  const [activityEvents, setActivityEvents] = useState<GeoActivityEvent[]>([]);
  const [inspected3DItem, setInspected3DItem] = useState<Inspectable3DItem | null>(null);
  const [latestNegativeAlert, setLatestNegativeAlert] = useState<Inspectable3DItem | null>(null);
  const [sessionPositiveCount, setSessionPositiveCount] = useState(0);
  const [sessionNegativeCount, setSessionNegativeCount] = useState(0);
  const [workspaceFocusTab, setWorkspaceFocusTab] = useState<'all' | 'rules' | 'detections'>('all');
  const [logoFailed, setLogoFailed] = useState(false);

  const [hostRoomId, setHostRoomId] = useState<string>(getInitialHostRoomId);
  const [joinedRoomId, setJoinedRoomId] = useState<string | null>(getJoinedRoomFromUrl);
  const [linkedNodes, setLinkedNodes] = useState<LinkedCameraNode[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const [isQrScannerOpen, setIsQrScannerOpen] = useState(false);

  const [geoIntel, setGeoIntel] = useState<GeoIntelligenceData | null>(null);
  const [geoIntelLoading, setGeoIntelLoading] = useState(false);
  const [networkRttMs, setNetworkRttMs] = useState<number | null>(null);
  const [telemetryHistory, setTelemetryHistory] = useState<TelemetrySample[]>([]);
  const [savedReports, setSavedReports] = useState<CommandDecisionReport[]>(loadSavedReports);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [securityStatus, setSecurityStatus] = useState<ServerSecurityStatus | null>(null);
  const [dbStats, setDbStats] = useState<DatabaseStats>({
    backend: 'IndexedDB',
    detectionsCount: 0,
    waypointsCount: 0,
    reportsCount: 0,
    trailCount: 0,
    lastUpdatedAt: null,
  });
  const [initialDbTrail, setInitialDbTrail] = useState<GeoActivityPoint[] | undefined>(undefined);
  const [simulation, setSimulation] = useState<SimulationSnapshot>(INITIAL_SIMULATION);

  const [mapsQuotaExceeded, setMapsQuotaExceeded] = useState(false);
  const [cloudUser, setCloudUser] = useState<User | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [cloudWaypoints, setCloudWaypoints] = useState<GeoDetectionPin[]>([]);
  const [cloudChatMessages, setCloudChatMessages] = useState<CloudChatMessage[]>([]);
  const [cloudMissions, setCloudMissions] = useState<CloudMissionItem[]>([]);

  const latencyHistoryRef = useRef<number[]>([]);
  const frameTimestampsRef = useRef<number[]>([]);
  const lastLoggedMapRef = useRef<Record<string, number>>({});
  const ackCooldownUntilRef = useRef<number>(0);
  const lastUiSyncRef = useRef<number>(0);
  const geoCoordsRef = useRef<GeoCoordinates | null>(null);
  geoCoordsRef.current = geoCoords;
  const sirenMutedRef = useRef(sirenMuted);
  sirenMutedRef.current = sirenMuted;
  const voiceAlertsEnabledRef = useRef(voiceAlertsEnabled);
  voiceAlertsEnabledRef.current = voiceAlertsEnabled;
  const hostWsRef = useRef<WebSocket | null>(null);
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const nodeCoordsMapRef = useRef<Record<string, GeoCoordinates>>({});
  const lastMotionPctRef = useRef<number>(0);
  const lastGeoIntelFetchRef = useRef<number>(0);
  const lastLatencyRef = useRef<number>(0);
  const activeDetectionsCountRef = useRef<number>(0);
  activeDetectionsCountRef.current = activeDetections.length;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, isDarkTheme ? 'dark' : 'light');
    } catch {
      // Ignore storage failures
    }
  }, [isDarkTheme]);

  const navigateToPage = useCallback((page: AppPageId) => {
    setActivePage(page);
    setMobileMoreOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const logActivityEvent = useCallback(
    (ev: Omit<GeoActivityEvent, 'id' | 'timestamp'>) => {
      const entry: GeoActivityEvent = {
        ...ev,
        id: `ga-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
      };
      setActivityEvents((prev) => [entry, ...prev].slice(0, 60));
    },
    []
  );

  useEffect(() => {
    const onQuotaExceeded = () => setMapsQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', onQuotaExceeded);
    return () => window.removeEventListener('gmp-quota-exceeded', onQuotaExceeded);
  }, []);

  useEffect(() => {
    const unsub = subscribeAuthState((user) => {
      setCloudUser(user);
      if (!user) {
        setCloudWaypoints([]);
        setCloudChatMessages([]);
        setCloudMissions([]);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!cloudUser) return;
    const unsubWp = subscribeUserWaypoints(cloudUser.uid, setCloudWaypoints);
    const unsubChat = subscribeUserChatMessages(cloudUser.uid, setCloudChatMessages);
    const unsubMissions = subscribeUserMissions(cloudUser.uid, setCloudMissions);
    return () => {
      unsubWp();
      unsubChat();
      unsubMissions();
    };
  }, [cloudUser]);

  useEffect(() => {
    try {
      localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(rules));
    } catch {
      // Ignore storage quota errors
    }
    if (hostWsRef.current && hostWsRef.current.readyState === WebSocket.OPEN) {
      hostWsRef.current.send(JSON.stringify({ type: 'rules:sync', rules }));
    }
  }, [rules]);

  // Host WebSocket Real-Time Sync for 5-6+ Linked Mobile Cameras & GPS Nodes
  useEffect(() => {
    if (joinedRoomId) return;
    let closed = false;
    let reconnectTimer: number | null = null;

    const connectHost = () => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      hostWsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        ws.send(
          JSON.stringify({
            type: 'join',
            roomId: hostRoomId,
            role: 'host',
            nodeId: 'host-primary',
            deviceName: 'Host Dashboard',
          })
        );
        ws.send(JSON.stringify({ type: 'rules:sync', rules: rulesRef.current }));
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(String(evt.data)) as Record<string, unknown>;
          if (msg.type === 'room:state' && Array.isArray(msg.nodes)) {
            const initialNodes = msg.nodes as LinkedCameraNode[];
            const nextMap: Record<string, GeoCoordinates> = {};
            for (const n of initialNodes) {
              if (n.coords) nextMap[n.nodeId] = n.coords;
            }
            nodeCoordsMapRef.current = nextMap;
            setLinkedNodes(initialNodes);
          } else if (msg.type === 'node:joined' && msg.node) {
            const incoming = msg.node as LinkedCameraNode;
            if (incoming.coords) {
              nodeCoordsMapRef.current[incoming.nodeId] = incoming.coords;
            }
            setLinkedNodes((prev) => {
              const filtered = prev.filter((n) => n.nodeId !== incoming.nodeId);
              return [incoming, ...filtered];
            });
            logActivityEvent({
              type: 'remote_node',
              message: `${incoming.deviceName} linked via QR code`,
            });
          } else if (msg.type === 'node:updated' && msg.node) {
            const updated = msg.node as LinkedCameraNode;
            if (updated.coords) {
              nodeCoordsMapRef.current[updated.nodeId] = updated.coords;
            }
            setLinkedNodes((prev) =>
              prev.map((n) => (n.nodeId === updated.nodeId ? updated : n))
            );
          } else if (msg.type === 'node:left' && typeof msg.nodeId === 'string') {
            const leftId = msg.nodeId;
            delete nodeCoordsMapRef.current[leftId];
            setLinkedNodes((prev) => prev.filter((n) => n.nodeId !== leftId));
          } else if (msg.type === 'node:gps' && typeof msg.nodeId === 'string' && msg.coords) {
            const nodeId = msg.nodeId;
            const deviceName = typeof msg.deviceName === 'string' ? msg.deviceName : 'Mobile Node';
            const nextCoords = msg.coords as GeoCoordinates;
            const lastSeen = typeof msg.lastSeen === 'number' ? msg.lastSeen : Date.now();
            nodeCoordsMapRef.current[nodeId] = nextCoords;
            setLinkedNodes((prev) =>
              prev.map((n) =>
                n.nodeId === nodeId
                  ? { ...n, gpsActive: true, coords: nextCoords, lastSeen }
                  : n
              )
            );
            const gpsThrottleKey = `gps-node:${nodeId}`;
            const now = Date.now();
            if (now - (lastLoggedMapRef.current[gpsThrottleKey] ?? 0) >= 8000) {
              lastLoggedMapRef.current[gpsThrottleKey] = now;
              logActivityEvent({
                type: 'remote_node',
                message: `${deviceName} GPS fix updated`,
                coords: { latitude: nextCoords.latitude, longitude: nextCoords.longitude },
              });
            }
          } else if (msg.type === 'node:frame' && typeof msg.nodeId === 'string') {
            const nodeId = msg.nodeId;
            const deviceName = typeof msg.deviceName === 'string' ? msg.deviceName : 'Mobile Cam';
            const detections = Array.isArray(msg.detections)
              ? (msg.detections as DetectedItem[])
              : [];
            const previewFrameUrl =
              typeof msg.previewFrameUrl === 'string' ? msg.previewFrameUrl : undefined;
            const fpsVal = typeof msg.fps === 'number' ? msg.fps : 0;
            const latVal = typeof msg.latencyMs === 'number' ? msg.latencyMs : null;
            const lastSeen = typeof msg.lastSeen === 'number' ? msg.lastSeen : Date.now();

            const matchedNodeCoords = nodeCoordsMapRef.current[nodeId];
            setLinkedNodes((prev) =>
              prev.map((n) => {
                if (n.nodeId === nodeId) {
                  return {
                    ...n,
                    cameraActive: true,
                    previewFrameUrl: previewFrameUrl || n.previewFrameUrl,
                    detections,
                    fps: fpsVal,
                    latencyMs: latVal,
                    lastSeen,
                  };
                }
                return n;
              })
            );

            const now = Date.now();
            const negItems = detections.filter((d) => d.classification === 'negative');
            if (negItems.length > 0) {
              const topNeg = negItems[0];
              setLatestNegativeAlert({
                id: topNeg.id,
                label: `${topNeg.displayLabel} (${deviceName})`,
                classification: 'negative',
                score: topNeg.score,
                thumbnailUrl: topNeg.thumbnailUrl || previewFrameUrl,
                latitude: matchedNodeCoords?.latitude ?? geoCoordsRef.current?.latitude,
                longitude: matchedNodeCoords?.longitude ?? geoCoordsRef.current?.longitude,
                timestamp: now,
              });
              if (!sirenMutedRef.current && now >= ackCooldownUntilRef.current) {
                if (!sirenEngine.isPlaying()) sirenEngine.start();
                if (voiceAlertsEnabledRef.current) {
                  speakTacticalAlert(`Alert from ${deviceName}: ${topNeg.displayLabel} detected.`);
                }
                setActiveNegativeLabels([`${topNeg.displayLabel} (${deviceName})`]);
                setIsSirenSounding(true);
                setIsTestSiren(false);
              }
            }

            // Log throttled detections from linked mobile camera
            for (const det of detections) {
              const key = `remote:${nodeId}:${det.rawClass}:${det.classification}`;
              if (now - (lastLoggedMapRef.current[key] ?? 0) >= 3000) {
                lastLoggedMapRef.current[key] = now;
                const label = `${det.displayLabel} (${deviceName})`;
                setLogs((prev) =>
                  [
                    {
                      id: `${now}-${nodeId}-${det.rawClass}`,
                      timestamp: now,
                      label,
                      rawClass: det.rawClass,
                      score: det.score,
                      classification: det.classification,
                      latencyMs: latVal ?? 45,
                      source: 'local' as const,
                      thumbnailUrl: det.thumbnailUrl || previewFrameUrl,
                    },
                    ...prev,
                  ].slice(0, 80)
                );
                if (det.classification === 'positive') setSessionPositiveCount((c) => c + 1);
                if (det.classification === 'negative') setSessionNegativeCount((c) => c + 1);
              }
            }
          }
        } catch {
          // Ignore malformed WS message
        }
      };

      ws.onclose = () => {
        hostWsRef.current = null;
        setWsConnected(false);
        if (!closed) {
          reconnectTimer = window.setTimeout(connectHost, 2000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connectHost();

    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (hostWsRef.current) {
        hostWsRef.current.close();
        hostWsRef.current = null;
      }
    };
  }, [hostRoomId, joinedRoomId, logActivityEvent]);

  useEffect(() => {
    try {
      localStorage.setItem(REPORTS_STORAGE_KEY, JSON.stringify(savedReports));
    } catch {
      // Ignore storage quota errors
    }
  }, [savedReports]);

  const refreshDbStats = useCallback(async () => {
    const stats = await dbGetStats();
    setDbStats(stats);
  }, []);

  useEffect(() => {
    if (joinedRoomId) return;
    let active = true;
    void (async () => {
      const [dbLogs, dbPins, dbReports, dbTrail, stats] = await Promise.all([
        dbLoadDetections(80),
        dbLoadWaypoints(24),
        dbLoadReports(10),
        dbLoadTrailPoints(150),
        dbGetStats(),
      ]);
      if (!active) return;
      if (dbLogs.length > 0) setLogs(dbLogs);
      if (dbPins.length > 0) setGeoPins(dbPins);
      if (dbReports.length > 0) setSavedReports(dbReports);
      if (dbTrail.length > 0) setInitialDbTrail(dbTrail);
      setDbStats(stats);
    })();
    return () => {
      active = false;
    };
  }, [joinedRoomId]);

  // Deterministic 3D Simulation Sandbox Loop (isolated from live GPS/DB)
  useEffect(() => {
    if (!simulation.running) return;
    const timer = window.setInterval(() => {
      setSimulation((prev) => {
        if (!prev.running) return prev;
        const step = prev.step + 1;
        const angle = step * 0.14;
        let east = 0;
        let north = 0;
        let speedKmh = 28;
        let simulatedAircraft = prev.simulatedAircraft;
        let advisory = 'Convoy executing perimeter patrol loop';

        if (prev.scenario === 'patrol') {
          east = Math.sin(angle) * 32;
          north = Math.cos(angle) * 32;
          speedKmh = 32;
          advisory = `Sim Patrol Vector: heading ${Math.round(((angle * 180) / Math.PI) % 360)}°`;
        } else if (prev.scenario === 'airspace') {
          east = Math.sin(angle * 0.5) * 14;
          north = Math.cos(angle * 0.5) * 14;
          speedKmh = 18;
          const airEast = 45000 - (step % 45) * 1800;
          const airNorth = Math.sin(angle) * 18000;
          const rangeKm = Math.round(Math.hypot(airEast, airNorth) / 1000);
          simulatedAircraft = [
            {
              id: 'sim-flt-1',
              callsign: 'SIM-ATM-01',
              eastMeters: airEast,
              northMeters: airNorth,
              altitudeMeters: 4200,
              headingDeg: 270,
              speedKmh: 760,
            },
          ];
          advisory =
            rangeKm < 15
              ? `ATM Drill Advisory: Simulated track within ${rangeKm} km sector`
              : `ATM Drill: Simulated track range ${rangeKm} km`;
        } else {
          east = Math.sin(angle * 1.4) * 40;
          north = Math.sin(angle * 0.7) * 28;
          speedKmh = 46;
          simulatedAircraft = [
            {
              id: 'sim-uav-1',
              callsign: 'SIM-SURV-02',
              eastMeters: Math.cos(angle) * 24000,
              northMeters: Math.sin(angle) * 24000,
              altitudeMeters: 2800,
              headingDeg: Math.round(((angle * 180) / Math.PI + 90) % 360),
              speedKmh: 340,
            },
          ];
          advisory = 'Multi-Vector Drill: Ground + Airspace tracks active in 3D twin';
        }

        return {
          ...prev,
          step,
          simulatedUnitOffsetM: { east, north, speedKmh },
          simulatedAircraft,
          simulatedTrail: [...prev.simulatedTrail, { eastMeters: east, northMeters: north }].slice(-45),
          advisory,
        };
      });
    }, 900);
    return () => window.clearInterval(timer);
  }, [simulation.running]);

  // Real-time Cyber / Network RTT Ping + Security Status + Signal Anomaly Sampling
  useEffect(() => {
    if (joinedRoomId) return;
    let active = true;

    const sampleTelemetry = async () => {
      let rtt = 0;
      const t0 = performance.now();
      try {
        const res = await fetch('/api/security-status', { cache: 'no-store' });
        rtt = Math.round(performance.now() - t0);
        if (res.ok) {
          const sec = (await res.json()) as ServerSecurityStatus;
          if (active) setSecurityStatus(sec);
        }
      } catch {
        rtt = 250;
      }
      if (!active) return;
      setNetworkRttMs(rtt);

      setTelemetryHistory((prev) => {
        const edge = Math.round(lastLatencyRef.current || 0);
        const motion = lastMotionPctRef.current;
        const detCount = activeDetectionsCountRef.current;

        const series = prev.map((p) => p.networkRttMs + p.edgeLatencyMs + p.motionPct * 2);
        const currentVal = rtt + edge + motion * 2;
        let z = 0;
        if (series.length >= 4) {
          const mean = series.reduce((a, b) => a + b, 0) / series.length;
          const variance =
            series.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / series.length;
          const std = Math.sqrt(variance);
          z = std > 1 ? Math.abs(currentVal - mean) / std : 0;
        }

        const next: TelemetrySample = {
          timestamp: Date.now(),
          edgeLatencyMs: edge,
          networkRttMs: rtt,
          motionPct: motion,
          detectionCount: detCount,
          anomalyScore: Number(z.toFixed(2)),
        };
        return [...prev, next].slice(-30);
      });
    };

    void sampleTelemetry();
    const timer = window.setInterval(() => {
      void sampleTelemetry();
    }, 4500);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [joinedRoomId]);

  const fetchGeoIntelligence = useCallback(async (lat: number, lon: number) => {
    setGeoIntelLoading(true);
    try {
      const res = await fetch(
        `/api/geo-intelligence?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`
      );
      if (res.ok) {
        const data = (await res.json()) as GeoIntelligenceData;
        setGeoIntel(data);
        lastGeoIntelFetchRef.current = Date.now();
      }
    } catch {
      // Preserve last fetched geo intel on transient network failure
    } finally {
      setGeoIntelLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!geoCoords) return;
    if (Date.now() - lastGeoIntelFetchRef.current >= 120000) {
      void fetchGeoIntelligence(geoCoords.latitude, geoCoords.longitude);
    }
  }, [geoCoords, fetchGeoIntelligence]);

  useEffect(() => {
    return () => {
      sirenEngine.stop();
    };
  }, []);

  const handleStartCamera = useCallback(() => {
    sirenEngine.unlock();
    setIsCameraActive(true);
    setActivePage('vision');
  }, []);

  const handleStopCamera = useCallback(() => {
    setIsCameraActive(false);
    setActiveDetections([]);
    setGlobalProducts([]);
    setFps(0);
  }, []);

  const handleAcknowledgeAlert = useCallback(() => {
    sirenEngine.stop();
    setIsSirenSounding(false);
    setIsTestSiren(false);
    ackCooldownUntilRef.current = Date.now() + 4000;
  }, []);

  const handleToggleMute = useCallback(() => {
    sirenEngine.unlock();
    setSirenMuted((prev) => {
      const next = !prev;
      sirenEngine.setMuted(next);
      if (next) {
        setIsSirenSounding(false);
        setIsTestSiren(false);
      }
      return next;
    });
  }, []);

  const handleTestSiren = useCallback(() => {
    sirenEngine.unlock();
    if (isSirenSounding) {
      sirenEngine.stop();
      setIsSirenSounding(false);
      setIsTestSiren(false);
      return;
    }
    if (sirenMuted) {
      sirenEngine.setMuted(false);
      setSirenMuted(false);
    }
    sirenEngine.start();
    setIsSirenSounding(true);
    setIsTestSiren(true);
  }, [isSirenSounding, sirenMuted]);

  const handleFrameResult = useCallback(
    (detections: DetectedItem[], latencyMs: number, motionPct?: number) => {
      const now = Date.now();
      lastLatencyRef.current = latencyMs;
      if (typeof motionPct === 'number') {
        lastMotionPctRef.current = motionPct;
      }

      const history = latencyHistoryRef.current;
      history.push(latencyMs);
      if (history.length > 15) history.shift();

      const frameTimes = frameTimestampsRef.current;
      frameTimes.push(now);
      while (frameTimes.length > 0 && now - frameTimes[0] > 1000) {
        frameTimes.shift();
      }

      const negativeItems = detections.filter((d) => d.classification === 'negative');
      if (negativeItems.length > 0) {
        const labels = Array.from(new Set(negativeItems.map((d) => d.displayLabel)));
        const topNeg = negativeItems[0];
        setLatestNegativeAlert({
          id: topNeg.id,
          label: topNeg.fineLabel || topNeg.displayLabel,
          classification: topNeg.classification,
          score: topNeg.score,
          thumbnailUrl: topNeg.thumbnailUrl,
          latitude: geoCoordsRef.current?.latitude,
          longitude: geoCoordsRef.current?.longitude,
          timestamp: now,
        });
        if (!sirenMutedRef.current && now >= ackCooldownUntilRef.current) {
          if (!sirenEngine.isPlaying()) {
            sirenEngine.start();
          }
          if (voiceAlertsEnabledRef.current) {
            speakTacticalAlert(`Negative alert: ${labels[0]} detected.`);
          }
          setActiveNegativeLabels(labels);
          setIsSirenSounding(true);
          setIsTestSiren(false);
        }
      } else if (!sirenEngine.isPlaying() && activeNegativeLabels.length > 0) {
        setActiveNegativeLabels([]);
      }

      if (lastUiSyncRef.current === 0 || now - lastUiSyncRef.current >= 100) {
        lastUiSyncRef.current = now;
        const avg = history.reduce((sum, val) => sum + val, 0) / history.length;
        setLastLatencyMs(latencyMs);
        setAvgLatencyMs(avg);
        setFps(frameTimes.length);
        setActiveDetections(detections);
      }

      const newEntries: DetectionLogEntry[] = [];
      let addedPositive = 0;
      let addedNegative = 0;

      const newPins: GeoDetectionPin[] = [];
      const currentGeo = geoCoordsRef.current;

      for (const det of detections) {
        const label = det.fineLabel || det.displayLabel;
        const key = `${label}:${det.classification}`;
        const lastLogged = lastLoggedMapRef.current[key] ?? 0;
        if (now - lastLogged >= 2000) {
          lastLoggedMapRef.current[key] = now;
          newEntries.push({
            id: `${now}-${det.rawClass}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: now,
            label,
            rawClass: det.rawClass,
            score: det.score,
            classification: det.classification,
            latencyMs,
            source: 'local',
            thumbnailUrl: det.thumbnailUrl,
          });
          if (det.classification === 'positive') addedPositive += 1;
          if (det.classification === 'negative') addedNegative += 1;

          const [bx, by, bw, bh] = det.bbox;
          const normX = Math.min(1, Math.max(0, (bx + bw / 2) / 640));
          const normY = Math.min(1, Math.max(0, (by + bh / 2) / 480));
          newPins.push({
            id: `pin-${now}-${det.rawClass}-${Math.random().toString(36).slice(2, 6)}`,
            label,
            classification: det.classification,
            score: det.score,
            gridX: 18 + normX * 64,
            gridY: 14 + normY * 30,
            latitude: currentGeo?.latitude,
            longitude: currentGeo?.longitude,
            timestamp: now,
            thumbnailUrl: det.thumbnailUrl,
          });
        }
      }

      if (newEntries.length > 0) {
        setLogs((prev) => [...newEntries, ...prev].slice(0, 80));
        void dbSaveDetections(newEntries).then(() => refreshDbStats());
        if (newPins.length > 0) {
          setGeoPins((prev) => [...newPins, ...prev].slice(0, 18));
          void dbSaveWaypoints(newPins).then(() => refreshDbStats());
        }
        if (addedPositive > 0) setSessionPositiveCount((c) => c + addedPositive);
        if (addedNegative > 0) setSessionNegativeCount((c) => c + addedNegative);
      }
    },
    [activeNegativeLabels.length, refreshDbStats]
  );

  const handleGlobalProductsResult = useCallback(
    (products: GlobalProductItem[], serverMs: number) => {
      const now = Date.now();
      setGlobalProducts(products);

      const negativeProducts = products.filter((p) => p.classification === 'negative');
      if (negativeProducts.length > 0) {
        const labels = negativeProducts.map((p) => p.productName);
        const topNeg = negativeProducts[0];
        setLatestNegativeAlert({
          id: topNeg.id,
          label: topNeg.productName,
          classification: topNeg.classification,
          score: topNeg.confidence,
          thumbnailUrl: topNeg.thumbnailUrl,
          latitude: geoCoordsRef.current?.latitude,
          longitude: geoCoordsRef.current?.longitude,
          timestamp: now,
        });
        if (!sirenMutedRef.current && now >= ackCooldownUntilRef.current) {
          if (!sirenEngine.isPlaying()) {
            sirenEngine.start();
          }
          if (voiceAlertsEnabledRef.current) {
            speakTacticalAlert(`Negative product detected: ${labels[0]}.`);
          }
          setActiveNegativeLabels((prev) => Array.from(new Set([...prev, ...labels])));
          setIsSirenSounding(true);
          setIsTestSiren(false);
        }
      }

      const newEntries: DetectionLogEntry[] = [];
      let addedPositive = 0;
      let addedNegative = 0;

      const newPins: GeoDetectionPin[] = [];
      const currentGeo = geoCoordsRef.current;

      for (const prod of products) {
        const key = `global:${prod.productName}:${prod.classification}`;
        const lastLogged = lastLoggedMapRef.current[key] ?? 0;
        if (now - lastLogged >= 3500) {
          lastLoggedMapRef.current[key] = now;
          newEntries.push({
            id: `${now}-gp-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: now,
            label: `${prod.productName}${prod.brand && prod.brand !== 'Generic' ? ` (${prod.brand})` : ''}`,
            rawClass: prod.category,
            score: prod.confidence,
            classification: prod.classification,
            latencyMs: serverMs,
            source: 'global',
            thumbnailUrl: prod.thumbnailUrl,
          });
          if (prod.classification === 'positive') addedPositive += 1;
          if (prod.classification === 'negative') addedNegative += 1;

          const normX = prod.box_2d ? (prod.box_2d[1] + prod.box_2d[3]) / 2000 : 0.5;
          const normY = prod.box_2d ? (prod.box_2d[0] + prod.box_2d[2]) / 2000 : 0.35;
          newPins.push({
            id: `gpin-${now}-${Math.random().toString(36).slice(2, 6)}`,
            label: prod.productName,
            classification: prod.classification,
            score: prod.confidence,
            gridX: 16 + normX * 68,
            gridY: 14 + normY * 32,
            latitude: currentGeo?.latitude,
            longitude: currentGeo?.longitude,
            timestamp: now,
            thumbnailUrl: prod.thumbnailUrl,
          });
        }
      }

      if (newEntries.length > 0) {
        setLogs((prev) => [...newEntries, ...prev].slice(0, 80));
        void dbSaveDetections(newEntries).then(() => refreshDbStats());
        if (newPins.length > 0) {
          setGeoPins((prev) => [...newPins, ...prev].slice(0, 18));
          void dbSaveWaypoints(newPins).then(() => refreshDbStats());
        }
        if (addedPositive > 0) setSessionPositiveCount((c) => c + addedPositive);
        if (addedNegative > 0) setSessionNegativeCount((c) => c + addedNegative);
      }
    },
    [refreshDbStats]
  );

  const handleAddManualGeoPin = useCallback(
    (label: string, classification: Classification) => {
      const now = Date.now();
      const angle = (now % 360) * (Math.PI / 180);
      const radius = 20 + (now % 14);
      const pin: GeoDetectionPin = {
        id: `gps-${now}-${Math.random().toString(36).slice(2, 6)}`,
        label,
        classification,
        score: 1,
        gridX: Math.max(15, Math.min(85, 50 + Math.cos(angle) * radius)),
        gridY: Math.max(15, Math.min(85, 50 + Math.sin(angle) * radius)),
        latitude: geoCoordsRef.current?.latitude,
        longitude: geoCoordsRef.current?.longitude,
        timestamp: now,
        isManualWaypoint: true,
      };
      setGeoPins((prev) => [pin, ...prev].slice(0, 24));
      void dbSaveWaypoints([pin]).then(() => refreshDbStats());
      if (cloudUser) {
        void saveWaypointToFirestore(cloudUser.uid, pin);
      }
      logActivityEvent({
        type: 'waypoint',
        message: `Pinned 3D GPS waypoint: ${label} (${classification})`,
        coords: geoCoordsRef.current
          ? { latitude: geoCoordsRef.current.latitude, longitude: geoCoordsRef.current.longitude }
          : undefined,
      });
    },
    [cloudUser, logActivityEvent, refreshDbStats]
  );

  const handleRotateRoom = useCallback(async () => {
    try {
      const res = await fetch('/api/rooms', { method: 'POST' });
      const data = (await res.json()) as { roomId?: string };
      if (data.roomId) {
        sessionStorage.setItem(HOST_ROOM_STORAGE_KEY, data.roomId);
        setHostRoomId(data.roomId);
        setLinkedNodes([]);
      }
    } catch {
      const arr = new Uint8Array(4);
      crypto.getRandomValues(arr);
      const code = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
      sessionStorage.setItem(HOST_ROOM_STORAGE_KEY, code);
      setHostRoomId(code);
      setLinkedNodes([]);
    }
  }, []);

  const handleGenerateCommandReport = useCallback(async () => {
    setIsGeneratingReport(true);
    setReportError(null);
    try {
      const snapshot = {
        timestamp: new Date().toISOString(),
        cameraActive: isCameraActive,
        activeDetectionsCount: activeDetections.length,
        activeDetections: activeDetections.slice(0, 8).map((d) => ({
          label: d.fineLabel || d.displayLabel,
          classification: d.classification,
          score: Number(d.score.toFixed(2)),
        })),
        recentLogsCount: logs.length,
        sessionPositiveCount,
        sessionNegativeCount,
        linkedMobileCameras: linkedNodes.map((n) => ({
          name: n.deviceName,
          cameraActive: n.cameraActive,
          gpsActive: n.gpsActive,
          detectionsCount: n.detections.length,
        })),
        gps: geoCoords,
        weather: geoIntel?.weather ?? null,
        elevationMeters: geoIntel?.elevationMeters ?? null,
        nearbyCivilianAircraftCount: geoIntel?.aircraft.length ?? 0,
        networkRttMs,
        wsConnected,
        motionSignalPct: lastMotionPctRef.current,
        latestAnomalyScore: telemetryHistory[telemetryHistory.length - 1]?.anomalyScore ?? 0,
      };

      const res = await fetch('/api/command-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
      const data = (await res.json()) as CommandDecisionReport & { error?: string };
      if (!res.ok) {
        setReportError(data.error || 'Unable to generate AI Command Report.');
        return;
      }
      setSavedReports((prev) => [data, ...prev].slice(0, 10));
      void dbSaveReport(data).then(() => refreshDbStats());
      if (cloudUser) {
        void saveMissionReportToFirestore(cloudUser.uid, data);
      }
    } catch {
      setReportError('Network error while generating AI Command Report.');
    } finally {
      setIsGeneratingReport(false);
    }
  }, [
    isCameraActive,
    activeDetections,
    logs.length,
    sessionPositiveCount,
    sessionNegativeCount,
    linkedNodes,
    geoCoords,
    geoIntel,
    networkRttMs,
    wsConnected,
    telemetryHistory,
    refreshDbStats,
    cloudUser,
  ]);

  const handleExportDb = useCallback(async () => {
    const json = await dbExportSnapshotJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gazva-db-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleExportCsv = useCallback(async () => {
    const csv = await dbExportDetectionsCsv();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gazva-detections-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleQuickTagRule = useCallback((keyword: string, target: 'positive' | 'negative') => {
    const normalized = keyword.trim().toLowerCase();
    if (!normalized) return;
    setRules((prev) => {
      const nextPos = prev.positive.filter((k) => k.toLowerCase() !== normalized);
      const nextNeg = prev.negative.filter((k) => k.toLowerCase() !== normalized);
      if (target === 'positive') nextPos.unshift(normalized);
      else nextNeg.unshift(normalized);
      return { ...prev, positive: nextPos, negative: nextNeg };
    });
  }, []);

  const handleClearDb = useCallback(async () => {
    await dbClearStore();
    setLogs([]);
    setGeoPins([]);
    setSavedReports([]);
    await refreshDbStats();
  }, [refreshDbStats]);

  const liveCounts = useMemo(() => {
    let positive = 0;
    let negative = 0;
    for (const det of activeDetections) {
      if (det.classification === 'positive') positive += 1;
      if (det.classification === 'negative') negative += 1;
    }
    return { positive, negative };
  }, [activeDetections]);

  const mergedGeoPins = useMemo(() => {
    if (cloudWaypoints.length === 0) return geoPins;
    const seen = new Set<string>();
    const combined: GeoDetectionPin[] = [];
    for (const wp of [...geoPins, ...cloudWaypoints]) {
      if (!seen.has(wp.id)) {
        seen.add(wp.id);
        combined.push(wp);
      }
    }
    return combined.slice(0, 32);
  }, [geoPins, cloudWaypoints]);

  const studioTelemetrySummary = useMemo(() => {
    const posStr = geoCoords
      ? `GPS(${geoCoords.latitude.toFixed(5)}, ${geoCoords.longitude.toFixed(5)}, acc ±${Math.round(geoCoords.accuracy)}m)`
      : 'GPS standby';
    const weatherStr = geoIntel?.weather
      ? `Temp ${geoIntel.weather.temperatureC}°C, Wind ${geoIntel.weather.windSpeedKmh} km/h`
      : 'Weather N/A';
    return `Camera:${isCameraActive ? 'ON' : 'OFF'}; Detections:${activeDetections.length}; LinkedCams:${linkedNodes.length}; ${posStr}; ${weatherStr}; RTT:${networkRttMs ?? 'N/A'}ms`;
  }, [geoCoords, geoIntel, isCameraActive, activeDetections.length, linkedNodes.length, networkRttMs]);

  const handleGoogleSignIn = useCallback(async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Google sign-in failed.');
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const handleGoogleSignOut = useCallback(async () => {
    setAuthBusy(true);
    try {
      await signOutGoogle();
    } finally {
      setAuthBusy(false);
    }
  }, []);

  if (joinedRoomId) {
    return (
      <MobileCameraNode
        roomId={joinedRoomId}
        onExitToHost={() => {
          setJoinedRoomId(null);
          if (window.location.search.includes('join=')) {
            window.history.replaceState({}, '', window.location.pathname);
          }
        }}
      />
    );
  }

  const navItems: Array<{ id: AppPageId; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'vision', label: 'Vision AR' },
    { id: 'multicam', label: `Multi-Cam (${linkedNodes.length})` },
    { id: 'maps', label: '3D & Maps' },
    { id: 'command', label: 'Command 35' },
    { id: 'studio', label: 'AI Studio' },
    { id: 'workspace', label: 'Rules & DB' },
  ];

  const pageModuleCards = [
    {
      id: 'vision' as const,
      title: 'Vision AR & Thermal',
      subtitle: 'Live camera object detection, Thermal Delta contrast, Global Product ID',
      metric: isCameraActive ? `${fps} FPS · ${activeDetections.length} live` : 'Camera Standby',
      accent: 'from-[#0B4FE6] to-[#1D4ED8]',
      icon: Camera,
      badge: isCameraActive ? 'Active' : 'Ready',
    },
    {
      id: 'multicam' as const,
      title: 'Multi-Cam QR Hub',
      subtitle: 'Pair 5–6+ mobile phone cameras over WebSocket using instant QR scan',
      metric: `${linkedNodes.length} Linked · ${wsConnected ? 'WS Ready' : 'Connecting'}`,
      accent: 'from-[#DC2626] to-[#0B4FE6]',
      icon: QrCode,
      badge: `Room ${hostRoomId.slice(0, 4)}`,
    },
    {
      id: 'maps' as const,
      title: '3D Digital Twin & Maps',
      subtitle: 'Standalone GPS activity tracking, WebGL 3D terrain, Google Maps & Geofence',
      metric: geoCoords
        ? `${geoCoords.latitude.toFixed(3)}, ${geoCoords.longitude.toFixed(3)}`
        : `${mergedGeoPins.length} Saved Pins`,
      accent: 'from-[#0B2240] to-[#0B4FE6]',
      icon: MapPin,
      badge: geoCoords ? 'GPS Locked' : 'GPS Ready',
    },
    {
      id: 'command' as const,
      title: '35-Domain Command',
      subtitle: 'GEOINT weather, satellite ephemeris, ADS-B airspace, Cyber RTT & C2 reports',
      metric: networkRttMs !== null ? `RTT ${networkRttMs} ms · ${savedReports.length} Reports` : 'Telemetry Live',
      accent: 'from-[#0B4FE6] to-[#DC2626]',
      icon: Activity,
      badge: '35 Domains',
    },
    {
      id: 'studio' as const,
      title: 'Gemini AI Studio',
      subtitle: 'Grounded Chatbot (Maps/Search), Live 16kHz Voice Copilot, Image & Media',
      metric: `${cloudChatMessages.length} Cloud Prompts`,
      accent: 'from-[#DC2626] to-[#991B1B]',
      icon: Sparkles,
      badge: 'Multimodal',
    },
    {
      id: 'workspace' as const,
      title: 'Rules, Logs & Cloud DB',
      subtitle: 'Edit Positive/Negative watchlists, search logs, export CSV/JSON & Firestore',
      metric: `${rules.positive.length + rules.negative.length} Rules · ${logs.length} Logs`,
      accent: 'from-[#0B2240] to-[#DC2626]',
      icon: Sliders,
      badge: cloudUser ? 'Cloud Synced' : 'IndexedDB',
    },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-[#F4F7FC] dark:bg-[#080E1C] text-slate-900 dark:text-slate-100 transition-colors">
      {mapsQuotaExceeded && (
        <div className="bg-amber-50 dark:bg-amber-950/90 border-b border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm">
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 dark:text-white hover:text-amber-700"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      {/* Clean 3-Zone Top Bar (iOS + One UI Glassmorphic Header) */}
      <header className="sticky top-0 z-30 bg-white/90 dark:bg-[#0B1224]/90 backdrop-blur-xl border-b border-slate-200/80 dark:border-slate-800/80">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center justify-between gap-4">
          {/* Zone 1: Brand Mark */}
          <button
            type="button"
            onClick={() => navigateToPage('overview')}
            className="flex items-center gap-2.5 whitespace-nowrap shrink-0 cursor-pointer text-left"
          >
            {!logoFailed ? (
              <img
                src="/assets/aistudio/image_5e07311e.png"
                alt="GAZVA logo"
                referrerPolicy="no-referrer"
                onError={() => setLogoFailed(true)}
                className="w-9 h-9 rounded-2xl object-cover border border-slate-200 dark:border-slate-700 bg-white shrink-0"
              />
            ) : (
              <span className="w-9 h-9 rounded-2xl bg-gradient-to-br from-[#DC2626] to-[#0B4FE6] text-white font-bold text-sm flex items-center justify-center shrink-0">
                GV
              </span>
            )}
            <span className="text-base sm:text-lg font-extrabold tracking-tight bg-gradient-to-r from-[#0B2240] to-[#0B4FE6] dark:from-white dark:to-blue-400 bg-clip-text text-transparent">
              GAZVA Vision
            </span>
          </button>

          {/* Zone 2: Clean Single-Line Multi-Page Navigation */}
          <nav
            aria-label="Primary Page Navigation"
            className="hidden lg:flex items-center gap-1.5 text-xs xl:text-sm font-semibold"
          >
            {navItems.map((item) => {
              const isActive = activePage === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigateToPage(item.id)}
                  className={`px-3 py-2 rounded-2xl transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    isActive
                      ? 'bg-[#0B4FE6] text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/80 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Theme Toggle + Cloud Auth + Primary Camera CTA */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setIsDarkTheme((prev) => !prev)}
              aria-label={isDarkTheme ? 'Switch to light theme' : 'Switch to dark theme'}
              title={isDarkTheme ? 'Light mode' : 'Dark mode'}
              className="w-10 h-10 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 flex items-center justify-center cursor-pointer shrink-0"
            >
              {isDarkTheme ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4" />}
            </button>

            {cloudUser ? (
              <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-2xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs whitespace-nowrap shrink-0">
                <Cloud className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span className="font-semibold text-slate-800 dark:text-slate-200 max-w-[100px] truncate">
                  {cloudUser.displayName || cloudUser.email}
                </span>
                <button
                  type="button"
                  onClick={handleGoogleSignOut}
                  disabled={authBusy}
                  title="Sign out"
                  className="p-1 rounded-xl hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleGoogleSignIn}
                disabled={authBusy}
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-100 whitespace-nowrap min-h-[40px] cursor-pointer disabled:opacity-50 shrink-0"
              >
                <LogIn className="w-3.5 h-3.5 text-[#0B4FE6] dark:text-blue-400" />
                <span>Sign In</span>
              </button>
            )}

            <button
              type="button"
              onClick={isCameraActive ? handleStopCamera : handleStartCamera}
              className={`inline-flex items-center gap-2 px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-bold rounded-2xl transition-colors whitespace-nowrap shrink-0 min-h-[40px] sm:min-h-[44px] cursor-pointer shadow-sm ${
                isCameraActive
                  ? 'bg-[#DC2626] text-white hover:bg-red-700'
                  : 'bg-[#0B4FE6] text-white hover:bg-[#1D4ED8]'
              }`}
            >
              {isCameraActive ? (
                <>
                  <CameraOff className="w-4 h-4 shrink-0" />
                  <span>Stop Camera</span>
                </>
              ) : (
                <>
                  <Camera className="w-4 h-4 shrink-0" />
                  <span>Start Camera</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      {authError && (
        <div className="max-w-[1440px] w-full mx-auto px-4 sm:px-6 pt-3">
          <div className="px-4 py-2.5 rounded-2xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-200">
            {authError}
          </div>
        </div>
      )}

      {/* Main Dedicated Page Viewport */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-5 sm:py-6 pb-20 lg:pb-8 space-y-5">
        {/* Global Active Siren Banner across all pages */}
        {isSirenSounding && (
          <div
            role="alert"
            className="p-4 rounded-3xl bg-[#DC2626] text-white flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-lg"
          >
            <div className="flex items-center gap-3 min-w-0">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-bold">
                  {isTestSiren
                    ? 'Warning Siren Test Active (Full Volume)'
                    : `Negative Object Detected: ${
                        activeNegativeLabels.join(', ') || 'Restricted Item'
                      }`}
                </div>
                <div className="text-xs text-red-100 mt-0.5">
                  Siren continues sounding until you acknowledge or mute the alert.
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {!isTestSiren && latestNegativeAlert && (
                <button
                  type="button"
                  onClick={() => setInspected3DItem(latestNegativeAlert)}
                  className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-sm font-bold bg-red-950 hover:bg-black text-white rounded-2xl transition-colors whitespace-nowrap min-h-[44px] cursor-pointer"
                >
                  <Box className="w-4 h-4" />
                  <span>View 3D Alert Pic</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleAcknowledgeAlert}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-bold bg-white text-[#DC2626] hover:bg-red-50 rounded-2xl transition-colors whitespace-nowrap min-h-[44px] cursor-pointer"
              >
                <BellOff className="w-4 h-4" />
                <span>Dismiss & Stop Siren</span>
              </button>
            </div>
          </div>
        )}

        {/* PAGE 1: OVERVIEW (One UI + Pixel UI Hub) */}
        {activePage === 'overview' && (
          <div className="space-y-6">
            {/* Samsung One UI Expandable Hero Banner (Red & Blue Signature) */}
            <section className="rounded-3xl overflow-hidden bg-gradient-to-br from-[#0B2240] via-[#0B4FE6] to-[#DC2626] text-white p-6 sm:p-8 shadow-md">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                <div className="space-y-2.5 max-w-2xl">
                  <div className="text-xs font-mono uppercase tracking-wider text-blue-100">
                    One UI · iOS · Pixel Command Suite
                  </div>
                  <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
                    GAZVA Vision Guard Hub
                  </h1>
                  <p className="text-sm text-blue-100 leading-relaxed">
                    Every capability now runs on its own dedicated page — launch Live Vision AR with Thermal Delta Contrast, connect 5–6+ phone cameras via QR, track standalone 3D GPS & Google Maps, or run Gemini AI & 35-Domain telemetry.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                  <button
                    type="button"
                    onClick={isCameraActive ? () => navigateToPage('vision') : handleStartCamera}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-white text-[#0B2240] hover:bg-blue-50 text-xs sm:text-sm font-bold min-h-[44px] cursor-pointer shadow-sm"
                  >
                    <Camera className="w-4 h-4 text-[#0B4FE6]" />
                    <span>{isCameraActive ? 'Open Live Feed' : 'Launch Camera AR'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => navigateToPage('maps')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-white/15 hover:bg-white/25 border border-white/25 text-white text-xs sm:text-sm font-bold min-h-[44px] cursor-pointer"
                  >
                    <MapPin className="w-4 h-4" />
                    <span>3D GPS Map</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleTestSiren}
                    className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs sm:text-sm font-bold min-h-[44px] cursor-pointer ${
                      isSirenSounding
                        ? 'bg-red-950 text-white'
                        : 'bg-[#DC2626] hover:bg-red-700 text-white border border-red-400/40'
                    }`}
                  >
                    <BellRing className="w-4 h-4" />
                    <span>{isSirenSounding ? 'Stop Siren' : 'Test Siren'}</span>
                  </button>
                </div>
              </div>

              {/* Compact Operational Readout Bar */}
              <div className="mt-6 pt-5 border-t border-white/15 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div className="rounded-2xl bg-white/10 px-3.5 py-2.5">
                  <div className="text-blue-100">Camera & Vision</div>
                  <div className="font-mono font-bold text-sm mt-0.5 tabular-nums">
                    {isCameraActive ? `${fps} FPS · ${activeDetections.length} obj` : 'Standby'}
                  </div>
                </div>
                <div className="rounded-2xl bg-white/10 px-3.5 py-2.5">
                  <div className="text-blue-100">Linked Mobile Nodes</div>
                  <div className="font-mono font-bold text-sm mt-0.5 tabular-nums">
                    {linkedNodes.length} Connected
                  </div>
                </div>
                <div className="rounded-2xl bg-white/10 px-3.5 py-2.5">
                  <div className="text-blue-100">GPS & 3D Twin</div>
                  <div className="font-mono font-bold text-sm mt-0.5 tabular-nums">
                    {geoCoords ? `±${Math.round(geoCoords.accuracy)}m Locked` : 'Ready'}
                  </div>
                </div>
                <div className="rounded-2xl bg-white/10 px-3.5 py-2.5">
                  <div className="text-blue-100">Session Alerts</div>
                  <div className="font-mono font-bold text-sm mt-0.5 tabular-nums">
                    {sessionPositiveCount} Safe · {sessionNegativeCount} Alert
                  </div>
                </div>
              </div>
            </section>

            {/* 6 Dedicated Module Page Launchers */}
            <section aria-label="Dedicated Module Pages">
              <div className="flex items-center justify-between mb-3.5">
                <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                  Dedicated Pages & Modules
                </h2>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setVoiceAlertsEnabled((v) => !v)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-2xl border text-xs font-semibold cursor-pointer ${
                      voiceAlertsEnabled
                        ? 'bg-[#0B4FE6] text-white border-[#0B4FE6]'
                        : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    <Megaphone className="w-3.5 h-3.5" />
                    <span>{voiceAlertsEnabled ? 'Voice On' : 'Voice Off'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleToggleMute}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-2xl border text-xs font-semibold cursor-pointer ${
                      sirenMuted
                        ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-700'
                        : 'bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {sirenMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                    <span>{sirenMuted ? 'Muted' : 'Siren Armed'}</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {pageModuleCards.map((card) => {
                  const Icon = card.icon;
                  return (
                    <button
                      key={card.id}
                      type="button"
                      onClick={() => navigateToPage(card.id)}
                      className="group text-left bg-white dark:bg-[#0F172A] border border-slate-200/90 dark:border-slate-800 hover:border-[#0B4FE6] dark:hover:border-blue-500 rounded-3xl p-5 shadow-sm hover:shadow-md transition-all cursor-pointer flex flex-col justify-between gap-4"
                    >
                      <div className="space-y-3">
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`w-11 h-11 rounded-2xl bg-gradient-to-br ${card.accent} text-white flex items-center justify-center shrink-0`}
                          >
                            <Icon className="w-5 h-5" />
                          </span>
                          <span className="text-[11px] font-mono font-bold px-2.5 py-1 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                            {card.badge}
                          </span>
                        </div>
                        <div>
                          <h3 className="text-base font-bold text-slate-900 dark:text-white group-hover:text-[#0B4FE6] dark:group-hover:text-blue-400 transition-colors">
                            {card.title}
                          </h3>
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                            {card.subtitle}
                          </p>
                        </div>
                      </div>

                      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs">
                        <span className="font-mono font-semibold text-slate-700 dark:text-slate-300 tabular-nums truncate">
                          {card.metric}
                        </span>
                        <span className="inline-flex items-center gap-1 font-bold text-[#0B4FE6] dark:text-blue-400 shrink-0">
                          <span>Open</span>
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {/* PAGE 2: VISION & AR PAGE (Kept mounted so camera & siren detection remain live across page switches) */}
        <section className={activePage === 'vision' ? 'space-y-5' : 'hidden'}>
          <div className="bg-white dark:bg-[#0F172A] border border-slate-200/90 dark:border-slate-800 rounded-3xl p-4 sm:p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h1 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                  Real-Time Vision AR & Thermal Analysis
                </h1>
                <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                  Sub-second frame classification · Standard AR, Motion Blue & Thermal Delta Contrast
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleTestSiren}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-2xl border transition-colors whitespace-nowrap min-h-[40px] cursor-pointer ${
                    isSirenSounding
                      ? 'bg-[#DC2626] text-white border-[#DC2626] hover:bg-red-700'
                      : 'bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  <BellRing className="w-4 h-4" />
                  <span>{isSirenSounding ? 'Stop Siren' : 'Test Siren'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setVoiceAlertsEnabled((v) => !v)}
                  aria-pressed={voiceAlertsEnabled}
                  className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-2xl border transition-colors whitespace-nowrap min-h-[40px] cursor-pointer ${
                    voiceAlertsEnabled
                      ? 'bg-[#0B4FE6] text-white border-[#0B4FE6]'
                      : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                  }`}
                >
                  <Megaphone className="w-4 h-4" />
                  <span>{voiceAlertsEnabled ? 'Voice On' : 'Voice Off'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleToggleMute}
                  aria-pressed={sirenMuted}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-2xl border transition-colors whitespace-nowrap min-h-[40px] cursor-pointer ${
                    sirenMuted
                      ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-700'
                      : 'bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  {sirenMuted ? (
                    <>
                      <VolumeX className="w-4 h-4" />
                      <span>Muted</span>
                    </>
                  ) : (
                    <>
                      <Volume2 className="w-4 h-4" />
                      <span>Siren Armed</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setWorkspaceFocusTab('rules');
                    navigateToPage('workspace');
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-2xl bg-slate-100 dark:bg-slate-800 hover:bg-[#0B4FE6] hover:text-white text-slate-800 dark:text-slate-200 min-h-[40px] cursor-pointer transition-colors"
                >
                  <Sliders className="w-3.5 h-3.5" />
                  <span>Edit Rules</span>
                </button>
              </div>
            </div>

            <CameraMonitor
              rules={rules}
              isCameraActive={isCameraActive}
              isSirenSounding={isSirenSounding}
              sirenMuted={sirenMuted}
              activeNegativeLabels={activeNegativeLabels}
              lastLatencyMs={lastLatencyMs}
              onStartCamera={handleStartCamera}
              onStopCamera={handleStopCamera}
              onAcknowledgeAlert={handleAcknowledgeAlert}
              onToggleMute={handleToggleMute}
              onFrameResult={handleFrameResult}
              onGlobalProductsResult={handleGlobalProductsResult}
            />
          </div>

          {/* 4-Column Pixel KPI Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
            <div className="bg-white dark:bg-[#0F172A] border border-slate-200/90 dark:border-slate-800 rounded-3xl p-4">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Detection Speed</div>
              <div
                className={`text-2xl font-mono font-bold tabular-nums mt-1 ${
                  lastLatencyMs === null
                    ? 'text-slate-900 dark:text-white'
                    : lastLatencyMs < 1000
                    ? 'text-[#0B4FE6] dark:text-blue-400'
                    : 'text-[#DC2626] dark:text-red-400'
                }`}
              >
                {lastLatencyMs !== null ? `${Math.round(lastLatencyMs)} ms` : '—'}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-1">
                {avgLatencyMs !== null
                  ? `Avg ${Math.round(avgLatencyMs)} ms · ${fps} fps`
                  : 'Target < 1,000 ms'}
              </div>
            </div>

            <div className="bg-white dark:bg-[#0F172A] border border-slate-200/90 dark:border-slate-800 rounded-3xl p-4">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">In Current Frame</div>
              <div className="text-2xl font-mono font-bold tabular-nums text-slate-900 dark:text-white mt-1">
                {activeDetections.length}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                {liveCounts.positive} Safe · {liveCounts.negative} Alert
              </div>
            </div>

            <div className="bg-white dark:bg-[#0F172A] border border-slate-200/90 dark:border-slate-800 rounded-3xl p-4">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Positive Logged</div>
              <div className="text-2xl font-mono font-bold tabular-nums text-emerald-600 dark:text-emerald-400 mt-1">
                {sessionPositiveCount}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">Green / Blue safe highlight</div>
            </div>

            <div className="bg-white dark:bg-[#0F172A] border border-slate-200/90 dark:border-slate-800 rounded-3xl p-4">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Negative Alerts</div>
              <div className="text-2xl font-mono font-bold tabular-nums text-[#DC2626] dark:text-red-400 mt-1">
                {sessionNegativeCount}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">Crimson warning + siren</div>
            </div>
          </div>

          {/* Live Objects Breakdown */}
          <div className="bg-white dark:bg-[#0F172A] border border-slate-200/90 dark:border-slate-800 rounded-3xl p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                Live Frame Classifications
              </h2>
              <span className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                {activeDetections.length} visible
              </span>
            </div>

            {activeDetections.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400 py-2">
                No objects currently detected above {Math.round(rules.confidenceThreshold * 100)}%
                confidence.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
                {activeDetections.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-white dark:bg-slate-950/60"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {item.classification === 'negative' ? (
                        <ShieldAlert className="w-4 h-4 text-[#DC2626] shrink-0" />
                      ) : item.classification === 'positive' ? (
                        <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4 text-slate-400 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                          {item.trackId ? `${item.trackId} · ` : ''}
                          {item.fineLabel || item.displayLabel}
                        </div>
                        {(item.fineLabel && item.fineLabel !== item.displayLabel) ||
                        typeof item.velocityPxPerSec === 'number' ? (
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate font-mono tabular-nums">
                            {item.fineLabel && item.fineLabel !== item.displayLabel
                              ? `Base: ${item.displayLabel}`
                              : ''}
                            {typeof item.velocityPxPerSec === 'number'
                              ? `${item.fineLabel ? ' · ' : ''}Vel ${item.velocityPxPerSec} px/s`
                              : ''}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 shrink-0 text-xs font-mono tabular-nums">
                      <span className="text-slate-500 dark:text-slate-400">
                        {Math.round(item.score * 100)}%
                      </span>
                      <span
                        className={`font-bold uppercase ${
                          item.classification === 'negative'
                            ? 'text-[#DC2626] dark:text-red-400'
                            : item.classification === 'positive'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {item.classification}
                      </span>
                      {item.classification !== 'positive' && (
                        <button
                          type="button"
                          onClick={() => handleQuickTagRule(item.rawClass, 'positive')}
                          title={`Mark "${item.rawClass}" as Safe (Positive)`}
                          className="px-2 py-1 rounded-xl border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-600 hover:text-white text-[10px] font-sans font-semibold text-emerald-700 dark:text-emerald-300 transition-colors cursor-pointer"
                        >
                          +Safe
                        </button>
                      )}
                      {item.classification !== 'negative' && (
                        <button
                          type="button"
                          onClick={() => handleQuickTagRule(item.rawClass, 'negative')}
                          title={`Mark "${item.rawClass}" as Alert (Negative + Siren)`}
                          className="px-2 py-1 rounded-xl border border-red-200 dark:border-red-800/60 bg-red-50 dark:bg-red-950/40 hover:bg-[#DC2626] hover:text-white text-[10px] font-sans font-semibold text-[#DC2626] dark:text-red-300 transition-colors cursor-pointer"
                        >
                          +Alert
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setInspected3DItem({
                            id: item.id,
                            label: item.fineLabel || item.displayLabel,
                            classification: item.classification,
                            score: item.score,
                            thumbnailUrl: item.thumbnailUrl,
                            latitude: geoCoords?.latitude,
                            longitude: geoCoords?.longitude,
                            timestamp: Date.now(),
                          })
                        }
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-[#0B4FE6] hover:text-white text-[11px] font-sans font-semibold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
                      >
                        <Box className="w-3 h-3" />
                        <span>3D Pic</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {globalProducts.length > 0 && (
              <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  <Globe className="w-4 h-4 text-[#0B4FE6] dark:text-blue-400" />
                  <span>Identified Worldwide Products & Brands</span>
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
                  {globalProducts.map((gp) => (
                    <div
                      key={gp.id}
                      className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-white dark:bg-slate-950/60"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                          {gp.productName}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                          {gp.brand} · {gp.category}
                        </div>
                      </div>
                      <div className="flex items-center gap-2.5 shrink-0">
                        <span
                          className={`text-xs font-mono font-bold uppercase ${
                            gp.classification === 'negative'
                              ? 'text-[#DC2626] dark:text-red-400'
                              : gp.classification === 'positive'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          {gp.classification}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setInspected3DItem({
                              id: gp.id,
                              label: gp.productName,
                              classification: gp.classification,
                              score: gp.confidence,
                              thumbnailUrl: gp.thumbnailUrl,
                              latitude: geoCoords?.latitude,
                              longitude: geoCoords?.longitude,
                              timestamp: Date.now(),
                            })
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-[#0B4FE6] hover:text-white text-[11px] font-semibold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
                        >
                          <Box className="w-3 h-3" />
                          <span>3D Pic</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* PAGE 3: MULTI-CAM QR HUB */}
        {activePage === 'multicam' && (
          <div className="space-y-4">
            <MultiCameraHub
              roomId={hostRoomId}
              wsConnected={wsConnected}
              linkedNodes={linkedNodes}
              onRotateRoom={handleRotateRoom}
              onOpenQrScanner={() => setIsQrScannerOpen(true)}
              onJoinSelfAsMobile={() => setJoinedRoomId(hostRoomId)}
              onInspect3D={setInspected3DItem}
            />
          </div>
        )}

        {/* PAGE 4: 3D GPS & GOOGLE MAPS (Kept mounted so GPS watchPosition & trail stay continuous across pages) */}
        <div className={activePage === 'maps' ? 'block' : 'hidden'}>
          <GeoTracker
            coords={geoCoords}
            onUpdateCoords={setGeoCoords}
            pins={mergedGeoPins}
            linkedNodes={linkedNodes}
            aircraft={geoIntel?.aircraft ?? []}
            satellite={geoIntel?.satellite ?? null}
            simulation={simulation}
            initialTrail={initialDbTrail}
            onSaveTrailPoint={(pt) => {
              void dbSaveTrailPoint(pt).then(() => refreshDbStats());
            }}
            activityEvents={activityEvents}
            onLogActivityEvent={logActivityEvent}
            onAddManualPin={handleAddManualGeoPin}
            onClearPins={() => {
              setGeoPins([]);
              void dbClearStore('waypoints').then(() => refreshDbStats());
            }}
            onInspect3D={setInspected3DItem}
          />
        </div>

        {/* PAGE 5: 35-DOMAIN COMMAND CENTER */}
        {activePage === 'command' && (
          <CommandAnalyticsCenter
            coords={geoCoords}
            geoIntel={geoIntel}
            geoIntelLoading={geoIntelLoading}
            onRefreshGeoIntel={() => {
              if (geoCoords) {
                void fetchGeoIntelligence(geoCoords.latitude, geoCoords.longitude);
              }
            }}
            telemetryHistory={telemetryHistory}
            networkRttMs={networkRttMs}
            wsConnected={wsConnected}
            roomId={hostRoomId}
            linkedNodes={linkedNodes}
            activeDetections={activeDetections}
            logs={logs}
            sessionNegativeCount={sessionNegativeCount}
            isCameraActive={isCameraActive}
            savedReports={savedReports}
            onGenerateReport={handleGenerateCommandReport}
            isGeneratingReport={isGeneratingReport}
            reportError={reportError}
            onClearReports={() => {
              setSavedReports([]);
              void dbClearStore('reports').then(() => refreshDbStats());
            }}
            securityStatus={securityStatus}
            dbStats={dbStats}
            onExportDb={handleExportDb}
            onExportCsv={handleExportCsv}
            onClearDb={handleClearDb}
            simulation={simulation}
            onToggleSimulation={() =>
              setSimulation((prev) => ({ ...prev, running: !prev.running }))
            }
            onResetSimulation={() =>
              setSimulation((prev) => ({
                ...INITIAL_SIMULATION,
                scenario: prev.scenario,
              }))
            }
            onChangeSimulationScenario={(scenario: SimulationScenario) =>
              setSimulation((prev) => ({
                ...INITIAL_SIMULATION,
                scenario,
                running: prev.running,
              }))
            }
            onJumpToModule={(target) => {
              if (target === 'camera') navigateToPage('vision');
              else if (target === 'multi-cam') navigateToPage('multicam');
              else if (target === 'gps-3d') navigateToPage('maps');
              else if (target === 'rules') {
                setWorkspaceFocusTab('rules');
                navigateToPage('workspace');
              } else if (target === 'detections') {
                setWorkspaceFocusTab('detections');
                navigateToPage('workspace');
              }
            }}
          />
        )}

        {/* PAGE 6: GEMINI AI STUDIO */}
        {activePage === 'studio' && (
          <GeminiStudioCenter
            coords={geoCoords}
            telemetrySummary={studioTelemetrySummary}
            userUid={cloudUser?.uid ?? null}
            cloudMessages={cloudChatMessages}
            onSaveChatMessage={(msg) => {
              if (cloudUser) {
                void saveChatMessageToFirestore(cloudUser.uid, msg);
              }
            }}
            onLogAiSession={(title, summary, modelUsed) => {
              if (cloudUser) {
                void saveAiSessionLogToFirestore(cloudUser.uid, title, summary, modelUsed);
              }
            }}
          />
        )}

        {/* PAGE 7: RULES, SEARCHABLE DETECTIONS & CLOUD DATABASE WORKSPACE */}
        {activePage === 'workspace' && (
          <div className="space-y-5">
            {/* Workspace Control Header */}
            <div className="bg-white dark:bg-[#0F172A] border border-slate-200/90 dark:border-slate-800 rounded-3xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                  Rules, Detections & Cloud Workspace
                </h1>
                <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
                  Manage Positive/Negative labels, search history logs, export CSV/JSON, and sync Firestore data
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl text-xs font-semibold">
                  {(
                    [
                      { id: 'all', label: 'Split View' },
                      { id: 'rules', label: 'Rules Only' },
                      { id: 'detections', label: 'Logs Only' },
                    ] as const
                  ).map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      onClick={() => setWorkspaceFocusTab(mode.id)}
                      className={`px-3 py-1.5 rounded-xl cursor-pointer transition-colors ${
                        workspaceFocusTab === mode.id
                          ? 'bg-[#0B4FE6] text-white'
                          : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => void handleExportCsv()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-100 rounded-2xl cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-[#0B4FE6]" />
                  <span>Export CSV</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleExportDb()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-100 rounded-2xl cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-[#0B4FE6]" />
                  <span>Export JSON</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleClearDb()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white dark:bg-slate-900 border border-red-200 dark:border-red-800/60 hover:bg-red-50 dark:hover:bg-red-950/40 text-[#DC2626] dark:text-red-400 rounded-2xl cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Purge Local DB</span>
                </button>
              </div>
            </div>

            <div
              className={`grid grid-cols-1 gap-5 items-start ${
                workspaceFocusTab === 'all' ? 'lg:grid-cols-12' : ''
              }`}
            >
              {workspaceFocusTab !== 'detections' && (
                <div
                  className={`bg-white dark:bg-[#0F172A] border border-slate-200/90 dark:border-slate-800 rounded-3xl p-4 sm:p-5 ${
                    workspaceFocusTab === 'all' ? 'lg:col-span-6' : ''
                  }`}
                >
                  <RulesPanel rules={rules} onChangeRules={setRules} />
                </div>
              )}

              {workspaceFocusTab !== 'rules' && (
                <div
                  className={`bg-white dark:bg-[#0F172A] border border-slate-200/90 dark:border-slate-800 rounded-3xl p-4 sm:p-5 ${
                    workspaceFocusTab === 'all' ? 'lg:col-span-6' : ''
                  }`}
                >
                  <DetectionsLog
                    logs={logs}
                    onClearLogs={() => setLogs([])}
                    onInspect3D={setInspected3DItem}
                  />
                </div>
              )}
            </div>

            {cloudUser ? (
              <div className="bg-white dark:bg-[#0F172A] border border-slate-200/90 dark:border-slate-800 rounded-3xl p-4 sm:p-5">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                    <Cloud className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    <span>Firestore Synced Workspace Activity ({cloudMissions.length})</span>
                  </div>
                  <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                    {cloudUser.email}
                  </span>
                </div>
                {cloudMissions.length === 0 ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Signed in. Generated Command Reports, GPS waypoints, and AI prompts sync automatically.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-2xl max-h-56 overflow-y-auto">
                    {cloudMissions.slice(0, 8).map((m) => (
                      <div key={m.id} className="px-3.5 py-2.5 text-xs flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-900 dark:text-white truncate">{m.title}</div>
                          <div className="text-slate-600 dark:text-slate-400 line-clamp-1">{m.summary}</div>
                        </div>
                        <span className="font-mono text-[10px] text-slate-400 shrink-0">
                          {m.modelUsed || m.kind}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-white dark:bg-[#0F172A] border border-slate-200/90 dark:border-slate-800 rounded-3xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-bold text-slate-900 dark:text-white">
                    Cloud Workspace Backup (Firestore)
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Sign in with Google to synchronize waypoints, AI Copilot prompts, and C2 reports across devices.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleGoogleSignIn}
                  disabled={authBusy}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-[#0B4FE6] hover:bg-[#1D4ED8] text-white text-xs font-bold min-h-[42px] cursor-pointer disabled:opacity-50"
                >
                  <LogIn className="w-4 h-4" />
                  <span>Sign In with Google</span>
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Mobile iOS + One UI More Drawer */}
      {mobileMoreOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-slate-950/55 backdrop-blur-xs flex items-end"
          onClick={() => setMobileMoreOpen(false)}
        >
          <div
            className="w-full bg-white dark:bg-[#0F172A] rounded-t-3xl border-t border-slate-200 dark:border-slate-800 p-5 pb-20 space-y-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="text-sm font-bold text-slate-900 dark:text-white">
                More Pages & Controls
              </div>
              <button
                type="button"
                onClick={() => setMobileMoreOpen(false)}
                aria-label="Close menu"
                className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2.5 text-xs font-semibold">
              <button
                type="button"
                onClick={() => navigateToPage('command')}
                className={`p-3 rounded-2xl border flex flex-col items-center gap-1.5 cursor-pointer ${
                  activePage === 'command'
                    ? 'bg-[#0B4FE6] text-white border-[#0B4FE6]'
                    : 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200'
                }`}
              >
                <Activity className="w-5 h-5" />
                <span>Command 35</span>
              </button>
              <button
                type="button"
                onClick={() => navigateToPage('studio')}
                className={`p-3 rounded-2xl border flex flex-col items-center gap-1.5 cursor-pointer ${
                  activePage === 'studio'
                    ? 'bg-[#0B4FE6] text-white border-[#0B4FE6]'
                    : 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200'
                }`}
              >
                <Sparkles className="w-5 h-5" />
                <span>AI Studio</span>
              </button>
              <button
                type="button"
                onClick={() => navigateToPage('workspace')}
                className={`p-3 rounded-2xl border flex flex-col items-center gap-1.5 cursor-pointer ${
                  activePage === 'workspace'
                    ? 'bg-[#0B4FE6] text-white border-[#0B4FE6]'
                    : 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200'
                }`}
              >
                <Layers className="w-5 h-5" />
                <span>Rules & DB</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5 text-xs font-semibold">
              <button
                type="button"
                onClick={handleTestSiren}
                className="py-3 px-3 rounded-2xl bg-[#DC2626] text-white flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <BellRing className="w-4 h-4" />
                <span>{isSirenSounding ? 'Stop Siren' : 'Test Siren'}</span>
              </button>
              {cloudUser ? (
                <button
                  type="button"
                  onClick={handleGoogleSignOut}
                  className="py-3 px-3 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Sign Out</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleGoogleSignIn}
                  className="py-3 px-3 rounded-2xl bg-[#0B4FE6] text-white flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <LogIn className="w-4 h-4" />
                  <span>Sign In</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Mobile One UI + iOS Fixed Bottom Thumb Dock */}
      <nav
        aria-label="Mobile Page Navigation"
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 h-14 bg-white/95 dark:bg-[#0B1224]/95 backdrop-blur-xl border-t border-slate-200 dark:border-slate-800 px-2 grid grid-cols-5 items-center"
      >
        {(
          [
            { id: 'overview', label: 'Home', icon: Home },
            { id: 'vision', label: 'Vision', icon: Camera },
            { id: 'multicam', label: 'QR Hub', icon: QrCode },
            { id: 'maps', label: '3D Map', icon: MapPin },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const active = activePage === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => navigateToPage(tab.id)}
              className={`h-11 rounded-xl flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold cursor-pointer ${
                active
                  ? 'text-[#0B4FE6] dark:text-blue-400'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => setMobileMoreOpen((o) => !o)}
          className={`h-11 rounded-xl flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold cursor-pointer ${
            activePage === 'command' || activePage === 'studio' || activePage === 'workspace' || mobileMoreOpen
              ? 'text-[#DC2626] dark:text-red-400'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          <Menu className="w-4 h-4" />
          <span>More</span>
        </button>
      </nav>

      <Alert3DModal
        item={inspected3DItem}
        coords={geoCoords}
        onClose={() => setInspected3DItem(null)}
      />

      <QrScannerModal
        isOpen={isQrScannerOpen}
        onClose={() => setIsQrScannerOpen(false)}
        onDetectedRoom={(room) => {
          setIsQrScannerOpen(false);
          setJoinedRoomId(room);
        }}
      />
    </div>
  );
}
