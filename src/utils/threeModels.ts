import * as THREE from 'three';
import { Classification } from '../types/vision';

export interface SpatialItemInput {
  id: string;
  label: string;
  classification: Classification;
  score: number;
  thumbnailUrl?: string;
}

export function isSoftwareWebGLRenderer(): boolean {
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
      renderer.includes('softpipe') ||
      renderer.includes('software') ||
      renderer.includes('basic render')
    );
  } catch {
    return true;
  }
}

export function getClassificationPalette(classification: Classification) {
  if (classification === 'negative') {
    return {
      accent: 0xdc2626,
      emissive: 0x991b1b,
      accentHex: '#DC2626',
      tintHex: '#FEE2E2',
      tagText: 'ALERT',
    };
  }
  if (classification === 'positive') {
    return {
      accent: 0x16a34a,
      emissive: 0x166534,
      accentHex: '#16A34A',
      tintHex: '#DCFCE7',
      tagText: 'SAFE',
    };
  }
  return {
    accent: 0xe8922d,
    emissive: 0x92400e,
    accentHex: '#E8922D',
    tintHex: '#FEF3C7',
    tagText: 'TRACKED',
  };
}

/**
 * Generates a crisp procedural fallback texture when no camera snapshot exists
 * (e.g. standalone GPS waypoints logged while camera is off).
 */
export function createLabelCardTexture(
  label: string,
  classification: Classification,
  score: number
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext('2d');
  const palette = getClassificationPalette(classification);

  if (ctx) {
    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Subtle grid backdrop
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.lineWidth = 1;
    for (let x = 24; x < canvas.width; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 24; y < canvas.height; y += 24) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // Header status bar
    ctx.fillStyle = palette.accentHex;
    ctx.fillRect(0, 0, canvas.width, 46);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 18px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${palette.tagText} · ${Math.round(score * 100)}%`, 16, 23);

    // Center crosshair emblem
    ctx.strokeStyle = palette.accentHex;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(160, 122, 34, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(160, 78);
    ctx.lineTo(160, 166);
    ctx.moveTo(116, 122);
    ctx.lineTo(204, 122);
    ctx.stroke();

    // Bottom label plate
    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.fillRect(0, 178, canvas.width, 62);
    ctx.fillStyle = '#F8FAFC';
    ctx.font = '700 21px "Plus Jakarta Sans", sans-serif';
    ctx.fillText(label.slice(0, 22), 16, 210, 288);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Loads a base64 camera snapshot or falls back cleanly to a procedural label card.
 */
export function loadSnapshotTexture(
  item: SpatialItemInput,
  onLoaded?: () => void
): THREE.Texture {
  if (!item.thumbnailUrl) {
    return createLabelCardTexture(item.label, item.classification, item.score);
  }

  const fallbackTex = createLabelCardTexture(item.label, item.classification, item.score);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    const palette = getClassificationPalette(item.classification);
    if (ctx) {
      ctx.fillStyle = '#0F172A';
      ctx.fillRect(0, 0, 320, 240);
      ctx.drawImage(img, 0, 0, 320, 198);

      // Clean caption strip below real photo
      ctx.fillStyle = palette.accentHex;
      ctx.fillRect(0, 198, 320, 42);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 17px "Plus Jakarta Sans", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        `${item.label.slice(0, 19)} · ${Math.round(item.score * 100)}%`,
        12,
        219,
        296
      );
      fallbackTex.image = canvas;
      fallbackTex.needsUpdate = true;
    }
    onLoaded?.();
  };
  img.src = item.thumbnailUrl;
  return fallbackTex;
}

/**
 * Builds a 3-8 part composite 3D silhouette representing the detected object category.
 */
export function createCategorySilhouetteGroup(
  label: string,
  classification: Classification
): THREE.Group {
  const lower = label.toLowerCase();
  const palette = getClassificationPalette(classification);
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: classification === 'negative' ? 0xef4444 : classification === 'positive' ? 0x22c55e : 0x3b82f6,
    metalness: 0.45,
    roughness: 0.3,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    metalness: 0.72,
    roughness: 0.22,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    metalness: 0.35,
    roughness: 0.48,
  });
  const glowMat = new THREE.MeshStandardMaterial({
    color: palette.accent,
    emissive: palette.emissive,
    emissiveIntensity: 0.9,
    roughness: 0.25,
  });

  if (
    lower.includes('bottle') ||
    lower.includes('cola') ||
    lower.includes('pepsi') ||
    lower.includes('drink') ||
    lower.includes('cup') ||
    lower.includes('can') ||
    lower.includes('water') ||
    lower.includes('soda')
  ) {
    // Multi-part beverage container
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.34, 0.16, 20), trimMat);
    base.position.y = 0.08;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.78, 20), bodyMat);
    body.position.y = 0.55;
    const labelBand = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.32, 20), glowMat);
    labelBand.position.y = 0.58;
    const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.32, 0.22, 20), bodyMat);
    shoulder.position.y = 1.05;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.14, 16), darkMat);
    cap.position.y = 1.23;
    group.add(base, body, labelBand, shoulder, cap);
  } else if (
    lower.includes('phone') ||
    lower.includes('mobile') ||
    lower.includes('iphone') ||
    lower.includes('samsung') ||
    lower.includes('remote') ||
    lower.includes('device')
  ) {
    // Multi-part handheld mobile device
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(0.56, 1.05, 0.1), trimMat);
    chassis.position.y = 0.58;
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.49, 0.94, 0.02), darkMat);
    screen.position.set(0, 0.58, 0.055);
    const cameraBump = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22, 0.04), darkMat);
    cameraBump.position.set(-0.14, 0.9, -0.06);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 14), glowMat);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(-0.14, 0.94, -0.08);
    const statusStrip = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.06, 0.025), glowMat);
    statusStrip.position.set(0, 0.94, 0.062);
    group.add(chassis, screen, cameraBump, lens, statusStrip);
  } else if (
    lower.includes('laptop') ||
    lower.includes('computer') ||
    lower.includes('keyboard') ||
    lower.includes('tv') ||
    lower.includes('monitor')
  ) {
    // Multi-part workstation / laptop
    const baseDeck = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.07, 0.68), trimMat);
    baseDeck.position.set(0, 0.04, 0.1);
    const keyboard = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.02, 0.36), darkMat);
    keyboard.position.set(0, 0.085, 0.04);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.66, 0.05), trimMat);
    lid.position.set(0, 0.39, -0.22);
    lid.rotation.x = -0.14;
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.56, 0.02), glowMat);
    screen.position.set(0, 0.39, -0.19);
    screen.rotation.x = -0.14;
    group.add(baseDeck, keyboard, lid, screen);
  } else if (
    lower.includes('person') ||
    lower.includes('human') ||
    lower.includes('man') ||
    lower.includes('woman')
  ) {
    // Stylized safety figure marker
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.4, 0.1, 20), darkMat);
    plinth.position.y = 0.05;
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.68, 16), bodyMat);
    torso.position.y = 0.44;
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.04, 10, 20), trimMat);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.78;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 14), trimMat);
    head.position.y = 0.99;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.14), glowMat);
    visor.position.set(0, 1.0, 0.12);
    group.add(plinth, torso, collar, head, visor);
  } else if (classification === 'negative') {
    // High-visibility multi-part hazard beacon prism for negative alerts
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.48, 0.14, 6), darkMat);
    plinth.position.y = 0.07;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.045, 10, 24), glowMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.18;
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.36, 0), bodyMat);
    core.position.y = 0.66;
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.03, 8, 24), trimMat);
    band.rotation.x = Math.PI / 3;
    band.position.y = 0.66;
    const crown = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.24, 6), glowMat);
    crown.position.y = 1.15;
    group.add(plinth, ring, core, band, crown);
  } else {
    // Commercial package / crate assembly
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.62, 0.68), bodyMat);
    crate.position.y = 0.34;
    const strapX = new THREE.Mesh(new THREE.BoxGeometry(0.71, 0.64, 0.12), trimMat);
    strapX.position.y = 0.34;
    const strapZ = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.64, 0.71), trimMat);
    strapZ.position.y = 0.34;
    const seal = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.24), glowMat);
    seal.position.y = 0.67;
    group.add(crate, strapX, strapZ, seal);
  }

  return group;
}

/**
 * Multi-part central GPS compass station at (0, 0, 0) in the 3D GPS Perimeter scene.
 */
export function createDeviceBeaconGroup(hasGpsLock: boolean): THREE.Group {
  const group = new THREE.Group();

  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x0b2240,
    metalness: 0.6,
    roughness: 0.3,
  });
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    metalness: 0.78,
    roughness: 0.2,
  });
  const beaconMat = new THREE.MeshStandardMaterial({
    color: hasGpsLock ? 0x10b981 : 0xe8922d,
    emissive: hasGpsLock ? 0x059669 : 0xb45309,
    emissiveIntensity: 0.85,
    roughness: 0.2,
  });
  const domeMat = new THREE.MeshPhysicalMaterial({
    color: 0xbae6fd,
    roughness: 0.1,
    metalness: 0.05,
    transmission: 0.55,
    transparent: true,
    opacity: 0.72,
  });

  const baseDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.98, 0.2, 28), baseMat);
  baseDisc.position.y = 0.1;

  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.74, 0.18, 24), metalMat);
  collar.position.y = 0.28;

  const statusRing = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.05, 12, 32), beaconMat);
  statusRing.rotation.x = Math.PI / 2;
  statusRing.position.y = 0.22;

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 0.85, 16), metalMat);
  mast.position.y = 0.75;

  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.28, 20, 16), domeMat);
  dome.position.y = 1.2;

  const coreLight = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 12), beaconMat);
  coreLight.position.y = 1.2;

  // Forward compass arrow pointing North (-Z)
  const pointer = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 4), beaconMat);
  pointer.rotation.x = -Math.PI / 2;
  pointer.position.set(0, 0.24, -1.05);

  group.add(baseDisc, collar, statusRing, mast, dome, coreLight, pointer);
  return group;
}

/**
 * Creates a complete 3D GPS marker assembly:
 * Pedestal base + 3D category object silhouette + Framed 3D Photo Billboard screen.
 */
export function createGeoPinGroup(
  item: SpatialItemInput,
  onTextureLoaded?: () => void
): THREE.Group {
  const group = new THREE.Group();
  group.userData = { pinId: item.id };
  const palette = getClassificationPalette(item.classification);

  const plinthMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    metalness: 0.55,
    roughness: 0.35,
  });
  const ringMat = new THREE.MeshStandardMaterial({
    color: palette.accent,
    emissive: palette.emissive,
    emissiveIntensity: 0.85,
    roughness: 0.25,
  });
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    metalness: 0.5,
    roughness: 0.3,
  });

  // Base pedestal & glow ring
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.68, 0.16, 20), plinthMat);
  plinth.position.y = 0.08;
  const glowRing = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.045, 10, 26), ringMat);
  glowRing.rotation.x = Math.PI / 2;
  glowRing.position.y = 0.14;
  group.add(plinth, glowRing);

  // Category 3D silhouette scaled cleanly beside/in front of the photo frame
  const silhouette = createCategorySilhouetteGroup(item.label, item.classification);
  silhouette.scale.setScalar(0.62);
  silhouette.position.set(0, 0.16, 0.28);
  group.add(silhouette);

  // Vertical pylon + Framed 3D Photo Plaque
  const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.35, 12), frameMat);
  pylon.position.set(0, 0.82, -0.32);

  const plaqueBack = new THREE.Mesh(new THREE.BoxGeometry(1.48, 1.12, 0.07), frameMat);
  plaqueBack.position.set(0, 1.65, -0.32);

  const borderTrim = new THREE.Mesh(new THREE.BoxGeometry(1.54, 1.18, 0.04), ringMat);
  borderTrim.position.set(0, 1.65, -0.34);

  const photoTex = loadSnapshotTexture(item, onTextureLoaded);
  const photoMat = new THREE.MeshBasicMaterial({ map: photoTex });
  const photoFace = new THREE.Mesh(new THREE.PlaneGeometry(1.38, 1.02), photoMat);
  photoFace.position.set(0, 1.65, -0.28);

  group.add(pylon, borderTrim, plaqueBack, photoFace);

  // Tag all child meshes with pinId for reliable Raycaster click picking
  group.traverse((child) => {
    child.userData = { pinId: item.id };
  });

  return group;
}

/**
 * Richer studio 3D stage for the Alert / Object 3D Picture Inspector modal.
 */
export function createInspectionStageGroup(
  item: SpatialItemInput,
  onTextureLoaded?: () => void
): { stage: THREE.Group; subjectPivot: THREE.Group } {
  const stage = new THREE.Group();
  const palette = getClassificationPalette(item.classification);

  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    metalness: 0.65,
    roughness: 0.28,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x94a3b8,
    metalness: 0.8,
    roughness: 0.2,
  });
  const glowMat = new THREE.MeshStandardMaterial({
    color: palette.accent,
    emissive: palette.emissive,
    emissiveIntensity: 0.9,
    roughness: 0.25,
  });

  // Studio turntable plinth
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.75, 0.24, 36), baseMat);
  deck.position.y = 0.12;
  const trimRing = new THREE.Mesh(new THREE.CylinderGeometry(1.42, 1.46, 0.08, 36), trimMat);
  trimRing.position.y = 0.26;
  const neonRing = new THREE.Mesh(new THREE.TorusGeometry(1.56, 0.04, 12, 48), glowMat);
  neonRing.rotation.x = Math.PI / 2;
  neonRing.position.y = 0.25;
  stage.add(deck, trimRing, neonRing);

  const subjectPivot = new THREE.Group();
  subjectPivot.position.y = 0.3;

  // Main 3D object silhouette positioned slightly forward-left
  const silhouette = createCategorySilhouetteGroup(item.label, item.classification);
  silhouette.scale.setScalar(1.25);
  silhouette.position.set(-0.52, 0, 0.32);
  subjectPivot.add(silhouette);

  // Framed 3D captured photo screen angled beside it
  const frameBack = new THREE.Mesh(new THREE.BoxGeometry(1.72, 1.32, 0.09), baseMat);
  frameBack.position.set(0.66, 0.85, -0.2);
  frameBack.rotation.y = -0.28;

  const frameGlow = new THREE.Mesh(new THREE.BoxGeometry(1.78, 1.38, 0.05), glowMat);
  frameGlow.position.set(0.66, 0.85, -0.225);
  frameGlow.rotation.y = -0.28;

  const standArm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.45, 12), trimMat);
  standArm.position.set(0.66, 0.16, -0.2);

  const photoTex = loadSnapshotTexture(item, onTextureLoaded);
  const photoMat = new THREE.MeshBasicMaterial({ map: photoTex });
  const photoPlane = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.2), photoMat);
  photoPlane.position.set(0.66, 0.85, -0.152);
  photoPlane.rotation.y = -0.28;

  subjectPivot.add(standArm, frameGlow, frameBack, photoPlane);
  stage.add(subjectPivot);

  return { stage, subjectPivot };
}

export function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
      obj.geometry.dispose();
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of materials) {
        if (!mat) continue;
        if ('map' in mat && mat.map && mat.map instanceof THREE.Texture) {
          mat.map.dispose();
        }
        mat.dispose();
      }
    }
  });
}
