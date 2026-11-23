import {
  CommandDecisionReport,
  DatabaseStats,
  DetectionLogEntry,
  GeoActivityPoint,
  GeoDetectionPin,
} from '../types/vision';

const DB_NAME = 'gazva_command_db_v1';
const DB_VERSION = 1;

const STORES = {
  detections: 'detections',
  waypoints: 'waypoints',
  reports: 'reports',
  trail: 'trail',
} as const;

function openGazvaDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORES.detections)) {
          db.createObjectStore(STORES.detections, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.waypoints)) {
          db.createObjectStore(STORES.waypoints, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.reports)) {
          db.createObjectStore(STORES.reports, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.trail)) {
          db.createObjectStore(STORES.trail, { keyPath: 'timestamp' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function putItems<T>(storeName: string, items: T[]): Promise<void> {
  if (items.length === 0) return;
  const db = await openGazvaDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const item of items) {
      store.put(item);
    }
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
  });
}

async function getAllItems<T>(storeName: string): Promise<T[]> {
  const db = await openGazvaDb();
  if (!db) return [];
  return new Promise<T[]>((resolve) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => {
      db.close();
      resolve(Array.isArray(req.result) ? (req.result as T[]) : []);
    };
    req.onerror = () => {
      db.close();
      resolve([]);
    };
  });
}

export async function dbSaveDetections(entries: DetectionLogEntry[]): Promise<void> {
  // Trim oldest records cleanly if database grows large
  await putItems(STORES.detections, entries);
}

export async function dbLoadDetections(limit = 80): Promise<DetectionLogEntry[]> {
  const all = await getAllItems<DetectionLogEntry>(STORES.detections);
  return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

export async function dbSaveWaypoints(pins: GeoDetectionPin[]): Promise<void> {
  await putItems(STORES.waypoints, pins);
}

export async function dbLoadWaypoints(limit = 30): Promise<GeoDetectionPin[]> {
  const all = await getAllItems<GeoDetectionPin>(STORES.waypoints);
  return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

export async function dbSaveReport(report: CommandDecisionReport): Promise<void> {
  await putItems(STORES.reports, [report]);
}

export async function dbLoadReports(limit = 15): Promise<CommandDecisionReport[]> {
  const all = await getAllItems<CommandDecisionReport>(STORES.reports);
  return all.sort((a, b) => b.generatedAt - a.generatedAt).slice(0, limit);
}

export async function dbSaveTrailPoint(point: GeoActivityPoint): Promise<void> {
  await putItems(STORES.trail, [point]);
}

export async function dbLoadTrailPoints(limit = 150): Promise<GeoActivityPoint[]> {
  const all = await getAllItems<GeoActivityPoint>(STORES.trail);
  return all.sort((a, b) => a.timestamp - b.timestamp).slice(-limit);
}

export async function dbGetStats(): Promise<DatabaseStats> {
  const db = await openGazvaDb();
  if (!db) {
    return {
      backend: 'Memory Fallback',
      detectionsCount: 0,
      waypointsCount: 0,
      reportsCount: 0,
      trailCount: 0,
      lastUpdatedAt: null,
    };
  }
  const countStore = (name: string): Promise<number> =>
    new Promise((resolve) => {
      const tx = db.transaction(name, 'readonly');
      const req = tx.objectStore(name).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    });

  const [detectionsCount, waypointsCount, reportsCount, trailCount] = await Promise.all([
    countStore(STORES.detections),
    countStore(STORES.waypoints),
    countStore(STORES.reports),
    countStore(STORES.trail),
  ]);
  db.close();

  return {
    backend: 'IndexedDB',
    detectionsCount,
    waypointsCount,
    reportsCount,
    trailCount,
    lastUpdatedAt: Date.now(),
  };
}

export async function dbExportSnapshotJson(): Promise<string> {
  const [detections, waypoints, reports, trail] = await Promise.all([
    getAllItems<DetectionLogEntry>(STORES.detections),
    getAllItems<GeoDetectionPin>(STORES.waypoints),
    getAllItems<CommandDecisionReport>(STORES.reports),
    getAllItems<GeoActivityPoint>(STORES.trail),
  ]);
  return JSON.stringify(
    {
        exportedAt: new Date().toISOString(),
        schema: DB_NAME,
        counts: {
          detections: detections.length,
          waypoints: waypoints.length,
          reports: reports.length,
          trail: trail.length,
        },
        detections: detections.sort((a, b) => b.timestamp - a.timestamp).slice(0, 200),
        waypoints: waypoints.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100),
        reports: reports.sort((a, b) => b.generatedAt - a.generatedAt).slice(0, 30),
        trail: trail.sort((a, b) => a.timestamp - b.timestamp).slice(-300),
      },
      null,
      2
    );
}

export async function dbExportDetectionsCsv(): Promise<string> {
  const detections = await getAllItems<DetectionLogEntry>(STORES.detections);
  const sorted = detections.sort((a, b) => b.timestamp - a.timestamp).slice(0, 500);
  const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['timestamp_iso', 'label', 'raw_class', 'classification', 'score', 'latency_ms', 'source'];
  const rows = sorted.map((d) =>
    [
      new Date(d.timestamp).toISOString(),
      d.label,
      d.rawClass,
      d.classification,
      d.score.toFixed(3),
      Math.round(d.latencyMs),
      d.source || 'local',
    ]
      .map(escape)
      .join(',')
  );
  return [header.join(','), ...rows].join('\n');
}

export async function dbClearStore(storeKey?: keyof typeof STORES): Promise<void> {
  const db = await openGazvaDb();
  if (!db) return;
  const targetStores = storeKey ? [STORES[storeKey]] : Object.values(STORES);
  await new Promise<void>((resolve) => {
    const tx = db.transaction(targetStores, 'readwrite');
    for (const name of targetStores) {
      tx.objectStore(name).clear();
    }
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
  });
}
