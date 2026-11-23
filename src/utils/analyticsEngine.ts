import {
  DetectionLogEntry,
  GeoCoordinates,
  GeoIntelligenceData,
  LinkedCameraNode,
  TelemetrySample,
} from '../types/vision';

export interface SignalStats {
  emaEdgeSeries: number[];
  emaRttSeries: number[];
  predictedNextRttMs: number;
  predictedNextEdgeMs: number;
  rttJitterMs: number;
  anomalyCount: number;
  trendDirection: 'improving' | 'stable' | 'rising';
}

export interface PatternInsightSummary {
  topClasses: Array<{ label: string; count: number; negativeCount: number; sharePct: number }>;
  negativeRatioPct: number;
  avgConfidencePct: number;
  dominantSource: 'local' | 'global' | 'mixed';
}

export interface DecisionAdvisory {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  domain: string;
  message: string;
}

/**
 * Exponential Moving Average (EMA) signal smoothing + linear regression predictive forecast
 */
export function analyzeSignalTelemetry(samples: TelemetrySample[]): SignalStats {
  if (samples.length === 0) {
    return {
      emaEdgeSeries: [],
      emaRttSeries: [],
      predictedNextRttMs: 0,
      predictedNextEdgeMs: 0,
      rttJitterMs: 0,
      anomalyCount: 0,
      trendDirection: 'stable',
    };
  }

  const alpha = 0.35;
  const emaEdgeSeries: number[] = [];
  const emaRttSeries: number[] = [];
  let prevEdge = samples[0].edgeLatencyMs;
  let prevRtt = samples[0].networkRttMs;

  let anomalyCount = 0;
  for (const s of samples) {
    prevEdge = alpha * s.edgeLatencyMs + (1 - alpha) * prevEdge;
    prevRtt = alpha * s.networkRttMs + (1 - alpha) * prevRtt;
    emaEdgeSeries.push(Math.round(prevEdge * 10) / 10);
    emaRttSeries.push(Math.round(prevRtt * 10) / 10);
    if (s.anomalyScore >= 2.0) anomalyCount += 1;
  }

  // Successive RTT jitter (RMS of delta RTT)
  let diffSqSum = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const d = samples[i].networkRttMs - samples[i - 1].networkRttMs;
    diffSqSum += d * d;
  }
  const rttJitterMs =
    samples.length > 1 ? Math.round(Math.sqrt(diffSqSum / (samples.length - 1))) : 0;

  // OLS Linear Regression 1-step prediction on RTT & Edge latency
  const regressNext = (vals: number[]): { next: number; slope: number } => {
    const n = vals.length;
    if (n < 2) return { next: vals[0] ?? 0, slope: 0 };
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (let i = 0; i < n; i += 1) {
      sumX += i;
      sumY += vals[i];
      sumXY += i * vals[i];
      sumXX += i * i;
    }
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return { next: vals[n - 1], slope: 0 };
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    return {
      next: Math.max(0, Math.round(intercept + slope * n)),
      slope,
    };
  };

  const rttForecast = regressNext(samples.map((s) => s.networkRttMs));
  const edgeForecast = regressNext(samples.map((s) => s.edgeLatencyMs));

  const trendDirection =
    rttForecast.slope > 1.5 ? 'rising' : rttForecast.slope < -1.5 ? 'improving' : 'stable';

  return {
    emaEdgeSeries,
    emaRttSeries,
    predictedNextRttMs: rttForecast.next,
    predictedNextEdgeMs: edgeForecast.next,
    rttJitterMs,
    anomalyCount,
    trendDirection,
  };
}

/**
 * Pattern Recognition across detection database entries
 */
export function analyzeDetectionPatterns(logs: DetectionLogEntry[]): PatternInsightSummary {
  if (logs.length === 0) {
    return {
      topClasses: [],
      negativeRatioPct: 0,
      avgConfidencePct: 0,
      dominantSource: 'local',
    };
  }

  const freq = new Map<string, { count: number; negativeCount: number }>();
  let negTotal = 0;
  let scoreSum = 0;
  let localCount = 0;
  let globalCount = 0;

  for (const entry of logs) {
    const key = entry.label;
    const cur = freq.get(key) ?? { count: 0, negativeCount: 0 };
    cur.count += 1;
    if (entry.classification === 'negative') {
      cur.negativeCount += 1;
      negTotal += 1;
    }
    freq.set(key, cur);
    scoreSum += entry.score;
    if (entry.source === 'global') globalCount += 1;
    else localCount += 1;
  }

  const topClasses = Array.from(freq.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 6)
    .map(([label, stats]) => ({
      label,
      count: stats.count,
      negativeCount: stats.negativeCount,
      sharePct: Math.round((stats.count / logs.length) * 100),
    }));

  const dominantSource =
    localCount > 0 && globalCount > 0
      ? 'mixed'
      : globalCount > localCount
      ? 'global'
      : 'local';

  return {
    topClasses,
    negativeRatioPct: Math.round((negTotal / logs.length) * 100),
    avgConfidencePct: Math.round((scoreSum / logs.length) * 100),
    dominantSource,
  };
}

/**
 * Computer-Aided Decision Support advisories grounded strictly in real sensor telemetry
 */
export function evaluateDecisionAdvisories(params: {
  coords: GeoCoordinates | null;
  geoIntel: GeoIntelligenceData | null;
  networkRttMs: number | null;
  wsConnected: boolean;
  linkedNodes: LinkedCameraNode[];
  signalStats: SignalStats;
  sessionNegativeCount: number;
}): DecisionAdvisory[] {
  const list: DecisionAdvisory[] = [];

  if (params.sessionNegativeCount > 0) {
    list.push({
      id: 'adv-neg',
      severity: 'critical',
      domain: 'Threat Detection',
      message: `${params.sessionNegativeCount} negative rule trigger(s) logged this session. Inspect 3D snapshots and verify perimeter clearance.`,
    });
  }

  if (params.signalStats.anomalyCount > 0) {
    list.push({
      id: 'adv-anom',
      severity: 'warning',
      domain: 'Anomaly Detection',
      message: `${params.signalStats.anomalyCount} statistical Z-score spike(s) observed in live edge/network waveform.`,
    });
  }

  if (!params.wsConnected) {
    list.push({
      id: 'adv-ws',
      severity: 'warning',
      domain: 'Network Monitoring',
      message: 'WebSocket room hub is reconnecting. Multi-camera QR node sync will resume automatically.',
    });
  } else if (params.networkRttMs !== null && params.networkRttMs > 220) {
    list.push({
      id: 'adv-rtt',
      severity: 'warning',
      domain: 'Network Monitoring',
      message: `Elevated network RTT (${params.networkRttMs} ms, jitter ${params.signalStats.rttJitterMs} ms). Prefer local Edge Lite0 mode for uninterrupted detection.`,
    });
  }

  if (params.coords && params.coords.accuracy > 80) {
    list.push({
      id: 'adv-gps-acc',
      severity: 'info',
      domain: 'GPS / GIS',
      message: `Current GPS horizontal accuracy is ±${Math.round(params.coords.accuracy)} m (coarse/indoor lock). Move outdoors for meter-level trail precision.`,
    });
  }

  if (params.geoIntel?.weather && params.geoIntel.weather.windSpeedKmh >= 40) {
    list.push({
      id: 'adv-wind',
      severity: 'warning',
      domain: 'Weather Prediction',
      message: `High surface wind (${params.geoIntel.weather.windSpeedKmh} km/h). Expect outdoor camera vibration and false motion alerts.`,
    });
  }

  if (list.length === 0) {
    list.push({
      id: 'adv-nominal',
      severity: 'info',
      domain: 'C2 Decision Support',
      message: `Nominal operation across ${params.linkedNodes.length} linked mobile node(s) and live telemetry streams.`,
    });
  }

  return list;
}
