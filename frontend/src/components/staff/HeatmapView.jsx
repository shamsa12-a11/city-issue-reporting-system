/**
 * Feature 12 heatmap drawn with Leaflet circles: every point is a real issue
 * location from the heatmap endpoint, coloured and sized by its weight
 * (report count) relative to the heaviest point. Palette: blue -> amber -> red.
 */
import { useEffect } from 'react';
import { CircleMarker, MapContainer, TileLayer, Tooltip, useMap } from 'react-leaflet';
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM } from '../../config';
import { useLanguage } from '../../i18n/LanguageContext';

const colorFor = (ratio) => (ratio >= 0.67 ? '#DC2626' : ratio >= 0.34 ? '#F59E0B' : '#2563EB');

function Fit({ points }) {
  const map = useMap();
  const key = `${points.length}:${points[0]?.latitude}:${points[points.length - 1]?.longitude}`;
  useEffect(() => {
    if (points.length === 1) map.setView([points[0].latitude, points[0].longitude], 15, { animate: false });
    else if (points.length > 1) map.fitBounds(points.map((p) => [p.latitude, p.longitude]), { padding: [32, 32], maxZoom: 15, animate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

export default function HeatmapView({ heatmap, className = 'h-[480px]' }) {
  const { t, language } = useLanguage();
  const points = heatmap?.points || [];
  const max = Math.max(1, heatmap?.summary.maxWeight || 1);
  return (
    <div className="relative">
      <MapContainer center={DEFAULT_MAP_CENTER} zoom={DEFAULT_MAP_ZOOM} scrollWheelZoom className={`w-full rounded-xl ${className}`}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' />
        <Fit points={points} />
        {points.map((p, i) => {
          const ratio = p.weight / max;
          return (
            <CircleMarker
              key={`${p.latitude},${p.longitude},${i}`}
              center={[p.latitude, p.longitude]}
              radius={8 + ratio * 16}
              pathOptions={{ stroke: false, fillColor: colorFor(ratio), fillOpacity: 0.45 }}
            >
              <Tooltip>{t('common.reports', { count: p.weight })}</Tooltip>
            </CircleMarker>
          );
        })}
      </MapContainer>
      {heatmap?.message && points.length === 0 && (
        <div className="pointer-events-none absolute inset-0 z-[400] flex items-center justify-center">
          <p className="rounded-lg bg-white/95 px-4 py-3 text-sm font-medium text-ink shadow">{language === 'so' ? heatmap.message.so : heatmap.message.en}</p>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted" aria-hidden="true">
        <span>{t('analytics.densityLow')}</span>
        <span className="h-3 w-3 rounded-full bg-royal" />
        <span className="h-3.5 w-3.5 rounded-full bg-warning" />
        <span className="h-4 w-4 rounded-full bg-critical" />
        <span>{t('analytics.densityHigh')}</span>
      </div>
    </div>
  );
}
