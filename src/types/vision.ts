export type Classification = 'positive' | 'negative' | 'neutral';

export interface DetectedItem {
  id: string;
  trackId?: string;
  velocityPxPerSec?: number;
  dwellMs?: number;
  trail?: Array<[number, number]>;
  rawClass: string;
  displayLabel: string;
  fineLabel?: string;
  score: number;
  bbox: [number, number, number, number];
  classification: Classification;
  thumbnailUrl?: string;
}

export interface GlobalProductItem {
  id: string;
  productName: string;
  brand: string;
  category: string;
  confidence: number;
  classification: Classification;
  box_2d?: [number, number, number, number];
  thumbnailUrl?: string;
}

export interface DetectionLogEntry {
  id: string;
  timestamp: number;
  label: string;
  rawClass: string;
  score: number;
  classification: Classification;
  latencyMs: number;
  source?: 'local' | 'global';
  thumbnailUrl?: string;
}

export interface VisionRules {
  positive: string[];
  negative: string[];
  confidenceThreshold: number;
  unlistedMode: Classification;
}

export interface RulePreset {
  id: string;
  name: string;
  description: string;
  positive: string[];
  negative: string[];
}

export interface GeoCoordinates {
  latitude: number;
  longitude: number;
  accuracy: number;
  heading: number | null;
  speed: number | null;
  updatedAt: number;
}

export interface GeoDetectionPin {
  id: string;
  label: string;
  classification: Classification;
  score: number;
  gridX: number; // 0-100 percentage on CSS map grid
  gridY: number; // 0-100 percentage on CSS map grid
  latitude?: number;
  longitude?: number;
  timestamp: number;
  thumbnailUrl?: string;
  isManualWaypoint?: boolean;
  sourceDevice?: string;
}

export interface GeoActivityPoint {
  latitude: number;
  longitude: number;
  accuracy: number;
  speed: number | null;
  heading: number | null;
  timestamp: number;
  sourceLabel: string;
}

export interface GeoActivityEvent {
  id: string;
  timestamp: number;
  type: 'gps_lock' | 'movement' | 'waypoint' | 'remote_node' | 'alert';
  message: string;
  distanceMeters?: number;
  coords?: {
    latitude: number;
    longitude: number;
  };
}

export interface LinkedCameraNode {
  nodeId: string;
  deviceName: string;
  connectedAt: number;
  lastSeen: number;
  cameraActive: boolean;
  gpsActive: boolean;
  coords: GeoCoordinates | null;
  previewFrameUrl?: string;
  detections: DetectedItem[];
  fps: number;
  latencyMs: number | null;
}

export interface NearbyAircraft {
  icao24: string;
  callsign: string;
  originCountry: string;
  latitude: number;
  longitude: number;
  altitudeMeters: number;
  velocityKmh: number;
  heading: number;
}

export interface WeatherForecastSlot {
  time: string;
  temperatureC: number;
  precipProb: number;
  windKmh: number;
}

export interface SatelliteTelemetry {
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
}

export interface GeoIntelligenceData {
  fetchedAt: number;
  elevationMeters: number | null;
  weather: {
    temperatureC: number;
    humidityPct: number;
    windSpeedKmh: number;
    windDirectionDeg: number;
    pressureHpa: number;
    cloudCoverPct: number;
    weatherCode: number;
    shortwaveRadiationWm2?: number | null;
    directRadiationWm2?: number | null;
  } | null;
  forecast: WeatherForecastSlot[];
  aircraft: NearbyAircraft[];
  airspaceNote?: string;
  satellite?: SatelliteTelemetry | null;
  satelliteNote?: string;
}

export interface TelemetrySample {
  timestamp: number;
  edgeLatencyMs: number;
  networkRttMs: number;
  motionPct: number;
  detectionCount: number;
  anomalyScore: number;
}

export interface CommandDecisionReport {
  id: string;
  generatedAt: number;
  overallRiskLevel: 'LOW' | 'MODERATE' | 'HIGH';
  executiveBrief: string;
  sensorFusionInsights: string[];
  predictiveForecast: string;
  cyberNetworkHealth: string;
  recommendedActions: string[];
}

export interface ServerSecurityStatus {
  ok: boolean;
  uptimeSeconds: number;
  activeRooms: number;
  connectedPeers: number;
  wsMaxPayloadBytes: number;
  geminiConfigured: boolean;
  apiKeysIsolatedServerSide: boolean;
}

export type SimulationScenario = 'patrol' | 'airspace' | 'perimeter_drill';

export interface SimulationSnapshot {
  running: boolean;
  scenario: SimulationScenario;
  step: number;
  simulatedUnitOffsetM: { east: number; north: number; speedKmh: number };
  simulatedAircraft: Array<{
    id: string;
    callsign: string;
    eastMeters: number;
    northMeters: number;
    altitudeMeters: number;
    headingDeg: number;
    speedKmh: number;
  }>;
  simulatedTrail: Array<{ eastMeters: number; northMeters: number }>;
  advisory: string;
}

export interface DatabaseStats {
  backend: 'IndexedDB' | 'Memory Fallback';
  detectionsCount: number;
  waypointsCount: number;
  reportsCount: number;
  trailCount: number;
  lastUpdatedAt: number | null;
}
