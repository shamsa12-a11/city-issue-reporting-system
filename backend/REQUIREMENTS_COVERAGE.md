# Backend requirements coverage — Project 13

Source of truth: [PROJECT_REQUIREMENTS.md](../PROJECT_REQUIREMENTS.md).
Test run: `npm test` — **1377 passed, 0 failed, 0 skipped (52 files)**.
All tests use an in-memory fake database (`tests/helpers.js`); they prove the
application logic, not the SQL against PostgreSQL.

Status key:
- **Done** — implemented and covered by tests.
- **Done, live check pending** — implemented and tested, but its SQL /
  PostGIS / locking has not yet been run against the live Supabase database.
- **Partial** — part of the requirement is outside the backend or not done.

Live verification done earlier (temporary data, cleaned up): Features 1–4,
and Feature 5 (with the limitation that SLA create/update could not be tested
live).

## Features

| # | Requirement | Status | Endpoints | Main files | Tests |
|---|---|---|---|---|---|
| F1 | Report an issue (category, description ≥ 10, 1–3 photos, location, district detected or chosen, `CIT-000123`, "Outside service area") | Done | `POST /api/issues` | `issue.service.js`, `photoStorage.js`, `upload.js` | `issues.create` 85, `upload` 20, `photoStorage` 25, `imageType` 9 |
| F2 | Duplicate detection (same category, 50 m, 7 days, photos shown), "Add my report", "This is different" + 10 m review flag, supervisor review queue, different categories separate | Done (review queue: live check pending) | `GET /api/issues/duplicates`, `POST /api/issues`, `GET /api/supervisor/review-issues` | `issue.service.js`, `issueDetail.service.js` | `issues.duplicates` 57, `issues.decision` 19, `issues.merge` 48, `issues.auditgaps` 45 |
| F3 | Routing rules for every category × district, automatic queue, Admin Unassigned queue, reroute with reason | Done (Karaan has no routing by design) | `/api/admin/routing-rules`, `/api/admin/issues/unassigned`, `/api/admin/issues/:id/reroute` | `routing.service.js` | `admin.routing` 73, `admin.reroute` 58, `backfill.script` 5 |
| F4 | Status workflow, history (who, when, comment), reopen within 7 days with photo, 2nd reopen to supervisor, auto-close after 7 days | Done | `GET/PATCH /api/issues/:id/status`, `/resolve`, `/reopen` | `status.service.js`, `autoClose.job.js` | `status.workflow` 71, `status.resolve` 23, `status.reopen` 47, `status.autoclose` 26 |
| F5 | SLA per category (admin), clock from creation, remaining time, orange at 75 %, red when breached, waiting still counts | Done | `/api/admin/slas`, `sla` in issue responses | `sla.js`, `sla.service.js` | `sla.calc` 22, `sla.responses` 14, `admin.sla` 32, `status.substatus` 27 |
| F6 | Escalation list, supervisor notification, action within 24 h, admin alert, permanent marker | Done, live check pending | `/api/supervisor/escalations`, `/api/admin/escalations`, `/api/issues/:id/comments` | `escalation.service.js`, `escalation.job.js`, `comment.service.js` | `escalation.*` 105 |
| F7 | Supervisors: new department issues, assign officers, workload; officers: own issues only, no assignment while on leave | Done, live check pending | `POST /api/issues/:id/assign`, `/api/supervisor/issues`, `/api/supervisor/workload`, `/api/officer/issues` | `assignment.service.js` | `assignment.assign` 42, `assignment.lists` 32 |
| F8 | Citizen photos = before; after photo taken at the issue location required to resolve; before/after side by side on the public page | Done, live check pending (location = officer device GPS within 50 m) | `POST /api/issues/:id/resolve`, `GET /api/issues/:id/photos`, `GET /api/public/issues/:ref` | `status.service.js`, `photo.service.js` | `photos.feature8` 22 |
| F9 | In-app + simulated SMS on every status change, Somali and English, reference + status, every linked citizen, SMS can be turned off, in-app cannot | Done, live check pending | `/api/notifications/*`, `PATCH /api/auth/me/preferences` | `notification.service.js`, `sms/providers.js` | `notifications.statuschange` 25, `notifications.api` 32, `sms.adapter` 5 |
| F10 | Public page without login: category, district, status, report count, report date, map location; filters; no reporter data; sensitive hidden | Done, live check pending | `GET /api/public/issues`, `GET /api/public/issues/:ref`, `PATCH /api/admin/issues/:id/sensitive` | `publicIssue.service.js` | `public.feature10` 35 |
| F11 | "Me too" on open issues, one per citizen, closed refused, sortable by upvotes | Done, live check pending | `POST/GET /api/public/issues/:ref/upvote`, `?sort=upvotes` | `upvote.service.js` | `upvotes.feature11` 22 |
| F12 | Live heatmap (public, supervisors, admin), category and date filters, real locations weighted by report count, empty-map message | Done, live check pending (map colours: frontend) | `/api/public/heatmap`, `/api/supervisor/heatmap`, `/api/admin/heatmap` | `heatmap.service.js` | `heatmap.feature12` 26 |
| F13 | District report: received, resolved, average resolution time, SLA breaches and %, reopened rate, monthly chart; date and category filters; zero values | Done, live check pending (charts: frontend) | `/api/admin/reports/district-performance`, `/api/supervisor/reports/district-performance` | `report.service.js` | `report.feature13` 29 |

## Roles (brief §3)

| Requirement | Status | Endpoints |
|---|---|---|
| Citizen: register / log in by phone, report, photos, location | Done | `/api/auth/*`, `POST /api/issues` |
| Citizen: view their reports, follow status | Done (My reports: live check pending) | `GET /api/issues/mine`, `GET /api/issues/:id/status` |
| Citizen: upvote, notifications, reopen within 7 days | Done | see F4, F9, F11 |
| Citizen: rate the fix | Done, live check pending | `PUT /api/issues/:id/rating` |
| Officer: assigned issues only, details and photos, status, after photos, resolve | Done (details: live check pending) | `/api/officer/issues`, `GET /api/issues/:id`, `/:id/photos`, `/:id/status`, `/:id/resolve` |
| Supervisor: new issues, assign, workload, SLA breaches, escalations, reassign or comment, heatmap and report | Done | see F6, F7, F12, F13 |
| Admin: manage users and roles | Done, live check pending | `/api/admin/users` |
| Admin: manage districts, departments, categories | Done, live check pending (categories: six fixed codes, names and activation) | `/api/admin/districts`, `/api/admin/departments`, `/api/admin/categories` |
| Admin: routing, SLAs, reroute, mark sensitive, analytics | Done | see F3, F5, F10, F13 |
| Permissions checked on the backend for every protected request | Done | `middleware/auth.js`; `authorize.test` 7, role tests in every feature file |

Admin management tests: `admin.management` 98.

## Common requirements (brief §5–§8, §11)

| Requirement | Status | Evidence |
|---|---|---|
| 12 required tables, keys, constraints, indexes, versioned schema | Done | `database/schema.sql` (19 tables, 36 indexes) |
| Realistic seed data (Somali names, real districts) | Partial | `database/seed.sql`: districts, departments, routing rules, SLAs, 15 demo users; no demo issues |
| Database documented | Done | `schema.sql` comments; README "Database overview" |
| Layered architecture | Done | routes → controllers → services → database |
| JWT, bcrypt, RBAC, backend validation | Done | `auth.*` tests, `express-validator` with `checkExact` on every route |
| Rate limiting | Done | `middleware/rateLimiters.js` (all `/api`, stricter for login, register, reports, workflow) |
| Secrets in `.env`, `.env.example` | Done | `.gitignore` excludes `.env`; `backend/.env.example` |
| Audit log of sensitive actions (who, what, when) | Done | `audit.service.js`; asserted in each feature's tests |
| ≥ 15 tests, one command | Done | `npm test`, 1377 tests |
| GitHub Actions CI | Configured, first run pending | `.github/workflows/backend-ci.yml` |
| ≥ 2 charts from real database queries | Done on the backend | report `monthly` and `totals`, heatmap points (charts drawn by the frontend) |
| Somali and English | Partial | backend texts for users are bilingual (notifications, SMS, categories, escalation messages, heatmap message, receipt); errors use stable codes for frontend translation; language switch and screens: frontend |
| Simulated payments (EVC Plus, Zaad, eDahab) with confirmation and receipt, behind adapters | Done, live check pending | `payments/providers.js`, `payment.service.js`; `payments` 51 |
| Simulated SMS outbox behind an adapter | Done | `sms/providers.js`; `sms.adapter` 5 |
| README: overview, setup, environment, database, API, tests, demo accounts, limitations | Done | `README.md` |
| README: architecture diagram, screenshots, frontend instructions | Partial | text folder tree only; screenshots and frontend instructions need the frontend |
| Code documentation (modules, functions, endpoints) | Done | header comments in every module, JSDoc on services and controllers |

## Needs live Supabase verification (not done; mocked tests only)

1. **Group A — F7, F9, F6:** assignment and notification/SMS writes; the
   escalation job SQL (`slaBreachedSql`, `SKIP LOCKED`, savepoints, guarded
   updates) against real timestamps.
2. **Group B — F8, F10–F13:** `ST_Distance` after-photo check and
   `taken_location` insert; public queries; upvote `ON CONFLICT`; heatmap
   filters; the report aggregate (`date_trunc`, `to_char`, date casts in the
   database time zone).
3. **Payments:** generated `PAY-` / `RCP-` columns, `FOR UPDATE OF p`,
   `hashtextextended` advisory lock, check constraints.
4. **Admin management:** staff insert, role update by code, `ESCAPE` in the
   user search, `ST_GeomFromGeoJSON` / `ST_IsValid` / `ST_Multi` boundaries,
   unique-constraint errors.
5. **Audit-gap endpoints:** My reports, rating update, review queue
   (`ST_Distance` between issues), issue details.
6. **Concurrency** under simultaneous requests (row locks, advisory locks),
   which the fake database cannot reproduce.
7. **First start of the escalation job** against existing live data (it marks
   every past breach and may alert supervisors/admins at once).
8. **Feature 3 backfill script** (`database/backfill_auto_route_assignments.sql`)
   is prepared but has never been run.

## Remaining work outside the backend

- Frontend (React, Tailwind, language switch, maps, charts).
- Native-speaker review of the Somali texts.
- Demo issues for the presentation (created through the API, or a seed
  script run with approval).
