/**
 * Leaflet maps (OpenStreetMap tiles). CircleMarkers are used instead of image
 * icons, so no marker image assets are needed and colours follow the palette.
 */
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { CircleMarker, MapContainer, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM } from '../config';
import { useLanguage } from '../i18n/LanguageContext';
import { StatusBadge } from './ui/badges';

export const STATUS_COLORS = {
  new: '#2563EB',
  assigned: '#142D4E',
  in_progress: '#F59E0B',
  resolved: '#16A34A',
  closed: '#64748B',
};

function Tiles() {
  const { t } = useLanguage();
  return <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution={`&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · ${t('common.mapAttribution')}`} />;
}

/** Fits the view to the given points (once per change). */
function FitTo({ points }) {
  const map = useMap();
  const key = points.map((p) => p.join(',')).join('|');
  // No animation: an animated move that outlives the map (fast navigation,
  // React StrictMode remounts) makes Leaflet throw "_leaflet_pos" errors.
  useEffect(() => {
    if (points.length === 1) map.setView(points[0], 16, { animate: false });
    else if (points.length > 1) map.fitBounds(points, { padding: [32, 32], maxZoom: 16, animate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

/** Public issues as coloured points; the popup links to the public issue page. */
export function IssueMap({ issues = [], className = 'h-96', fit = true, scrollWheelZoom = false }) {
  const { categoryName, formatDate } = useLanguage();
  const points = issues.map((i) => [i.location.latitude, i.location.longitude]);
  return (
    <MapContainer center={DEFAULT_MAP_CENTER} zoom={DEFAULT_MAP_ZOOM} scrollWheelZoom={scrollWheelZoom} className={`w-full rounded-xl ${className}`}>
      <Tiles />
      {fit && points.length > 0 && <FitTo points={points} />}
      {issues.map((issue) => (
        <CircleMarker
          key={issue.referenceNumber}
          center={[issue.location.latitude, issue.location.longitude]}
          radius={7 + Math.min(issue.reportCount || 1, 8)}
          pathOptions={{ color: '#FFFFFF', weight: 2, fillColor: STATUS_COLORS[issue.status], fillOpacity: 0.9 }}
        >
          <Popup>
            <div className="min-w-44 space-y-1.5 font-sans">
              <p className="font-semibold text-ink">{categoryName(issue.category)}</p>
              <p className="text-xs text-muted">
                {issue.district.name} · {formatDate(issue.reportedAt)}
              </p>
              <StatusBadge status={issue.status} />
              <p>
                <Link to={`/issues/${issue.referenceNumber}`} className="text-xs font-semibold text-royal">
                  {issue.referenceNumber} →
                </Link>
              </p>
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}

/** One fixed point (e.g. an issue's location). */
export function PointMap({ latitude, longitude, className = 'h-64', color = '#2563EB' }) {
  return (
    <MapContainer center={[latitude, longitude]} zoom={16} scrollWheelZoom={false} className={`w-full rounded-xl ${className}`}>
      <Tiles />
      <CircleMarker center={[latitude, longitude]} radius={10} pathOptions={{ color: '#FFFFFF', weight: 3, fillColor: color, fillOpacity: 1 }} />
    </MapContainer>
  );
}

function ClickToPick({ onPick }) {
  useMapEvents({ click: (e) => onPick({ latitude: e.latlng.lat, longitude: e.latlng.lng }) });
  return null;
}

function FollowPoint({ value }) {
  const map = useMap();
  useEffect(() => {
    if (value) map.setView([value.latitude, value.longitude], Math.max(map.getZoom(), 16), { animate: false });
  }, [value, map]);
  return null;
}

/** Tap / click to set { latitude, longitude }; follows a GPS fix. */
export function LocationPicker({ value, onChange, className = 'h-72' }) {
  return (
    <MapContainer center={value ? [value.latitude, value.longitude] : DEFAULT_MAP_CENTER} zoom={value ? 16 : DEFAULT_MAP_ZOOM} className={`w-full cursor-crosshair rounded-xl ${className}`}>
      <Tiles />
      <ClickToPick onPick={onChange} />
      <FollowPoint value={value} />
      {value && <CircleMarker center={[value.latitude, value.longitude]} radius={11} pathOptions={{ color: '#FFFFFF', weight: 3, fillColor: '#DC2626', fillOpacity: 1 }} />}
    </MapContainer>
  );
}
