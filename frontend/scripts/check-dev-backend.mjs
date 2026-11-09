// Runs before `npm run dev` in frontend/ (the "predev" script).
// Makes sure the dev frontend only talks to the in-memory dev backend:
//   - refuses if VITE_API_ORIGIN is set (the browser would call that backend
//     directly, bypassing the checked proxy) or NODE_OPTIONS is set
//   - asks the proxy target for /api/__test-backend; if a different backend
//     answers there (for example one connected to Supabase), it refuses,
//     unless CODKA_ALLOW_REAL_BACKEND=1 is set on purpose
//   - if nothing answers yet, it only warns (start the backend any time)
import { loadEnv } from 'vite';

const env = loadEnv('development', process.cwd(), '');
const backend = env.VITE_DEV_BACKEND_URL || 'http://127.0.0.1:5000';

function refuse(message) {
  console.error(`\n[dev] REFUSED: ${message}\nThe frontend was not started.\n`);
  process.exit(1);
}

if (env.VITE_API_ORIGIN) refuse('VITE_API_ORIGIN is set. Remove it so all API calls go through the dev proxy.');
if (process.env.NODE_OPTIONS) refuse('NODE_OPTIONS is set. Clear it first (PowerShell: Remove-Item Env:NODE_OPTIONS).');

let identity = null;
let answered = false;
try {
  const res = await fetch(`${backend}/api/__test-backend`, { signal: AbortSignal.timeout(3000) });
  answered = true;
  if (res.ok) identity = await res.json().catch(() => null);
} catch {
  // Nothing is listening yet.
}

if (identity?.mode === 'in-memory') {
  console.log(`[dev] Backend check OK: in-memory dev backend at ${backend} (pid ${identity.pid}).`);
} else if (answered) {
  if (process.env.CODKA_ALLOW_REAL_BACKEND === '1') {
    console.warn(`[dev] WARNING: ${backend} is NOT the in-memory dev backend. Continuing because CODKA_ALLOW_REAL_BACKEND=1.`);
  } else {
    refuse(`${backend} is answering but it is NOT the in-memory dev backend (it could be connected to Supabase). Stop it, then use the root "npm run dev".`);
  }
} else {
  console.warn(`[dev] WARNING: no backend at ${backend} yet. Start it with "npm run dev" in backend/ (or use the root "npm run dev").`);
}
