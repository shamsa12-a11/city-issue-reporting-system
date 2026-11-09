/**
 * DEMO GPS — LOCAL DEVELOPMENT ONLY.
 *
 * A map with a draggable marker that sets the location a form will send,
 * for browser testing when the device GPS is wrong. It does not change any
 * check: the backend still detects the district and still enforces the
 * 50 m after-photo rule on whatever point is sent.
 *
 * It only appears when ALL of these are true:
 *   1. Vite dev server (`import.meta.env.DEV`). Pages import this file only
 *      inside an `import.meta.env.DEV` branch, so production builds do not
 *      contain it at all.
 *   2. The page is opened on 127.0.0.1 or localhost.
 *   3. VITE_API_ORIGIN is not set (all API calls go through the dev proxy).
 *   4. The backend behind the proxy answers /api/__test-backend as the
 *      in-memory dev backend. That route exists only in
 *      backend/scripts/dev-memory-server.js, never in the real server.
 * English only on purpose: this is a developer tool, not part of the app.
 */
import { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import { Circle, CircleMarker, MapContainer, Marker, TileLayer, useMapEvents } from 'react-leaflet';
import { DEFAULT_MAP_CENTER } from '../config';

const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];
const RULE_METRES = 50; // shown for information only; the backend decides

/** true only on the verified local in-memory demo backend. */
function useDemoGpsEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.VITE_API_ORIGIN) return undefined;
    if (!LOCAL_HOSTS.includes(window.location.hostname)) return undefined;
    let alive = true;
    fetch('/api/__test-backend', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((id) => {
        if (alive) setEnabled(id?.mode === 'in-memory' && id?.database === 'memory');
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return enabled;
}

/** Great-circle distance in metres (display only). */
function metresBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

const demoIcon = L.divIcon({
  className: '',
  html: '<div style="transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center"><span style="background:#B45309;color:#fff;font:700 10px/1 sans-serif;padding:3px 5px;border-radius:4px;white-space:nowrap">DEMO GPS</span><span style="width:16px;height:16px;margin-top:2px;border-radius:50%;background:#F59E0B;border:3px solid #fff;box-shadow:0 0 0 1px #B45309"></span></div>',
  iconSize: [0, 0],
});

function ClickToMove({ onPick }) {
  useMapEvents({ click: (e) => onPick({ latitude: e.latlng.lat, longitude: e.latlng.lng }) });
  return null;
}

/**
 * @param {{ latitude:number, longitude:number }|null} value   current point of the form
 * @param {(p:{latitude:number, longitude:number}) => void} onChange
 * @param {{ latitude:number, longitude:number }} [target]  issue location (officer resolve)
 */
export default function DemoGpsPanel({ value, onChange, target }) {
  const enabled = useDemoGpsEnabled();
  const [start] = useState(() => (value ? [value.latitude, value.longitude] : target ? [target.latitude, target.longitude] : DEFAULT_MAP_CENTER));
  const distance = useMemo(() => (value && target ? metresBetween(value, target) : null), [value, target]);
  if (!enabled) return null;

  const pick = (p) => onChange({ latitude: Number(p.latitude.toFixed(6)), longitude: Number(p.longitude.toFixed(6)) });

  return (
    <div className="rounded-xl border-2 border-dashed border-amber-500 bg-amber-50 p-4">
      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-amber-800">
        <span className="rounded bg-amber-600 px-2 py-0.5 text-xs font-bold tracking-wide text-white">DEMO GPS</span>
        Local in-memory demo only — simulated location, not real GPS
      </p>
      <p className="mt-1 text-xs text-amber-800">Click the map or drag the marker. The server still checks this point with its normal rules.</p>
      <div className="mt-3 overflow-hidden rounded-lg border border-amber-300">
        <MapContainer center={start} zoom={16} className="h-64 w-full cursor-crosshair">
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' />
          <ClickToMove onPick={pick} />
          {target && (
            <>
              <Circle center={[target.latitude, target.longitude]} radius={RULE_METRES} pathOptions={{ color: '#2563EB', weight: 1, fillOpacity: 0.08 }} />
              <CircleMarker center={[target.latitude, target.longitude]} radius={7} pathOptions={{ color: '#FFFFFF', weight: 2, fillColor: '#2563EB', fillOpacity: 1 }} />
            </>
          )}
          {value && (
            <Marker
              position={[value.latitude, value.longitude]}
              icon={demoIcon}
              draggable
              eventHandlers={{ dragend: (e) => pick({ latitude: e.target.getLatLng().lat, longitude: e.target.getLatLng().lng }) }}
            />
          )}
        </MapContainer>
      </div>
      <div className="mt-3 space-y-1 text-xs text-amber-900">
        <p>
          Demo point:{' '}
          <span className="font-mono font-semibold">{value ? `${value.latitude.toFixed(6)}, ${value.longitude.toFixed(6)}` : 'none yet — click the map'}</span>
        </p>
        {target && (
          <>
            <p>
              Issue location (blue dot, circle = {RULE_METRES} m):{' '}
              <span className="font-mono font-semibold">
                {target.latitude.toFixed(6)}, {target.longitude.toFixed(6)}
              </span>{' '}
              <button type="button" onClick={() => pick(target)} className="ml-1 rounded border border-amber-600 bg-white px-2 py-0.5 font-semibold text-amber-800 hover:bg-amber-100">
                Put demo point on the issue location
              </button>
            </p>
            {distance != null && <p>About {Math.round(distance)} m from the issue (estimate; the server decides).</p>}
          </>
        )}
      </div>
    </div>
  );
}
