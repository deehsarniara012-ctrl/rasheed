import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Box,
  Compass,
  Grid2x2,
  LocateFixed,
  LocateOff,
  Map as MapIcon,
  MapPin,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  Classification,
  GeoActivityEvent,
  GeoActivityPoint,
  GeoCoordinates,
  GeoDetectionPin,
  LinkedCameraNode,
  NearbyAircraft,
  SatelliteTelemetry,
  SimulationSnapshot,
} from '../types/vision';
import { haversineMeters } from '../utils/geoMath';
import { Inspectable3DItem } from './Alert3DModal';
import { AirOrSatSelection, Geo3DMap } from './Geo3DMap';
import { GoogleMapsView } from './GoogleMapsView';

interface GeoTrackerProps {
  coords: GeoCoordinates | null;
  onUpdateCoords: (coords: GeoCoordinates | null) => void;
  pins: GeoDetectionPin[];
  linkedNodes: LinkedCameraNode[];
  aircraft?: NearbyAircraft[];
  satellite?: SatelliteTelemetry | null;
  simulation?: SimulationSnapshot | null;
  initialTrail?: GeoActivityPoint[];
  onSaveTrailPoint?: (point: GeoActivityPoint) => void;
  activityEvents: GeoActivityEvent[];
  onLogActivityEvent: (ev: Omit<GeoActivityEvent, 'id' | 'timestamp'>) => void;
  onAddManualPin: (label: string, classification: Classification) => void;
  onClearPins: () => void;
  onInspect3D: (item: Inspectable3DItem) => void;
}

export const GeoTracker: React.FC<GeoTrackerProps> = ({
  coords,
  onUpdateCoords,
  pins,
  linkedNodes,
  aircraft = [],
  satellite = null,
  simulation = null,
  initialTrail,
  onSaveTrailPoint,
  activityEvents,
  onLogActivityEvent,
  onAddManualPin,
  onClearPins,
  onInspect3D,
}) => {
  const [gpsStatus, setGpsStatus] = useState<'idle' | 'locating' | 'active' | 'error'>('idle');
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [activityRecording, setActivityRecording] = useState(true);
  const [activityTrail, setActivityTrail] = useState<GeoActivityPoint[]>(() => initialTrail ?? []);
  const [totalDistanceMeters, setTotalDistanceMeters] = useState(0);
  const [peakSpeedKmh, setPeakSpeedKmh] = useState(0);
  const [sessionStartMs, setSessionStartMs] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const [filterMode, setFilterMode] = useState<'all' | 'negative'>('all');
  const [viewMode, setViewMode] = useState<'3d' | 'gmap' | '2d'>('3d');
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [geofenceRadiusMeters, setGeofenceRadiusMeters] = useState<number>(250);
  const [selectedAirSat, setSelectedAirSat] = useState<AirOrSatSelection | null>(null);

  const [waypointLabel, setWaypointLabel] = useState('');
  const [waypointClass, setWaypointClass] = useState<Classification>('neutral');

  const watchIdRef = useRef<number | null>(null);
  const activityRecordingRef = useRef(activityRecording);
  activityRecordingRef.current = activityRecording;
  const lastTrailPointRef = useRef<GeoActivityPoint | null>(null);
  const onLogEventRef = useRef(onLogActivityEvent);
  onLogEventRef.current = onLogActivityEvent;
  const lastBreachLogMapRef = useRef<Record<string, number>>({});

  useEffect(() => {
    if (initialTrail && initialTrail.length > 0 && activityTrail.length === 0) {
      setActivityTrail(initialTrail);
      lastTrailPointRef.current = initialTrail[initialTrail.length - 1];
    }
  }, [initialTrail, activityTrail.length]);

  // Session duration ticker while GPS activity is active
  useEffect(() => {
    if (gpsStatus !== 'active' || !activityRecording) return;
    const timer = window.setInterval(() => {
      if (sessionStartMs) {
        setElapsedSeconds(Math.floor((Date.now() - sessionStartMs) / 1000));
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [gpsStatus, activityRecording, sessionStartMs]);

  const stopWatching = useCallback(() => {
    if (watchIdRef.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }, []);

  const recordGpsFix = useCallback(
    (next: GeoCoordinates) => {
      onUpdateCoords(next);

      if (!activityRecordingRef.current) return;
      setSessionStartMs((prev) => prev ?? Date.now());

      const prevPoint = lastTrailPointRef.current;
      const point: GeoActivityPoint = {
        latitude: next.latitude,
        longitude: next.longitude,
        accuracy: next.accuracy,
        speed: next.speed,
        heading: next.heading,
        timestamp: next.updatedAt,
        sourceLabel: 'Host GPS',
      };

      const speedKmh = next.speed !== null && next.speed >= 0 ? next.speed * 3.6 : 0;
      setPeakSpeedKmh((prev) => Math.max(prev, speedKmh));

      if (!prevPoint) {
        lastTrailPointRef.current = point;
        setActivityTrail((prev) => [...prev, point].slice(-150));
        onSaveTrailPoint?.(point);
        onLogEventRef.current({
          type: 'gps_lock',
          message: `Standalone GPS lock acquired (±${Math.round(next.accuracy)}m accuracy)`,
          coords: { latitude: next.latitude, longitude: next.longitude },
        });
      } else {
        const deltaMeters = haversineMeters(
          prevPoint.latitude,
          prevPoint.longitude,
          next.latitude,
          next.longitude
        );
        // Filter stationary GPS jitter (< 2.5m)
        if (deltaMeters >= 2.5 && deltaMeters <= 5000) {
          lastTrailPointRef.current = point;
          setTotalDistanceMeters((d) => d + deltaMeters);
          setActivityTrail((prev) => [...prev, point].slice(-150));
          onSaveTrailPoint?.(point);
          onLogEventRef.current({
            type: 'movement',
            message: `Moved +${deltaMeters.toFixed(1)}m${
              speedKmh > 0.5 ? ` at ${speedKmh.toFixed(1)} km/h` : ''
            }`,
            distanceMeters: deltaMeters,
            coords: { latitude: next.latitude, longitude: next.longitude },
          });
        }
      }
    },
    [onUpdateCoords, onSaveTrailPoint]
  );

  const startTrackingGps = useCallback(() => {
    if (!navigator.geolocation) {
      setGpsStatus('error');
      setGpsError('Browser Geolocation API is not supported on this device.');
      return;
    }

    stopWatching();
    setGpsStatus('locating');
    setGpsError(null);

    const onSuccess = (pos: GeolocationPosition) => {
      setGpsStatus('active');
      setGpsError(null);
      recordGpsFix({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        heading: pos.coords.heading,
        speed: pos.coords.speed,
        updatedAt: pos.timestamp || Date.now(),
      });
    };

    const onError = (err: GeolocationPositionError) => {
      setGpsStatus('error');
      if (err.code === err.PERMISSION_DENIED) {
        setGpsError('Location permission denied. Allow GPS access in browser settings.');
      } else if (err.code === err.POSITION_UNAVAILABLE) {
        setGpsError('Device location signal unavailable.');
      } else {
        setGpsError('Location request timed out. Tap Refresh GPS to retry.');
      }
    };

    navigator.geolocation.getCurrentPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 4000,
    });

    watchIdRef.current = navigator.geolocation.watchPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 2500,
    });
  }, [recordGpsFix, stopWatching]);

  // Auto-start standalone GPS activity when permission is granted (works without camera)
  useEffect(() => {
    let active = true;
    if (navigator.permissions?.query) {
      navigator.permissions
        .query({ name: 'geolocation' })
        .then((status) => {
          if (active && status.state === 'granted') {
            startTrackingGps();
          }
        })
        .catch(() => {
          // Permissions query unsupported
        });
    }
    return () => {
      active = false;
      stopWatching();
    };
  }, [startTrackingGps, stopWatching]);

  const visiblePins = useMemo(() => {
    if (filterMode === 'negative') {
      return pins.filter((p) => p.classification === 'negative');
    }
    return pins;
  }, [pins, filterMode]);

  const selectedPin = useMemo(
    () => visiblePins.find((p) => p.id === selectedPinId) || visiblePins[0] || null,
    [visiblePins, selectedPinId]
  );

  // Evaluate live Haversine geofence perimeter status for linked mobile nodes & host trail excursion
  const geofenceBreaches = useMemo(() => {
    if (!coords) return [] as Array<{ id: string; name: string; distanceMeters: number }>;
    const breaches: Array<{ id: string; name: string; distanceMeters: number }> = [];

    if (activityTrail.length > 0) {
      const origin = activityTrail[0];
      const hostDist = haversineMeters(
        origin.latitude,
        origin.longitude,
        coords.latitude,
        coords.longitude
      );
      if (hostDist > geofenceRadiusMeters) {
        breaches.push({
          id: 'host-excursion',
          name: 'Host GPS Origin Excursion',
          distanceMeters: Math.round(hostDist),
        });
      }
    }

    for (const node of linkedNodes) {
      if (!node.coords) continue;
      const d = haversineMeters(
        coords.latitude,
        coords.longitude,
        node.coords.latitude,
        node.coords.longitude
      );
      if (d > geofenceRadiusMeters) {
        breaches.push({
          id: node.nodeId,
          name: node.deviceName,
          distanceMeters: Math.round(d),
        });
      }
    }

    return breaches;
  }, [coords, activityTrail, linkedNodes, geofenceRadiusMeters]);

  useEffect(() => {
    const now = Date.now();
    for (const b of geofenceBreaches) {
      if (now - (lastBreachLogMapRef.current[b.id] ?? 0) >= 20000) {
        lastBreachLogMapRef.current[b.id] = now;
        onLogEventRef.current({
          type: 'remote_node',
          message: `Geofence alert: ${b.name} is ${b.distanceMeters}m outside ${geofenceRadiusMeters}m perimeter`,
          distanceMeters: b.distanceMeters,
        });
      }
    }
  }, [geofenceBreaches, geofenceRadiusMeters]);

  const formatCoord = (val: number, posChar: string, negChar: string) => {
    const dir = val >= 0 ? posChar : negChar;
    return `${Math.abs(val).toFixed(6)}° ${dir}`;
  };

  const formatDuration = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  };

  const currentSpeedKmh =
    coords?.speed !== null && coords?.speed !== undefined && coords.speed >= 0
      ? coords.speed * 3.6
      : 0;
  const movementState =
    gpsStatus !== 'active'
      ? 'Standby'
      : currentSpeedKmh > 1.2
      ? 'Moving'
      : 'Stationary';

  const handleDropWaypoint = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = waypointLabel.trim();
    if (!cleaned) return;
    onAddManualPin(cleaned, waypointClass);
    setWaypointLabel('');
  };

  const handleResetTrail = () => {
    setActivityTrail([]);
    setTotalDistanceMeters(0);
    setPeakSpeedKmh(0);
    setElapsedSeconds(0);
    setSessionStartMs(gpsStatus === 'active' ? Date.now() : null);
    lastTrailPointRef.current = null;
  };

  return (
    <section
      id="geo-tracker"
      className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-3xl p-4 sm:p-6 shadow-xs"
    >
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white tracking-tight">
            Standalone 3D GPS Activity & Maps
          </h2>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Tracks live GPS distance, trail, speed & connected mobile cameras without needing host camera ON
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-2xl">
            <button
              type="button"
              onClick={() => setViewMode('3d')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl transition-colors whitespace-nowrap min-h-[36px] cursor-pointer ${
                viewMode === '3d'
                  ? 'bg-[#0B4FE6] text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Box className="w-3.5 h-3.5" />
              <span>3D GPS View</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('gmap')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl transition-colors whitespace-nowrap min-h-[36px] cursor-pointer ${
                viewMode === 'gmap'
                  ? 'bg-[#0B4FE6] text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <MapIcon className="w-3.5 h-3.5" />
              <span>Google Maps</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('2d')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl transition-colors whitespace-nowrap min-h-[36px] cursor-pointer ${
                viewMode === '2d'
                  ? 'bg-[#0B4FE6] text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Grid2x2 className="w-3.5 h-3.5" />
              <span>2D Grid</span>
            </button>
          </div>

          <button
            type="button"
            onClick={startTrackingGps}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-2xl transition-colors whitespace-nowrap min-h-[42px] cursor-pointer shadow-xs ${
              gpsStatus === 'active'
                ? 'bg-[#0B4FE6] text-white hover:bg-[#1D4ED8]'
                : 'bg-[#DC2626] text-white hover:bg-red-700'
            }`}
          >
            {gpsStatus === 'locating' ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : gpsStatus === 'error' ? (
              <LocateOff className="w-4 h-4" />
            ) : (
              <LocateFixed className="w-4 h-4" />
            )}
            <span>
              {gpsStatus === 'active'
                ? 'Refresh GPS'
                : gpsStatus === 'locating'
                ? 'Locating...'
                : 'Enable GPS Activity'}
            </span>
          </button>

          {gpsStatus === 'active' && (
            <button
              type="button"
              onClick={() => setActivityRecording((r) => !r)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-2xl border transition-colors whitespace-nowrap min-h-[42px] cursor-pointer ${
                activityRecording
                  ? 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800'
                  : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700'
              }`}
            >
              {activityRecording ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              <span>{activityRecording ? 'Pause Log' : 'Resume Log'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Standalone GPS Activity Telemetry Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 mb-4">
        <div className="border border-slate-200/90 dark:border-slate-800 rounded-2xl p-3 bg-slate-50/80 dark:bg-slate-950/60">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Activity State</div>
          <div className="text-sm font-mono font-bold text-slate-900 dark:text-white mt-0.5 flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-[#0B4FE6]" />
            <span>{movementState}</span>
          </div>
        </div>

        <div className="border border-slate-200/90 dark:border-slate-800 rounded-2xl p-3 bg-slate-50/80 dark:bg-slate-950/60">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Distance Tracked</div>
          <div className="text-sm font-mono font-bold text-[#0B4FE6] dark:text-blue-400 tabular-nums mt-0.5">
            {totalDistanceMeters >= 1000
              ? `${(totalDistanceMeters / 1000).toFixed(2)} km`
              : `${totalDistanceMeters.toFixed(1)} m`}
          </div>
        </div>

        <div className="border border-slate-200/90 dark:border-slate-800 rounded-2xl p-3 bg-slate-50/80 dark:bg-slate-950/60">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Speed / Peak</div>
          <div className="text-sm font-mono font-bold text-slate-900 dark:text-white tabular-nums mt-0.5 truncate">
            {currentSpeedKmh.toFixed(1)} / {peakSpeedKmh.toFixed(1)} km/h
          </div>
        </div>

        <div className="border border-slate-200/90 dark:border-slate-800 rounded-2xl p-3 bg-slate-50/80 dark:bg-slate-950/60">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Latitude</div>
          <div className="text-xs font-mono font-bold text-slate-900 dark:text-white tabular-nums mt-1 truncate">
            {coords ? formatCoord(coords.latitude, 'N', 'S') : '—'}
          </div>
        </div>

        <div className="border border-slate-200/90 dark:border-slate-800 rounded-2xl p-3 bg-slate-50/80 dark:bg-slate-950/60">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Longitude</div>
          <div className="text-xs font-mono font-bold text-slate-900 dark:text-white tabular-nums mt-1 truncate">
            {coords ? formatCoord(coords.longitude, 'E', 'W') : '—'}
          </div>
        </div>

        <div className="border border-slate-200/90 dark:border-slate-800 rounded-2xl p-3 bg-slate-50/80 dark:bg-slate-950/60">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Session / Trail</div>
          <div className="text-sm font-mono font-bold text-slate-900 dark:text-white tabular-nums mt-0.5">
            {formatDuration(elapsedSeconds)} · {activityTrail.length} pts
          </div>
        </div>
      </div>

      {gpsError && (
        <div className="mb-4 px-3.5 py-2.5 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300">
          {gpsError}
        </div>
      )}

      {/* Standalone GPS Waypoint Plotter (works without Camera) */}
      <form
        onSubmit={handleDropWaypoint}
        className="mb-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 rounded-2xl p-2.5"
      >
        <input
          type="text"
          value={waypointLabel}
          onChange={(e) => setWaypointLabel(e.target.value)}
          placeholder="Drop standalone GPS 3D pin without camera (e.g. Gate 1, Patrol Point)..."
          className="flex-1 min-w-0 px-3.5 py-2 text-xs sm:text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0B4FE6]/25"
        />
        <div className="flex items-center gap-2">
          <select
            value={waypointClass}
            onChange={(e) => setWaypointClass(e.target.value as Classification)}
            aria-label="Pin classification"
            className="px-3 py-2 text-xs font-semibold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-200 min-h-[40px]"
          >
            <option value="neutral">Waypoint</option>
            <option value="positive">Positive Safe</option>
            <option value="negative">Negative Alert</option>
          </select>
          <button
            type="submit"
            disabled={!waypointLabel.trim()}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-bold bg-[#DC2626] hover:bg-red-700 text-white rounded-xl whitespace-nowrap min-h-[40px] cursor-pointer disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Pin on 3D GPS</span>
          </button>
        </div>
      </form>

      {geofenceBreaches.length > 0 && (
        <div className="mb-4 px-3.5 py-2.5 rounded-2xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-200 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
            <span>
              Geofence Perimeter Exceeded ({geofenceRadiusMeters}m):{' '}
              {geofenceBreaches.map((b) => `${b.name} (${b.distanceMeters}m)`).join(', ')}
            </span>
          </div>
          <span className="font-mono text-[11px] text-red-700 dark:text-red-300">Live Haversine</span>
        </div>
      )}

      {/* Main 3D Map / 2D CSS Grid + Activity & Marker Inspector */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-stretch">
        <div className="md:col-span-8 flex flex-col gap-2">
          {viewMode === '3d' ? (
            <Geo3DMap
              coords={coords}
              pins={visiblePins}
              activityTrail={activityTrail}
              linkedNodes={linkedNodes}
              aircraft={aircraft}
              satellite={satellite}
              simulation={simulation}
              geofenceRadiusMeters={geofenceRadiusMeters}
              selectedPinId={selectedPin?.id || null}
              onSelectAirOrSat={(info) => setSelectedAirSat(info)}
              onSelectPin={(id) => {
                setSelectedAirSat(null);
                if (id.startsWith('node:')) {
                  const nodeId = id.slice(5);
                  const node = linkedNodes.find((n) => n.nodeId === nodeId);
                  if (node) {
                    onInspect3D({
                      id: node.nodeId,
                      label: node.deviceName,
                      classification: node.detections.some((d) => d.classification === 'negative')
                        ? 'negative'
                        : 'neutral',
                      score: 1,
                      thumbnailUrl: node.previewFrameUrl,
                      latitude: node.coords?.latitude,
                      longitude: node.coords?.longitude,
                      timestamp: node.lastSeen,
                    });
                  }
                } else {
                  setSelectedPinId(id);
                }
              }}
            />
          ) : viewMode === 'gmap' ? (
            <GoogleMapsView
              coords={coords}
              pins={visiblePins}
              linkedNodes={linkedNodes}
              onInspect3D={onInspect3D}
            />
          ) : (
            <div
              className="relative w-full h-72 sm:h-80 rounded-xl border border-slate-200 bg-slate-950 overflow-hidden select-none"
              style={{
                backgroundImage:
                  'linear-gradient(to right, rgba(148,163,184,0.14) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.14) 1px, transparent 1px)',
                backgroundSize: '32px 32px',
              }}
              aria-label="CSS coordinate grid showing current device location and detected objects"
            >
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-28 h-28 rounded-full border border-slate-700/70" />
              </div>
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-52 h-52 rounded-full border border-slate-700/50" />
              </div>
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-80 h-80 rounded-full border border-slate-800/60" />
              </div>

              <div className="absolute inset-x-0 top-1/2 h-px bg-slate-700/60 pointer-events-none" />
              <div className="absolute inset-y-0 left-1/2 w-px bg-slate-700/60 pointer-events-none" />

              <span className="absolute top-2 left-1/2 -translate-x-1/2 text-[10px] font-mono font-semibold text-slate-400">
                N · FORWARD
              </span>
              <span className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] font-mono font-semibold text-slate-400">
                S
              </span>
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] font-mono font-semibold text-slate-400">
                W
              </span>
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono font-semibold text-slate-400">
                E
              </span>

              <div
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 flex flex-col items-center pointer-events-none"
                title="Your Current Device Position"
              >
                <div className="w-8 h-8 rounded-full bg-[#0B2240] border-2 border-white shadow-md flex items-center justify-center text-white">
                  <Compass className="w-4 h-4" />
                </div>
                <span className="mt-1 px-1.5 py-0.5 rounded bg-slate-900/90 text-[10px] font-mono font-semibold text-white whitespace-nowrap border border-slate-700">
                  {coords ? 'GPS LOCKED' : 'DEVICE'}
                </span>
              </div>

              {visiblePins.map((pin) => {
                const isNeg = pin.classification === 'negative';
                const isPos = pin.classification === 'positive';
                const isSelected = selectedPin?.id === pin.id;

                return (
                  <button
                    key={pin.id}
                    type="button"
                    onClick={() => setSelectedPinId(pin.id)}
                    style={{
                      left: `${Math.max(8, Math.min(92, pin.gridX))}%`,
                      top: `${Math.max(10, Math.min(88, pin.gridY))}%`,
                    }}
                    className={`absolute -translate-x-1/2 -translate-y-1/2 z-20 group flex flex-col items-center cursor-pointer transition-transform ${
                      isSelected ? 'scale-110 z-30' : 'hover:scale-105'
                    }`}
                  >
                    <span
                      className={`w-6 h-6 rounded-full border-2 border-white shadow-sm flex items-center justify-center text-white ${
                        isNeg
                          ? 'bg-red-600'
                          : isPos
                          ? 'bg-emerald-600'
                          : 'bg-slate-600'
                      }`}
                    >
                      {isNeg ? (
                        <ShieldAlert className="w-3.5 h-3.5" />
                      ) : isPos ? (
                        <ShieldCheck className="w-3.5 h-3.5" />
                      ) : (
                        <MapPin className="w-3.5 h-3.5" />
                      )}
                    </span>
                    <span
                      className={`mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold whitespace-nowrap border ${
                        isNeg
                          ? 'bg-red-950/90 text-red-200 border-red-500/60'
                          : isPos
                          ? 'bg-emerald-950/90 text-emerald-200 border-emerald-500/60'
                          : 'bg-slate-900/90 text-slate-200 border-slate-700'
                      }`}
                    >
                      {pin.label}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Filter, Geofence Perimeter & Reset Controls */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-2xl">
                <button
                  type="button"
                  onClick={() => setFilterMode('all')}
                  className={`px-3 py-1.5 text-xs font-bold rounded-xl transition-colors whitespace-nowrap min-h-[34px] cursor-pointer ${
                    filterMode === 'all'
                      ? 'bg-[#0B4FE6] text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  All 3D Items ({pins.length})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterMode('negative')}
                  className={`px-3 py-1.5 text-xs font-bold rounded-xl transition-colors whitespace-nowrap min-h-[34px] cursor-pointer ${
                    filterMode === 'negative'
                      ? 'bg-[#DC2626] text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  Alerts Only ({pins.filter((p) => p.classification === 'negative').length})
                </button>
              </div>

              <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 font-medium">
                <span>Geofence:</span>
                <select
                  value={geofenceRadiusMeters}
                  onChange={(e) => setGeofenceRadiusMeters(Number(e.target.value))}
                  aria-label="Geofence perimeter radius"
                  className="px-2.5 py-1.5 text-xs font-mono font-semibold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-800 dark:text-slate-200 min-h-[34px]"
                >
                  <option value={100}>100 m</option>
                  <option value={250}>250 m</option>
                  <option value={500}>500 m</option>
                  <option value={1000}>1,000 m</option>
                  <option value={2500}>2,500 m</option>
                </select>
              </label>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleResetTrail}
                disabled={activityTrail.length === 0}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors whitespace-nowrap min-h-[34px] cursor-pointer disabled:opacity-40"
              >
                <span>Reset Trail</span>
              </button>
              <button
                type="button"
                onClick={onClearPins}
                disabled={pins.length === 0}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-xl transition-colors whitespace-nowrap min-h-[34px] cursor-pointer disabled:opacity-40"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear Pins</span>
              </button>
            </div>
          </div>
        </div>

        {/* Right Side: Selected 3D Pin / Air-Sat Telemetry + Standalone GPS Activity Timeline */}
        <div className="md:col-span-4 border border-slate-200/90 dark:border-slate-800 rounded-2xl p-3.5 bg-slate-50/70 dark:bg-slate-950/60 flex flex-col justify-between gap-3">
          {selectedAirSat && (
            <div className="rounded-2xl border border-blue-200 dark:border-blue-800 bg-blue-50/80 dark:bg-blue-950/50 p-3 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold uppercase font-mono text-[#0B4FE6] dark:text-blue-300">
                  {selectedAirSat.kind === 'satellite' ? '3D LEO Satellite' : '3D ADS-B Flight'}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedAirSat(null)}
                  aria-label="Close aircraft or satellite telemetry"
                  className="text-[#0B4FE6] dark:text-blue-300 hover:text-slate-950 p-0.5 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="text-sm font-bold text-slate-900 dark:text-white truncate">
                {selectedAirSat.title}
              </div>
              <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                {selectedAirSat.subtitle}
              </div>
              <div className="text-[11px] font-mono text-slate-600 dark:text-slate-400">
                {selectedAirSat.details}
              </div>
            </div>
          )}
          {selectedPin ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  Selected 3D GPS Pin
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onInspect3D({
                      id: selectedPin.id,
                      label: selectedPin.label,
                      classification: selectedPin.classification,
                      score: selectedPin.score,
                      thumbnailUrl: selectedPin.thumbnailUrl,
                      latitude: selectedPin.latitude,
                      longitude: selectedPin.longitude,
                      timestamp: selectedPin.timestamp,
                    })
                  }
                  className="inline-flex items-center gap-1 px-3 py-1 rounded-xl bg-[#0B4FE6] hover:bg-[#1D4ED8] text-white text-[11px] font-bold cursor-pointer"
                >
                  <Box className="w-3 h-3" />
                  <span>Open 3D Pic</span>
                </button>
              </div>

              {selectedPin.thumbnailUrl && (
                <img
                  src={selectedPin.thumbnailUrl}
                  alt={selectedPin.label}
                  className="w-full h-24 rounded-xl object-cover border border-slate-200 dark:border-slate-700 bg-slate-900"
                />
              )}

              <div>
                <div className="text-sm font-bold text-slate-900 dark:text-white truncate">
                  {selectedPin.label}
                </div>
                <div className="flex items-center gap-2 text-xs mt-0.5">
                  <span
                    className={`font-mono font-bold uppercase ${
                      selectedPin.classification === 'negative'
                        ? 'text-red-600 dark:text-red-400'
                        : selectedPin.classification === 'positive'
                        ? 'text-[#0B4FE6] dark:text-blue-400'
                        : 'text-amber-700 dark:text-amber-400'
                    }`}
                  >
                    {selectedPin.classification}
                  </span>
                  <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                    ·
                  </span>
                  <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400">
                    {Math.round(selectedPin.score * 100)}%
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="py-3 text-center">
              <Activity className="w-5 h-5 text-[#0B4FE6] mx-auto mb-1" />
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                GPS Activity Ready
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                Enable GPS above to track movement distance & waypoints without camera.
              </p>
            </div>
          )}

          {/* GPS Activity Timeline */}
          <div className="border-t border-slate-200/80 dark:border-slate-800 pt-2.5 flex-1 flex flex-col min-h-[120px]">
            <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
              Live GPS Activity Log ({activityEvents.length})
            </div>
            {activityEvents.length === 0 ? (
              <div className="text-[11px] text-slate-400 italic">
                Waiting for GPS movement, waypoints, or mobile node sync...
              </div>
            ) : (
              <ul className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                {activityEvents.slice(0, 12).map((ev) => (
                  <li
                    key={ev.id}
                    className="text-[11px] bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 rounded-xl px-2.5 py-2 flex items-start justify-between gap-2"
                  >
                    <span className="text-slate-700 dark:text-slate-200 leading-snug">{ev.message}</span>
                    <span className="font-mono text-[10px] text-slate-400 shrink-0 tabular-nums">
                      {new Date(ev.timestamp).toLocaleTimeString([], {
                        hour12: false,
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
