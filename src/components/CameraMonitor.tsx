import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';
import {
  AlertTriangle,
  Camera,
  CameraOff,
  Crosshair,
  Download,
  Flame,
  Globe,
  ImagePlus,
  Maximize2,
  Minimize2,
  RefreshCw,
  ScanSearch,
  ShieldAlert,
  SwitchCamera,
  Video,
  Volume2,
  VolumeX,
  Zap,
  ZoomIn,
} from 'lucide-react';
import { DetectedItem, GlobalProductItem, VisionRules } from '../types/vision';
import { classifyDetection, formatObjectLabel } from '../utils/classifier';
import { MultiObjectTracker } from '../utils/objectTracker';

export type EngineMode = 'fast' | 'accurate';

interface CameraMonitorProps {
  rules: VisionRules;
  isCameraActive: boolean;
  isSirenSounding: boolean;
  sirenMuted: boolean;
  activeNegativeLabels: string[];
  lastLatencyMs: number | null;
  onStartCamera: () => void;
  onStopCamera: () => void;
  onAcknowledgeAlert: () => void;
  onToggleMute: () => void;
  onFrameResult: (detections: DetectedItem[], latencyMs: number, motionPct?: number) => void;
  onGlobalProductsResult: (products: GlobalProductItem[], serverMs: number) => void;
}

function isSoftwareWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return false;
    const renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '').toLowerCase();
    return (
      renderer.includes('swiftshader') ||
      renderer.includes('llvmpipe') ||
      renderer.includes('software') ||
      renderer.includes('softpipe')
    );
  } catch {
    return true;
  }
}

export const CameraMonitor: React.FC<CameraMonitorProps> = ({
  rules,
  isCameraActive,
  isSirenSounding,
  sirenMuted,
  activeNegativeLabels,
  lastLatencyMs,
  onStartCamera,
  onStopCamera,
  onAcknowledgeAlert,
  onToggleMute,
  onFrameResult,
  onGlobalProductsResult,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const globalSnapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const thumbCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const motionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevLumaRef = useRef<Uint8Array | null>(null);
  const motionGridRef = useRef<Uint8Array | null>(null);
  const lastMotionPctRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const detectorRef = useRef<ObjectDetector | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastVideoTimeRef = useRef<number>(-1);
  const lastTimestampMsRef = useRef<number>(0);
  const thumbCacheRef = useRef<Record<string, { url: string; at: number }>>({});
  const globalInFlightRef = useRef<boolean>(false);
  const globalProductsRef = useRef<{ items: GlobalProductItem[]; at: number }>({
    items: [],
    at: 0,
  });
  const trackerRef = useRef<MultiObjectTracker>(new MultiObjectTracker());

  const rulesRef = useRef(rules);
  rulesRef.current = rules;

  const onFrameResultRef = useRef(onFrameResult);
  onFrameResultRef.current = onFrameResult;

  const onGlobalProductsResultRef = useRef(onGlobalProductsResult);
  onGlobalProductsResultRef.current = onGlobalProductsResult;

  const [engineMode, setEngineMode] = useState<EngineMode>('fast');
  const [zoomLevel, setZoomLevel] = useState<number>(1.0);
  const zoomLevelRef = useRef(zoomLevel);
  zoomLevelRef.current = zoomLevel;

  const engineModeRef = useRef(engineMode);
  engineModeRef.current = engineMode;

  const [isFullCamera, setIsFullCamera] = useState(false);
  const [worldProductsEnabled, setWorldProductsEnabled] = useState(true);
  const [arOverlayMode, setArOverlayMode] = useState<'standard' | 'motion' | 'thermal'>('standard');
  const arOverlayModeRef = useRef(arOverlayMode);
  arOverlayModeRef.current = arOverlayMode;
  const [globalProducts, setGlobalProducts] = useState<GlobalProductItem[]>([]);
  const [globalStatusNote, setGlobalStatusNote] = useState<string | null>(null);
  const [isIdentifyingGlobal, setIsIdentifyingGlobal] = useState(false);

  const [modelStatus, setModelStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [delegateLabel, setDelegateLabel] = useState<'GPU' | 'CPU'>('GPU');
  const [modelError, setModelError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [testImageUrl, setTestImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isFullCamera) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isFullCamera]);

  // Initialize MediaPipe ObjectDetector with automatic GPU/Software-WebGL speed selection
  useEffect(() => {
    let cancelled = false;

    const initDetector = async () => {
      try {
        setModelStatus('loading');
        setModelError(null);

        if (detectorRef.current) {
          detectorRef.current.close();
          detectorRef.current = null;
        }

        const modelPath =
          engineMode === 'accurate'
            ? '/models/efficientdet_lite2.tflite'
            : '/models/efficientdet_lite0.tflite';

        const vision = await FilesetResolver.forVisionTasks('/wasm');
        if (cancelled) return;

        const warmup = document.createElement('canvas');
        warmup.width = 320;
        warmup.height = 180;
        const wCtx = warmup.getContext('2d');
        if (wCtx) {
          wCtx.fillStyle = '#000';
          wCtx.fillRect(0, 0, warmup.width, warmup.height);
        }

        const preferCpuFirst = isSoftwareWebGL();
        let activeDelegate: 'GPU' | 'CPU' = preferCpuFirst ? 'CPU' : 'GPU';
        let detector: ObjectDetector | null = null;

        const originalConsoleError = console.error;
        console.error = (...args: unknown[]) => {
          const first = typeof args[0] === 'string' ? args[0] : '';
          if (
            first.startsWith('INFO: Created TensorFlow Lite') ||
            first.includes('All log messages before absl::InitializeLog()')
          ) {
            return;
          }
          originalConsoleError(...args);
        };

        try {
          if (!preferCpuFirst) {
            try {
              const gpuDet = await ObjectDetector.createFromOptions(vision, {
                baseOptions: { modelAssetPath: modelPath, delegate: 'GPU' },
                runningMode: 'VIDEO',
                scoreThreshold: 0.35,
                maxResults: 10,
              });
              const ts = Math.max(lastTimestampMsRef.current + 1, Math.round(performance.now()));
              lastTimestampMsRef.current = ts;
              // Warm up GPU shaders and measure real speed
              gpuDet.detectForVideo(warmup, ts);
              const tBench = performance.now();
              gpuDet.detectForVideo(warmup, ts + 1);
              const gpuMs = performance.now() - tBench;
              lastTimestampMsRef.current = ts + 1;

              if (gpuMs <= 120) {
                detector = gpuDet;
                activeDelegate = 'GPU';
              } else {
                gpuDet.close();
              }
            } catch {
              detector = null;
            }
          }

          if (!detector) {
            activeDelegate = 'CPU';
            detector = await ObjectDetector.createFromOptions(vision, {
              baseOptions: { modelAssetPath: modelPath, delegate: 'CPU' },
              runningMode: 'VIDEO',
              scoreThreshold: 0.35,
              maxResults: 10,
            });
            const ts = Math.max(lastTimestampMsRef.current + 1, Math.round(performance.now()));
            lastTimestampMsRef.current = ts;
            detector.detectForVideo(warmup, ts);
          }
        } finally {
          console.error = originalConsoleError;
        }

        if (cancelled) {
          detector.close();
          return;
        }

        detectorRef.current = detector;
        setDelegateLabel(activeDelegate);
        setModelStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setModelStatus('error');
        setModelError(
          err instanceof Error ? err.message : 'Unable to initialize vision engine.'
        );
      }
    };

    void initDetector();

    return () => {
      cancelled = true;
      if (detectorRef.current) {
        detectorRef.current.close();
        detectorRef.current = null;
      }
    };
  }, [engineMode]);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  const drawOverlay = useCallback(
    (
      detections: DetectedItem[],
      sourceW: number,
      sourceH: number,
      mirrorHorizontal: boolean
    ) => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container || sourceW === 0 || sourceH === 0) return;

      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const targetW = Math.max(1, Math.round(rect.width * dpr));
      const targetH = Math.max(1, Math.round(rect.height * dpr));

      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const mediaRatio = sourceW / sourceH;
      const containerRatio = rect.width / rect.height;
      let drawW = rect.width;
      let drawH = rect.height;
      let offsetX = 0;
      let offsetY = 0;

      if (mediaRatio > containerRatio) {
        drawH = rect.width / mediaRatio;
        offsetY = (rect.height - drawH) / 2;
      } else {
        drawW = rect.height * mediaRatio;
        offsetX = (rect.width - drawW) / 2;
      }

      const scaleX = drawW / sourceW;
      const scaleY = drawH / sourceH;

      // Helper to render crisp bounding box + label
      const renderBox = (
        boxX: number,
        boxY: number,
        boxW: number,
        boxH: number,
        classification: 'positive' | 'negative' | 'neutral',
        labelText: string,
        isWorldProduct: boolean
      ) => {
        const isPositive = classification === 'positive';
        const isNegative = classification === 'negative';

        const strokeColor = isNegative
          ? '#DC2626'
          : isPositive
          ? '#16A34A'
          : isWorldProduct
          ? '#0B2240'
          : '#64748B';
        const fillColor = isNegative
          ? 'rgba(220, 38, 38, 0.22)'
          : isPositive
          ? 'rgba(22, 163, 74, 0.14)'
          : isWorldProduct
          ? 'rgba(11, 34, 64, 0.12)'
          : 'rgba(100, 116, 139, 0.08)';
        const labelBg = isNegative
          ? '#DC2626'
          : isPositive
          ? '#16A34A'
          : isWorldProduct
          ? '#0B2240'
          : '#334155';

        ctx.fillStyle = fillColor;
        ctx.fillRect(boxX, boxY, boxW, boxH);

        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = isNegative ? 3.5 : isPositive || isWorldProduct ? 2.75 : 1.75;
        if (classification === 'neutral' && !isWorldProduct) {
          ctx.setLineDash([6, 4]);
        } else {
          ctx.setLineDash([]);
        }
        ctx.strokeRect(boxX, boxY, boxW, boxH);
        ctx.setLineDash([]);

        if (isPositive || isNegative || isWorldProduct) {
          const bracket = Math.min(18, boxW * 0.25, boxH * 0.25);
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(boxX, boxY + bracket);
          ctx.lineTo(boxX, boxY);
          ctx.lineTo(boxX + bracket, boxY);

          ctx.moveTo(boxX + boxW - bracket, boxY);
          ctx.lineTo(boxX + boxW, boxY);
          ctx.lineTo(boxX + boxW, boxY + bracket);

          ctx.moveTo(boxX, boxY + boxH - bracket);
          ctx.lineTo(boxX, boxY + boxH);
          ctx.lineTo(boxX + bracket, boxY + boxH);

          ctx.moveTo(boxX + boxW - bracket, boxY + boxH);
          ctx.lineTo(boxX + boxW, boxY + boxH);
          ctx.lineTo(boxX + boxW, boxY + boxH - bracket);
          ctx.stroke();
        }

        ctx.font = '700 12px "Plus Jakarta Sans", sans-serif';
        const textMetrics = ctx.measureText(labelText);
        const padX = 8;
        const tagH = 24;
        const tagW = Math.min(rect.width - 8, textMetrics.width + padX * 2);
        const tagX = Math.max(4, Math.min(boxX, rect.width - tagW - 4));
        const tagY =
          boxY >= tagH + 4 ? boxY - tagH : Math.min(boxY + 4, rect.height - tagH - 4);

        ctx.fillStyle = labelBg;
        ctx.fillRect(tagX, tagY, tagW, tagH);

        ctx.fillStyle = '#FFFFFF';
        ctx.textBaseline = 'middle';
        ctx.fillText(labelText, tagX + padX, tagY + tagH / 2, tagW - padX * 2);
      };

      // Draw local real-time detections + AR tracking trails
      for (const det of detections) {
        const [rawX, rawY, rawW, rawH] = det.bbox;
        const boxW = rawW * scaleX;
        const boxH = rawH * scaleY;
        const boxX = mirrorHorizontal
          ? rect.width - (offsetX + rawX * scaleX + boxW)
          : offsetX + rawX * scaleX;
        const boxY = offsetY + rawY * scaleY;

        // Draw AR trajectory vector trail + arrowhead when track moves across frames
        if (det.trail && det.trail.length >= 2) {
          ctx.save();
          const trailStroke =
            det.classification === 'negative'
              ? 'rgba(239, 68, 68, 0.9)'
              : det.classification === 'positive'
              ? 'rgba(16, 185, 129, 0.9)'
              : 'rgba(56, 189, 248, 0.9)';
          ctx.strokeStyle = trailStroke;
          ctx.fillStyle = trailStroke;
          ctx.lineWidth = 2;
          ctx.beginPath();
          let lastPx = 0;
          let lastPy = 0;
          let prevPx = 0;
          let prevPy = 0;
          det.trail.forEach(([tx, ty], tIdx) => {
            const px = mirrorHorizontal
              ? rect.width - (offsetX + tx * scaleX)
              : offsetX + tx * scaleX;
            const py = offsetY + ty * scaleY;
            if (tIdx === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
            if (tIdx === det.trail!.length - 2) {
              prevPx = px;
              prevPy = py;
            }
            if (tIdx === det.trail!.length - 1) {
              lastPx = px;
              lastPy = py;
            }
          });
          ctx.stroke();

          // Vector arrowhead at trajectory tip
          const segDx = lastPx - prevPx;
          const segDy = lastPy - prevPy;
          if (Math.hypot(segDx, segDy) > 3) {
            const ang = Math.atan2(segDy, segDx);
            const headLen = 8;
            ctx.beginPath();
            ctx.moveTo(lastPx, lastPy);
            ctx.lineTo(
              lastPx - headLen * Math.cos(ang - Math.PI / 6),
              lastPy - headLen * Math.sin(ang - Math.PI / 6)
            );
            ctx.lineTo(
              lastPx - headLen * Math.cos(ang + Math.PI / 6),
              lastPy - headLen * Math.sin(ang + Math.PI / 6)
            );
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();
        }

        const prefix =
          det.classification === 'negative'
            ? 'NEGATIVE ALERT'
            : det.classification === 'positive'
            ? 'POSITIVE'
            : 'DETECTED';
        const pct = Math.round(det.score * 100);
        const trackPrefix = det.trackId ? `${det.trackId} · ` : '';
        renderBox(
          boxX,
          boxY,
          boxW,
          boxH,
          det.classification,
          `${trackPrefix}${prefix} · ${det.displayLabel.toUpperCase()} · ${pct}%`,
          false
        );
      }

      // Draw fresh global commercial product identifications (valid for 3.5s)
      const gpState = globalProductsRef.current;
      if (gpState.items.length > 0 && Date.now() - gpState.at < 3500) {
        for (const gp of gpState.items) {
          if (!gp.box_2d) continue;
          const [ymin, xmin, ymax, xmax] = gp.box_2d;
          const rawW = ((xmax - xmin) / 1000) * drawW;
          const rawH = ((ymax - ymin) / 1000) * drawH;
          if (rawW < 12 || rawH < 12) continue;

          const rawX = offsetX + (xmin / 1000) * drawW;
          const boxX = mirrorHorizontal
            ? rect.width - (rawX + rawW)
            : rawX;
          const boxY = offsetY + (ymin / 1000) * drawH;

          const prefix =
            gp.classification === 'negative'
              ? 'NEGATIVE ALERT'
              : gp.classification === 'positive'
              ? 'POSITIVE'
              : 'PRODUCT';
          const pct = Math.round(gp.confidence * 100);
          renderBox(
            boxX,
            boxY,
            rawW,
            rawH,
            gp.classification,
            `${prefix} · ${gp.productName.toUpperCase()} · ${pct}%`,
            true
          );
        }
      }

      // Optional Optical Motion / Thermal-Ramp AR layer (real frame-to-frame visible pixel contrast)
      const overlayMode = arOverlayModeRef.current;
      if (overlayMode !== 'standard' && motionGridRef.current) {
        const gridW = 32;
        const gridH = 24;
        const cellW = drawW / gridW;
        const cellH = drawH / gridH;
        const grid = motionGridRef.current;
        for (let gy = 0; gy < gridH; gy += 1) {
          for (let gx = 0; gx < gridW; gx += 1) {
            const delta = grid[gy * gridW + gx];
            if (overlayMode === 'thermal') {
              if (delta > 16) {
                const intensity = Math.min(1, (delta - 16) / 110);
                // Cool Blue (#0B4FE6) -> Amber/Orange -> Crimson Red (#DC2626) heat ramp
                const r = Math.round(11 + intensity * 225);
                const g = Math.round(79 + (intensity < 0.5 ? intensity * 140 : (1 - intensity) * 140));
                const b = Math.round(230 * (1 - intensity));
                const alpha = 0.14 + intensity * 0.44;
                const drawX = mirrorHorizontal
                  ? rect.width - (offsetX + (gx + 1) * cellW)
                  : offsetX + gx * cellW;
                ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
                ctx.fillRect(drawX, offsetY + gy * cellH, cellW + 0.5, cellH + 0.5);
              }
            } else if (delta > 28) {
              const alpha = Math.min(0.45, (delta - 24) / 140);
              const drawX = mirrorHorizontal
                ? rect.width - (offsetX + (gx + 1) * cellW)
                : offsetX + gx * cellW;
              ctx.fillStyle = `rgba(11, 79, 230, ${alpha.toFixed(2)})`;
              ctx.fillRect(drawX, offsetY + gy * cellH, cellW, cellH);
            }
          }
        }
      }

      // Crisp AR telemetry readout strip at bottom-left of HUD when AR overlay or tracks are active
      if (overlayMode !== 'standard' || detections.length > 0) {
        const modeTag =
          overlayMode === 'thermal'
            ? 'THERMAL DELTA'
            : overlayMode === 'motion'
            ? 'MOTION AR'
            : 'AR';
        const hudText = `${modeTag} · ${detections.length} Track${detections.length === 1 ? '' : 's'} · Motion ${lastMotionPctRef.current}% · ${zoomLevelRef.current.toFixed(1)}x`;
        ctx.font = '600 11px "JetBrains Mono", monospace';
        const metrics = ctx.measureText(hudText);
        const pillW = Math.min(rect.width - 16, metrics.width + 16);
        const pillY = rect.height - 30;
        ctx.fillStyle = 'rgba(11, 34, 64, 0.88)';
        ctx.fillRect(10, pillY, pillW, 22);
        ctx.fillStyle = '#F8FAFC';
        ctx.textBaseline = 'middle';
        ctx.fillText(hudText, 18, pillY + 11, pillW - 12);
      }

      ctx.restore();
    },
    []
  );

  // Zero-copy fast detection at 1x zoom; zoomed center-crop detection at >1x zoom
  const runFastDetection = useCallback(
    (source: HTMLVideoElement | HTMLImageElement, srcW: number, srcH: number) => {
      const detector = detectorRef.current;
      if (!detector || srcW === 0 || srcH === 0) return null;

      const zoom = zoomLevelRef.current;
      const isZoomed = zoom > 1.05;
      const currentRules = rulesRef.current;

      let inferSource: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement = source;
      let targetW = srcW;
      let targetH = srcH;

      const t0 = performance.now();

      if (isZoomed) {
        const inferenceWidth = engineModeRef.current === 'accurate' ? 448 : 320;
        if (!offscreenCanvasRef.current) {
          offscreenCanvasRef.current = document.createElement('canvas');
        }
        const offscreen = offscreenCanvasRef.current;
        targetW = inferenceWidth;
        targetH = Math.max(1, Math.round((srcH / srcW) * inferenceWidth));
        if (offscreen.width !== targetW || offscreen.height !== targetH) {
          offscreen.width = targetW;
          offscreen.height = targetH;
        }
        const offCtx = offscreen.getContext('2d', { willReadFrequently: false });
        if (!offCtx) return null;

        const cropW = srcW / zoom;
        const cropH = srcH / zoom;
        const cropX = (srcW - cropW) / 2;
        const cropY = (srcH - cropH) / 2;
        offCtx.drawImage(source, cropX, cropY, cropW, cropH, 0, 0, targetW, targetH);
        inferSource = offscreen;
      }

      const monotonicTs = Math.max(
        lastTimestampMsRef.current + 1,
        Math.round(performance.now())
      );
      lastTimestampMsRef.current = monotonicTs;

      const result = detector.detectForVideo(inferSource, monotonicTs);
      const latencyMs = performance.now() - t0;
      const nowMs = Date.now();

      const detections: DetectedItem[] = [];
      for (let i = 0; i < result.detections.length; i += 1) {
        const det = result.detections[i];
        const cat = det.categories[0];
        const box = det.boundingBox;
        if (!cat || !box) continue;
        if (cat.score < currentRules.confidenceThreshold) continue;

        const rawClass = (cat.categoryName || cat.displayName || 'object').toLowerCase();
        const { classification } = classifyDetection(rawClass, currentRules);

        // Capture a throttled 160x120 JPEG crop thumbnail for 3D Alert & 3D GPS views
        const cacheKey = `${rawClass}:${classification}`;
        let cached = thumbCacheRef.current[cacheKey];
        if (!cached || nowMs - cached.at >= 1600) {
          if (!thumbCanvasRef.current) {
            thumbCanvasRef.current = document.createElement('canvas');
            thumbCanvasRef.current.width = 160;
            thumbCanvasRef.current.height = 120;
          }
          const tCanvas = thumbCanvasRef.current;
          const tCtx = tCanvas.getContext('2d');
          if (tCtx && box.width > 4 && box.height > 4) {
            const padX = box.width * 0.14;
            const padY = box.height * 0.14;
            const sx = Math.max(0, box.originX - padX);
            const sy = Math.max(0, box.originY - padY);
            const sw = Math.min(targetW - sx, box.width + padX * 2);
            const sh = Math.min(targetH - sy, box.height + padY * 2);
            if (sw > 4 && sh > 4) {
              tCtx.fillStyle = '#0F172A';
              tCtx.fillRect(0, 0, 160, 120);
              tCtx.drawImage(inferSource, sx, sy, sw, sh, 0, 0, 160, 120);
              const thumbUrl = tCanvas.toDataURL('image/jpeg', 0.72);
              cached = { url: thumbUrl, at: nowMs };
              thumbCacheRef.current[cacheKey] = cached;
            }
          }
        }

        detections.push({
          id: `${rawClass}-${i}`,
          rawClass,
          displayLabel: formatObjectLabel(rawClass),
          score: cat.score,
          bbox: [box.originX, box.originY, box.width, box.height],
          classification,
          thumbnailUrl: cached?.url,
        });
      }

      // Compute lightweight 32x24 Optical Motion signal delta
      let motionPct = lastMotionPctRef.current;
      if (source instanceof HTMLVideoElement) {
        const mW = 32;
        const mH = 24;
        if (!motionCanvasRef.current) {
          motionCanvasRef.current = document.createElement('canvas');
          motionCanvasRef.current.width = mW;
          motionCanvasRef.current.height = mH;
        }
        const mCtx = motionCanvasRef.current.getContext('2d', { willReadFrequently: true });
        if (mCtx) {
          mCtx.drawImage(inferSource, 0, 0, mW, mH);
          const pixels = mCtx.getImageData(0, 0, mW, mH).data;
          const totalCells = mW * mH;
          if (!motionGridRef.current || motionGridRef.current.length !== totalCells) {
            motionGridRef.current = new Uint8Array(totalCells);
          }
          const curLuma = new Uint8Array(totalCells);
          let activeCells = 0;
          const prev = prevLumaRef.current;
          for (let idx = 0; idx < totalCells; idx += 1) {
            const p = idx * 4;
            const luma = (pixels[p] * 77 + pixels[p + 1] * 150 + pixels[p + 2] * 29) >> 8;
            curLuma[idx] = luma;
            if (prev) {
              const diff = Math.abs(luma - prev[idx]);
              motionGridRef.current[idx] = diff;
              if (diff > 28) activeCells += 1;
            }
          }
          prevLumaRef.current = curLuma;
          motionPct = Math.round((activeCells / totalCells) * 100);
          lastMotionPctRef.current = motionPct;
        }
      }

      const trackedDetections = trackerRef.current.update(detections, nowMs, targetW);
      return { detections: trackedDetections, latencyMs, targetW, targetH, motionPct };
    },
    []
  );

  // Accurate Worldwide Commercial Product & Brand Recognition (/api/identify-products)
  const identifyWorldProducts = useCallback(
    async (source: HTMLVideoElement | HTMLImageElement, srcW: number, srcH: number) => {
      if (globalInFlightRef.current || srcW === 0 || srcH === 0) return;
      globalInFlightRef.current = true;
      setIsIdentifyingGlobal(true);

      try {
        if (!globalSnapCanvasRef.current) {
          globalSnapCanvasRef.current = document.createElement('canvas');
        }
        const snap = globalSnapCanvasRef.current;
        const snapW = 480;
        const snapH = Math.max(1, Math.round((srcH / srcW) * snapW));
        snap.width = snapW;
        snap.height = snapH;
        const ctx = snap.getContext('2d');
        if (!ctx) return;

        const zoom = zoomLevelRef.current;
        const cropW = srcW / zoom;
        const cropH = srcH / zoom;
        const cropX = (srcW - cropW) / 2;
        const cropY = (srcH - cropH) / 2;

        ctx.drawImage(source, cropX, cropY, cropW, cropH, 0, 0, snapW, snapH);
        const dataUrl = snap.toDataURL('image/jpeg', 0.78);
        const imageBase64 = dataUrl.split(',')[1];
        if (!imageBase64) return;

        const currentRules = rulesRef.current;
        const res = await fetch('/api/identify-products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageBase64,
            mimeType: 'image/jpeg',
            positiveRules: currentRules.positive,
            negativeRules: currentRules.negative,
          }),
        });

        const payload = (await res.json()) as {
          products?: Array<{
            productName: string;
            brand: string;
            category: string;
            confidence: number;
            box_2d?: [number, number, number, number];
          }>;
          serverMs?: number;
          error?: string;
        };

        if (!res.ok) {
          setGlobalStatusNote(payload.error || 'World Product AI unavailable.');
          return;
        }

        setGlobalStatusNote(null);
        const mapped: GlobalProductItem[] = (payload.products ?? []).map((p, idx) => {
          const { classification } = classifyDetection(p.productName, currentRules, [
            p.brand,
            p.category,
          ]);

          let thumbnailUrl: string | undefined = dataUrl;
          if (p.box_2d) {
            if (!thumbCanvasRef.current) {
              thumbCanvasRef.current = document.createElement('canvas');
              thumbCanvasRef.current.width = 160;
              thumbCanvasRef.current.height = 120;
            }
            const tCanvas = thumbCanvasRef.current;
            const tCtx = tCanvas.getContext('2d');
            const [ymin, xmin, ymax, xmax] = p.box_2d;
            const sx = Math.max(0, (xmin / 1000) * snapW);
            const sy = Math.max(0, (ymin / 1000) * snapH);
            const sw = Math.max(12, Math.min(snapW - sx, ((xmax - xmin) / 1000) * snapW));
            const sh = Math.max(12, Math.min(snapH - sy, ((ymax - ymin) / 1000) * snapH));
            if (tCtx && sw > 8 && sh > 8) {
              tCtx.fillStyle = '#0F172A';
              tCtx.fillRect(0, 0, 160, 120);
              tCtx.drawImage(snap, sx, sy, sw, sh, 0, 0, 160, 120);
              thumbnailUrl = tCanvas.toDataURL('image/jpeg', 0.75);
            }
          }

          return {
            id: `gp-${idx}-${p.productName}`,
            productName: p.productName,
            brand: p.brand,
            category: p.category,
            confidence: p.confidence,
            classification,
            box_2d: p.box_2d,
            thumbnailUrl,
          };
        });

        globalProductsRef.current = { items: mapped, at: Date.now() };
        setGlobalProducts(mapped);
        onGlobalProductsResultRef.current(mapped, payload.serverMs ?? 400);
      } catch {
        setGlobalStatusNote('World Product AI network error.');
      } finally {
        globalInFlightRef.current = false;
        setIsIdentifyingGlobal(false);
      }
    },
    []
  );

  // Trigger instant manual or periodic World Product scan
  const handleScanProductNow = useCallback(() => {
    if (isCameraActive && videoRef.current && videoRef.current.videoWidth > 0) {
      void identifyWorldProducts(
        videoRef.current,
        videoRef.current.videoWidth,
        videoRef.current.videoHeight
      );
    } else if (testImageUrl && imageRef.current && imageRef.current.naturalWidth > 0) {
      void identifyWorldProducts(
        imageRef.current,
        imageRef.current.naturalWidth,
        imageRef.current.naturalHeight
      );
    }
  }, [isCameraActive, testImageUrl, identifyWorldProducts]);

  // Continuous 1.1s World Product scan cadence when World Products AI is enabled
  useEffect(() => {
    if (!isCameraActive || !worldProductsEnabled) return;

    // Fire an initial scan quickly after stream starts
    const initialTimer = window.setTimeout(() => {
      const video = videoRef.current;
      if (video && video.readyState >= 2 && video.videoWidth > 0) {
        void identifyWorldProducts(video, video.videoWidth, video.videoHeight);
      }
    }, 350);

    const interval = window.setInterval(() => {
      const video = videoRef.current;
      if (video && video.readyState >= 2 && video.videoWidth > 0) {
        void identifyWorldProducts(video, video.videoWidth, video.videoHeight);
      }
    }, 1100);

    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [isCameraActive, worldProductsEnabled, identifyWorldProducts]);

  const stopStream = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    lastVideoTimeRef.current = -1;
  }, []);

  useEffect(() => {
    if (!isCameraActive) {
      stopStream();
      trackerRef.current.reset();
      if (!testImageUrl) {
        clearCanvas();
        globalProductsRef.current = { items: [], at: 0 };
        setGlobalProducts([]);
      }
      return;
    }

    let cancelled = false;
    setTestImageUrl(null);
    setCameraError(null);

    const openStream = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('Camera API is not supported in this browser or context.');
        onStopCamera();
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30 },
          },
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
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof Error && err.name === 'NotAllowedError'
            ? 'Camera permission was denied. Allow camera access in your browser or upload a photo to test.'
            : 'Unable to access camera hardware. Check your webcam connection or upload a test photo.';
        setCameraError(message);
        onStopCamera();
      }
    };

    void openStream();
    return () => {
      cancelled = true;
      stopStream();
    };
  }, [isCameraActive, facingMode, stopStream, clearCanvas, onStopCamera, testImageUrl]);

  useEffect(() => {
    if (!isCameraActive) return;

    let active = true;

    const tick = () => {
      if (!active) return;

      const video = videoRef.current;
      if (
        video &&
        detectorRef.current &&
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        video.currentTime !== lastVideoTimeRef.current
      ) {
        lastVideoTimeRef.current = video.currentTime;
        const output = runFastDetection(video, video.videoWidth, video.videoHeight);
        if (output) {
          drawOverlay(
            output.detections,
            output.targetW,
            output.targetH,
            facingMode === 'user'
          );
          onFrameResultRef.current(output.detections, output.latencyMs, output.motionPct);
        }
      }

      if (active) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      active = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isCameraActive, facingMode, drawOverlay, runFastDetection]);

  const analyzeTestImage = useCallback(() => {
    const img = imageRef.current;
    if (!img || !detectorRef.current || !img.complete || img.naturalWidth === 0) return;

    const output = runFastDetection(img, img.naturalWidth, img.naturalHeight);
    if (output) {
      drawOverlay(output.detections, output.targetW, output.targetH, false);
      onFrameResultRef.current(output.detections, output.latencyMs);
    }

    if (worldProductsEnabled) {
      void identifyWorldProducts(img, img.naturalWidth, img.naturalHeight).then(() => {
        if (output) {
          drawOverlay(output.detections, output.targetW, output.targetH, false);
        }
      });
    }
  }, [drawOverlay, runFastDetection, worldProductsEnabled, identifyWorldProducts]);

  useEffect(() => {
    if (testImageUrl && modelStatus === 'ready') {
      analyzeTestImage();
    }
  }, [testImageUrl, modelStatus, rules, zoomLevel, engineMode, analyzeTestImage]);

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (isCameraActive) {
      onStopCamera();
    }
    setCameraError(null);
    globalProductsRef.current = { items: [], at: 0 };
    setGlobalProducts([]);
    const url = URL.createObjectURL(file);
    setTestImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
    e.target.value = '';
  };

  const handleClearTestImage = () => {
    setTestImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    globalProductsRef.current = { items: [], at: 0 };
    setGlobalProducts([]);
    clearCanvas();
  };

  const handleOpenFullCamera = () => {
    setIsFullCamera(true);
    if (!isCameraActive && !testImageUrl) {
      onStartCamera();
    }
  };

  const handleCaptureSnapshot = useCallback(() => {
    const video = videoRef.current;
    const img = imageRef.current;
    const overlay = canvasRef.current;

    const useVideo = isCameraActive && video && video.videoWidth > 0;
    const useImg = !isCameraActive && Boolean(testImageUrl) && img && img.naturalWidth > 0;
    if (!useVideo && !useImg) return;

    const srcW = useVideo ? video!.videoWidth : img!.naturalWidth;
    const srcH = useVideo ? video!.videoHeight : img!.naturalHeight;

    const snap = document.createElement('canvas');
    snap.width = srcW;
    snap.height = srcH;
    const ctx = snap.getContext('2d');
    if (!ctx) return;

    const zoom = zoomLevelRef.current;
    const cropW = srcW / zoom;
    const cropH = srcH / zoom;
    const cropX = (srcW - cropW) / 2;
    const cropY = (srcH - cropH) / 2;

    ctx.save();
    if (useVideo && facingMode === 'user') {
      ctx.translate(srcW, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(
      useVideo ? video! : img!,
      cropX,
      cropY,
      cropW,
      cropH,
      0,
      0,
      srcW,
      srcH
    );
    ctx.restore();

    if (overlay && overlay.width > 0 && overlay.height > 0) {
      ctx.drawImage(overlay, 0, 0, srcW, srcH);
    }

    // Crisp forensic timestamp stamp
    const stamp = `GAZVA Vision Guard · ${new Date().toISOString()} · Zoom ${zoom.toFixed(1)}x`;
    ctx.fillStyle = 'rgba(11, 34, 64, 0.86)';
    ctx.fillRect(0, srcH - 28, srcW, 28);
    ctx.fillStyle = '#F8FAFC';
    ctx.font = '600 13px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(stamp, 12, srcH - 14, srcW - 24);

    const url = snap.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `gazva-snap-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
    a.click();
  }, [isCameraActive, testImageUrl, facingMode]);

  const mediaTransform =
    facingMode === 'user' && isCameraActive
      ? `scaleX(-${zoomLevel}) scaleY(${zoomLevel})`
      : `scale(${zoomLevel})`;

  return (
    <div className="flex flex-col gap-3">
      {/* Main Camera Viewport (expands to full-screen on mobile/desktop when Full Camera is active) */}
      <div
        ref={containerRef}
        className={
          isFullCamera
            ? `fixed inset-0 z-50 bg-black overflow-hidden flex flex-col ${
                isSirenSounding ? 'ring-4 ring-inset ring-red-600' : ''
              }`
            : `relative w-full aspect-[4/5] sm:aspect-video bg-slate-950 rounded-3xl overflow-hidden border transition-colors ${
                isSirenSounding
                  ? 'border-red-600 ring-4 ring-red-500/40'
                  : 'border-slate-200/80 dark:border-slate-800'
              }`
        }
      >
        <video
          ref={videoRef}
          playsInline
          muted
          style={{ transform: mediaTransform, transformOrigin: 'center center' }}
          className={`w-full h-full object-contain ${
            isCameraActive ? 'block' : 'hidden'
          }`}
        />

        {testImageUrl && !isCameraActive && (
          <img
            ref={imageRef}
            src={testImageUrl}
            alt="Uploaded object analysis frame"
            style={{
              transform: `scale(${zoomLevel})`,
              transformOrigin: 'center center',
            }}
            onLoad={() => {
              if (modelStatus === 'ready') {
                analyzeTestImage();
              }
            }}
            className="w-full h-full object-contain"
          />
        )}

        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
        />

        {(isCameraActive || testImageUrl) && zoomLevel > 1.05 && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <Crosshair className="w-7 h-7 text-white/45" />
          </div>
        )}

        {/* Top HUD Strip */}
        <div className="absolute top-3 inset-x-3 flex items-start justify-between gap-2 pointer-events-none">
          <div className="flex flex-col gap-1.5 pointer-events-auto">
            {(isCameraActive || testImageUrl) && lastLatencyMs !== null && (
              <div className="inline-flex items-center gap-2 bg-slate-950/85 text-white px-3 py-1.5 rounded-lg border border-white/15 backdrop-blur-xs">
                <Zap className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="text-xs font-medium text-slate-300">Speed</span>
                <span
                  className={`text-sm font-mono font-bold tabular-nums ${
                    lastLatencyMs < 1000 ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                >
                  {Math.round(lastLatencyMs)} ms
                </span>
                <span className="text-slate-500" aria-hidden="true">
                  ·
                </span>
                <span className="text-[11px] font-mono font-semibold text-slate-200 tabular-nums">
                  {zoomLevel.toFixed(1)}x
                </span>
              </div>
            )}

            {worldProductsEnabled &&
              globalProducts.length > 0 &&
              (isCameraActive || testImageUrl) && (
                <div className="bg-slate-950/85 text-white px-3 py-2 rounded-lg border border-white/15 backdrop-blur-xs max-w-[260px] sm:max-w-xs">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300 mb-1">
                    <Globe className="w-3.5 h-3.5 text-[#E8922D] shrink-0" />
                    <span>World Product ID</span>
                    {isIdentifyingGlobal && (
                      <span className="text-slate-400 font-mono">· Live</span>
                    )}
                  </div>
                  <div className="space-y-1">
                    {globalProducts.slice(0, 3).map((gp) => (
                      <div key={gp.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-semibold truncate">{gp.productName}</span>
                        <span
                          className={`font-mono text-[10px] font-bold uppercase shrink-0 ${
                            gp.classification === 'negative'
                              ? 'text-red-400'
                              : gp.classification === 'positive'
                              ? 'text-emerald-400'
                              : 'text-slate-300'
                          }`}
                        >
                          {gp.classification}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
          </div>

          <div className="flex items-center gap-2 pointer-events-auto">
            {testImageUrl && !isCameraActive && (
              <button
                type="button"
                onClick={handleClearTestImage}
                className="px-3 py-2 text-xs font-semibold bg-slate-950/85 text-white hover:bg-slate-900 rounded-lg border border-white/15 min-h-[40px] cursor-pointer"
              >
                Close Photo
              </button>
            )}

            <button
              type="button"
              onClick={() => (isFullCamera ? setIsFullCamera(false) : handleOpenFullCamera())}
              aria-label={isFullCamera ? 'Exit Full Camera' : 'Open Full Camera'}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-slate-950/85 text-white hover:bg-slate-900 rounded-lg border border-white/15 min-h-[40px] cursor-pointer"
            >
              {isFullCamera ? (
                <>
                  <Minimize2 className="w-4 h-4" />
                  <span>Exit Full</span>
                </>
              ) : (
                <>
                  <Maximize2 className="w-4 h-4" />
                  <span>Full Camera</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Standby / Error Overlay */}
        {!isCameraActive && !testImageUrl && (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-slate-900 text-white">
            {cameraError ? (
              <div className="max-w-md space-y-4">
                <div className="w-12 h-12 rounded-xl bg-red-500/15 text-red-400 flex items-center justify-center mx-auto">
                  <CameraOff className="w-6 h-6" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-white">
                    Camera Feed Unavailable
                  </h2>
                  <p className="text-sm text-slate-300 mt-1">{cameraError}</p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={onStartCamera}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold bg-white text-slate-900 hover:bg-slate-100 rounded-lg min-h-[44px] cursor-pointer"
                  >
                    <RefreshCw className="w-4 h-4" />
                    <span>Retry Camera</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold bg-slate-800 text-white hover:bg-slate-700 border border-slate-700 rounded-lg min-h-[44px] cursor-pointer"
                  >
                    <ImagePlus className="w-4 h-4" />
                    <span>Test with Photo</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="max-w-md space-y-4">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#0B4FE6] to-[#DC2626] p-0.5 mx-auto">
                  <div className="w-full h-full rounded-[14px] bg-slate-950 flex items-center justify-center">
                    <Video className="w-7 h-7 text-white" />
                  </div>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white tracking-tight">
                    Ready for Real-Time Vision & AR Scanning
                  </h2>
                  <p className="text-sm text-slate-300 mt-1">
                    {modelStatus === 'loading'
                      ? `Loading ${
                          engineMode === 'accurate' ? 'High-Accuracy Lite2' : 'Turbo Lite0'
                        } engine...`
                      : modelStatus === 'error'
                      ? modelError
                      : 'Open live camera or full-screen mode to identify objects, motion signatures, and global products.'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2.5">
                  <button
                    type="button"
                    onClick={onStartCamera}
                    className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-[#0B4FE6] text-white hover:bg-[#1D4ED8] rounded-2xl transition-colors min-h-[44px] cursor-pointer shadow-sm"
                  >
                    <Camera className="w-4 h-4" />
                    <span>Start Camera</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleOpenFullCamera}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold bg-white/10 text-white hover:bg-white/20 border border-white/20 rounded-2xl transition-colors min-h-[44px] cursor-pointer"
                  >
                    <Maximize2 className="w-4 h-4" />
                    <span>Full Screen</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold bg-red-600/20 text-red-200 hover:bg-red-600/35 border border-red-500/40 rounded-2xl transition-colors min-h-[44px] cursor-pointer"
                  >
                    <ImagePlus className="w-4 h-4" />
                    <span>Test Photo</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Full-Camera Floating Bottom Thumb Dock */}
        {isFullCamera && (
          <div className="absolute inset-x-0 bottom-0 p-4 pb-6 bg-gradient-to-t from-black/95 via-black/80 to-transparent text-white space-y-3">
            {isSirenSounding && (
              <button
                type="button"
                onClick={onAcknowledgeAlert}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold bg-red-600 text-white hover:bg-red-700 rounded-xl min-h-[48px] cursor-pointer"
              >
                <AlertTriangle className="w-5 h-5" />
                <span>
                  STOP SIREN · {activeNegativeLabels.join(', ') || 'Negative Object'}
                </span>
              </button>
            )}

            <div className="flex items-center gap-3 bg-white/10 backdrop-blur-md px-3.5 py-2.5 rounded-xl border border-white/15">
              <ZoomIn className="w-4 h-4 text-slate-200 shrink-0" />
              <input
                type="range"
                min={1}
                max={8}
                step={0.1}
                value={zoomLevel}
                onChange={(e) => setZoomLevel(Number(e.target.value))}
                aria-label="Digital zoom magnification"
                className="flex-1 accent-[#E8922D] cursor-pointer"
              />
              <span className="text-xs font-mono font-bold tabular-nums w-10 text-right">
                {zoomLevel.toFixed(1)}x
              </span>
              {zoomLevel > 1 && (
                <button
                  type="button"
                  onClick={() => setZoomLevel(1)}
                  className="text-xs font-semibold text-[#E8922D] px-1.5 py-1 cursor-pointer"
                >
                  Reset
                </button>
              )}
            </div>

            <div className="grid grid-cols-5 gap-2">
              <button
                type="button"
                onClick={isCameraActive ? onStopCamera : onStartCamera}
                className={`flex flex-col items-center justify-center gap-1 py-2.5 px-1 rounded-xl text-[11px] font-semibold min-h-[52px] cursor-pointer ${
                  isCameraActive ? 'bg-red-600 text-white' : 'bg-[#E8922D] text-slate-950'
                }`}
              >
                {isCameraActive ? <CameraOff className="w-4 h-4" /> : <Camera className="w-4 h-4" />}
                <span>{isCameraActive ? 'Stop' : 'Start'}</span>
              </button>

              <button
                type="button"
                onClick={handleScanProductNow}
                className="flex flex-col items-center justify-center gap-1 py-2.5 px-1 rounded-xl bg-white/10 text-white text-[11px] font-semibold min-h-[52px] cursor-pointer"
              >
                <ScanSearch className="w-4 h-4" />
                <span>Scan</span>
              </button>

              <button
                type="button"
                onClick={() =>
                  setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'))
                }
                className="flex flex-col items-center justify-center gap-1 py-2.5 px-1 rounded-xl bg-white/10 text-white text-[11px] font-semibold min-h-[52px] cursor-pointer"
              >
                <SwitchCamera className="w-4 h-4" />
                <span>Flip</span>
              </button>

              <button
                type="button"
                onClick={onToggleMute}
                className={`flex flex-col items-center justify-center gap-1 py-2.5 px-1 rounded-xl text-[11px] font-semibold min-h-[52px] cursor-pointer ${
                  sirenMuted ? 'bg-amber-500 text-slate-950' : 'bg-white/10 text-white'
                }`}
              >
                {sirenMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                <span>{sirenMuted ? 'Muted' : 'Siren'}</span>
              </button>

              <button
                type="button"
                onClick={() => setIsFullCamera(false)}
                className="flex flex-col items-center justify-center gap-1 py-2.5 px-1 rounded-xl bg-white/10 text-white text-[11px] font-semibold min-h-[52px] cursor-pointer"
              >
                <Minimize2 className="w-4 h-4" />
                <span>Exit</span>
              </button>
            </div>
          </div>
        )}

        {/* Standard Viewport Negative Alert Bar */}
        {!isFullCamera && isSirenSounding && (
          <div className="absolute inset-x-0 bottom-0 p-3 sm:p-4 bg-gradient-to-t from-red-950 via-red-900/95 to-red-900/80 text-white border-t border-red-500 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-lg bg-red-600 flex items-center justify-center shrink-0">
                <ShieldAlert className="w-6 h-6 text-white" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-mono font-bold uppercase tracking-wider text-red-200">
                  Negative Object Alert · Siren Active
                </div>
                <div className="text-sm sm:text-base font-bold truncate">
                  Detected: {activeNegativeLabels.join(', ') || 'Restricted Object'}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={onAcknowledgeAlert}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-bold bg-white text-red-700 hover:bg-red-50 rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[44px] cursor-pointer"
            >
              <AlertTriangle className="w-4 h-4" />
              <span>Stop Siren & Acknowledge</span>
            </button>
          </div>
        )}
      </div>

      {/* Digital Zoom Slider, AR Thermal/Motion Overlay & Engine Switch */}
      <div className="flex flex-col gap-3 bg-slate-50 dark:bg-slate-900/70 border border-slate-200/90 dark:border-slate-800 rounded-2xl p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-[200px]">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap shrink-0">
              <ZoomIn className="w-4 h-4 text-[#0B4FE6]" />
              <span>Digital Zoom</span>
            </div>
            <input
              type="range"
              min={1}
              max={8}
              step={0.1}
              value={zoomLevel}
              onChange={(e) => setZoomLevel(Number(e.target.value))}
              aria-label="Digital zoom magnification slider"
              className="flex-1 min-w-[110px] accent-[#0B4FE6] cursor-pointer"
            />
            <span className="text-xs font-mono font-bold text-[#0B4FE6] dark:text-blue-400 tabular-nums w-11 text-right shrink-0">
              {zoomLevel.toFixed(1)}x
            </span>
            {zoomLevel > 1 && (
              <button
                type="button"
                onClick={() => setZoomLevel(1)}
                className="px-2.5 py-1 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:text-slate-900 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
              >
                1x
              </button>
            )}
          </div>

          {/* Model Speed Segmented Control (iOS style) */}
          <div className="flex items-center gap-1 p-1 bg-slate-200/80 dark:bg-slate-800 rounded-xl">
            <button
              type="button"
              onClick={() => setEngineMode('fast')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap min-h-[34px] cursor-pointer ${
                engineMode === 'fast'
                  ? 'bg-white dark:bg-slate-950 text-[#0B4FE6] dark:text-blue-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              Turbo Speed
            </button>
            <button
              type="button"
              onClick={() => setEngineMode('accurate')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap min-h-[34px] cursor-pointer ${
                engineMode === 'accurate'
                  ? 'bg-white dark:bg-slate-950 text-[#0B4FE6] dark:text-blue-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              High Accuracy
            </button>
          </div>
        </div>

        {/* Overlay Mode & World Products Strip */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200/70 dark:border-slate-800">
          <div className="flex items-center gap-1 p-1 bg-slate-200/80 dark:bg-slate-800 rounded-xl">
            {(
              [
                { id: 'standard', label: 'Standard AR', icon: Crosshair },
                { id: 'motion', label: 'Motion Blue', icon: Zap },
                { id: 'thermal', label: 'Thermal Delta', icon: Flame },
              ] as const
            ).map((m) => {
              const Icon = m.icon;
              const active = arOverlayMode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setArOverlayMode(m.id)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap min-h-[34px] cursor-pointer ${
                    active
                      ? m.id === 'thermal'
                        ? 'bg-red-600 text-white shadow-xs'
                        : m.id === 'motion'
                        ? 'bg-[#0B4FE6] text-white shadow-xs'
                        : 'bg-white dark:bg-slate-950 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{m.label}</span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => setWorldProductsEnabled((v) => !v)}
            aria-pressed={worldProductsEnabled}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl border transition-colors whitespace-nowrap min-h-[38px] cursor-pointer ${
              worldProductsEnabled
                ? 'bg-[#0B4FE6] text-white border-[#0B4FE6]'
                : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-300 dark:border-slate-700 hover:bg-slate-100'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>World Products {worldProductsEnabled ? 'On' : 'Off'}</span>
          </button>
        </div>
      </div>

      {/* Camera Hardware & Quick Actions Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span className="font-semibold text-slate-800 dark:text-slate-200">
            {modelStatus === 'loading'
              ? 'Loading Fast Vision Engine...'
              : modelStatus === 'ready'
              ? `${
                  engineMode === 'accurate' ? 'High-Accuracy Lite2' : 'Turbo Lite0'
                } Ready (${delegateLabel})`
              : 'Engine Error'}
          </span>
          <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
            ·
          </span>
          <span>
            {isCameraActive
              ? facingMode === 'environment'
                ? 'Rear Camera'
                : 'Front Camera'
              : testImageUrl
              ? 'Static Photo Analysis'
              : 'Camera Standby'}
          </span>
          {globalStatusNote && (
            <>
              <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
                ·
              </span>
              <span className="text-amber-700 dark:text-amber-400">{globalStatusNote}</span>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(isCameraActive || testImageUrl) && (
            <>
              <button
                type="button"
                onClick={handleScanProductNow}
                disabled={isIdentifyingGlobal}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-[#0B4FE6] hover:bg-[#1D4ED8] rounded-xl transition-colors whitespace-nowrap min-h-[40px] cursor-pointer disabled:opacity-50"
              >
                <ScanSearch className="w-4 h-4" />
                <span>{isIdentifyingGlobal ? 'Scanning...' : 'Scan Product'}</span>
              </button>

              <button
                type="button"
                onClick={handleCaptureSnapshot}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-xl transition-colors whitespace-nowrap min-h-[40px] cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>Save Snap</span>
              </button>
            </>
          )}

          <button
            type="button"
            onClick={handleOpenFullCamera}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[#0B4FE6] dark:text-blue-400 bg-blue-50 dark:bg-blue-950/50 border border-blue-200/80 dark:border-blue-800/80 hover:bg-blue-100 dark:hover:bg-blue-900/60 rounded-xl transition-colors whitespace-nowrap min-h-[40px] cursor-pointer"
          >
            <Maximize2 className="w-4 h-4" />
            <span>Full Camera</span>
          </button>

          <button
            type="button"
            onClick={() =>
              setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'))
            }
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-xl transition-colors whitespace-nowrap min-h-[40px] cursor-pointer"
          >
            <SwitchCamera className="w-4 h-4" />
            <span>Flip Camera</span>
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/70 hover:bg-red-100 dark:hover:bg-red-900/50 rounded-xl transition-colors whitespace-nowrap min-h-[40px] cursor-pointer"
          >
            <ImagePlus className="w-4 h-4" />
            <span>Analyze Photo</span>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handlePhotoUpload}
            className="hidden"
          />
        </div>
      </div>
    </div>
  );
};
