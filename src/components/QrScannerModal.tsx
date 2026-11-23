import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { CameraOff, QrCode, X } from 'lucide-react';
import { extractRoomIdFromQrText } from '../utils/geoMath';

interface QrScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDetectedRoom: (roomId: string) => void;
}

export const QrScannerModal: React.FC<QrScannerModalProps> = ({
  isOpen,
  onClose,
  onDetectedRoom,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState('');

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    let timerId: number | null = null;
    setScanError(null);

    const stopAll = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };

    const startScanner = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setScanError('Camera QR scanning unavailable here. Enter the Host Room Code below.');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } },
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

        const BarcodeDetCtor = (
          window as unknown as {
            BarcodeDetector?: new (opts?: { formats: string[] }) => {
              detect: (src: ImageBitmapSource) => Promise<Array<{ rawValue: string }>>;
            };
          }
        ).BarcodeDetector;
        const barcodeDetector = BarcodeDetCtor
          ? new BarcodeDetCtor({ formats: ['qr_code'] })
          : null;

        const scanTick = async () => {
          if (cancelled) return;
          const video = videoRef.current;
          if (video && video.readyState >= 2 && video.videoWidth > 0) {
            try {
              let foundRaw: string | null = null;

              if (barcodeDetector) {
                const hits = await barcodeDetector.detect(video);
                if (hits.length > 0 && hits[0].rawValue) {
                  foundRaw = hits[0].rawValue;
                }
              }

              if (!foundRaw) {
                if (!canvasRef.current) {
                  canvasRef.current = document.createElement('canvas');
                }
                const canvas = canvasRef.current;
                const w = Math.min(480, video.videoWidth);
                const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w));
                if (canvas.width !== w || canvas.height !== h) {
                  canvas.width = w;
                  canvas.height = h;
                }
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (ctx) {
                  ctx.drawImage(video, 0, 0, w, h);
                  const imgData = ctx.getImageData(0, 0, w, h);
                  const qr = jsQR(imgData.data, w, h, { inversionAttempts: 'dontInvert' });
                  if (qr?.data) {
                    foundRaw = qr.data;
                  }
                }
              }

              if (foundRaw) {
                const parsedRoom = extractRoomIdFromQrText(foundRaw);
                if (parsedRoom) {
                  stopAll();
                  onDetectedRoom(parsedRoom);
                  return;
                }
              }
            } catch {
              // Continue scanning frames cleanly
            }
          }

          if (!cancelled) {
            timerId = window.setTimeout(() => {
              void scanTick();
            }, 140);
          }
        };

        void scanTick();
      } catch {
        if (!cancelled) {
          setScanError('Camera permission denied. Enter the Host Room Code below to link.');
        }
      }
    };

    void startScanner();

    return () => {
      cancelled = true;
      stopAll();
    };
  }, [isOpen, onDetectedRoom]);

  if (!isOpen) return null;

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const room = extractRoomIdFromQrText(manualCode);
    if (room) {
      onDetectedRoom(room);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Scan Host QR Code to Link Camera"
    >
      <div className="w-full max-w-md bg-white dark:bg-[#0F172A] rounded-3xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-2xl">
        <div className="px-5 py-4 bg-gradient-to-r from-[#0B2240] via-[#0B4FE6] to-[#DC2626] text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <QrCode className="w-5 h-5 text-white" />
            <div>
              <h3 className="text-sm font-bold">Scan QR Code to Link Mobile</h3>
              <p className="text-[11px] text-blue-100">
                Point camera at the Host dashboard QR code
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close QR Scanner"
            className="p-2 rounded-xl bg-white/15 hover:bg-white/25 text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="relative w-full aspect-[4/3] bg-slate-950 flex items-center justify-center overflow-hidden">
          <video
            ref={videoRef}
            playsInline
            muted
            className={`w-full h-full object-cover ${scanError ? 'hidden' : 'block'}`}
          />
          {!scanError && (
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
              <div className="w-48 h-48 border-2 border-[#0B4FE6] rounded-2xl shadow-[0_0_0_9999px_rgba(2,6,23,0.45)]" />
            </div>
          )}
          {scanError && (
            <div className="p-6 text-center text-white space-y-2">
              <CameraOff className="w-8 h-8 text-red-400 mx-auto" />
              <p className="text-xs text-slate-300">{scanError}</p>
            </div>
          )}
        </div>

        <form onSubmit={handleManualSubmit} className="p-4 bg-slate-50 dark:bg-slate-900/70 border-t border-slate-200 dark:border-slate-800 space-y-2">
          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            Or enter Host Room Code directly
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value.toUpperCase())}
              placeholder="e.g. A1B2C3D4"
              className="flex-1 px-3.5 py-2 text-sm font-mono uppercase bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-2xl text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#0B4FE6]/25"
            />
            <button
              type="submit"
              disabled={!extractRoomIdFromQrText(manualCode)}
              className="px-4 py-2 text-xs font-bold bg-[#0B4FE6] hover:bg-[#1D4ED8] text-white rounded-2xl min-h-[42px] cursor-pointer disabled:opacity-45"
            >
              Link Device
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
