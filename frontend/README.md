# Codka Magaalada — frontend

React 19 + Vite, JavaScript, Tailwind CSS 4, React Router 7, Axios,
Leaflet / React Leaflet (OpenStreetMap tiles), Recharts (analytics), Lucide icons.

## Run

Easiest: run `npm run dev` from the project root (starts the in-memory
backend and this frontend together; see the root README). Separately:

```bash
cd backend && npm run dev        # in-memory API on http://127.0.0.1:5000
cd frontend && npm install
npm run dev                      # http://127.0.0.1:5173
npm run build                    # production build in dist/
```

`npm run dev` here first runs `scripts/check-dev-backend.mjs`: it refuses if
`VITE_API_ORIGIN` or `NODE_OPTIONS` is set, or if the backend that answers is
not the in-memory dev backend (override on purpose with
`CODKA_ALLOW_REAL_BACKEND=1`). It only warns if no backend is running yet.

In development Vite proxies `/api` and `/uploads` to the backend
(`VITE_DEV_BACKEND_URL`, default `http://127.0.0.1:5000`), so no CORS setup
is needed. For a production build served from another host set
`VITE_API_ORIGIN` (see `.env.example`; nothing in it is secret).

## Structure

```
src/
├── api/          client.js (Axios, Bearer token, ApiError with the backend error code)
│                 services.js (one function per backend endpoint used)
├── auth/         AuthContext (JWT session, /auth/me), route guards, role homes
├── i18n/         en.js, so.js, LanguageContext (t(), error messages by code, dates)
├── components/   ui/ (Button, Card, fields, Alert, Pagination, Modal, badges, Spinner),
│                 staff/ (StaffIssueRow, AssignModal, HeatmapView, Tabs), maps, photos,
│                 IssueCard, UpvoteButton, CategoryIcon, Brand, ErrorBoundary
├── hooks/        useAsync (loading / error / reload, ignores stale responses)
├── layouts/      PublicLayout (navbar + footer), WorkspaceLayout (sidebar workspace)
│                 used by CitizenLayout and the officer / supervisor / admin layouts
├── pages/        public/, auth/, citizen/, staff/, admin/, misc.jsx (404)
├── utils/        validation (mirrors the backend rules)
├── config.js     API base, map defaults, limits
└── App.jsx       routes (lazy-loaded pages)
```

## Pages

| Path | Who | Backend |
|---|---|---|
| `/`, `/explore`, `/issues/:ref` | everyone | public issues (list, map, detail), heatmap summary, categories, upvotes |
| `/login`, `/register` | guests | `/api/auth/login`, `/api/auth/register` |
| `/citizen/*` | citizen | dashboard, report an issue, My reports + detail (reopen, rating), notifications + SMS outbox, payments + receipts, settings |
| `/officer`, `/officer/issues[/:id]` | officer | own assignments; start work, waiting for materials, resolve with after photos at the location, comments |
| `/supervisor/*` | supervisor | overview, department issues + assign/reassign, workload, escalations, duplicate review, maps & analytics |
| `/admin/*` | admin | overview, Unassigned queue + reroute, escalations, analytics, users, districts, departments, categories & SLAs, routing rules, payments, sensitive switch |
| `/<role>/notifications`, `/<role>/settings` | every logged-in role | in-app notifications, language (and SMS for citizens) |

Coverage against the brief: [REQUIREMENTS_COVERAGE.md](REQUIREMENTS_COVERAGE.md).

## Checks

```bash
npm run build        # production build
npm run check:i18n   # every key in Somali and English; every t('…') key exists
```

## Notes and limitations

- Only the JWT is stored (localStorage); the user and role are always read
  from `/api/auth/me`. Permissions are enforced by the backend.
- Language: Somali by default, switchable everywhere; when logged in the
  choice is saved as the user's preferred language. Notifications are shown
  in the current language (the API returns both). Somali texts are drafts and
  need native review.
- There is no "title" field on reports: the brief and the API have none.
- Comments are staff-only in the backend, and issue subscriptions happen
  automatically when a citizen adds a report to an existing issue; neither
  has a citizen screen.
- No audit-log page: the backend has no endpoint to read the audit log.
- Duplicate review is a list: the backend has no confirm / clear action.
- Staff list search filters the loaded page (the list APIs have no search).
- The simulated payment PIN is never stored; the screen warns not to use a
  real PIN.
- Map tiles come from OpenStreetMap and need an internet connection.
