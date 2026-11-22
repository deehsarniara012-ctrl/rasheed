import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as tf from '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import {
  AlertTriangle,
  Camera,
  CameraOff,
  ImagePlus,
  RefreshCw,
  ShieldAlert,
  SwitchCamera,
  Video,
} from 'lucide-react';
import { DetectedItem, VisionRules } from '../types/vision';
import { classifyDetection, formatObjectLabel } from '../utils/classifier';

interface CameraMonitorProps {
  rules: VisionRules;
  isCameraActive: boolean;
  isSirenSounding: boolean;
  activeNegativeLabels: string[];
  lastLatencyMs: number | null;
  onStartCamera: () => void;
  onStopCamera: () => void;
  onAcknowledgeAlert: () => void;
  onFrameResult: (detections: DetectedItem[], latencyMs: number) => void;
}

export const CameraMonitor: React.FC<CameraMonitorProps> = ({
  rules,
  isCameraActive,
  isSirenSounding,
  activeNegativeLabels,
  lastLatencyMs,
  onStartCamera,
  onStopCamera,
  onAcknowledgeAlert,
  onFrameResult,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const modelRef = useRef<cocoSsd.ObjectDetection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const inferringRef = useRef(false);

  const rulesRef = useRef(rules);
  rulesRef.current = rules;

  const onFrameResultRef = useRef(onFrameResult);
  onFrameResultRef.current = onFrameResult;

  const [modelStatus, setModelStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [modelError, setModelError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [testImageUrl, setTestImageUrl] = useState<string | null>(null);

  // Load and warm up TensorFlow.js COCO-SSD model once on mount
  useEffect(() => {
    let cancelled = false;

    const initModel = async () => {
      try {
        setModelStatus('loading');
        setModelError(null);
        await tf.ready();
        try {
          if (tf.getBackend() !== 'webgl') {
            await tf.setBackend('webgl');
          }
        } catch {
          // Fallback to default backend if WebGL is unavailable
        }
        const loaded = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
        if (cancelled) return;

        // Warm up WebGL shaders on a tiny canvas so first live frame runs in <100ms
        const warmupCanvas = document.createElement('canvas');
        warmupCanvas.width = 64;
        warmupCanvas.height = 64;
        await loaded.detect(warmupCanvas, 1, 0.5);

        if (cancelled) return;
        modelRef.current = loaded;
        setModelStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setModelStatus('error');
        setModelError(
          err instanceof Error ? err.message : 'Unable to load object detection model.'
        );
      }
    };

    void initModel();
    return () => {
      cancelled = true;
    };
  }, []);

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

      // Map source media coordinates into object-contain viewport box
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

      for (const det of detections) {
        const [rawX, rawY, rawW, rawH] = det.bbox;
        const boxW = rawW * scaleX;
        const boxH = rawH * scaleY;
        const boxX = mirrorHorizontal
          ? rect.width - (offsetX + rawX * scaleX + boxW)
          : offsetX + rawX * scaleX;
        const boxY = offsetY + rawY * scaleY;

        const isPositive = det.classification === 'positive';
        const isNegative = det.classification === 'negative';

        const strokeColor = isNegative
          ? '#DC2626'
          : isPositive
          ? '#16A34A'
          : '#64748B';
        const fillColor = isNegative
          ? 'rgba(220, 38, 38, 0.22)'
          : isPositive
          ? 'rgba(22, 163, 74, 0.14)'
          : 'rgba(100, 116, 139, 0.08)';
        const labelBg = isNegative
          ? '#DC2626'
          : isPositive
          ? '#16A34A'
          : '#334155';

        // Fill & bounding box
        ctx.fillStyle = fillColor;
        ctx.fillRect(boxX, boxY, boxW, boxH);

        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = isNegative ? 3.5 : isPositive ? 3 : 1.75;
        if (det.classification === 'neutral') {
          ctx.setLineDash([6, 4]);
        } else {
          ctx.setLineDash([]);
        }
        ctx.strokeRect(boxX, boxY, boxW, boxH);
        ctx.setLineDash([]);

        // High-contrast corner brackets for Positive & Negative
        if (isPositive || isNegative) {
          const bracket = Math.min(18, boxW * 0.25, boxH * 0.25);
          ctx.lineWidth = 4;
          ctx.beginPath();
          // Top-left
          ctx.moveTo(boxX, boxY + bracket);
          ctx.lineTo(boxX, boxY);
          ctx.lineTo(boxX + bracket, boxY);
          // Top-right
          ctx.moveTo(boxX + boxW - bracket, boxY);
          ctx.lineTo(boxX + boxW, boxY);
          ctx.lineTo(boxX + boxW, boxY + bracket);
          // Bottom-left
          ctx.moveTo(boxX, boxY + boxH - bracket);
          ctx.lineTo(boxX, boxY + boxH);
          ctx.lineTo(boxX + bracket, boxY + boxH);
          // Bottom-right
          ctx.moveTo(boxX + boxW - bracket, boxY + boxH);
          ctx.lineTo(boxX + boxW, boxY + boxH);
          ctx.lineTo(boxX + boxW, boxY + boxH - bracket);
          ctx.stroke();
        }

        // Crisp rectangular label tag
        const prefix = isNegative
          ? 'NEGATIVE ALERT'
          : isPositive
          ? 'POSITIVE'
          : 'NEUTRAL';
        const pct = Math.round(det.score * 100);
        const text = `${prefix} · ${det.displayLabel.toUpperCase()} · ${pct}%`;

        ctx.font = '700 12px "Plus Jakarta Sans", sans-serif';
        const textMetrics = ctx.measureText(text);
        const padX = 8;
        const tagH = 24;
        const tagW = Math.min(rect.width - 8, textMetrics.width + padX * 2);
        const tagX = Math.max(4, Math.min(boxX, rect.width - tagW - 4));
        const tagY = boxY >= tagH + 4 ? boxY - tagH : Math.min(boxY + 4, rect.height - tagH - 4);

        ctx.fillStyle = labelBg;
        ctx.fillRect(tagX, tagY, tagW, tagH);

        ctx.fillStyle = '#FFFFFF';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, tagX + padX, tagY + tagH / 2, tagW - padX * 2);
      }

      ctx.restore();
    },
    []
  );

  // Stop active camera stream & loop
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
    inferringRef.current = false;
  }, []);

  // Manage camera stream lifecycle
  useEffect(() => {
    if (!isCameraActive) {
      stopStream();
      if (!testImageUrl) {
        clearCanvas();
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
            width: { ideal: 1280 },
            height: { ideal: 720 },
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

  // Real-time continuous inference loop
  useEffect(() => {
    if (!isCameraActive) return;

    let active = true;

    const analyzeFrame = async () => {
      if (!active) return;

      const video = videoRef.current;
      const model = modelRef.current;

      if (
        video &&
        model &&
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        !inferringRef.current
      ) {
        inferringRef.current = true;
        try {
          const currentRules = rulesRef.current;
          const t0 = performance.now();
          const predictions = await model.detect(
            video,
            12,
            currentRules.confidenceThreshold
          );
          const latencyMs = performance.now() - t0;

          if (!active) return;

          const detections: DetectedItem[] = predictions.map((pred, idx) => {
            const { classification } = classifyDetection(pred.class, currentRules);
            return {
              id: `${pred.class}-${idx}`,
              rawClass: pred.class,
              displayLabel: formatObjectLabel(pred.class),
              score: pred.score,
              bbox: pred.bbox,
              classification,
            };
          });

          drawOverlay(
            detections,
            video.videoWidth,
            video.videoHeight,
            facingMode === 'user'
          );
          onFrameResultRef.current(detections, latencyMs);
        } catch {
          // Skip transient frame errors
        } finally {
          inferringRef.current = false;
        }
      }

      if (active) {
        rafRef.current = requestAnimationFrame(() => {
          void analyzeFrame();
        });
      }
    };

    rafRef.current = requestAnimationFrame(() => {
      void analyzeFrame();
    });

    return () => {
      active = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isCameraActive, facingMode, drawOverlay]);

  // Analyze uploaded test photo whenever photo or rules change
  const analyzeTestImage = useCallback(async () => {
    const img = imageRef.current;
    const model = modelRef.current;
    if (!img || !model || !img.complete || img.naturalWidth === 0) return;

    const currentRules = rulesRef.current;
    const t0 = performance.now();
    const predictions = await model.detect(img, 12, currentRules.confidenceThreshold);
    const latencyMs = performance.now() - t0;

    const detections: DetectedItem[] = predictions.map((pred, idx) => {
      const { classification } = classifyDetection(pred.class, currentRules);
      return {
        id: `img-${pred.class}-${idx}`,
        rawClass: pred.class,
        displayLabel: formatObjectLabel(pred.class),
        score: pred.score,
        bbox: pred.bbox,
        classification,
      };
    });

    drawOverlay(detections, img.naturalWidth, img.naturalHeight, false);
    onFrameResultRef.current(detections, latencyMs);
  }, [drawOverlay]);

  useEffect(() => {
    if (testImageUrl && modelStatus === 'ready') {
      void analyzeTestImage();
    }
  }, [testImageUrl, modelStatus, rules, analyzeTestImage]);

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (isCameraActive) {
      onStopCamera();
    }
    setCameraError(null);
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
    clearCanvas();
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Main Camera Viewport */}
      <div
        ref={containerRef}
        className={`relative w-full aspect-video sm:aspect-[16/10] bg-slate-950 rounded-xl overflow-hidden border transition-colors ${
          isSirenSounding
            ? 'border-red-600 ring-4 ring-red-500/40'
            : 'border-slate-200'
        }`}
      >
        {/* Live Video Element */}
        <video
          ref={videoRef}
          playsInline
          muted
          className={`w-full h-full object-contain ${
            isCameraActive ? 'block' : 'hidden'
          } ${facingMode === 'user' ? 'scale-x-[-1]' : ''}`}
        />

        {/* Test Photo Element */}
        {testImageUrl && !isCameraActive && (
          <img
            ref={imageRef}
            src={testImageUrl}
            alt="Uploaded object analysis frame"
            onLoad={() => {
              if (modelStatus === 'ready') {
                void analyzeTestImage();
              }
            }}
            className="w-full h-full object-contain"
          />
        )}

        {/* Bounding Box Canvas Overlay */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
        />

        {/* Top-Left Live Speed Overlay when detecting */}
        {(isCameraActive || testImageUrl) && lastLatencyMs !== null && (
          <div className="absolute top-3 left-3 flex items-center gap-2 bg-slate-950/85 text-white px-3 py-1.5 rounded-lg border border-white/15 backdrop-blur-xs">
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
            <span className="text-[11px] font-medium text-slate-300">
              {lastLatencyMs < 1000 ? '< 1000ms OK' : 'Slow'}
            </span>
          </div>
        )}

        {/* Clear Test Photo Button */}
        {testImageUrl && !isCameraActive && (
          <button
            type="button"
            onClick={handleClearTestImage}
            className="absolute top-3 right-3 px-3 py-1.5 text-xs font-semibold bg-slate-950/85 text-white hover:bg-slate-900 rounded-lg border border-white/15 min-h-[36px] cursor-pointer"
          >
            Close Photo
          </button>
        )}

        {/* Idle / Error / Loading State inside Viewport */}
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
                <div className="w-14 h-14 rounded-xl bg-white/10 text-white flex items-center justify-center mx-auto">
                  <Video className="w-7 h-7" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-white">
                    Ready for Sub-Second Object Analysis
                  </h2>
                  <p className="text-sm text-slate-300 mt-1">
                    {modelStatus === 'loading'
                      ? 'Preparing local neural vision engine for <1000ms detection...'
                      : modelStatus === 'error'
                      ? modelError
                      : 'Start the live camera to highlight Positive objects in green and trigger the siren on Negative objects.'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2.5">
                  <button
                    type="button"
                    onClick={onStartCamera}
                    className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-[#E8922D] text-slate-950 hover:bg-[#f09e3d] rounded-lg transition-colors min-h-[44px] cursor-pointer"
                  >
                    <Camera className="w-4 h-4" />
                    <span>Start Live Camera</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold bg-slate-800 text-white hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors min-h-[44px] cursor-pointer"
                  >
                    <ImagePlus className="w-4 h-4" />
                    <span>Test Photo</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Active Red Warning Banner when Negative Object Triggers Siren */}
        {isSirenSounding && (
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

      {/* Camera Secondary Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <span className="font-medium text-slate-800">
            {modelStatus === 'loading'
              ? 'Loading Vision Engine...'
              : modelStatus === 'ready'
              ? 'Vision Engine Ready'
              : 'Engine Error'}
          </span>
          <span className="text-slate-300" aria-hidden="true">
            ·
          </span>
          <span>
            {isCameraActive
              ? facingMode === 'environment'
                ? 'Rear / Main Camera'
                : 'Front Camera'
              : testImageUrl
              ? 'Static Photo Analysis'
              : 'Camera Standby'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'))
            }
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap min-h-[40px] cursor-pointer"
          >
            <SwitchCamera className="w-4 h-4" />
            <span>Flip Camera</span>
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap min-h-[40px] cursor-pointer"
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
