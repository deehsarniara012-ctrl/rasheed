import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BellOff,
  BellRing,
  Camera,
  CameraOff,
  CheckCircle2,
  ShieldAlert,
  ShieldCheck,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { CameraMonitor } from './components/CameraMonitor';
import { DetectionsLog } from './components/DetectionsLog';
import { RulesPanel } from './components/RulesPanel';
import { DEFAULT_RULES } from './data/cocoClasses';
import { DetectedItem, DetectionLogEntry, VisionRules } from './types/vision';
import { sirenEngine } from './utils/sirenAudio';

const RULES_STORAGE_KEY = 'gazva_vision_rules_v1';

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
  const [rules, setRules] = useState<VisionRules>(loadSavedRules);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [sirenMuted, setSirenMuted] = useState(false);
  const [isSirenSounding, setIsSirenSounding] = useState(false);
  const [isTestSiren, setIsTestSiren] = useState(false);
  const [activeNegativeLabels, setActiveNegativeLabels] = useState<string[]>([]);

  const [activeDetections, setActiveDetections] = useState<DetectedItem[]>([]);
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);
  const [avgLatencyMs, setAvgLatencyMs] = useState<number | null>(null);
  const [fps, setFps] = useState<number>(0);

  const [logs, setLogs] = useState<DetectionLogEntry[]>([]);
  const [sessionPositiveCount, setSessionPositiveCount] = useState(0);
  const [sessionNegativeCount, setSessionNegativeCount] = useState(0);
  const [rightTab, setRightTab] = useState<'rules' | 'detections'>('rules');
  const [logoFailed, setLogoFailed] = useState(false);

  const latencyHistoryRef = useRef<number[]>([]);
  const frameTimestampsRef = useRef<number[]>([]);
  const lastLoggedMapRef = useRef<Record<string, number>>({});
  const ackCooldownUntilRef = useRef<number>(0);
  const sirenMutedRef = useRef(sirenMuted);
  sirenMutedRef.current = sirenMuted;

  useEffect(() => {
    try {
      localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(rules));
    } catch {
      // Ignore storage quota errors
    }
  }, [rules]);

  useEffect(() => {
    return () => {
      sirenEngine.stop();
    };
  }, []);

  const handleStartCamera = useCallback(() => {
    sirenEngine.unlock();
    setIsCameraActive(true);
  }, []);

  const handleStopCamera = useCallback(() => {
    setIsCameraActive(false);
    setActiveDetections([]);
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
    (detections: DetectedItem[], latencyMs: number) => {
      const now = Date.now();

      // Update latency metrics (rolling window of 15 frames)
      setLastLatencyMs(latencyMs);
      const history = latencyHistoryRef.current;
      history.push(latencyMs);
      if (history.length > 15) history.shift();
      const avg = history.reduce((sum, val) => sum + val, 0) / history.length;
      setAvgLatencyMs(avg);

      // Update FPS over trailing 1000ms
      const frameTimes = frameTimestampsRef.current;
      frameTimes.push(now);
      while (frameTimes.length > 0 && now - frameTimes[0] > 1000) {
        frameTimes.shift();
      }
      setFps(frameTimes.length);

      setActiveDetections(detections);

      // Trigger Negative Alert & Full-Volume Siren immediately
      const negativeItems = detections.filter((d) => d.classification === 'negative');
      if (negativeItems.length > 0) {
        const labels = Array.from(new Set(negativeItems.map((d) => d.displayLabel)));
        setActiveNegativeLabels(labels);

        if (!sirenMutedRef.current && now >= ackCooldownUntilRef.current) {
          if (!sirenEngine.isPlaying()) {
            sirenEngine.start();
          }
          setIsSirenSounding(true);
          setIsTestSiren(false);
        }
      } else if (!sirenEngine.isPlaying()) {
        setActiveNegativeLabels([]);
      }

      // Throttle detection log writes (every 2s per class+classification)
      const newEntries: DetectionLogEntry[] = [];
      let addedPositive = 0;
      let addedNegative = 0;

      for (const det of detections) {
        const key = `${det.rawClass}:${det.classification}`;
        const lastLogged = lastLoggedMapRef.current[key] ?? 0;
        if (now - lastLogged >= 2000) {
          lastLoggedMapRef.current[key] = now;
          newEntries.push({
            id: `${now}-${det.rawClass}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: now,
            label: det.displayLabel,
            rawClass: det.rawClass,
            score: det.score,
            classification: det.classification,
            latencyMs,
          });
          if (det.classification === 'positive') addedPositive += 1;
          if (det.classification === 'negative') addedNegative += 1;
        }
      }

      if (newEntries.length > 0) {
        setLogs((prev) => [...newEntries, ...prev].slice(0, 80));
        if (addedPositive > 0) {
          setSessionPositiveCount((c) => c + addedPositive);
        }
        if (addedNegative > 0) {
          setSessionNegativeCount((c) => c + addedNegative);
        }
      }
    },
    []
  );

  const liveCounts = useMemo(() => {
    let positive = 0;
    let negative = 0;
    for (const det of activeDetections) {
      if (det.classification === 'positive') positive += 1;
      if (det.classification === 'negative') negative += 1;
    }
    return { positive, negative };
  }, [activeDetections]);

  const scrollToSection = (tab?: 'rules' | 'detections') => {
    if (tab) {
      setRightTab(tab);
      const panel = document.getElementById('workspace-panel');
      panel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Three-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Brand Mark */}
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              scrollToSection();
            }}
            className="flex items-center gap-2.5 whitespace-nowrap shrink-0"
          >
            {!logoFailed ? (
              <img
                src="/assets/aistudio/image_5e07311e.png"
                alt="GAZVA logo"
                referrerPolicy="no-referrer"
                onError={() => setLogoFailed(true)}
                className="w-9 h-9 rounded-lg object-cover border border-slate-200 bg-white shrink-0"
              />
            ) : (
              <span className="w-9 h-9 rounded-lg bg-[#0B2240] text-white font-bold text-sm flex items-center justify-center shrink-0">
                GV
              </span>
            )}
            <span className="text-base sm:text-lg font-bold tracking-tight text-[#0B2240]">
              GAZVA Vision Guard
            </span>
          </a>

          {/* Zone 2: Clean Single-Line Navigation */}
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <button
              type="button"
              onClick={() => scrollToSection()}
              className="hover:text-[#0B2240] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Live Monitor
            </button>
            <button
              type="button"
              onClick={() => scrollToSection('rules')}
              className="hover:text-[#0B2240] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Classification Rules
            </button>
            <button
              type="button"
              onClick={() => scrollToSection('detections')}
              className="hover:text-[#0B2240] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Recent Detections
            </button>
          </nav>

          {/* Zone 3: Single Primary Action */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={isCameraActive ? handleStopCamera : handleStartCamera}
              className={`inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[44px] cursor-pointer ${
                isCameraActive
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-[#0B2240] text-white hover:bg-[#13325c]'
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

      {/* Main Content Container */}
      <main id="top" className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-5 sm:py-6">
        {/* Global Active Siren Banner (Accessible even if scrolled) */}
        {isSirenSounding && (
          <div
            role="alert"
            className="mb-5 p-4 rounded-xl bg-red-600 text-white flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-sm"
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
            <button
              type="button"
              onClick={handleAcknowledgeAlert}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-bold bg-white text-red-700 hover:bg-red-50 rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[44px] cursor-pointer"
            >
              <BellOff className="w-4 h-4" />
              <span>Dismiss & Stop Siren</span>
            </button>
          </div>
        )}

        {/* Workspace 12-Column Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Live Camera + Speed Telemetry + Active Detections */}
          <section className="lg:col-span-7 xl:col-span-8 flex flex-col gap-5">
            {/* Camera Card */}
            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div>
                  <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
                    Real-Time Camera Analysis
                  </h1>
                  <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
                    Sub-second frame classification · Green for Positive · Red & Siren for Negative
                  </p>
                </div>

                {/* Audio Siren Controls */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleTestSiren}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap min-h-[40px] cursor-pointer ${
                      isSirenSounding
                        ? 'bg-red-600 text-white border-red-600 hover:bg-red-700'
                        : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <BellRing className="w-4 h-4" />
                    <span>{isSirenSounding ? 'Stop Siren' : 'Test Siren'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleToggleMute}
                    aria-pressed={sirenMuted}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap min-h-[40px] cursor-pointer ${
                      sirenMuted
                        ? 'bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100'
                        : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-50'
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
                </div>
              </div>

              <CameraMonitor
                rules={rules}
                isCameraActive={isCameraActive}
                isSirenSounding={isSirenSounding}
                activeNegativeLabels={activeNegativeLabels}
                lastLatencyMs={lastLatencyMs}
                onStartCamera={handleStartCamera}
                onStopCamera={handleStopCamera}
                onAcknowledgeAlert={handleAcknowledgeAlert}
                onFrameResult={handleFrameResult}
              />
            </div>

            {/* 4-Column Real-Time Speed & Classification KPI Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="text-xs font-medium text-slate-500">Detection Speed</div>
                <div
                  className={`text-2xl font-mono font-bold tabular-nums mt-1 ${
                    lastLatencyMs === null
                      ? 'text-slate-900'
                      : lastLatencyMs < 1000
                      ? 'text-emerald-600'
                      : 'text-amber-600'
                  }`}
                >
                  {lastLatencyMs !== null ? `${Math.round(lastLatencyMs)} ms` : '—'}
                </div>
                <div className="text-xs text-slate-500 font-mono tabular-nums mt-1">
                  {avgLatencyMs !== null
                    ? `Avg ${Math.round(avgLatencyMs)} ms · ${fps} fps`
                    : 'Target < 1,000 ms'}
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="text-xs font-medium text-slate-500">In Current Frame</div>
                <div className="text-2xl font-mono font-bold tabular-nums text-slate-900 mt-1">
                  {activeDetections.length}
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  {liveCounts.positive} Positive · {liveCounts.negative} Negative
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="text-xs font-medium text-slate-500">Positive Logged</div>
                <div className="text-2xl font-mono font-bold tabular-nums text-emerald-600 mt-1">
                  {sessionPositiveCount}
                </div>
                <div className="text-xs text-slate-500 mt-1">Green safe highlight</div>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="text-xs font-medium text-slate-500">Negative Alerts</div>
                <div className="text-2xl font-mono font-bold tabular-nums text-red-600 mt-1">
                  {sessionNegativeCount}
                </div>
                <div className="text-xs text-slate-500 mt-1">Red warning + siren</div>
              </div>
            </div>

            {/* Live Objects Breakdown Table */}
            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2 mb-3">
                <h2 className="text-sm font-bold text-slate-900">
                  Live Frame Classifications
                </h2>
                <span className="text-xs text-slate-500 font-mono tabular-nums">
                  {activeDetections.length} visible
                </span>
              </div>

              {activeDetections.length === 0 ? (
                <p className="text-xs text-slate-500 py-2">
                  No objects currently detected above {Math.round(rules.confidenceThreshold * 100)}%
                  confidence.
                </p>
              ) : (
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                  {activeDetections.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-3 px-3.5 py-2.5"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {item.classification === 'negative' ? (
                          <ShieldAlert className="w-4 h-4 text-red-600 shrink-0" />
                        ) : item.classification === 'positive' ? (
                          <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                        ) : (
                          <CheckCircle2 className="w-4 h-4 text-slate-400 shrink-0" />
                        )}
                        <span className="text-sm font-semibold text-slate-900 truncate">
                          {item.displayLabel}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 shrink-0 text-xs font-mono tabular-nums">
                        <span className="text-slate-500">
                          {Math.round(item.score * 100)}%
                        </span>
                        <span
                          className={`font-bold uppercase ${
                            item.classification === 'negative'
                              ? 'text-red-600'
                              : item.classification === 'positive'
                              ? 'text-emerald-600'
                              : 'text-slate-500'
                          }`}
                        >
                          {item.classification}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Right Column: Rules Editor & Recent Detections */}
          <aside
            id="workspace-panel"
            className="lg:col-span-5 xl:col-span-4 bg-white border border-slate-200 rounded-xl p-4 sm:p-5"
          >
            <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg mb-5">
              <button
                type="button"
                onClick={() => setRightTab('rules')}
                className={`px-3 py-2 text-xs sm:text-sm font-semibold rounded-md transition-colors whitespace-nowrap min-h-[40px] cursor-pointer ${
                  rightTab === 'rules'
                    ? 'bg-white text-[#0B2240] shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Edit Rules ({rules.positive.length + rules.negative.length})
              </button>
              <button
                type="button"
                onClick={() => setRightTab('detections')}
                className={`px-3 py-2 text-xs sm:text-sm font-semibold rounded-md transition-colors whitespace-nowrap min-h-[40px] cursor-pointer ${
                  rightTab === 'detections'
                    ? 'bg-white text-[#0B2240] shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Detections ({logs.length})
              </button>
            </div>

            {rightTab === 'rules' ? (
              <RulesPanel rules={rules} onChangeRules={setRules} />
            ) : (
              <DetectionsLog logs={logs} onClearLogs={() => setLogs([])} />
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}
