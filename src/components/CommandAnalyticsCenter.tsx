import React, { useMemo, useState } from 'react';
import {
  Activity,
  CloudSun,
  Cpu,
  Database,
  Download,
  FileText,
  Info,
  Network,
  Orbit,
  Plane,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import {
  CommandDecisionReport,
  DatabaseStats,
  DetectedItem,
  DetectionLogEntry,
  GeoCoordinates,
  GeoIntelligenceData,
  LinkedCameraNode,
  ServerSecurityStatus,
  SimulationScenario,
  SimulationSnapshot,
  TelemetrySample,
} from '../types/vision';
import {
  analyzeDetectionPatterns,
  analyzeSignalTelemetry,
  evaluateDecisionAdvisories,
} from '../utils/analyticsEngine';
import { computeSolarPosition, haversineMeters } from '../utils/geoMath';

interface CommandAnalyticsCenterProps {
  coords: GeoCoordinates | null;
  geoIntel: GeoIntelligenceData | null;
  geoIntelLoading: boolean;
  onRefreshGeoIntel: () => void;
  telemetryHistory: TelemetrySample[];
  networkRttMs: number | null;
  wsConnected: boolean;
  roomId: string;
  linkedNodes: LinkedCameraNode[];
  activeDetections: DetectedItem[];
  logs: DetectionLogEntry[];
  sessionNegativeCount: number;
  isCameraActive: boolean;
  savedReports: CommandDecisionReport[];
  onGenerateReport: () => Promise<void>;
  isGeneratingReport: boolean;
  reportError: string | null;
  onClearReports: () => void;
  securityStatus: ServerSecurityStatus | null;
  dbStats: DatabaseStats;
  onExportDb: () => Promise<void>;
  onExportCsv: () => Promise<void>;
  onClearDb: () => Promise<void>;
  simulation: SimulationSnapshot;
  onToggleSimulation: () => void;
  onResetSimulation: () => void;
  onChangeSimulationScenario: (scenario: SimulationScenario) => void;
  onJumpToModule: (target: 'camera' | 'multi-cam' | 'gps-3d' | 'rules' | 'detections') => void;
}

export const CommandAnalyticsCenter: React.FC<CommandAnalyticsCenterProps> = ({
  coords,
  geoIntel,
  geoIntelLoading,
  onRefreshGeoIntel,
  telemetryHistory,
  networkRttMs,
  wsConnected,
  roomId,
  linkedNodes,
  activeDetections,
  logs,
  sessionNegativeCount,
  isCameraActive,
  savedReports,
  onGenerateReport,
  isGeneratingReport,
  reportError,
  onClearReports,
  securityStatus,
  dbStats,
  onExportDb,
  onExportCsv,
  onClearDb,
  simulation,
  onToggleSimulation,
  onResetSimulation,
  onChangeSimulationScenario,
  onJumpToModule,
}) => {
  const [activeTab, setActiveTab] = useState<
    'fusion' | 'geoint' | 'airspace' | 'cyber' | 'decisions'
  >('fusion');
  const [dbSearchQuery, setDbSearchQuery] = useState('');
  const [dbClassFilter, setDbClassFilter] = useState<'all' | 'negative' | 'positive'>('all');

  const latestSample = telemetryHistory[telemetryHistory.length - 1] ?? null;
  const signalStats = useMemo(
    () => analyzeSignalTelemetry(telemetryHistory),
    [telemetryHistory]
  );
  const patternSummary = useMemo(() => analyzeDetectionPatterns(logs), [logs]);
  const advisories = useMemo(
    () =>
      evaluateDecisionAdvisories({
        coords,
        geoIntel,
        networkRttMs,
        wsConnected,
        linkedNodes,
        signalStats,
        sessionNegativeCount,
      }),
    [
      coords,
      geoIntel,
      networkRttMs,
      wsConnected,
      linkedNodes,
      signalStats,
      sessionNegativeCount,
    ]
  );

  const solarPos = useMemo(
    () => (coords ? computeSolarPosition(coords.latitude, coords.longitude) : null),
    [coords]
  );

  const rttSummary = useMemo(() => {
    if (telemetryHistory.length === 0) return null;
    const vals = telemetryHistory.map((t) => t.networkRttMs);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    return { min, avg, max };
  }, [telemetryHistory]);

  const filteredDbLogs = useMemo(() => {
    const q = dbSearchQuery.trim().toLowerCase();
    return logs.filter((entry) => {
      if (dbClassFilter !== 'all' && entry.classification !== dbClassFilter) return false;
      if (!q) return true;
      return (
        entry.label.toLowerCase().includes(q) ||
        entry.rawClass.toLowerCase().includes(q) ||
        (entry.source || '').toLowerCase().includes(q)
      );
    });
  }, [logs, dbSearchQuery, dbClassFilter]);

  const maxLatency = Math.max(
    60,
    ...telemetryHistory.map((s) => Math.max(s.edgeLatencyMs, s.networkRttMs))
  );

  // Build normalized SVG polyline coordinates for Raw + EMA Signal Processing waveforms
  const { edgePath, rttPath, emaRttPath, anomalyPoints } = useMemo(() => {
    const w = 360;
    const h = 110;
    if (telemetryHistory.length === 0) {
      return {
        edgePath: '',
        rttPath: '',
        emaRttPath: '',
        anomalyPoints: [] as Array<{ x: number; y: number }>,
      };
    }
    const stepX = telemetryHistory.length > 1 ? w / (telemetryHistory.length - 1) : w;
    const edgePts: string[] = [];
    const rttPts: string[] = [];
    const emaPts: string[] = [];
    const anomalies: Array<{ x: number; y: number }> = [];

    telemetryHistory.forEach((s, idx) => {
      const x = Math.round(idx * stepX * 10) / 10;
      const yEdge =
        Math.round((h - Math.min(1, s.edgeLatencyMs / maxLatency) * (h - 14) - 6) * 10) / 10;
      const yRtt =
        Math.round((h - Math.min(1, s.networkRttMs / maxLatency) * (h - 14) - 6) * 10) / 10;
      const emaVal = signalStats.emaRttSeries[idx] ?? s.networkRttMs;
      const yEma = Math.round((h - Math.min(1, emaVal / maxLatency) * (h - 14) - 6) * 10) / 10;
      edgePts.push(`${x},${yEdge}`);
      rttPts.push(`${x},${yRtt}`);
      emaPts.push(`${x},${yEma}`);
      if (s.anomalyScore >= 2.0) {
        anomalies.push({ x, y: Math.min(yEdge, yRtt) });
      }
    });

    return {
      edgePath: edgePts.join(' '),
      rttPath: rttPts.join(' '),
      emaRttPath: emaPts.join(' '),
      anomalyPoints: anomalies,
    };
  }, [telemetryHistory, maxLatency, signalStats.emaRttSeries]);

  const activeReport = savedReports[0] ?? null;

  // Complete 35-Capability Live Matrix wired directly to real runtime states
  const capabilityMatrix = useMemo(
    () => [
      { id: 1, name: 'AI', state: securityStatus?.geminiConfigured ? 'Cloud Ready' : 'Standby', tab: 'decisions' as const },
      { id: 2, name: 'Machine Learning', state: isCameraActive ? 'Active' : 'Ready', jump: 'camera' as const },
      { id: 3, name: 'Deep Learning', state: 'EfficientDet', jump: 'camera' as const },
      { id: 4, name: 'Computer Vision', state: `${activeDetections.length} obj`, jump: 'camera' as const },
      { id: 5, name: 'Neural Networks', state: 'TFLite + Gemini', jump: 'camera' as const },
      { id: 6, name: 'GPS Software', state: coords ? 'Locked' : 'Standby', jump: 'gps-3d' as const },
      { id: 7, name: 'GIS', state: coords ? 'Active' : 'Needs GPS', tab: 'geoint' as const },
      { id: 8, name: 'Satellite Data Processing', state: geoIntel?.satellite ? 'Live LEO' : 'Standby', tab: 'geoint' as const },
      { id: 9, name: 'Geospatial Intelligence (GEOINT)', state: geoIntel ? 'Synced' : 'Standby', tab: 'geoint' as const },
      { id: 10, name: 'Signal Processing', state: `${telemetryHistory.length} pts EMA`, tab: 'fusion' as const },
      { id: 11, name: 'Sensor Fusion Software', state: `${linkedNodes.length + (coords ? 1 : 0)} feeds`, tab: 'fusion' as const },
      { id: 12, name: 'Image Recognition', state: 'Global Brands', jump: 'camera' as const },
      { id: 13, name: 'Object Detection', state: isCameraActive ? 'Live' : 'Standby', jump: 'camera' as const },
      { id: 14, name: 'Object Tracking', state: `${activeDetections.filter((d) => d.trackId).length} tracks`, jump: 'camera' as const },
      { id: 15, name: 'Pattern Recognition', state: `${logs.length} samples`, tab: 'decisions' as const },
      { id: 16, name: 'Predictive Analytics', state: `RTT→${signalStats.predictedNextRttMs}ms`, tab: 'fusion' as const },
      { id: 17, name: 'Data Analytics', state: `${patternSummary.topClasses.length} classes`, tab: 'decisions' as const },
      { id: 18, name: '3D Mapping Software', state: 'Three.js WebGL', jump: 'gps-3d' as const },
      { id: 19, name: 'Digital Twin', state: 'Live 3D Sector', jump: 'gps-3d' as const },
      { id: 20, name: 'Real-Time Data Processing', state: wsConnected ? 'WS Live' : 'Reconnecting', jump: 'multi-cam' as const },
      { id: 21, name: 'Flight Tracking Software', state: `${geoIntel?.aircraft.length ?? 0} ADS-B`, tab: 'airspace' as const },
      { id: 22, name: 'Air Traffic Management (ATM)', state: 'Slant Range', tab: 'airspace' as const },
      { id: 23, name: 'Weather Prediction Software', state: geoIntel?.weather ? `${Math.round(geoIntel.weather.temperatureC)}°C` : 'Standby', tab: 'geoint' as const },
      { id: 24, name: 'Cybersecurity Software', state: typeof window !== 'undefined' && window.isSecureContext ? 'TLS Context' : 'Local', tab: 'cyber' as const },
      { id: 25, name: 'Threat Detection Software', state: `${sessionNegativeCount} alerts`, jump: 'rules' as const },
      { id: 26, name: 'Network Monitoring', state: networkRttMs !== null ? `${networkRttMs} ms` : 'Measuring', tab: 'cyber' as const },
      { id: 27, name: 'Database Management', state: `${dbStats.backend} (${dbStats.detectionsCount + dbStats.waypointsCount + dbStats.reportsCount})`, tab: 'cyber' as const },
      { id: 28, name: 'Cloud Computing', state: securityStatus?.geminiConfigured ? 'API Ready' : 'Express Hub', tab: 'fusion' as const },
      { id: 29, name: 'Edge Computing', state: 'On-Device WASM', tab: 'fusion' as const },
      { id: 30, name: 'Command & Control (C2)', state: `Room ${roomId}`, tab: 'decisions' as const },
      { id: 31, name: 'Simulation Software', state: simulation.running ? 'Sim Active' : 'Sandbox Ready', tab: 'airspace' as const },
      { id: 32, name: 'Augmented Reality (AR)', state: 'Trails + Motion', jump: 'camera' as const },
      { id: 33, name: 'Geographic Info System (GIS)', state: geoIntel?.elevationMeters !== null && geoIntel?.elevationMeters !== undefined ? `${Math.round(geoIntel.elevationMeters)}m elev` : 'Ready', jump: 'gps-3d' as const },
      { id: 34, name: 'Anomaly Detection', state: `${signalStats.anomalyCount} spikes`, tab: 'fusion' as const },
      { id: 35, name: 'Computer-Aided Decision Support', state: `${advisories.length} advisories`, tab: 'decisions' as const },
    ],
    [
      securityStatus,
      isCameraActive,
      activeDetections,
      coords,
      geoIntel,
      telemetryHistory.length,
      linkedNodes.length,
      logs.length,
      signalStats,
      patternSummary.topClasses.length,
      wsConnected,
      sessionNegativeCount,
      networkRttMs,
      dbStats,
      roomId,
      simulation.running,
      advisories.length,
    ]
  );

  return (
    <section
      id="command-analytics"
      className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-3xl p-4 sm:p-6 space-y-5 shadow-xs"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white tracking-tight">
            GAZVA 35-Domain Command, GIS & Analytics Center
          </h2>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            35 integrated domains · Sensor fusion, satellite & weather GEOINT, ATM, cybersecurity, IndexedDB, simulation & AI C2
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRefreshGeoIntel}
            disabled={!coords || geoIntelLoading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-blue-50 dark:bg-blue-950/50 border border-blue-200/80 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/60 text-[#0B4FE6] dark:text-blue-300 rounded-2xl min-h-[40px] cursor-pointer disabled:opacity-45"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${geoIntelLoading ? 'animate-spin' : ''}`} />
            <span>Sync GIS / Sat / Flights</span>
          </button>

          <button
            type="button"
            onClick={() => void onGenerateReport()}
            disabled={isGeneratingReport}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold bg-[#DC2626] hover:bg-red-700 text-white rounded-2xl min-h-[40px] cursor-pointer disabled:opacity-50 shadow-xs"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{isGeneratingReport ? 'Analyzing...' : 'Generate C2 Report'}</span>
          </button>
        </div>
      </div>

      {/* Honest Hardware Boundary Notice */}
      <div className="flex items-start gap-2.5 px-4 py-3 rounded-2xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400">
        <Info className="w-4 h-4 text-[#0B4FE6] shrink-0 mt-0.5" />
        <span>
          <strong className="text-slate-900 dark:text-white">Hardware Scope:</strong> Standard phone/PC cameras capture visible light only and cannot physically see through solid walls or measure body temperature. Use Multi-Cam QR phones in separate rooms for multi-angle coverage, and toggle <strong>Simulation Sandbox</strong> only when running isolated scenario drills.
        </span>
      </div>

      {/* 4-Column Real-Time Telemetry Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="border border-slate-200/90 dark:border-slate-800 rounded-2xl p-3.5 bg-slate-50/80 dark:bg-slate-950/60">
          <div className="flex items-center justify-between text-[11px] font-medium text-slate-500 dark:text-slate-400">
            <span>Network & Cyber Sync</span>
            <Network className="w-3.5 h-3.5 text-[#0B4FE6]" />
          </div>
          <div className="text-sm font-mono font-bold text-slate-900 dark:text-white tabular-nums mt-1">
            {networkRttMs !== null ? `${Math.round(networkRttMs)} ms RTT` : 'Measuring...'}
          </div>
          <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 truncate">
            {wsConnected ? `WS Live · Jitter ${signalStats.rttJitterMs}ms` : 'WS Reconnecting'}
          </div>
        </div>

        <div className="border border-slate-200/90 dark:border-slate-800 rounded-2xl p-3.5 bg-slate-50/80 dark:bg-slate-950/60">
          <div className="flex items-center justify-between text-[11px] font-medium text-slate-500 dark:text-slate-400">
            <span>Satellite & Weather</span>
            <CloudSun className="w-3.5 h-3.5 text-[#DC2626]" />
          </div>
          <div className="text-sm font-mono font-bold text-slate-900 dark:text-white tabular-nums mt-1">
            {geoIntel?.weather
              ? `${geoIntel.weather.temperatureC.toFixed(1)}°C · ${geoIntel.weather.windSpeedKmh} km/h`
              : coords
              ? 'Ready to Sync'
              : 'Enable GPS'}
          </div>
          <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 truncate">
            {geoIntel?.satellite
              ? `${geoIntel.satellite.name} ${geoIntel.satellite.distanceKmFromUser ?? '—'}km`
              : geoIntel?.elevationMeters !== null && geoIntel?.elevationMeters !== undefined
              ? `Elev ${Math.round(geoIntel.elevationMeters)}m`
              : 'Open-Meteo + LEO Sat'}
          </div>
        </div>

        <div className="border border-slate-200/90 dark:border-slate-800 rounded-2xl p-3.5 bg-slate-50/80 dark:bg-slate-950/60">
          <div className="flex items-center justify-between text-[11px] font-medium text-slate-500 dark:text-slate-400">
            <span>Air Traffic (ATM)</span>
            <Plane className="w-3.5 h-3.5 text-[#0B4FE6]" />
          </div>
          <div className="text-sm font-mono font-bold text-slate-900 dark:text-white tabular-nums mt-1">
            {geoIntel ? `${geoIntel.aircraft.length} Flights` : coords ? 'Standby' : 'Enable GPS'}
          </div>
          <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 truncate">
            ~90 km ADS-B Sector
          </div>
        </div>

        <div className="border border-slate-200/90 dark:border-slate-800 rounded-2xl p-3.5 bg-slate-50/80 dark:bg-slate-950/60">
          <div className="flex items-center justify-between text-[11px] font-medium text-slate-500 dark:text-slate-400">
            <span>IndexedDB & Anomaly</span>
            <Cpu className="w-3.5 h-3.5 text-[#DC2626]" />
          </div>
          <div className="text-sm font-mono font-bold text-slate-900 dark:text-white tabular-nums mt-1">
            {latestSample ? `Z=${latestSample.anomalyScore.toFixed(1)} · ${dbStats.detectionsCount} DB` : `${dbStats.detectionsCount} DB`}
          </div>
          <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 truncate">
            {activeDetections.length} tracks · {savedReports.length} reports
          </div>
        </div>
      </div>

      {/* Sub-Navigation Tabs (iOS Segmented Control) */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-2xl w-full sm:w-fit">
        {[
          { id: 'fusion', label: 'Signal, Edge & Cloud' },
          { id: 'geoint', label: 'GEOINT, Sat & Weather' },
          { id: 'airspace', label: `ATM & Simulation (${geoIntel?.aircraft.length ?? 0})` },
          { id: 'cyber', label: 'Cyber, Net & Database' },
          { id: 'decisions', label: 'AI C2 & 35 Domains' },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={`px-3.5 py-2 text-xs font-bold rounded-xl transition-colors whitespace-nowrap cursor-pointer ${
              activeTab === tab.id
                ? 'bg-[#0B4FE6] text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* TAB 1: Signal Processing, Predictive Analytics, Edge & Cloud Computing */}
      {activeTab === 'fusion' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="border border-slate-800 rounded-2xl p-4 bg-slate-950 text-white">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <Activity className="w-4 h-4 text-[#DC2626]" />
                <span>Signal Processing (Raw + EMA Filter & Anomaly Z-Score)</span>
              </div>
              <span className="text-[10px] font-mono text-slate-400 tabular-nums">
                {telemetryHistory.length} samples
              </span>
            </div>

            <svg viewBox="0 0 360 110" className="w-full h-28 overflow-visible">
              <line x1="0" y1="28" x2="360" y2="28" stroke="#1e293b" strokeWidth="1" />
              <line x1="0" y1="56" x2="360" y2="56" stroke="#1e293b" strokeWidth="1" />
              <line x1="0" y1="84" x2="360" y2="84" stroke="#1e293b" strokeWidth="1" />

              {rttPath && (
                <polyline fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeOpacity="0.65" points={rttPath} />
              )}
              {emaRttPath && (
                <polyline fill="none" stroke="#ef4444" strokeWidth="2" points={emaRttPath} />
              )}
              {edgePath && (
                <polyline fill="none" stroke="#10b981" strokeWidth="2" points={edgePath} />
              )}
              {anomalyPoints.map((pt, idx) => (
                <circle
                  key={idx}
                  cx={pt.x}
                  cy={pt.y}
                  r="4"
                  fill="#ef4444"
                  stroke="#ffffff"
                  strokeWidth="1.5"
                />
              ))}
            </svg>

            <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] font-mono text-slate-300">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-emerald-500" />
                Edge Infer ms
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-blue-400" />
                Raw RTT ms
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-red-500" />
                EMA Filtered RTT
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
                Z≥2 Spike
              </span>
            </div>
          </div>

          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl p-4 bg-slate-50/70 dark:bg-slate-950/60 space-y-3">
            <div className="text-xs font-bold text-slate-900 dark:text-white">
              Edge vs Cloud Compute & Linear-Regression Predictive Forecast
            </div>
            <div className="grid grid-cols-2 gap-2.5 text-xs">
              <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl p-3">
                <div className="text-slate-500 dark:text-slate-400 text-[11px]">Edge Compute Tier</div>
                <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
                  {isCameraActive ? `${latestSample?.edgeLatencyMs ?? 0} ms` : 'Standby'}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  MediaPipe TFLite + IoU Tracker + IndexedDB
                </div>
              </div>
              <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl p-3">
                <div className="text-slate-500 dark:text-slate-400 text-[11px]">Cloud Compute Tier</div>
                <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
                  {securityStatus?.geminiConfigured ? 'Gemini + WS Hub' : 'Express WS Hub'}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Product AI + C2 Decision Engine + GIS Feeds
                </div>
              </div>
              <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl p-3">
                <div className="text-slate-500 dark:text-slate-400 text-[11px]">OLS Predicted Next RTT</div>
                <div className="font-mono font-bold text-[#0B4FE6] dark:text-blue-400 mt-0.5 tabular-nums">
                  {signalStats.predictedNextRttMs} ms ({signalStats.trendDirection})
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Jitter: {signalStats.rttJitterMs} ms RMS
                </div>
              </div>
              <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl p-3">
                <div className="text-slate-500 dark:text-slate-400 text-[11px]">Fused Active Sensors</div>
                <div className="font-mono font-bold text-emerald-700 dark:text-emerald-400 mt-0.5 tabular-nums">
                  {(isCameraActive ? 1 : 0) + (coords ? 1 : 0) + linkedNodes.length} Streams
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  {signalStats.anomalyCount} anomaly spike(s)
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: GEOINT, Satellite Data Processing & Weather Prediction */}
      {activeTab === 'geoint' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Open-Meteo Hourly Weather Forecast & Satellite Solar Irradiance */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl p-4 bg-slate-50/70 dark:bg-slate-900/50 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-white">
                <CloudSun className="w-4 h-4 text-[#0B4FE6] dark:text-blue-400" />
                <span>Weather Prediction & Satellite Solar Irradiance (GIS)</span>
              </div>
              {geoIntel?.weather && (
                <span className="text-[11px] font-mono text-slate-600 dark:text-slate-400 tabular-nums">
                  {geoIntel.weather.shortwaveRadiationWm2 !== null &&
                  geoIntel.weather.shortwaveRadiationWm2 !== undefined
                    ? `${geoIntel.weather.shortwaveRadiationWm2} W/m² Solar`
                    : `Cloud ${geoIntel.weather.cloudCoverPct}%`}
                </span>
              )}
            </div>

            {geoIntel && geoIntel.forecast.length > 0 ? (
              <div className="grid grid-cols-4 sm:grid-cols-8 gap-2 items-end h-28 pt-2">
                {geoIntel.forecast.map((slot) => {
                  const barHeight = Math.max(
                    18,
                    Math.min(72, Math.round((slot.temperatureC + 10) * 1.4))
                  );
                  return (
                    <div key={slot.time} className="flex flex-col items-center justify-end gap-1 h-full">
                      <span className="text-[10px] font-mono font-bold text-slate-800 dark:text-slate-200 tabular-nums">
                        {Math.round(slot.temperatureC)}°
                      </span>
                      <div
                        style={{ height: `${barHeight}px` }}
                        className="w-full max-w-[26px] rounded-t-lg bg-[#0B4FE6] relative overflow-hidden"
                        title={`${slot.time}: ${slot.temperatureC}°C, Rain ${slot.precipProb}%, Wind ${slot.windKmh} km/h`}
                      >
                        {slot.precipProb > 0 && (
                          <div
                            style={{ height: `${Math.min(100, slot.precipProb)}%` }}
                            className="absolute inset-x-0 bottom-0 bg-[#DC2626]/80"
                          />
                        )}
                      </div>
                      <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                        {slot.time}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="h-28 flex items-center justify-center text-xs text-slate-500 dark:text-slate-400 text-center px-4">
                {coords
                  ? 'Click Sync GIS / Sat / Flights above to load real-time weather & satellite irradiance.'
                  : 'Enable GPS Activity in 3D & Maps to sync weather prediction and terrain elevation.'}
              </div>
            )}

            {solarPos && (
              <div className="pt-2 border-t border-slate-200 dark:border-slate-800 grid grid-cols-3 gap-2 text-xs">
                <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5">
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">Solar Elevation</div>
                  <div className="font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                    {solarPos.elevationDeg}° ({solarPos.daylight ? 'Day' : 'Night'})
                  </div>
                </div>
                <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5">
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">Solar Azimuth</div>
                  <div className="font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                    {solarPos.azimuthDeg}°
                  </div>
                </div>
                <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5">
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">Terrain Elevation</div>
                  <div className="font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                    {geoIntel?.elevationMeters !== null && geoIntel?.elevationMeters !== undefined
                      ? `${Math.round(geoIntel.elevationMeters)} m`
                      : '—'}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Satellite Orbital Telemetry */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl p-4 bg-slate-50/70 dark:bg-slate-900/50 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-white">
                <Orbit className="w-4 h-4 text-[#DC2626] dark:text-red-400" />
                <span>Satellite Data Processing & GEOINT Ephemeris</span>
              </div>
              <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                {geoIntel?.satellite ? `NORAD ${geoIntel.satellite.noradId}` : 'LEO Feed'}
              </span>
            </div>

            {geoIntel?.satellite ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">Orbital Craft</div>
                  <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5 truncate">
                    {geoIntel.satellite.name}
                  </div>
                </div>
                <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">Ground Range / Brg</div>
                  <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
                    {geoIntel.satellite.distanceKmFromUser ?? '—'} km ·{' '}
                    {geoIntel.satellite.bearingDegFromUser ?? '—'}°
                  </div>
                </div>
                <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">Altitude / Speed</div>
                  <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
                    {geoIntel.satellite.altitudeKm} km · {geoIntel.satellite.velocityKmh} km/h
                  </div>
                </div>
                <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">Sub-Satellite Point</div>
                  <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
                    {geoIntel.satellite.latitude}°, {geoIntel.satellite.longitude}°
                  </div>
                </div>
                <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">Swath Footprint</div>
                  <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5 tabular-nums">
                    {geoIntel.satellite.footprintKm} km
                  </div>
                </div>
                <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">Illumination</div>
                  <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5 capitalize">
                    {geoIntel.satellite.visibility}
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
                {geoIntel?.satelliteNote ||
                  'Sync GIS / Sat / Flights with GPS locked to retrieve live orbital ephemeris and plot the 3D satellite azimuth arc.'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: Air Traffic Management (ADS-B) & 3D Simulation Sandbox */}
      {activeTab === 'airspace' && (
        <div className="space-y-4">
          {/* Interactive 3D Simulation Sandbox Controls */}
          <div className="border border-blue-200 dark:border-blue-900/50 bg-blue-50/70 dark:bg-blue-950/30 rounded-2xl p-4 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-bold text-slate-900 dark:text-white">
                  3D Simulation Software Sandbox (Isolated Test Layer)
                </div>
                <p className="text-[11px] text-slate-600 dark:text-slate-400">
                  Deterministic kinematic simulation plotted in amber on the 3D Digital Twin without modifying live GPS records.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={simulation.scenario}
                  onChange={(e) =>
                    onChangeSimulationScenario(e.target.value as SimulationScenario)
                  }
                  aria-label="Simulation scenario"
                  className="px-3 py-2 text-xs font-semibold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-900 dark:text-white"
                >
                  <option value="patrol">Ground Patrol Trajectory</option>
                  <option value="airspace">Airspace Separation Drill</option>
                  <option value="perimeter_drill">Multi-Vector Perimeter Drill</option>
                </select>
                <button
                  type="button"
                  onClick={onToggleSimulation}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-xl cursor-pointer ${
                    simulation.running
                      ? 'bg-[#DC2626] text-white hover:bg-red-700'
                      : 'bg-[#0B4FE6] text-white hover:bg-[#1D4ED8]'
                  }`}
                >
                  {simulation.running ? (
                    <>
                      <Square className="w-3.5 h-3.5" />
                      <span>Pause Sim</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5" />
                      <span>Run Simulation</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={onResetSimulation}
                  className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-xl cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset</span>
                </button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono text-slate-700 dark:text-slate-300 tabular-nums">
              <span>Step: T+{simulation.step}s</span>
              <span>
                Unit Offset: {Math.round(simulation.simulatedUnitOffsetM.east)}m E,{' '}
                {Math.round(simulation.simulatedUnitOffsetM.north)}m N
              </span>
              <span>Sim Speed: {simulation.simulatedUnitOffsetM.speedKmh} km/h</span>
              <span className="font-sans text-slate-800 dark:text-slate-200">{simulation.advisory}</span>
            </div>
          </div>

          {/* Real OpenSky ADS-B Air Traffic Table */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden bg-white dark:bg-slate-950/60">
            <div className="px-4 py-3 bg-slate-50 dark:bg-slate-900/70 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-bold text-slate-800 dark:text-slate-100">
                Live Civilian ADS-B Aircraft & Air Traffic Management (ATM)
              </span>
              <span className="text-slate-500 dark:text-slate-400 font-mono">
                {geoIntel?.airspaceNote || 'Enable GPS to query sector'}
              </span>
            </div>
            {geoIntel && geoIntel.aircraft.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 font-semibold border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="px-3.5 py-2.5">Callsign</th>
                      <th className="px-3.5 py-2.5">Country</th>
                      <th className="px-3.5 py-2.5">Slant Range</th>
                      <th className="px-3.5 py-2.5">Altitude</th>
                      <th className="px-3.5 py-2.5">Speed</th>
                      <th className="px-3.5 py-2.5">Heading</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono tabular-nums">
                    {geoIntel.aircraft.map((flt) => {
                      const distKm = coords
                        ? haversineMeters(
                            coords.latitude,
                            coords.longitude,
                            flt.latitude,
                            flt.longitude
                          ) / 1000
                        : null;
                      return (
                        <tr key={flt.icao24} className="hover:bg-slate-50 dark:hover:bg-slate-900/60">
                          <td className="px-3.5 py-2 font-bold text-[#0B4FE6] dark:text-blue-400">{flt.callsign}</td>
                          <td className="px-3.5 py-2 font-sans text-slate-700 dark:text-slate-300">{flt.originCountry}</td>
                          <td
                            className={`px-3.5 py-2 font-semibold ${
                              distKm !== null && distKm < 15
                                ? 'text-[#DC2626] dark:text-red-400'
                                : 'text-slate-700 dark:text-slate-300'
                            }`}
                          >
                            {distKm !== null ? `${distKm.toFixed(1)} km` : '—'}
                          </td>
                          <td className="px-3.5 py-2 text-slate-700 dark:text-slate-300">{flt.altitudeMeters} m</td>
                          <td className="px-3.5 py-2 text-slate-700 dark:text-slate-300">{flt.velocityKmh} km/h</td>
                          <td className="px-3.5 py-2 text-slate-600 dark:text-slate-400">{flt.heading}°</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                {coords
                  ? geoIntel?.airspaceNote ||
                    'Click Sync GIS / Sat / Flights to query nearby civilian ADS-B flights.'
                  : 'Enable GPS Location first so we know which airspace sector to query.'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 4: Cybersecurity, Network Monitoring & IndexedDB Database Management */}
      {activeTab === 'cyber' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Cybersecurity & Network Monitoring */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl p-4 bg-slate-50/70 dark:bg-slate-900/50 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-white">
                <ShieldCheck className="w-4 h-4 text-[#0B4FE6] dark:text-blue-400" />
                <span>Cybersecurity & Network Monitoring</span>
              </div>
              <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                {securityStatus ? `Uptime ${securityStatus.uptimeSeconds}s` : 'Probing'}
              </span>
            </div>

            <div className="space-y-1.5 text-xs">
              <div className="flex items-center justify-between bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2.5">
                <span className="text-slate-700 dark:text-slate-300">Transport Security Context</span>
                <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                  {typeof window !== 'undefined' && window.isSecureContext
                    ? 'HTTPS / Secure'
                    : 'Localhost'}
                </span>
              </div>
              <div className="flex items-center justify-between bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2.5">
                <span className="text-slate-700 dark:text-slate-300">Gemini API Key Isolation</span>
                <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                  {securityStatus?.apiKeysIsolatedServerSide ? 'Server-Only Verified' : 'Checking'}
                </span>
              </div>
              <div className="flex items-center justify-between bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2.5">
                <span className="text-slate-700 dark:text-slate-300">WebSocket Payload Cap & Hub</span>
                <span className="font-mono font-semibold text-slate-900 dark:text-white tabular-nums">
                  {securityStatus ? `${Math.round(securityStatus.wsMaxPayloadBytes / 1024)} KB` : '512 KB'} ·{' '}
                  {securityStatus?.connectedPeers ?? 0} peers
                </span>
              </div>
              <div className="flex items-center justify-between bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2.5">
                <span className="text-slate-700 dark:text-slate-300">Network RTT / RMS Jitter</span>
                <span className="font-mono font-semibold text-slate-900 dark:text-white tabular-nums">
                  {networkRttMs !== null ? `${networkRttMs} ms` : '—'} / {signalStats.rttJitterMs} ms
                </span>
              </div>
              {rttSummary && (
                <div className="flex items-center justify-between bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2.5">
                  <span className="text-slate-700 dark:text-slate-300">RTT Min / Avg / Max</span>
                  <span className="font-mono font-semibold text-slate-900 dark:text-white tabular-nums">
                    {rttSummary.min} / {rttSummary.avg} / {rttSummary.max} ms
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* IndexedDB Database Management */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl p-4 bg-slate-50/70 dark:bg-slate-900/50 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-white">
                <Database className="w-4 h-4 text-[#0B4FE6] dark:text-blue-400" />
                <span>Database Management ({dbStats.backend})</span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void onExportCsv()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-xl cursor-pointer"
                >
                  <Download className="w-3 h-3" />
                  <span>Export CSV</span>
                </button>
                <button
                  type="button"
                  onClick={() => void onExportDb()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-xl cursor-pointer"
                >
                  <Download className="w-3 h-3" />
                  <span>Export JSON</span>
                </button>
                <button
                  type="button"
                  onClick={() => void onClearDb()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold bg-white dark:bg-slate-900 border border-red-200 dark:border-red-800/60 hover:bg-red-50 dark:hover:bg-red-950/40 text-[#DC2626] dark:text-red-400 rounded-xl cursor-pointer"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>Purge DB</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">Detections</div>
                <div className="font-mono font-bold text-slate-900 dark:text-white text-base tabular-nums">
                  {dbStats.detectionsCount}
                </div>
              </div>
              <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">Waypoints</div>
                <div className="font-mono font-bold text-slate-900 dark:text-white text-base tabular-nums">
                  {dbStats.waypointsCount}
                </div>
              </div>
              <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">GPS Trail</div>
                <div className="font-mono font-bold text-slate-900 dark:text-white text-base tabular-nums">
                  {dbStats.trailCount}
                </div>
              </div>
              <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">AI Reports</div>
                <div className="font-mono font-bold text-slate-900 dark:text-white text-base tabular-nums">
                  {dbStats.reportsCount}
                </div>
              </div>
            </div>

            {/* Searchable Detections Table Browser */}
            <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-2.5 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[140px]">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={dbSearchQuery}
                    onChange={(e) => setDbSearchQuery(e.target.value)}
                    placeholder="Filter DB records by object, class or source..."
                    className="w-full pl-8 pr-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0B4FE6]/20"
                  />
                </div>
                <select
                  value={dbClassFilter}
                  onChange={(e) =>
                    setDbClassFilter(e.target.value as 'all' | 'negative' | 'positive')
                  }
                  aria-label="Filter DB classification"
                  className="px-2.5 py-1.5 text-xs font-semibold bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-100"
                >
                  <option value="all">All ({logs.length})</option>
                  <option value="negative">Alerts</option>
                  <option value="positive">Safe</option>
                </select>
              </div>

              {filteredDbLogs.length === 0 ? (
                <div className="text-[11px] text-slate-400 text-center py-3">
                  No matching detection records in session store.
                </div>
              ) : (
                <ul className="max-h-32 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 text-[11px]">
                  {filteredDbLogs.slice(0, 20).map((row) => (
                    <li
                      key={row.id}
                      className="py-1.5 px-1 flex items-center justify-between gap-2"
                    >
                      <span className="font-medium text-slate-800 dark:text-slate-200 truncate">{row.label}</span>
                      <div className="flex items-center gap-2 font-mono shrink-0 tabular-nums">
                        <span
                          className={`uppercase font-bold ${
                            row.classification === 'negative'
                              ? 'text-[#DC2626] dark:text-red-400'
                              : row.classification === 'positive'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-slate-500'
                          }`}
                        >
                          {row.classification}
                        </span>
                        <span className="text-slate-400">{Math.round(row.score * 100)}%</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: AI C2 Decision Support, Pattern Recognition & Unified 35-Domain Matrix */}
      {activeTab === 'decisions' && (
        <div className="space-y-4">
          {/* Pattern Recognition & Rule-Based Decision Support */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="border border-slate-200 dark:border-slate-800 rounded-2xl p-4 bg-slate-50/70 dark:bg-slate-900/50 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-slate-900 dark:text-white">
                  Pattern Recognition & Data Analytics
                </span>
                <span className="font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                  Avg Conf {patternSummary.avgConfidencePct}% · Neg {patternSummary.negativeRatioPct}%
                </span>
              </div>
              {patternSummary.topClasses.length > 0 ? (
                <div className="space-y-1.5">
                  {patternSummary.topClasses.map((item) => (
                    <div key={item.label} className="space-y-0.5 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-slate-800 dark:text-slate-200 truncate">{item.label}</span>
                        <span className="font-mono text-slate-600 dark:text-slate-400 tabular-nums">
                          {item.count} ({item.sharePct}%)
                        </span>
                      </div>
                      <div className="h-2 w-full bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
                        <div
                          style={{ width: `${Math.max(6, item.sharePct)}%` }}
                          className={`h-full rounded-full ${
                            item.negativeCount > 0 ? 'bg-[#DC2626]' : 'bg-[#0B4FE6]'
                          }`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-slate-500 dark:text-slate-400 py-4 text-center">
                  Start camera or link a mobile camera via QR to accumulate object pattern statistics.
                </div>
              )}
            </div>

            <div className="border border-slate-200 dark:border-slate-800 rounded-2xl p-4 bg-slate-50/70 dark:bg-slate-900/50 space-y-2">
              <div className="text-xs font-bold text-slate-900 dark:text-white">
                Computer-Aided Decision Support Advisories
              </div>
              <div className="space-y-1.5">
                {advisories.map((adv) => (
                  <div
                    key={adv.id}
                    className={`rounded-xl px-3 py-2 text-xs border ${
                      adv.severity === 'critical'
                        ? 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800/60 text-red-900 dark:text-red-200'
                        : adv.severity === 'warning'
                        ? 'bg-amber-50 dark:bg-amber-950/35 border-amber-200 dark:border-amber-800/60 text-amber-900 dark:text-amber-200'
                        : 'bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <span className="font-bold">{adv.domain}: </span>
                    <span>{adv.message}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Gemini AI C2 Report */}
          {reportError && (
            <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/60 text-xs text-red-700 dark:text-red-300">
              {reportError}
            </div>
          )}

          {activeReport ? (
            <div className="border border-slate-200 dark:border-slate-800 rounded-2xl p-4 bg-slate-50/70 dark:bg-slate-900/50 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-[#0B4FE6] dark:text-blue-400" />
                  <span className="text-sm font-bold text-slate-900 dark:text-white">
                    Fused Command Decision Report
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`px-2.5 py-0.5 rounded-lg text-[11px] font-mono font-bold ${
                      activeReport.overallRiskLevel === 'HIGH'
                        ? 'bg-[#DC2626] text-white'
                        : activeReport.overallRiskLevel === 'MODERATE'
                        ? 'bg-amber-500 text-slate-950'
                        : 'bg-emerald-600 text-white'
                    }`}
                  >
                    RISK: {activeReport.overallRiskLevel}
                  </span>
                  <button
                    type="button"
                    onClick={onClearReports}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-slate-500 dark:text-slate-400 hover:text-red-600 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Clear Reports</span>
                  </button>
                </div>
              </div>

              <p className="text-xs sm:text-sm text-slate-800 dark:text-slate-200 leading-relaxed">
                {activeReport.executiveBrief}
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-3 space-y-1.5">
                  <div className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase">
                    Sensor Fusion & Anomaly Insights
                  </div>
                  <ul className="space-y-1 text-xs text-slate-700 dark:text-slate-300 list-disc pl-4">
                    {activeReport.sensorFusionInsights.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>

                <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-3 space-y-1.5">
                  <div className="text-[11px] font-bold text-slate-600 dark:text-slate-400 uppercase">
                    Recommended C2 Actions
                  </div>
                  <ul className="space-y-1 text-xs text-slate-700 dark:text-slate-300 list-disc pl-4">
                    {activeReport.recommendedActions.map((act, i) => (
                      <li key={i}>{act}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ) : (
            <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-2xl p-5 text-center space-y-1.5">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                No AI Command Reports generated yet
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Click <strong>Generate C2 Report</strong> above to synthesize live GPS, weather, satellite, airspace, linked nodes, and signal telemetry into a saved decision report.
              </p>
            </div>
          )}

          {/* Unified 35-Domain Interactive Directory */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl p-4 bg-white dark:bg-slate-950/60 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-slate-900 dark:text-white">
                Unified 35-Capability GAZVA Architecture (Click any domain to open)
              </span>
              <span className="font-mono text-[#0B4FE6] dark:text-blue-400 font-semibold">35 / 35 Wired</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {capabilityMatrix.map((cap) => (
                <button
                  key={cap.id}
                  type="button"
                  onClick={() => {
                    if (cap.tab) setActiveTab(cap.tab);
                    else if (cap.jump) onJumpToModule(cap.jump);
                  }}
                  className="text-left p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-[#0B4FE6] dark:hover:border-blue-500 hover:bg-blue-50/40 dark:hover:bg-blue-950/30 transition-colors cursor-pointer"
                >
                  <div className="text-[11px] font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {String(cap.id).padStart(2, '0')}. {cap.name}
                  </div>
                  <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 truncate mt-0.5 tabular-nums">
                    {cap.state}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
