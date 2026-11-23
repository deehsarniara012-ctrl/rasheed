import React, { useEffect, useMemo, useState } from 'react';
import {
  APIProvider,
  APILoadingStatus,
  AdvancedMarker,
  Map as GoogleMap,
  InfoWindow,
  Pin,
  useAdvancedMarkerRef,
  useApiLoadingStatus,
} from '@vis.gl/react-google-maps';
import { Box, Compass, MapPin } from 'lucide-react';
import { GeoCoordinates, GeoDetectionPin, LinkedCameraNode } from '../types/vision';
import { Inspectable3DItem } from './Alert3DModal';

interface GoogleMapsViewProps {
  coords: GeoCoordinates | null;
  pins: GeoDetectionPin[];
  linkedNodes: LinkedCameraNode[];
  onInspect3D: (item: Inspectable3DItem) => void;
}

interface MarkerItemProps {
  id: string;
  position: { lat: number; lng: number };
  title: string;
  subtitle: string;
  background: string;
  borderColor: string;
  glyphColor: string;
  glyphText: string;
  thumbnailUrl?: string;
  isSelected: boolean;
  onSelect: () => void;
  onClose: () => void;
  onInspect?: () => void;
}

const MapMarkerWithInfo: React.FC<MarkerItemProps> = ({
  position,
  title,
  subtitle,
  background,
  borderColor,
  glyphColor,
  glyphText,
  thumbnailUrl,
  isSelected,
  onSelect,
  onClose,
  onInspect,
}) => {
  const [markerRef, marker] = useAdvancedMarkerRef();

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={position}
        title={title}
        onClick={onSelect}
      >
        <Pin
          background={background}
          borderColor={borderColor}
          glyphColor={glyphColor}
          glyphText={glyphText}
        />
      </AdvancedMarker>
      {isSelected && marker && (
        <InfoWindow anchor={marker} maxWidth={230} onCloseClick={onClose}>
          <div className="p-0.5 text-slate-900 space-y-1.5">
            <div className="text-xs font-bold leading-snug">{title}</div>
            <div className="text-[11px] text-slate-600">{subtitle}</div>
            {thumbnailUrl && (
              <img
                src={thumbnailUrl}
                alt={title}
                className="w-full h-16 object-cover rounded border border-slate-200"
              />
            )}
            {onInspect && (
              <button
                type="button"
                onClick={onInspect}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#0B2240] text-white text-[11px] font-semibold cursor-pointer"
              >
                <Box className="w-3 h-3" />
                <span>Inspect 3D Pic</span>
              </button>
            )}
          </div>
        </InfoWindow>
      )}
    </>
  );
};

const MapsStatusWatcher: React.FC<{ onErrorState: (msg: string | null) => void }> = ({
  onErrorState,
}) => {
  const status = useApiLoadingStatus();

  useEffect(() => {
    if (status === APILoadingStatus.AUTH_FAILURE || status === APILoadingStatus.FAILED) {
      window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
      onErrorState(
        'Google Maps could not finish loading. Check quota or network connectivity.'
      );
    } else if (status === APILoadingStatus.LOADED) {
      onErrorState(null);
    }
  }, [status, onErrorState]);

  return null;
};

export const GoogleMapsView: React.FC<GoogleMapsViewProps> = ({
  coords,
  pins,
  linkedNodes,
  onInspect3D,
}) => {
  const mapsApiKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) || '';
  const hasValidKey =
    mapsApiKey.trim().length > 0 && mapsApiKey.trim() !== 'MY_GOOGLE_MAPS_API_KEY';

  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const center = useMemo(() => {
    if (coords) {
      return { lat: coords.latitude, lng: coords.longitude };
    }
    const nodeWithCoords = linkedNodes.find((n) => n.coords !== null);
    if (nodeWithCoords?.coords) {
      return { lat: nodeWithCoords.coords.latitude, lng: nodeWithCoords.coords.longitude };
    }
    const pinWithCoords = pins.find(
      (p) => typeof p.latitude === 'number' && typeof p.longitude === 'number'
    );
    if (pinWithCoords && pinWithCoords.latitude !== undefined && pinWithCoords.longitude !== undefined) {
      return { lat: pinWithCoords.latitude, lng: pinWithCoords.longitude };
    }
    return { lat: 37.7749, lng: -122.4194 };
  }, [coords, linkedNodes, pins]);

  const geoPins = useMemo(
    () =>
      pins.filter(
        (p) => typeof p.latitude === 'number' && typeof p.longitude === 'number'
      ),
    [pins]
  );

  if (!hasValidKey) {
    return (
      <div className="w-full h-72 sm:h-80 rounded-xl border border-slate-200 bg-slate-950 text-slate-200 flex flex-col items-center justify-center p-6 text-center gap-2">
        <MapPin className="w-6 h-6 text-[#E8922D]" />
        <div className="text-sm font-semibold">Google Maps Platform Key Pending</div>
        <p className="text-xs text-slate-400 max-w-sm">
          Attach <code className="font-mono text-slate-200">VITE_GOOGLE_MAPS_API_KEY</code> in
          environment secrets to display live street & satellite tiles. Use 3D GPS View or 2D CSS
          Grid anytime.
        </p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-72 sm:h-80 rounded-xl border border-slate-200 bg-slate-950 overflow-hidden">
      <APIProvider apiKey={mapsApiKey} libraries={['marker']} language="en" region="US">
        <MapsStatusWatcher onErrorState={setLoadError} />
        <GoogleMap
          mapId="DEMO_MAP_ID"
          internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
          defaultCenter={center}
          center={coords ? { lat: coords.latitude, lng: coords.longitude } : undefined}
          defaultZoom={coords ? 16 : 12}
          gestureHandling="greedy"
          style={{ width: '100%', height: '100%' }}
        >
          {coords && (
            <MapMarkerWithInfo
              id="host-gps"
              position={{ lat: coords.latitude, lng: coords.longitude }}
              title="GAZVA Host Station"
              subtitle={`GPS ±${Math.round(coords.accuracy)}m`}
              background="#0B2240"
              borderColor="#FFFFFF"
              glyphColor="#FFFFFF"
              glyphText="H"
              isSelected={selectedMarkerId === 'host-gps'}
              onSelect={() => setSelectedMarkerId('host-gps')}
              onClose={() => setSelectedMarkerId(null)}
            />
          )}

          {linkedNodes.map((node, index) => {
            if (!node.coords) return null;
            const hasNeg = node.detections.some((d) => d.classification === 'negative');
            const mId = `node:${node.nodeId}`;
            return (
              <MapMarkerWithInfo
                key={mId}
                id={mId}
                position={{ lat: node.coords.latitude, lng: node.coords.longitude }}
                title={node.deviceName}
                subtitle={`Mobile Cam · ${node.detections.length} detections`}
                background={hasNeg ? '#DC2626' : '#0EA5E9'}
                borderColor="#FFFFFF"
                glyphColor="#FFFFFF"
                glyphText={`C${index + 1}`}
                thumbnailUrl={node.previewFrameUrl}
                isSelected={selectedMarkerId === mId}
                onSelect={() => setSelectedMarkerId(mId)}
                onClose={() => setSelectedMarkerId(null)}
                onInspect={() =>
                  onInspect3D({
                    id: node.nodeId,
                    label: node.deviceName,
                    classification: hasNeg ? 'negative' : 'neutral',
                    score: 1,
                    thumbnailUrl: node.previewFrameUrl,
                    latitude: node.coords?.latitude,
                    longitude: node.coords?.longitude,
                    timestamp: node.lastSeen,
                  })
                }
              />
            );
          })}

          {geoPins.map((pin) => {
            const isNeg = pin.classification === 'negative';
            const isPos = pin.classification === 'positive';
            return (
              <MapMarkerWithInfo
                key={pin.id}
                id={pin.id}
                position={{ lat: pin.latitude!, lng: pin.longitude! }}
                title={pin.label}
                subtitle={`${pin.classification.toUpperCase()} · ${Math.round(pin.score * 100)}%`}
                background={isNeg ? '#DC2626' : isPos ? '#059669' : '#E8922D'}
                borderColor="#FFFFFF"
                glyphColor="#FFFFFF"
                glyphText={isNeg ? '!' : isPos ? '✓' : 'P'}
                thumbnailUrl={pin.thumbnailUrl}
                isSelected={selectedMarkerId === pin.id}
                onSelect={() => setSelectedMarkerId(pin.id)}
                onClose={() => setSelectedMarkerId(null)}
                onInspect={() =>
                  onInspect3D({
                    id: pin.id,
                    label: pin.label,
                    classification: pin.classification,
                    score: pin.score,
                    thumbnailUrl: pin.thumbnailUrl,
                    latitude: pin.latitude,
                    longitude: pin.longitude,
                    timestamp: pin.timestamp,
                  })
                }
              />
            );
          })}
        </GoogleMap>
      </APIProvider>

      {!coords && (
        <div className="absolute bottom-2.5 left-2.5 px-2.5 py-1 rounded-md bg-slate-900 text-slate-100 border border-slate-700 text-[11px] font-medium flex items-center gap-1.5 pointer-events-none">
          <Compass className="w-3.5 h-3.5 text-[#E8922D]" />
          <span>Enable GPS Activity above to center map on your live coordinates</span>
        </div>
      )}

      {loadError && (
        <div className="absolute top-2.5 left-2.5 right-2.5 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-xs font-medium">
          {loadError}
        </div>
      )}
    </div>
  );
};
