import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';
import {
  ArrowLeft,
  Camera,
  CameraOff,
  LocateFixed,
  LocateOff,
  Radio,
  ShieldAlert,
  ShieldCheck,
  SwitchCamera,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { DEFAULT_RULES } from '../data/cocoClasses';
import { DetectedItem, GeoCoordinates, VisionRules } from '../types/vision';
import { classifyDetection, formatObjectLabel } from '../utils/classifier';

interface MobileCameraNodeProps {
  roomId: string;
  onExitToHost: () => void;
}

function getOrCreateNodeId(): string {
  const key = 'gazva_mobile_node_id';
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const generated = `mob-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem(key, generated);
    return generated;
  } catch {
    return `mob-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export const MobileCameraNode: React.FC<MobileCameraNodeProps> = ({ roomId, onExitToHost }) => {
  const [nodeId] = useState(getOrCreateNodeId);
  const [deviceName, setDeviceName] = useState(() => `Mobile-${nodeId.slice(-4).toUpperCase()}`);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [wsError, setWsError] = useState<string | null>(null);

  const [cameraActive, setCameraActive] = useState(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [detectorReady, setDetectorReady] = useState(false);

  const [gpsActive, setGpsActive] = useState(false);
  const [coords, setCoords] = useState<GeoCoordinates | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);

  const [detections, setDetections] = useState<DetectedItem[]>([]);
  const [fps, setFps] = useState(0);
  const [rules, setRules] = useState<VisionRules>(DEFAULT_RULES);

  const wsRef = useRef<WebSocket | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<ObjectDetector | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const thumbCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const lastTimestampMsRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const lastSentFrameAtRef = useRef(0);
  const frameTimesRef = useRef<number[]>([]);
  const rulesRef = useRef(rules);
  rulesRef.current = rules;

  const sendWs = useCallback((payload: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  // Connect to Room Hub over WebSocket with auto-reconnect
  useEffect(() => {
    let closedByUser = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (closedByUser) return;
      setWsStatus('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsStatus('connected');
        setWsError(null);
        ws.send(
          JSON.stringify({
            type: 'join',
            roomId,
            role: 'camera',
            nodeId,
            deviceName,
          })
        );
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(String(evt.data)) as Record<string, unknown>;
          if (msg.type === 'room:state' || msg.type === 'rules:updated') {
            if (msg.rules && typeof msg.rules === 'object') {
              setRules(msg.rules as VisionRules);
            }
          } else if (msg.type === 'error' && typeof msg.error === 'string') {
            setWsError(msg.error);
          }
        } catch {
          // Ignore malformed server frame
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!closedByUser) {
          setWsStatus('disconnected');
          reconnectTimer = window.setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      closedByUser = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [roomId, nodeId, deviceName]);

  // Sync camera/GPS/device status when toggled
  useEffect(() => {
    if (wsStatus === 'connected') {
      sendWs({
        type: 'node:status',
        cameraActive,
        gpsActive,
        deviceName,
      });
    }
  }, [wsStatus, cameraActive, gpsActive, deviceName, sendWs]);

  // Load MediaPipe Lite0 Vision Engine for mobile camera detection
  useEffect(() => {
    let cancelled = false;
    const loadDetector = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks('/wasm');
        if (cancelled) return;
        const originalError = console.error;
        console.error = (...args: unknown[]) => {
          const s = typeof args[0] === 'string' ? args[0] : '';
          if (s.startsWith('INFO: Created TensorFlow Lite') || s.includes('absl::InitializeLog')) return;
          originalError(...args);
        };
        let det: ObjectDetector;
        try {
          det = await ObjectDetector.createFromOptions(vision, {
            baseOptions: { modelAssetPath: '/models/efficientdet_lite0.tflite', delegate: 'CPU' },
            runningMode: 'VIDEO',
            scoreThreshold: 0.35,
            maxResults: 6,
          });
        } finally {
          console.error = originalError;
        }
        if (cancelled) {
          det.close();
          return;
        }
        detectorRef.current = det;
        setDetectorReady(true);
      } catch {
        setDetectorReady(false);
      }
    };
    void loadDetector();
    return () => {
      cancelled = true;
      detectorRef.current?.close();
      detectorRef.current = null;
    };
  }, []);

  // Standalone Mobile GPS Tracking (works even if camera is OFF)
  const toggleMobileGps = useCallback(() => {
    if (gpsActive) {
      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      setGpsActive(false);
      return;
    }

    if (!navigator.geolocation) {
      setGpsError('GPS Geolocation not supported on this device.');
      return;
    }

    setGpsError(null);
    setGpsActive(true);

    const handlePos = (pos: GeolocationPosition) => {
      const next: GeoCoordinates = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        heading: pos.coords.heading,
        speed: pos.coords.speed,
        updatedAt: pos.timestamp || Date.now(),
      };
      setCoords(next);
      sendWs({ type: 'gps:update', coords: next });
    };

    const handleErr = (err: GeolocationPositionError) => {
      setGpsError(err.message || 'Unable to acquire GPS fix.');
    };

    navigator.geolocation.getCurrentPosition(handlePos, handleErr, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 3000,
    });
    watchIdRef.current = navigator.geolocation.watchPosition(handlePos, handleErr, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 2000,
    });
  }, [gpsActive, sendWs]);

  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  // Mobile Camera Stream & Detection -> Host WebSocket Broadcast
  useEffect(() => {
    if (!cameraActive) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setDetections([]);
      setFps(0);
      return;
    }

    let cancelled = false;
    let rafId = 0;

    const run = async () => {
      try {
        setCameraError(null);
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        const tick = () => {
          if (cancelled) return;
          const video = videoRef.current;
          const now = Date.now();

          if (video && video.readyState >= 2 && video.videoWidth > 0 && video.currentTime !== lastVideoTimeRef.current) {
            lastVideoTimeRef.current = video.currentTime;
            frameTimesRef.current.push(now);
            while (frameTimesRef.current.length > 0 && now - frameTimesRef.current[0] > 1000) {
              frameTimesRef.current.shift();
            }

            let currentDets: DetectedItem[] = [];
            let latencyMs: number | null = null;

            if (detectorRef.current) {
              const t0 = performance.now();
              const ts = Math.max(lastTimestampMsRef.current + 1, Math.round(t0));
              lastTimestampMsRef.current = ts;
              const res = detectorRef.current.detectForVideo(video, ts);
              latencyMs = performance.now() - t0;

              const currentRules = rulesRef.current;
              for (let i = 0; i < res.detections.length; i += 1) {
                const det = res.detections[i];
                const cat = det.categories[0];
                const box = det.boundingBox;
                if (!cat || !box || cat.score < currentRules.confidenceThreshold) continue;
                const rawClass = (cat.categoryName || cat.displayName || 'object').toLowerCase();
                const { classification } = classifyDetection(rawClass, currentRules);

                let thumbUrl: string | undefined;
                if (now - lastSentFrameAtRef.current >= 220 && box.width > 8 && box.height > 8) {
                  if (!thumbCanvasRef.current) {
                    thumbCanvasRef.current = document.createElement('canvas');
                    thumbCanvasRef.current.width = 120;
                    thumbCanvasRef.current.height = 90;
                  }
                  const tCtx = thumbCanvasRef.current.getContext('2d');
                  if (tCtx) {
                    tCtx.drawImage(
                      video,
                      Math.max(0, box.originX),
                      Math.max(0, box.originY),
                      Math.max(10, box.width),
                      Math.max(10, box.height),
                      0,
                      0,
                      120,
                      90
                    );
                    thumbUrl = thumbCanvasRef.current.toDataURL('image/jpeg', 0.65);
                  }
                }

                currentDets.push({
                  id: `${nodeId}-${rawClass}-${i}`,
                  rawClass,
                  displayLabel: formatObjectLabel(rawClass),
                  score: cat.score,
                  bbox: [box.originX, box.originY, box.width, box.height],
                  classification,
                  thumbnailUrl: thumbUrl,
                });
              }
            }

            if (now - lastSentFrameAtRef.current >= 220) {
              lastSentFrameAtRef.current = now;
              if (!previewCanvasRef.current) {
                previewCanvasRef.current = document.createElement('canvas');
                previewCanvasRef.current.width = 320;
                previewCanvasRef.current.height = 240;
              }
              const pCanvas = previewCanvasRef.current;
              const pCtx = pCanvas.getContext('2d');
              let previewFrameUrl: string | undefined;
              if (pCtx) {
                pCtx.drawImage(video, 0, 0, pCanvas.width, pCanvas.height);
                previewFrameUrl = pCanvas.toDataURL('image/jpeg', 0.56);
              }

              setDetections(currentDets);
              setFps(frameTimesRef.current.length);
              sendWs({
                type: 'camera:frame',
                previewFrameUrl,
                detections: currentDets,
                fps: frameTimesRef.current.length,
                latencyMs,
              });
            }
          }

          if (!cancelled) {
            rafId = requestAnimationFrame(tick);
          }
        };

        rafId = requestAnimationFrame(tick);
      } catch {
        if (!cancelled) {
          setCameraError('Unable to start phone camera. Allow permissions or use GPS-only mode.');
          setCameraActive(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [cameraActive, facingMode, nodeId, sendWs]);

  return (
    <div className="min-h-screen bg-[#080E1C] text-white flex flex-col">
      <header className="px-4 py-3 bg-gradient-to-r from-[#0B2240] via-[#0B4FE6]/40 to-[#DC2626]/30 border-b border-white/10 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onExitToHost}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-2xl bg-white/10 hover:bg-white/20 text-xs font-semibold min-h-[40px] cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Host View</span>
        </button>

        <div className="text-center min-w-0">
          <div className="text-[11px] font-mono text-blue-200 uppercase">
            Linked Room · {roomId}
          </div>
          <div className="text-sm font-bold truncate">{deviceName}</div>
        </div>

        <div
          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-2xl text-xs font-semibold ${
            wsStatus === 'connected'
              ? 'bg-[#0B4FE6]/30 text-blue-200 border border-blue-400/50'
              : 'bg-red-600/30 text-red-200 border border-red-500/50'
          }`}
        >
          {wsStatus === 'connected' ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
          <span>{wsStatus === 'connected' ? 'Live' : 'Syncing'}</span>
        </div>
      </header>

      <main className="flex-1 p-4 max-w-xl w-full mx-auto flex flex-col gap-4">
        {wsError && (
          <div className="p-3 rounded-2xl bg-red-950 border border-red-600 text-xs text-red-200">
            {wsError}
          </div>
        )}

        {/* Device Name */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3.5 flex items-center gap-3">
          <Radio className="w-4 h-4 text-[#DC2626] shrink-0" />
          <input
            type="text"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            maxLength={32}
            aria-label="Mobile camera name"
            className="flex-1 bg-transparent text-sm font-semibold text-white focus:outline-none"
          />
          <span className="text-[11px] font-mono text-blue-300">
            {detectorReady ? 'AI Ready' : 'Loading AI'}
          </span>
        </div>

        {/* Phone Camera Preview */}
        <div className="relative w-full aspect-[4/3] bg-slate-900 rounded-3xl border border-slate-800 overflow-hidden flex items-center justify-center">
          <video
            ref={videoRef}
            playsInline
            muted
            className={`w-full h-full object-cover ${cameraActive ? 'block' : 'hidden'}`}
          />

          {!cameraActive && (
            <div className="p-6 text-center space-y-3">
              <CameraOff className="w-9 h-9 text-slate-500 mx-auto" />
              <div className="text-sm font-semibold text-slate-200">
                {cameraError || 'Mobile Camera Standby'}
              </div>
              <p className="text-xs text-slate-400">
                You can stream live camera detection or run GPS-only tracking below.
              </p>
            </div>
          )}

          {cameraActive && (
            <div className="absolute top-3 left-3 px-3 py-1 rounded-xl bg-slate-950/85 border border-blue-500/40 text-[11px] font-mono text-blue-200">
              Streaming to Host · {fps} fps
            </div>
          )}
        </div>

        {/* Camera + Standalone GPS Controls */}
        <div className="grid grid-cols-3 gap-2.5">
          <button
            type="button"
            onClick={() => setCameraActive((v) => !v)}
            className={`flex items-center justify-center gap-1.5 py-3 px-3 rounded-2xl text-xs font-bold min-h-[48px] cursor-pointer ${
              cameraActive ? 'bg-[#DC2626] text-white' : 'bg-[#0B4FE6] text-white'
            }`}
          >
            {cameraActive ? <CameraOff className="w-4 h-4" /> : <Camera className="w-4 h-4" />}
            <span>{cameraActive ? 'Stop Cam' : 'Start Cam'}</span>
          </button>

          <button
            type="button"
            onClick={() => setFacingMode((f) => (f === 'environment' ? 'user' : 'environment'))}
            className="flex items-center justify-center gap-1.5 py-3 px-3 rounded-2xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold min-h-[48px] cursor-pointer"
          >
            <SwitchCamera className="w-4 h-4" />
            <span>Flip</span>
          </button>

          <button
            type="button"
            onClick={toggleMobileGps}
            className={`flex items-center justify-center gap-1.5 py-3 px-3 rounded-2xl text-xs font-bold min-h-[48px] cursor-pointer ${
              gpsActive ? 'bg-[#DC2626] text-white' : 'bg-slate-800 hover:bg-slate-700 text-white'
            }`}
          >
            {gpsActive ? <LocateFixed className="w-4 h-4" /> : <LocateOff className="w-4 h-4" />}
            <span>{gpsActive ? 'GPS On' : 'Start GPS'}</span>
          </button>
        </div>

        {/* GPS Activity Box */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3.5 space-y-1.5">
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className="text-slate-300">Mobile GPS Activity Stream</span>
            <span className={gpsActive ? 'text-blue-400 font-mono' : 'text-slate-500 font-mono'}>
              {gpsActive ? 'LIVE' : 'STANDBY'}
            </span>
          </div>
          {gpsError && <div className="text-xs text-red-400">{gpsError}</div>}
          <div className="text-xs font-mono text-slate-300 tabular-nums">
            {coords
              ? `${coords.latitude.toFixed(6)}°, ${coords.longitude.toFixed(6)}° (±${Math.round(
                  coords.accuracy
                )}m)`
              : 'Tap Start GPS to track and send live coordinates to Host without camera.'}
          </div>
        </div>

        {/* Detections List */}
        {detections.length > 0 && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl divide-y divide-slate-800">
            {detections.map((d) => (
              <div key={d.id} className="px-3.5 py-2.5 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 font-semibold">
                  {d.classification === 'negative' ? (
                    <ShieldAlert className="w-4 h-4 text-red-500" />
                  ) : (
                    <ShieldCheck className="w-4 h-4 text-blue-400" />
                  )}
                  <span>{d.displayLabel}</span>
                </div>
                <span className="font-mono uppercase text-slate-400">
                  {d.classification} · {Math.round(d.score * 100)}%
                </span>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};
