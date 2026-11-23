import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  Box,
  Camera,
  Check,
  Copy,
  LocateFixed,
  QrCode,
  RefreshCw,
  ScanLine,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { LinkedCameraNode } from '../types/vision';
import { Inspectable3DItem } from './Alert3DModal';

interface MultiCameraHubProps {
  roomId: string;
  wsConnected: boolean;
  linkedNodes: LinkedCameraNode[];
  onRotateRoom: () => void;
  onOpenQrScanner: () => void;
  onJoinSelfAsMobile: () => void;
  onInspect3D: (item: Inspectable3DItem) => void;
}

export const MultiCameraHub: React.FC<MultiCameraHubProps> = ({
  roomId,
  wsConnected,
  linkedNodes,
  onRotateRoom,
  onOpenQrScanner,
  onJoinSelfAsMobile,
  onInspect3D,
}) => {
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);

  const joinUrl = `${window.location.origin}/?join=${encodeURIComponent(roomId)}`;

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(joinUrl, {
      width: 220,
      margin: 2,
      color: {
        dark: '#0B2240',
        light: '#FFFFFF',
      },
    })
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch(() => {
        if (active) setQrDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [joinUrl]);

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard failures in restricted frames
    }
  };

  return (
    <section
      id="multi-camera-hub"
      className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-3xl p-4 sm:p-6 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white tracking-tight">
            Multi-Mobile Camera & QR Link Hub
          </h2>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Scan the QR code on 5, 6, or up to 16 mobile phones to stream live cameras & GPS to this screen
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onOpenQrScanner}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold bg-[#DC2626] hover:bg-red-700 text-white rounded-2xl transition-colors whitespace-nowrap min-h-[42px] cursor-pointer shadow-xs"
          >
            <ScanLine className="w-4 h-4" />
            <span>Scan QR to Link</span>
          </button>

          <button
            type="button"
            onClick={onJoinSelfAsMobile}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#0B4FE6] dark:text-blue-300 bg-blue-50 dark:bg-blue-950/60 border border-blue-200/80 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/60 rounded-2xl transition-colors whitespace-nowrap min-h-[42px] cursor-pointer"
          >
            <Smartphone className="w-4 h-4" />
            <span>Open Mobile Mode</span>
          </button>
        </div>
      </div>

      {/* QR Pairing Card + Room Status */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        <div className="lg:col-span-4 border border-slate-200/90 dark:border-slate-800 rounded-2xl p-4 bg-slate-50/80 dark:bg-slate-950/60 flex flex-col sm:flex-row lg:flex-col items-center gap-4">
          <div className="w-40 h-40 rounded-2xl bg-white border border-slate-200 p-2.5 flex items-center justify-center shrink-0 shadow-xs">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt={`QR Code to link mobile cameras to room ${roomId}`}
                className="w-full h-full object-contain"
              />
            ) : (
              <QrCode className="w-12 h-12 text-slate-400" />
            )}
          </div>

          <div className="flex-1 w-full space-y-2.5 text-center sm:text-left lg:text-center">
            <div>
              <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                Host Room Code
              </div>
              <div className="text-2xl font-mono font-bold text-[#0B4FE6] dark:text-blue-400 tracking-wider">
                {roomId}
              </div>
              <div className="text-xs font-mono text-slate-600 dark:text-slate-400 mt-0.5 tabular-nums">
                {wsConnected
                  ? `${linkedNodes.length} / 16 Mobile Nodes Linked`
                  : 'Connecting real-time sync...'}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-center sm:justify-start lg:justify-center gap-2">
              <button
                type="button"
                onClick={handleCopyLink}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold bg-[#0B4FE6] hover:bg-[#1D4ED8] text-white rounded-xl min-h-[38px] cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Copied Link' : 'Copy Link'}</span>
              </button>
              <button
                type="button"
                onClick={onRotateRoom}
                title="Generate new Room Code"
                className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl min-h-[38px] cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>New Code</span>
              </button>
            </div>
          </div>
        </div>

        {/* Connected Multi-Camera Feeds Grid (supports 5, 6, 8, up to 16 mobile cameras) */}
        <div className="lg:col-span-8">
          {linkedNodes.length === 0 ? (
            <div className="h-full min-h-[240px] border border-dashed border-slate-300 dark:border-slate-700 rounded-2xl p-6 flex flex-col items-center justify-center text-center bg-slate-50/50 dark:bg-slate-950/40">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#0B4FE6]/15 to-[#DC2626]/15 text-[#0B4FE6] dark:text-blue-400 flex items-center justify-center mb-3">
                <Smartphone className="w-7 h-7" />
              </div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                Ready for 5–6+ Mobile Cameras via QR Scan
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mt-1">
                Scan the QR code with any phone camera (or tap Open Mobile Mode on another browser tab) to connect multiple live mobile cameras and standalone GPS feeds into this screen.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {linkedNodes.map((node) => {
                const negDet = node.detections.find((d) => d.classification === 'negative');
                const topDet = negDet || node.detections[0];

                return (
                  <div
                    key={node.nodeId}
                    className={`rounded-2xl border overflow-hidden flex flex-col bg-slate-950 text-white ${
                      negDet
                        ? 'border-red-500 ring-2 ring-red-500/40'
                        : 'border-slate-200 dark:border-slate-800'
                    }`}
                  >
                    <div className="relative aspect-[4/3] bg-slate-900 flex items-center justify-center overflow-hidden">
                      {node.previewFrameUrl ? (
                        <img
                          src={node.previewFrameUrl}
                          alt={`${node.deviceName} live camera stream`}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="p-4 text-center space-y-1">
                          <LocateFixed className="w-6 h-6 text-blue-400 mx-auto" />
                          <div className="text-xs font-semibold text-slate-200">
                            {node.gpsActive ? 'GPS Tracking Active' : 'Camera Standby'}
                          </div>
                          <div className="text-[11px] font-mono text-slate-400 tabular-nums">
                            {node.coords
                              ? `${node.coords.latitude.toFixed(4)}°, ${node.coords.longitude.toFixed(4)}°`
                              : 'No camera stream'}
                          </div>
                        </div>
                      )}

                      <div className="absolute top-2 left-2 px-2.5 py-1 rounded-lg bg-slate-950/85 border border-white/15 text-[10px] font-mono font-semibold flex items-center gap-1.5">
                        <Camera className="w-3 h-3 text-blue-400" />
                        <span className="truncate max-w-[110px]">{node.deviceName}</span>
                        {node.cameraActive && (
                          <span className="text-emerald-400 tabular-nums">{node.fps}fps</span>
                        )}
                      </div>

                      {topDet && (
                        <button
                          type="button"
                          onClick={() =>
                            onInspect3D({
                              id: topDet.id,
                              label: `${topDet.displayLabel} (${node.deviceName})`,
                              classification: topDet.classification,
                              score: topDet.score,
                              thumbnailUrl: topDet.thumbnailUrl || node.previewFrameUrl,
                              latitude: node.coords?.latitude,
                              longitude: node.coords?.longitude,
                              timestamp: node.lastSeen,
                            })
                          }
                          className="absolute bottom-2 right-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#0B4FE6] hover:bg-[#1D4ED8] border border-white/20 text-[10px] font-semibold text-white cursor-pointer"
                        >
                          <Box className="w-3 h-3" />
                          <span>3D Pic</span>
                        </button>
                      )}
                    </div>

                    <div className="px-3 py-2.5 bg-slate-900 border-t border-slate-800 flex items-center justify-between gap-2 text-[11px]">
                      {topDet ? (
                        <div className="flex items-center gap-1.5 min-w-0">
                          {topDet.classification === 'negative' ? (
                            <ShieldAlert className="w-3.5 h-3.5 text-red-400 shrink-0" />
                          ) : (
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          )}
                          <span className="font-semibold truncate">{topDet.displayLabel}</span>
                        </div>
                      ) : (
                        <span className="text-slate-400 truncate">
                          {node.gpsActive ? 'GPS Only Mode' : 'Connected'}
                        </span>
                      )}

                      <span className="font-mono text-slate-400 shrink-0">
                        {node.coords ? 'GPS' : 'No GPS'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
