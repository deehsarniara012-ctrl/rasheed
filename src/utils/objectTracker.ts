import { DetectedItem } from '../types/vision';

interface TrackEntry {
  trackId: string;
  rawClass: string;
  cx: number;
  cy: number;
  bbox: [number, number, number, number];
  firstSeenMs: number;
  lastSeenMs: number;
  trail: Array<[number, number]>;
  velocityPxPerSec: number;
}

function computeIoU(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ax1 = a[0];
  const ay1 = a[1];
  const ax2 = a[0] + a[2];
  const ay2 = a[1] + a[3];

  const bx1 = b[0];
  const by1 = b[1];
  const bx2 = b[0] + b[2];
  const by2 = b[1] + b[3];

  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);

  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Deterministic IoU + centroid multi-object tracker assigning persistent Track IDs,
 * velocity vectors, dwell times, and motion trails across video frames.
 */
export class MultiObjectTracker {
  private tracks: TrackEntry[] = [];
  private nextSeq = 1;

  reset(): void {
    this.tracks = [];
    this.nextSeq = 1;
  }

  update(detections: DetectedItem[], nowMs: number, frameWidth: number): DetectedItem[] {
    // Prune stale tracks (> 1.4s unseen)
    this.tracks = this.tracks.filter((t) => nowMs - t.lastSeenMs <= 1400);

    const usedTrackIds = new Set<string>();
    const maxCentroidDist = Math.max(40, frameWidth * 0.16);

    const enriched = detections.map((det) => {
      const [bx, by, bw, bh] = det.bbox;
      const cx = bx + bw / 2;
      const cy = by + bh / 2;

      let bestTrack: TrackEntry | null = null;
      let bestScore = 0;

      for (const trk of this.tracks) {
        if (usedTrackIds.has(trk.trackId)) continue;
        if (trk.rawClass !== det.rawClass) continue;

        const iou = computeIoU(trk.bbox, det.bbox);
        const dist = Math.hypot(cx - trk.cx, cy - trk.cy);
        const distScore = dist <= maxCentroidDist ? 1 - dist / maxCentroidDist : 0;
        const combined = iou * 0.7 + distScore * 0.3;

        if ((iou >= 0.18 || dist <= maxCentroidDist * 0.75) && combined > bestScore) {
          bestScore = combined;
          bestTrack = trk;
        }
      }

      if (bestTrack) {
        usedTrackIds.add(bestTrack.trackId);
        const dtSec = Math.max(0.016, (nowMs - bestTrack.lastSeenMs) / 1000);
        const stepPx = Math.hypot(cx - bestTrack.cx, cy - bestTrack.cy);
        const instVel = stepPx / dtSec;
        bestTrack.velocityPxPerSec = Math.round(bestTrack.velocityPxPerSec * 0.6 + instVel * 0.4);
        bestTrack.cx = cx;
        bestTrack.cy = cy;
        bestTrack.bbox = det.bbox;
        bestTrack.lastSeenMs = nowMs;
        bestTrack.trail = [...bestTrack.trail, [Math.round(cx), Math.round(cy)] as [number, number]].slice(-10);

        return {
          ...det,
          trackId: bestTrack.trackId,
          velocityPxPerSec: bestTrack.velocityPxPerSec,
          dwellMs: nowMs - bestTrack.firstSeenMs,
          trail: bestTrack.trail,
        };
      }

      const trackId = `TRK-${String(this.nextSeq++).padStart(2, '0')}`;
      const created: TrackEntry = {
        trackId,
        rawClass: det.rawClass,
        cx,
        cy,
        bbox: det.bbox,
        firstSeenMs: nowMs,
        lastSeenMs: nowMs,
        trail: [[Math.round(cx), Math.round(cy)]],
        velocityPxPerSec: 0,
      };
      usedTrackIds.add(trackId);
      this.tracks.push(created);

      return {
        ...det,
        trackId,
        velocityPxPerSec: 0,
        dwellMs: 0,
        trail: created.trail,
      };
    });

    return enriched;
  }
}
