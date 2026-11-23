export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function bearingDegrees(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Converts a target lat/lon into local East (+X) / South (+Z) / North (-Z) meters relative to origin.
 */
export function latLonToLocalMeters(
  originLat: number,
  originLon: number,
  targetLat: number,
  targetLon: number
): { eastMeters: number; northMeters: number } {
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((originLat * Math.PI) / 180);
  return {
    eastMeters: (targetLon - originLon) * metersPerDegLon,
    northMeters: (targetLat - originLat) * metersPerDegLat,
  };
}

export function extractRoomIdFromQrText(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const joinParam = parsed.searchParams.get('join');
    if (joinParam) {
      const cleaned = joinParam.replace(/[^A-Za-z0-9_-]/g, '').toUpperCase().slice(0, 16);
      return cleaned || null;
    }
  } catch {
    // Not a URL; inspect as direct room code
  }
  const codeMatch = trimmed.match(/^[A-Za-z0-9_-]{4,16}$/);
  return codeMatch ? codeMatch[0].toUpperCase() : null;
}

/**
 * Computes real astronomical solar elevation and azimuth (degrees) for any lat/lon and UTC timestamp.
 */
export function computeSolarPosition(
  latDeg: number,
  lonDeg: number,
  date: Date = new Date()
): { elevationDeg: number; azimuthDeg: number; daylight: boolean } {
  const rad = Math.PI / 180;
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 0));
  const diff = date.getTime() - start.getTime();
  const dayOfYear = Math.floor(diff / 86400000);
  const utcHours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;

  const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (utcHours - 12) / 24);
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma);

  const timeOffset = eqTime + 4 * lonDeg;
  const trueSolarTimeMin = (utcHours * 60 + timeOffset + 1440) % 1440;
  const hourAngleDeg = trueSolarTimeMin / 4 - 180;
  const ha = hourAngleDeg * rad;
  const lat = latDeg * rad;

  const cosZenith = Math.max(
    -1,
    Math.min(1, Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha))
  );
  const zenith = Math.acos(cosZenith);
  const elevationDeg = Math.round((90 - zenith / rad) * 10) / 10;

  const cosAz =
    (Math.sin(lat) * cosZenith - Math.sin(decl)) / (Math.cos(lat) * Math.sin(zenith) || 1e-6);
  const clampedAz = Math.max(-1, Math.min(1, cosAz));
  let azimuthDeg = Math.acos(clampedAz) / rad;
  azimuthDeg = hourAngleDeg > 0 ? (azimuthDeg + 180) % 360 : (540 - azimuthDeg) % 360;

  return {
    elevationDeg,
    azimuthDeg: Math.round(azimuthDeg),
    daylight: elevationDeg > 0,
  };
}

