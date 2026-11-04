# City Issue Reporting System

Somalia 10X — Project 13. A web system where residents report city problems
(broken roads, street lights, rubbish, water leaks, flooding) and district
departments assign, fix and track them. Full requirements:
[PROJECT_REQUIREMENTS.md](PROJECT_REQUIREMENTS.md).

## Project status

| Area | Status |
|---|---|
| Database schema (19 tables, PostGIS) — `backend/database/schema.sql` | Done |
| Seed data (districts, departments, routing, SLAs, demo users) — `backend/database/seed.sql` | Done |
| Backend foundation: config, DB pool, security middleware, error handling | Done |
| Authentication: phone + password login, JWT, `/me` | Done |
| Citizen registration (phone + password, role fixed to citizen) | Done |
| Server-side role authorization (citizen / officer / supervisor / admin) | Done (middleware; applied to feature routes as they are built) |
| Audit log of logins and registrations | Done |
| Issue reporting, duplicates, routing, workflow, SLAs, notifications, heatmap, reports | Not started |
| Frontend (React) | Not started |
| GitHub Actions CI | Not started |

## Technology stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ (developed on 22.17) |
| API | Express 5.3 |
| Database | Supabase PostgreSQL 15+ with PostGIS, `pg` 8.23 |
| Auth | `jsonwebtoken` 9 (HS256), `bcrypt` 6 |
| Security | `helmet` 8, `cors` 2.8, `express-rate-limit` 8, `express-validator` 7 |
| Uploads | `multer` 2.5 (memory storage); photos stored on local disk |
| Config | `dotenv` 18 |
| Tests | Jest 30, Supertest 7 |
| Frontend (planned) | React, Tailwind CSS, React Router, Axios |

## Backend architecture

```
backend/
├── database/            schema.sql, seed.sql (run in Supabase SQL editor)
├── src/
│   ├── server.js        entry point: checks env, starts server, clean shutdown
│   ├── app.js           Express app: helmet → cors → JSON → rate limit → routes → errors
│   ├── config/          env.js (validated settings), db.js (pg connection pool)
│   ├── routes/          URL → middleware + validation → controller
│   ├── controllers/     HTTP in/out only
│   ├── services/        business logic and parameterized SQL (data access)
│   ├── middleware/      auth (authenticate/authorize), validate, upload, rate limiters, errors
│   ├── storage/         photoStorage.js — the only code that reads/writes photo files
│   └── utils/           AppError, JWT, password, phone and image-type helpers
├── uploads/             uploaded photos (created on first upload, git-ignored)
└── tests/               Jest + Supertest (database replaced by an in-memory fake)
```

Request flow: `route → validation → controller → service → database`.

Security notes:
- Every SQL statement uses `$1, $2…` parameters; no user input is concatenated into SQL.
- The JWT only identifies the user. On every request the user and role are
  re-read from the database, so a role change or disabled account takes
  effect immediately.
- Login returns the same error for an unknown phone and a wrong password, and
  takes the same time for both, so registered numbers cannot be discovered.
- Errors never expose stack traces or SQL to the client.

## Setup on a fresh computer

Requirements: Node.js 20 or newer, and a Supabase project.

### 1. Database (once)

In the Supabase dashboard → **SQL Editor**, run in this order:
1. `backend/database/schema.sql`
2. `backend/database/seed.sql`

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
```

Edit `backend/.env` and set at least `DATABASE_URL` and `JWT_SECRET`, then:

```bash
npm run dev     # development server with auto-restart (http://localhost:5000)
npm start       # same, without auto-restart
npm test        # run all tests (no database needed)
```

Check it works: open <http://localhost:5000/api/health> — it should show
`"database": "up"`.

## Environment variables

Defined in `backend/.env` (template: [backend/.env.example](backend/.env.example)).
Never commit `.env`; it is listed in `.gitignore`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Supabase connection string (Settings → Database → URI). Do not add `?sslmode=`. |
| `JWT_SECRET` | yes | — | Secret for signing tokens, at least 32 characters. |
| `JWT_EXPIRES_IN` | no | `8h` | Token lifetime (e.g. `30m`, `8h`, `1d`). |
| `PORT` | no | `5000` | API port. |
| `NODE_ENV` | no | `development` | `development`, `production` or `test`. |
| `DB_SSL` | no | `true` | Use SSL to the database. `false` only for a local PostgreSQL. |
| `DB_SSL_CA_PATH` | no | — | Path to the Supabase CA certificate to fully verify the server. |
| `DB_POOL_MAX` | no | `10` | Maximum database connections. |
| `CORS_ORIGIN` | no | `http://localhost:5173` | Allowed frontend origin(s), comma-separated. |
| `RATE_LIMIT_WINDOW_MS` | no | `900000` | Rate-limit window (15 minutes). |
| `RATE_LIMIT_MAX` | no | `300` | Requests per IP per window for all `/api` routes. |
| `LOGIN_RATE_LIMIT_MAX` | no | `10` | Failed login attempts per IP per window. |
| `REGISTER_RATE_LIMIT_MAX` | no | `5` | Registration attempts (all, successful or not) per IP per window. |
| `UPLOADS_DIR` | no | `backend/uploads` | Folder where uploaded photos are stored. Relative paths are relative to `backend/`. A drive root (`C:\`, `/`) is rejected at startup. |

Generate a JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## API endpoints

Base URL: `http://localhost:5000/api`. All errors use one shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request data", "details": [{ "field": "phoneNumber", "message": "..." }] } }
```

### `GET /api/health` — public

Checks the API and the database connection.

- `200` `{ "status": "ok", "database": "up", "timestamp": "2026-11-04T10:00:00.000Z" }`
- `503` `{ "status": "degraded", "database": "down", "timestamp": "..." }`

### `POST /api/auth/register` — public, rate-limited

Creates a **citizen** account and logs it in. The role is always set to
`citizen` on the server; officer, supervisor and admin accounts cannot be
created here.

Request:

```json
{ "fullName": "Hodan Abdi Farah", "phoneNumber": "+252615550001", "password": "SafePass123", "preferredLanguage": "so" }
```

| Field | Rules |
|---|---|
| `fullName` | required, 2–100 characters, must contain letters (trimmed) |
| `phoneNumber` | required, international format. Spaces, dashes, dots and brackets are removed and a `00` prefix becomes `+` (e.g. `00252 61-555 0001` → `+252615550001`). Local numbers like `0615550001` are rejected. |
| `password` | required, 8+ characters, at least one letter and one number, at most 72 bytes |
| `preferredLanguage` | optional, `so` (default) or `en` |

Any other field (for example `role`, `roleId`, `departmentId`) is rejected
with `400`, so a client cannot choose its own role.

Response `201`: same shape as login — `{ "token", "tokenType": "Bearer", "user": { ..., "role": "citizen", "department": null, "district": null } }`.

Errors: `400 VALIDATION_ERROR`, `409 PHONE_ALREADY_REGISTERED`,
`429 TOO_MANY_REQUESTS`.

### `POST /api/auth/login` — public, rate-limited

Request:

```json
{ "phoneNumber": "+252610000001", "password": "CityDemo#2026" }
```

`phoneNumber` must be in international format; spaces and dashes are removed.

Response `200`:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "tokenType": "Bearer",
  "user": {
    "id": 2,
    "fullName": "Fadumo Ali Warsame",
    "phoneNumber": "+252610000101",
    "role": "supervisor",
    "preferredLanguage": "so",
    "smsNotificationsEnabled": true,
    "isOnLeave": false,
    "department": { "id": 1, "name": "Hodan Public Works" },
    "district": { "id": 1, "name": "Hodan" }
  }
}
```

`department` and `district` are `null` for citizens and admins.

Errors: `400 VALIDATION_ERROR` / `INVALID_JSON`, `401 INVALID_CREDENTIALS`,
`403 ACCOUNT_DISABLED`, `429 TOO_MANY_REQUESTS`.

### `GET /api/auth/me` — any logged-in user

Header: `Authorization: Bearer <token>`

- `200` `{ "user": { ...same shape as login... } }`
- `401` `AUTH_REQUIRED` (no token), `INVALID_TOKEN`, `TOKEN_EXPIRED`

### Protecting new routes

```js
const { authenticate, authorize, ROLES } = require('../middleware/auth');

router.get('/admin/users', authenticate, authorize(ROLES.ADMIN), controller.listUsers);
router.patch('/issues/:id/status', authenticate, authorize(ROLES.OFFICER, ROLES.SUPERVISOR), controller.updateStatus);
```

`authenticate` returns `401` without a valid token; `authorize` returns `403`
for any role not listed.

## Demo accounts

All demo accounts use the password **`CityDemo#2026`** (local demo only — never
use these accounts in production).

| Role | Name | Phone | Department |
|---|---|---|---|
| Admin | Abdirahman Hassan Mohamed | `+252610000001` | — |
| Supervisor | Fadumo Ali Warsame | `+252610000101` | Hodan Public Works |
| Supervisor | Abdullahi Omar Farah | `+252610000102` | Hodan Water & Drainage |
| Supervisor | Hawa Abdi Nur | `+252610000103` | Wadajir Public Works |
| Supervisor | Mohamed Yusuf Ahmed | `+252610000104` | Howlwadaag Sanitation |
| Officer | Ahmed Mahad Abdi | `+252610000201` | Hodan Public Works |
| Officer | Ismail Sheikh Ali (on leave) | `+252610000202` | Hodan Public Works |
| Officer | Sahra Mohamud Hirsi | `+252610000203` | Hodan Water & Drainage |
| Officer | Bashir Ali Jama | `+252610000204` | Wadajir Public Works |
| Officer | Khadija Osman Aden | `+252610000205` | Howlwadaag Sanitation |
| Citizen | Amina Abdullahi Hussein | `+252610000301` | — |
| Citizen | Hassan Ibrahim Guled | `+252610000302` | — |
| Citizen | Ayaan Mohamed Ali | `+252610000303` | — |
| Citizen | Yusuf Abdi Warsame (SMS off) | `+252610000304` | — |
| Citizen | Faisal Nur Hassan | `+252610000305` | — |

Example:

```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"+252610000001","password":"CityDemo#2026"}'
```

## Tests

```bash
cd backend
npm test
```

143 tests in 11 files. They run without a database (the `pg` pool is replaced
by an in-memory fake that answers the same parameterized queries):

| File | Covers |
|---|---|
| `tests/health.test.js` | health 200/503, security headers, JSON 404 |
| `tests/password.test.js` | bcrypt hashing, pgcrypto `$2a$` hash compatibility, malformed input |
| `tests/auth.register.test.js` | citizen registration: safe profile, bcrypt-only storage, server-assigned role, rejected `role`/`roleId` fields, phone normalization, invalid input, duplicate phone (incl. simultaneous requests), audit log, no DB details leaked |
| `tests/auth.login.test.js` | login validation, correct/wrong credentials, no account enumeration, disabled account, audit log, parameterized query |
| `tests/auth.middleware.test.js` | missing/invalid/forged/`alg:none`/expired tokens, deleted or disabled user, role read from DB |
| `tests/authorize.test.js` | access matrix for all 4 roles, forged role claim, 401 vs 403 |
| `tests/db.transaction.test.js` | `withTransaction`: commit, rollback on error, failed BEGIN/COMMIT/ROLLBACK, client always released |
| `tests/imageType.test.js` | JPEG/PNG/WebP detected from bytes; GIF, WAV, text, empty and truncated files rejected |
| `tests/photoStorage.test.js` | random file names, storage re-checks bytes/size and rejects mismatched types, save/delete, path-traversal rejection, cleanup when a transaction fails |
| `tests/env.uploadsDir.test.js` | `UPLOADS_DIR` default, relative (from `backend/`), absolute, and drive-root rejection |
| `tests/upload.test.js` | 1–3 photos, 5 MB limit, disguised files, wrong field, broken forms; `/uploads` serving, CORP header, 404s |

Photo tests write to a temporary folder, never to `backend/uploads`.

## Known limitations

- Only health and authentication endpoints exist so far; the issue features
  are still to be built.
- Registration does not verify phone ownership (no SMS code); SMS is
  simulated in this project.
- Registration answers `409` for a number that is already registered, which
  reveals that the number has an account. This is needed for a clear message
  to the user; the registration rate limit keeps such checks slow.
- Without `DB_SSL_CA_PATH` the database connection is encrypted but the
  server certificate is not verified.
- Rate-limit counters are kept in memory, so they reset when the server restarts.
- Photos are served publicly at `/uploads/issues/<random-uuid>.<ext>`. The
  names cannot be guessed, but anyone who has a URL can open it (relevant
  later for issues marked Sensitive).
- Photo metadata (EXIF, which may include GPS and phone model) is not
  removed yet.
- If the server crashes between saving a photo and finishing the database
  transaction, an unused photo file can remain on disk.
- `npm audit` reports a moderate advisory in Jest's own dependencies
  (development only); runtime dependencies report 0 vulnerabilities.
