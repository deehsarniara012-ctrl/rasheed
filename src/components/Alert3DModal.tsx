import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MapPin, Pause, Play, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { Classification, GeoCoordinates } from '../types/vision';
import {
  createInspectionStageGroup,
  disposeObject3D,
  isSoftwareWebGLRenderer,
} from '../utils/threeModels';

export interface Inspectable3DItem {
  id: string;
  label: string;
  classification: Classification;
  score: number;
  thumbnailUrl?: string;
  latitude?: number;
  longitude?: number;
  timestamp?: number;
}

interface Alert3DModalProps {
  item: Inspectable3DItem | null;
  coords: GeoCoordinates | null;
  onClose: () => void;
}

export const Alert3DModal: React.FC<Alert3DModalProps> = ({ item, coords, onClose }) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stageHostRef = useRef<THREE.Group | null>(null);
  const pivotRef = useRef<THREE.Group | null>(null);
  const requestRenderRef = useRef<(() => void) | null>(null);

  const [autoRotate, setAutoRotate] = useState(true);
  const autoRotateRef = useRef(autoRotate);
  autoRotateRef.current = autoRotate;

  useEffect(() => {
    if (!item) return;
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = isSoftwareWebGLRenderer();
    const width = Math.max(260, container.clientWidth);
    const height = Math.max(240, container.clientHeight);

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = false;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x090f1d);
    scene.fog = new THREE.FogExp2(0x090f1d, 0.045);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envTarget = pmremGenerator.fromScene(roomEnv, 0.04);
    scene.environment = envTarget.texture;
    roomEnv.dispose();

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 60);
    camera.position.set(0, 2.25, 4.5);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.95, 0);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.08;
    controls.minDistance = 2.4;
    controls.maxDistance = 8.5;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.update();

    const hemi = new THREE.HemisphereLight(0x93c5fd, 0x0f172a, 0.85);
    scene.add(hemi);
    const keyLight = new THREE.DirectionalLight(0xfff1d6, 2.0);
    keyLight.position.set(5, 8, 6);
    scene.add(keyLight);

    const grid = new THREE.GridHelper(12, 16, 0x334155, 0x1e293b);
    scene.add(grid);

    const stageHost = new THREE.Group();
    scene.add(stageHost);
    stageHostRef.current = stageHost;

    let rafId = 0;
    let timerId: number | null = null;
    let disposed = false;

    const { stage, subjectPivot } = createInspectionStageGroup(item, () => {
      renderer.render(scene, camera);
    });
    stageHost.add(stage);
    pivotRef.current = subjectPivot;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const tick = () => {
      if (disposed) return;
      if (autoRotateRef.current && !prefersReducedMotion && pivotRef.current) {
        pivotRef.current.rotation.y += isSoftwareGl ? 0.018 : 0.009;
      }
      controls.update();
      renderer.render(scene, camera);

      if (autoRotateRef.current && !prefersReducedMotion) {
        timerId = window.setTimeout(() => {
          if (!disposed) {
            rafId = requestAnimationFrame(tick);
          }
        }, isSoftwareGl ? 55 : 16);
      }
    };

    const requestRender = () => {
      if (!disposed) {
        controls.update();
        renderer.render(scene, camera);
      }
    };
    requestRenderRef.current = requestRender;
    controls.addEventListener('change', requestRender);

    const resizeObserver = new ResizeObserver(() => {
      if (!container) return;
      const w = Math.max(260, container.clientWidth);
      const h = Math.max(240, container.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      requestRender();
    });
    resizeObserver.observe(container);

    rafId = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      if (timerId !== null) window.clearTimeout(timerId);
      resizeObserver.disconnect();
      controls.removeEventListener('change', requestRender);
      disposeObject3D(stageHost);
      grid.dispose();
      controls.dispose();
      envTarget.dispose();
      pmremGenerator.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      stageHostRef.current = null;
      pivotRef.current = null;
      requestRenderRef.current = null;
    };
  }, [item]);

  if (!item) return null;

  const isNeg = item.classification === 'negative';
  const isPos = item.classification === 'positive';
  const lat = item.latitude ?? coords?.latitude;
  const lng = item.longitude ?? coords?.longitude;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80"
      role="dialog"
      aria-modal="true"
      aria-label={`3D Inspection View for ${item.label}`}
    >
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-2xl">
        {/* Modal Header */}
        <div
          className={`px-4 sm:px-5 py-3.5 flex items-center justify-between gap-3 border-b ${
            isNeg
              ? 'bg-[#DC2626] text-white border-red-700'
              : isPos
              ? 'bg-[#0B4FE6] text-white border-blue-700'
              : 'bg-[#0B2240] text-white border-slate-800'
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            {isNeg ? (
              <ShieldAlert className="w-5 h-5 shrink-0" />
            ) : (
              <ShieldCheck className="w-5 h-5 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="text-[11px] font-mono font-semibold uppercase opacity-90">
                3D Object & Snapshot Model · {item.classification}
              </div>
              <h3 className="text-base font-bold truncate">{item.label}</h3>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close 3D Inspector"
            className="p-2 rounded-xl bg-black/20 hover:bg-black/35 text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Isolated 3D WebGL Canvas */}
        <div className="relative w-full h-72 sm:h-80 bg-slate-950">
          <div ref={mountRef} className="w-full h-full" />

          <button
            type="button"
            onClick={() => setAutoRotate((v) => !v)}
            className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-xs font-semibold text-white cursor-pointer"
          >
            {autoRotate ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span>{autoRotate ? 'Pause Spin' : 'Spin 3D'}</span>
          </button>
        </div>

        {/* Metadata + Captured Photo Preview Strip */}
        <div className="p-4 sm:p-5 bg-slate-50 dark:bg-slate-950/70 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            {item.thumbnailUrl && (
              <img
                src={item.thumbnailUrl}
                alt={item.label}
                className="w-20 h-15 rounded-xl object-cover border border-slate-200 dark:border-slate-700 bg-slate-900 shrink-0"
              />
            )}
            <div className="min-w-0 space-y-1">
              <div className="text-xs font-mono font-bold text-slate-800 dark:text-slate-100 tabular-nums">
                Confidence: {Math.round(item.score * 100)}%
              </div>
              <div className="flex items-center gap-1.5 text-xs font-mono text-slate-600 dark:text-slate-400 tabular-nums truncate">
                <MapPin className="w-3.5 h-3.5 text-[#0B4FE6] shrink-0" />
                <span>
                  {lat !== undefined && lng !== undefined
                    ? `${lat.toFixed(5)}°, ${lng.toFixed(5)}°`
                    : 'Enable GPS in Geo-Tracker to stamp coordinates'}
                </span>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 rounded-2xl bg-[#0B4FE6] hover:bg-[#1D4ED8] text-white text-xs font-bold whitespace-nowrap min-h-[40px] cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
