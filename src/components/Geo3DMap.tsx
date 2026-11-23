import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ChevronDown, ChevronUp, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import {
  GeoActivityPoint,
  GeoCoordinates,
  GeoDetectionPin,
  LinkedCameraNode,
  NearbyAircraft,
  SatelliteTelemetry,
  SimulationSnapshot,
} from '../types/vision';
import { latLonToLocalMeters } from '../utils/geoMath';
import {
  createDeviceBeaconGroup,
  createGeoPinGroup,
  disposeObject3D,
  isSoftwareWebGLRenderer,
} from '../utils/threeModels';

export interface AirOrSatSelection {
  kind: 'aircraft' | 'satellite';
  title: string;
  subtitle: string;
  details: string;
}

type CameraPreset = 'orbital' | 'top' | 'low';

interface Geo3DMapProps {
  coords: GeoCoordinates | null;
  pins: GeoDetectionPin[];
  activityTrail: GeoActivityPoint[];
  linkedNodes: LinkedCameraNode[];
  aircraft?: NearbyAircraft[];
  satellite?: SatelliteTelemetry | null;
  simulation?: SimulationSnapshot | null;
  geofenceRadiusMeters?: number;
  selectedPinId: string | null;
  onSelectPin: (pinId: string) => void;
  onSelectAirOrSat?: (info: AirOrSatSelection) => void;
}

const PRESET_VIEWS: Record<
  CameraPreset,
  { pos: [number, number, number]; target: [number, number, number] }
> = {
  orbital: { pos: [0, 11.5, 16.5], target: [0, 0.6, -1.2] },
  top: { pos: [0, 23.5, 0.8], target: [0, 0, 0] },
  low: { pos: [8.5, 4.2, 11.0], target: [0, 1.0, -0.5] },
};

function geofenceMetersToSceneRadius(meters: number): number {
  if (meters <= 100) return 3.8;
  if (meters <= 250) return 6.0;
  if (meters <= 500) return 8.2;
  if (meters <= 1000) return 10.5;
  return 12.8;
}

export const Geo3DMap: React.FC<Geo3DMapProps> = ({
  coords,
  pins,
  activityTrail,
  linkedNodes,
  aircraft = [],
  satellite = null,
  simulation = null,
  geofenceRadiusMeters = 250,
  selectedPinId,
  onSelectPin,
  onSelectAirOrSat,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const requestRenderRef = useRef<(() => void) | null>(null);
  const animateToPresetRef = useRef<((preset: CameraPreset) => void) | null>(null);
  const dynamicGroupRef = useRef<THREE.Group | null>(null);
  const trailGroupRef = useRef<THREE.Group | null>(null);
  const beaconGroupRef = useRef<THREE.Group | null>(null);
  const geofenceGroupRef = useRef<THREE.Group | null>(null);
  const selectionRingRef = useRef<THREE.Mesh | null>(null);
  const pinPositionMapRef = useRef<Map<string, THREE.Vector3>>(new Map());
  const onSelectPinRef = useRef(onSelectPin);
  onSelectPinRef.current = onSelectPin;
  const onSelectAirOrSatRef = useRef(onSelectAirOrSat);
  onSelectAirOrSatRef.current = onSelectAirOrSat;

  const [contextLost, setContextLost] = useState(false);
  const [activePreset, setActivePreset] = useState<CameraPreset>('orbital');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDockCollapsed, setIsDockCollapsed] = useState(false);

  useEffect(() => {
    if (!isExpanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsExpanded(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isExpanded]);

  // Initialize Three.js WebGL scene once
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = isSoftwareWebGLRenderer();
    const width = Math.max(240, container.clientWidth);
    const height = Math.max(220, container.clientHeight);

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = false;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070d1a);
    scene.fog = new THREE.FogExp2(0x070d1a, 0.02);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envTarget = pmremGenerator.fromScene(roomEnv, 0.04);
    scene.environment = envTarget.texture;
    roomEnv.dispose();

    const camera = new THREE.PerspectiveCamera(46, width / height, 0.1, 160);
    camera.position.set(0, 11.5, 16.5);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.6, -1.2);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.08;
    controls.minDistance = 5;
    controls.maxDistance = 38;
    controls.maxPolarAngle = Math.PI / 2.15;
    controls.update();
    controlsRef.current = controls;

    const hemiLight = new THREE.HemisphereLight(0x93c5fd, 0x0f172a, 0.85);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff1d6, 1.85);
    keyLight.position.set(10, 16, 12);
    scene.add(keyLight);

    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x0b1324,
      metalness: 0.25,
      roughness: 0.85,
    });
    const floorMesh = new THREE.Mesh(new THREE.CircleGeometry(19, 48), floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = -0.02;
    scene.add(floorMesh);

    const gridHelper = new THREE.GridHelper(34, 34, 0x334155, 0x1e293b);
    gridHelper.position.y = 0.002;
    scene.add(gridHelper);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.24,
      side: THREE.DoubleSide,
    });
    const rangeRadii = [4.5, 9.0, 13.5];
    const rangeRings: THREE.Mesh[] = [];
    for (const r of rangeRadii) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - 0.04, r + 0.04, 56), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.01;
      scene.add(ring);
      rangeRings.push(ring);
    }

    const selRingMat = new THREE.MeshBasicMaterial({
      color: 0xfacc15,
      side: THREE.DoubleSide,
    });
    const selRing = new THREE.Mesh(new THREE.RingGeometry(0.76, 0.92, 32), selRingMat);
    selRing.rotation.x = -Math.PI / 2;
    selRing.position.y = 0.03;
    selRing.visible = false;
    scene.add(selRing);
    selectionRingRef.current = selRing;

    const geofenceGroup = new THREE.Group();
    scene.add(geofenceGroup);
    geofenceGroupRef.current = geofenceGroup;

    const beaconGroup = new THREE.Group();
    scene.add(beaconGroup);
    beaconGroupRef.current = beaconGroup;

    const trailGroup = new THREE.Group();
    scene.add(trailGroup);
    trailGroupRef.current = trailGroup;

    const dynamicGroup = new THREE.Group();
    scene.add(dynamicGroup);
    dynamicGroupRef.current = dynamicGroup;

    // Smooth damped camera transition state (cancelled immediately on manual OrbitControls drag)
    const desiredCamPos = new THREE.Vector3(0, 11.5, 16.5);
    const desiredCtrlTarget = new THREE.Vector3(0, 0.6, -1.2);
    let isTweeningCamera = false;
    let lastTweenTickMs = performance.now();
    let tweenRafId: number | null = null;
    let tweenTimeoutId: number | null = null;

    let renderPending = false;
    const renderNow = () => {
      renderPending = false;
      controls.update();
      renderer.render(scene, camera);
    };

    const requestRender = () => {
      if (!renderPending) {
        renderPending = true;
        requestAnimationFrame(renderNow);
      }
    };
    requestRenderRef.current = requestRender;

    const cancelTween = () => {
      isTweeningCamera = false;
      if (tweenRafId !== null) {
        cancelAnimationFrame(tweenRafId);
        tweenRafId = null;
      }
      if (tweenTimeoutId !== null) {
        window.clearTimeout(tweenTimeoutId);
        tweenTimeoutId = null;
      }
    };

    const stepCameraTween = () => {
      if (!isTweeningCamera) return;
      const nowMs = performance.now();
      const dt = Math.min(0.05, Math.max(0.004, (nowMs - lastTweenTickMs) / 1000));
      lastTweenTickMs = nowMs;

      const lambda = isSoftwareGl ? 10 : 7;
      camera.position.x = THREE.MathUtils.damp(camera.position.x, desiredCamPos.x, lambda, dt);
      camera.position.y = THREE.MathUtils.damp(camera.position.y, desiredCamPos.y, lambda, dt);
      camera.position.z = THREE.MathUtils.damp(camera.position.z, desiredCamPos.z, lambda, dt);

      controls.target.x = THREE.MathUtils.damp(controls.target.x, desiredCtrlTarget.x, lambda, dt);
      controls.target.y = THREE.MathUtils.damp(controls.target.y, desiredCtrlTarget.y, lambda, dt);
      controls.target.z = THREE.MathUtils.damp(controls.target.z, desiredCtrlTarget.z, lambda, dt);

      controls.update();
      renderer.render(scene, camera);

      const posDist = camera.position.distanceTo(desiredCamPos);
      const tgtDist = controls.target.distanceTo(desiredCtrlTarget);
      if (posDist < 0.04 && tgtDist < 0.04) {
        camera.position.copy(desiredCamPos);
        controls.target.copy(desiredCtrlTarget);
        controls.update();
        renderer.render(scene, camera);
        isTweeningCamera = false;
        return;
      }

      if (isSoftwareGl) {
        tweenTimeoutId = window.setTimeout(stepCameraTween, 45);
      } else {
        tweenRafId = requestAnimationFrame(stepCameraTween);
      }
    };

    animateToPresetRef.current = (preset: CameraPreset) => {
      cancelTween();
      const cfg = PRESET_VIEWS[preset];
      desiredCamPos.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
      desiredCtrlTarget.set(cfg.target[0], cfg.target[1], cfg.target[2]);
      isTweeningCamera = true;
      lastTweenTickMs = performance.now();
      stepCameraTween();
    };

    controls.addEventListener('start', cancelTween);
    controls.addEventListener('change', requestRender);

    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    let downX = 0;
    let downY = 0;

    const handlePointerDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
    };

    const handlePointerUp = (e: PointerEvent) => {
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (Math.hypot(dx, dy) > 6) return;

      const rect = renderer.domElement.getBoundingClientRect();
      pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(pointerNdc, camera);
      const hits = raycaster.intersectObjects(dynamicGroup.children, true);
      if (hits.length > 0) {
        const hitData = hits[0].object.userData as {
          pinId?: string;
          airSatInfo?: AirOrSatSelection;
        };
        if (hitData?.pinId) {
          onSelectPinRef.current(hitData.pinId);
        } else if (hitData?.airSatInfo) {
          onSelectAirOrSatRef.current?.(hitData.airSatInfo);
        }
      }
    };

    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);

    const handleLost = (e: Event) => {
      e.preventDefault();
      setContextLost(true);
    };
    const handleRestored = () => {
      setContextLost(false);
      requestRender();
    };
    renderer.domElement.addEventListener('webglcontextlost', handleLost);
    renderer.domElement.addEventListener('webglcontextrestored', handleRestored);

    const resizeObserver = new ResizeObserver(() => {
      if (!container) return;
      const w = Math.max(240, container.clientWidth);
      const h = Math.max(220, container.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      requestRender();
    });
    resizeObserver.observe(container);

    requestRender();

    return () => {
      cancelTween();
      animateToPresetRef.current = null;
      resizeObserver.disconnect();
      controls.removeEventListener('start', cancelTween);
      controls.removeEventListener('change', requestRender);
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      renderer.domElement.removeEventListener('webglcontextlost', handleLost);
      renderer.domElement.removeEventListener('webglcontextrestored', handleRestored);

      disposeObject3D(geofenceGroup);
      disposeObject3D(beaconGroup);
      disposeObject3D(trailGroup);
      disposeObject3D(dynamicGroup);
      floorMesh.geometry.dispose();
      floorMat.dispose();
      gridHelper.dispose();
      rangeRings.forEach((r) => r.geometry.dispose());
      ringMat.dispose();
      selRing.geometry.dispose();
      selRingMat.dispose();

      controls.dispose();
      envTarget.dispose();
      pmremGenerator.dispose();
      renderer.dispose();

      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      requestRenderRef.current = null;
      geofenceGroupRef.current = null;
      beaconGroupRef.current = null;
      trailGroupRef.current = null;
      dynamicGroupRef.current = null;
      controlsRef.current = null;
      cameraRef.current = null;
      selectionRingRef.current = null;
    };
  }, []);

  // Update center GPS beacon whenever lock state changes
  useEffect(() => {
    const beaconHost = beaconGroupRef.current;
    if (!beaconHost) return;
    while (beaconHost.children.length > 0) {
      const child = beaconHost.children[0];
      beaconHost.remove(child);
      disposeObject3D(child);
    }
    const beacon = createDeviceBeaconGroup(Boolean(coords));
    beaconHost.add(beacon);
    requestRenderRef.current?.();
  }, [coords]);

  // Update 3D Geofence Perimeter Ring & 4 Cardinal Boundary Posts
  useEffect(() => {
    const host = geofenceGroupRef.current;
    if (!host) return;
    while (host.children.length > 0) {
      const child = host.children[0];
      host.remove(child);
      disposeObject3D(child);
    }

    const r = geofenceMetersToSceneRadius(geofenceRadiusMeters);
    const fenceMat = new THREE.MeshBasicMaterial({
      color: 0xe8922d,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
    });
    const fenceRing = new THREE.Mesh(new THREE.RingGeometry(r - 0.08, r + 0.08, 64), fenceMat);
    fenceRing.rotation.x = -Math.PI / 2;
    fenceRing.position.y = 0.025;
    host.add(fenceRing);

    const postMat = new THREE.MeshStandardMaterial({
      color: 0xe8922d,
      emissive: 0xb45309,
      emissiveIntensity: 0.7,
      metalness: 0.4,
      roughness: 0.3,
    });
    const postGeo = new THREE.CylinderGeometry(0.06, 0.08, 0.7, 10);
    const angles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
    for (const a of angles) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(Math.cos(a) * r, 0.35, Math.sin(a) * r);
      host.add(post);
    }

    requestRenderRef.current?.();
  }, [geofenceRadiusMeters]);

  // Render 3D GPS Activity Trail (even when camera is OFF)
  useEffect(() => {
    const host = trailGroupRef.current;
    if (!host) return;
    while (host.children.length > 0) {
      const child = host.children[0];
      host.remove(child);
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      } else {
        disposeObject3D(child);
      }
    }

    if (activityTrail.length >= 2) {
      const origin = coords || activityTrail[activityTrail.length - 1];
      const points: THREE.Vector3[] = [];
      for (const pt of activityTrail) {
        const { eastMeters, northMeters } = latLonToLocalMeters(
          origin.latitude,
          origin.longitude,
          pt.latitude,
          pt.longitude
        );
        const clampedX = Math.max(-13, Math.min(13, eastMeters * 0.25));
        const clampedZ = Math.max(-13, Math.min(13, -northMeters * 0.25));
        points.push(new THREE.Vector3(clampedX, 0.08, clampedZ));
      }
      const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
      const lineMat = new THREE.LineBasicMaterial({ color: 0x38bdf8 });
      const line = new THREE.Line(lineGeo, lineMat);
      host.add(line);
    }

    requestRenderRef.current?.();
  }, [activityTrail, coords]);

  // Rebuild 3D object markers + linked mobile camera nodes
  useEffect(() => {
    const host = dynamicGroupRef.current;
    if (!host) return;

    while (host.children.length > 0) {
      const child = host.children[0];
      host.remove(child);
      disposeObject3D(child);
    }
    pinPositionMapRef.current.clear();

    pins.forEach((pin, idx) => {
      const group = createGeoPinGroup(
        {
          id: pin.id,
          label: pin.label,
          classification: pin.classification,
          score: pin.score,
          thumbnailUrl: pin.thumbnailUrl,
        },
        () => requestRenderRef.current?.()
      );

      let posX = (pin.gridX - 50) * 0.26;
      let posZ = (pin.gridY - 50) * 0.26;

      if (coords && pin.latitude !== undefined && pin.longitude !== undefined) {
        const { eastMeters, northMeters } = latLonToLocalMeters(
          coords.latitude,
          coords.longitude,
          pin.latitude,
          pin.longitude
        );
        if (Math.hypot(eastMeters, northMeters) > 2) {
          posX = Math.max(-12.5, Math.min(12.5, eastMeters * 0.25));
          posZ = Math.max(-12.5, Math.min(12.5, -northMeters * 0.25));
        }
      }

      const angle = (idx * 2.39996) % (Math.PI * 2);
      const jitter = idx === 0 ? 0 : 0.45;
      posX += Math.cos(angle) * jitter;
      posZ += Math.sin(angle) * jitter;

      group.position.set(posX, 0, posZ);
      group.lookAt(0, 0, 14);

      host.add(group);
      pinPositionMapRef.current.set(pin.id, new THREE.Vector3(posX, 0.03, posZ));
    });

    // Plot connected mobile cameras directly in 3D GPS Space
    linkedNodes.forEach((node, idx) => {
      const hasNeg = node.detections.some((d) => d.classification === 'negative');
      const hasPos = node.detections.some((d) => d.classification === 'positive');
      const group = createGeoPinGroup(
        {
          id: `node:${node.nodeId}`,
          label: `${node.deviceName}`,
          classification: hasNeg ? 'negative' : hasPos ? 'positive' : 'neutral',
          score: node.cameraActive ? 1 : 0.9,
          thumbnailUrl: node.previewFrameUrl,
        },
        () => requestRenderRef.current?.()
      );

      let posX: number;
      let posZ: number;
      if (coords && node.coords) {
        const { eastMeters, northMeters } = latLonToLocalMeters(
          coords.latitude,
          coords.longitude,
          node.coords.latitude,
          node.coords.longitude
        );
        posX = Math.max(-12, Math.min(12, eastMeters * 0.25));
        posZ = Math.max(-12, Math.min(12, -northMeters * 0.25));
        if (Math.hypot(posX, posZ) < 1.8) {
          const a = (idx / Math.max(1, linkedNodes.length)) * Math.PI * 2;
          posX = Math.cos(a) * 4.2;
          posZ = Math.sin(a) * 4.2;
        }
      } else {
        const a = (idx / Math.max(1, linkedNodes.length)) * Math.PI * 2 - Math.PI / 2;
        posX = Math.cos(a) * 6.5;
        posZ = Math.sin(a) * 6.5;
      }

      group.position.set(posX, 0, posZ);
      group.lookAt(0, 0, 14);
      host.add(group);
      pinPositionMapRef.current.set(`node:${node.nodeId}`, new THREE.Vector3(posX, 0.03, posZ));
    });

    // Plot real nearby civilian ADS-B aircraft in 3D GIS airspace
    if (coords && aircraft.length > 0) {
      const planeMat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0284c7,
        emissiveIntensity: 0.75,
        metalness: 0.5,
        roughness: 0.25,
      });
      const wingMat = new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        metalness: 0.7,
        roughness: 0.2,
      });

      aircraft.forEach((flt) => {
        const { eastMeters, northMeters } = latLonToLocalMeters(
          coords.latitude,
          coords.longitude,
          flt.latitude,
          flt.longitude
        );
        // Scale 90 km airspace smoothly inside outer 13.5 radius ring
        const px = Math.max(-13.5, Math.min(13.5, eastMeters / 5500));
        const pz = Math.max(-13.5, Math.min(13.5, -northMeters / 5500));
        const py = Math.max(2.2, Math.min(6.5, 2.2 + flt.altitudeMeters / 3500));

        const planeGroup = new THREE.Group();
        const fuselage = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.75, 8), planeMat);
        fuselage.rotation.x = Math.PI / 2;
        const wing = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.04, 0.22), wingMat);
        const tail = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.16, 0.06), planeMat);
        tail.position.set(0, 0.1, 0.28);
        planeGroup.add(fuselage, wing, tail);
        planeGroup.position.set(px, py, pz);
        planeGroup.rotation.y = -((flt.heading * Math.PI) / 180);

        const distKm = (Math.hypot(eastMeters, northMeters) / 1000).toFixed(1);
        const airInfo: AirOrSatSelection = {
          kind: 'aircraft',
          title: flt.callsign || flt.icao24,
          subtitle: `${flt.originCountry} · ADS-B ${distKm} km range`,
          details: `Altitude ${flt.altitudeMeters}m · Speed ${flt.velocityKmh} km/h · Heading ${flt.heading}°`,
        };
        planeGroup.traverse((obj) => {
          obj.userData = { airSatInfo: airInfo };
        });

        host.add(planeGroup);
      });
    }

    // Plot Satellite orbital azimuth vector & LEO craft when satellite ephemeris is synced
    if (satellite && satellite.bearingDegFromUser !== null) {
      const azRad = (satellite.bearingDegFromUser * Math.PI) / 180;
      const sx = Math.sin(azRad) * 11.5;
      const sz = -Math.cos(azRad) * 11.5;
      const sy = 7.8;

      const satGroup = new THREE.Group();
      const bodyMat = new THREE.MeshStandardMaterial({
        color: 0xfef08a,
        metalness: 0.8,
        roughness: 0.2,
      });
      const panelMat = new THREE.MeshStandardMaterial({
        color: 0x1d4ed8,
        emissive: 0x1e40af,
        emissiveIntensity: 0.5,
        metalness: 0.4,
        roughness: 0.3,
      });
      const core = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.7, 10), bodyMat);
      core.rotation.z = Math.PI / 2;
      const solarL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.04, 1.5), panelMat);
      solarL.position.set(-0.28, 0, 0);
      const solarR = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.04, 1.5), panelMat);
      solarR.position.set(0.28, 0, 0);
      satGroup.add(core, solarL, solarR);
      satGroup.position.set(sx, sy, sz);
      satGroup.lookAt(0, 0, 0);

      const satInfo: AirOrSatSelection = {
        kind: 'satellite',
        title: `${satellite.name} (NORAD ${satellite.noradId})`,
        subtitle: `Ground Range ${satellite.distanceKmFromUser ?? '—'} km · Azimuth ${satellite.bearingDegFromUser}°`,
        details: `Alt ${satellite.altitudeKm} km · Vel ${satellite.velocityKmh} km/h · Swath ${satellite.footprintKm} km · ${satellite.visibility}`,
      };
      satGroup.traverse((obj) => {
        obj.userData = { airSatInfo: satInfo };
      });

      host.add(satGroup);

      // Orbital arc from horizon through zenith toward satellite azimuth
      const arcPts = [
        new THREE.Vector3(-sx * 0.9, 4.5, -sz * 0.9),
        new THREE.Vector3(0, sy + 1.4, 0),
        new THREE.Vector3(sx, sy, sz),
      ];
      const arcGeo = new THREE.BufferGeometry().setFromPoints(arcPts);
      const arcMat = new THREE.LineBasicMaterial({ color: 0xfde047, transparent: true, opacity: 0.55 });
      host.add(new THREE.Line(arcGeo, arcMat));
    }

    // Plot Sandboxed Simulation Layer (distinct amber telemetry, completely separate from real GPS)
    if (simulation && simulation.running) {
      const simMat = new THREE.MeshStandardMaterial({
        color: 0xf59e0b,
        emissive: 0xd97706,
        emissiveIntensity: 0.7,
        metalness: 0.4,
        roughness: 0.3,
      });

      const ux = Math.max(-12, Math.min(12, simulation.simulatedUnitOffsetM.east * 0.025));
      const uz = Math.max(-12, Math.min(12, -simulation.simulatedUnitOffsetM.north * 0.025));
      const unitGroup = new THREE.Group();
      const chassis = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.25, 0.8), simMat);
      chassis.position.y = 0.2;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.45, 8), simMat);
      mast.position.y = 0.52;
      unitGroup.add(chassis, mast);
      unitGroup.position.set(ux, 0, uz);
      host.add(unitGroup);

      if (simulation.simulatedTrail.length >= 2) {
        const sPts = simulation.simulatedTrail.map(
          (p) =>
            new THREE.Vector3(
              Math.max(-12.5, Math.min(12.5, p.eastMeters * 0.025)),
              0.12,
              Math.max(-12.5, Math.min(12.5, -p.northMeters * 0.025))
            )
        );
        const sGeo = new THREE.BufferGeometry().setFromPoints(sPts);
        const sMat = new THREE.LineBasicMaterial({ color: 0xf59e0b });
        host.add(new THREE.Line(sGeo, sMat));
      }

      for (const sa of simulation.simulatedAircraft) {
        const ax = Math.max(-13, Math.min(13, sa.eastMeters / 4000));
        const az = Math.max(-13, Math.min(13, -sa.northMeters / 4000));
        const ay = Math.max(2.6, Math.min(6.2, 2.6 + sa.altitudeMeters / 3000));
        const sPlane = new THREE.Group();
        const f = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.7, 8), simMat);
        f.rotation.x = Math.PI / 2;
        const w = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.04, 0.2), simMat);
        sPlane.add(f, w);
        sPlane.position.set(ax, ay, az);
        sPlane.rotation.y = -((sa.headingDeg * Math.PI) / 180);
        host.add(sPlane);
      }
    }

    requestRenderRef.current?.();
  }, [pins, linkedNodes, aircraft, satellite, simulation, coords]);

  useEffect(() => {
    const ring = selectionRingRef.current;
    if (!ring) return;
    const activeId = selectedPinId || pins[0]?.id;
    const pos = activeId ? pinPositionMapRef.current.get(activeId) : undefined;
    if (pos) {
      ring.position.copy(pos);
      ring.visible = true;
    } else {
      ring.visible = false;
    }
    requestRenderRef.current?.();
  }, [selectedPinId, pins]);

  const handleSelectPreset = (preset: CameraPreset) => {
    setActivePreset(preset);
    animateToPresetRef.current?.(preset);
  };

  return (
    <div
      className={
        isExpanded
          ? 'fixed inset-0 z-40 w-screen h-screen bg-[#080E1C] overflow-hidden'
          : 'relative w-full h-72 sm:h-80 rounded-3xl border border-slate-200 dark:border-slate-800 bg-[#080E1C] overflow-hidden'
      }
    >
      <div ref={mountRef} className="w-full h-full" />

      <div className="absolute top-2.5 left-2.5 px-2.5 py-1 rounded-xl bg-slate-900 border border-slate-700 text-[11px] font-mono text-slate-200 pointer-events-none">
        3D Twin · {geofenceRadiusMeters}m Fence · {linkedNodes.length} Cams · {aircraft.length} Flights
        {satellite ? ' · 1 Sat' : ''}
        {simulation?.running ? ' · SIM' : ''}
      </div>

      <div className="absolute top-2.5 right-2.5 flex items-center gap-1 bg-slate-900 border border-slate-700 rounded-xl p-1">
        {!isDockCollapsed && (
          <>
            {(
              [
                { id: 'orbital', label: 'Orbital' },
                { id: 'top', label: 'Top GIS' },
                { id: 'low', label: 'Low' },
              ] as const
            ).map((view) => (
              <button
                key={view.id}
                type="button"
                onClick={() => handleSelectPreset(view.id)}
                className={`px-2 py-1 rounded-lg text-[11px] font-semibold cursor-pointer transition-colors ${
                  activePreset === view.id
                    ? 'bg-[#0B4FE6] text-white'
                    : 'text-slate-200 hover:bg-slate-800'
                }`}
              >
                {view.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => handleSelectPreset('orbital')}
              title="Reset 3D camera"
              className="inline-flex items-center justify-center p-1 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => setIsDockCollapsed((c) => !c)}
          title={isDockCollapsed ? 'Expand camera controls' : 'Collapse camera controls'}
          className="inline-flex items-center justify-center p-1 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 cursor-pointer"
        >
          {isDockCollapsed ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronUp className="w-3.5 h-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={() => setIsExpanded((e) => !e)}
          title={isExpanded ? 'Exit full viewport 3D (Esc)' : 'Expand 3D Digital Twin'}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[#DC2626] text-white hover:bg-red-700 text-[11px] font-semibold cursor-pointer"
        >
          {isExpanded ? (
            <>
              <Minimize2 className="w-3.5 h-3.5" />
              <span>Exit</span>
            </>
          ) : (
            <>
              <Maximize2 className="w-3.5 h-3.5" />
              <span>Expand 3D</span>
            </>
          )}
        </button>
      </div>

      {contextLost && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950 text-slate-200 text-xs font-medium p-4 text-center">
          3D graphics context paused. Restoring view...
        </div>
      )}
    </div>
  );
};
