# Frontend requirements coverage — Project 13 (Codka Magaalada)

Sources: [PROJECT_REQUIREMENTS.md](../PROJECT_REQUIREMENTS.md) and
[backend/REQUIREMENTS_COVERAGE.md](../backend/REQUIREMENTS_COVERAGE.md).

**How it was tested.** `npm run build` passes; `npm run check:i18n` confirms
664 keys exist in both Somali and English and every `t('…')` key used in the
code resolves. End-to-end browser checks (headless Microsoft Edge driving the
real frontend) ran against the **real backend Express app on the backend's
in-memory test database** — not against Supabase:

| Run | Checks |
|---|---|
| Public pages + citizen journey | 56 / 56 passed |
| Citizen rating and reopen | 10 / 10 passed |
| Supervisor, officer and admin journeys | 60 / 60 passed |

Status key: **Done** = built and exercised end to end; **Done (not E2E)** =
built and builds, reviewed against the API, not driven in the browser test;
**Blocked** = needs something the backend does not provide.

## Features

| # | Requirement | Page / component | Backend endpoint(s) | Status |
|---|---|---|---|---|
| F1 | Report an issue: category, description, 1–3 photos, GPS or map pin, district (detected, or chosen), reference number, "Outside service area" | `/citizen/report` — `ReportIssuePage`, `LocationPicker`, `PhotoPicker` | `GET /categories`, `GET /districts`, `POST /issues` | Done |
| F2 | Duplicate check with photos; "Add my report to this issue" / "This is different" | duplicate dialog in `ReportIssuePage` | `GET /issues/duplicates`, `POST /issues` (`duplicateOfIssueId` / `confirmDifferent`), 409 `POSSIBLE_DUPLICATES` | Done |
| F2 | Supervisor review of "different within 10 m" | `/supervisor/review` — `ReviewPage`; flag shown on the staff issue page | `GET /supervisor/review-issues`, `GET /issues/:id` | Done (list). **Blocked:** no backend action to confirm a duplicate / clear the flag; the page says so |
| F3 | Routing for every category × district, Unassigned queue, reroute with reason | `/admin/routing`, `/admin/issues` (All issues), `/admin/unassigned`, reroute dialog on the admin issue page and lists | `GET/PUT /admin/routing-rules`, `GET /admin/issues`, `GET /admin/issues/unassigned`, `POST /admin/issues/:id/reroute` | Done |
| F4 | Status workflow, history (who, when, comment), reopen within 7 days with photo, auto-close | `StaffIssuePage` (start work, history with names), `ReportDetailPage` (history, reopen) | `PATCH /issues/:id/status`, `GET /issues/:id/status`, `POST /issues/:id/reopen` | Done (auto-close is a backend job) |
| F5 | SLA remaining time, orange at 75 %, red when breached; waiting for materials | `SlaBadge` everywhere; "waiting for materials" toggle on `StaffIssuePage`; SLA hours on `/admin/categories` | `sla` object in responses, `PATCH /issues/:id/status` (`subStatus`), `GET/PUT /admin/slas` | Done |
| F6 | Escalation list, supervisor notification, comment / reassign within 24 h, admin alert, permanent mark | `/supervisor/escalations`, `/admin/escalations`, escalation card + comments on `StaffIssuePage`, notifications | `GET /supervisor|admin/escalations`, `POST /issues/:id/comments`, `POST /issues/:id/assign`, `GET /notifications` | Done |
| F7 | New department issues, assign officers, officer workload; officers see only their issues | `/supervisor`, `/supervisor/issues`, `/supervisor/workload`, `AssignModal`; `/officer`, `/officer/issues` | `GET /supervisor/issues`, `GET /supervisor/workload`, `POST /issues/:id/assign`, `GET /officer/issues` | Done |
| F8 | Before photos; resolve only with after photos taken at the location; side-by-side on public pages | resolve form on `StaffIssuePage` (GPS + photos), `BeforeAfter` on public, citizen and staff pages | `POST /issues/:id/resolve`, `GET /issues/:id/photos`, `GET /public/issues/:ref` | Done (the 50 m refusal and success both tested) |
| F9 | In-app + simulated SMS notifications, Somali / English, SMS can be turned off | `/<role>/notifications` (in-app, mark read), citizen SMS outbox tab, bell with unread count, settings | `GET /notifications`, `/unread-count`, `/read`, `/read-all`, `/sms`, `PATCH /auth/me/preferences` | Done |
| F10 | Public pages: category, district, status, report count, date, map; filters; no personal data; sensitive hidden | `/`, `/explore` (list + map), `/issues/:ref`; sensitive switch on the admin issue page | `GET /public/issues`, `GET /public/issues/:ref`, `PATCH /admin/issues/:id/sensitive` | Done |
| F11 | "Me too" on open issues, one per citizen; sort by upvotes | `UpvoteButton`, sort on `/explore` | `GET/POST /public/issues/:ref/upvote`, `?sort=upvotes` | Done |
| F12 | Live heatmap for public, supervisors, admin; category and date filters; report-count weight; empty-map message | `HeatmapView` on `/supervisor/analytics` and `/admin/analytics`; public map on `/` and `/explore` | `GET /supervisor|admin/heatmap` (public: `GET /public/heatmap` for landing stats) | Done. A public heatmap *page* is not separate: the public map shows every public issue sized by report count |
| F13 | District report: received, resolved, avg. resolution time, SLA breaches and %, reopened rate, monthly chart; date and category filters | `AnalyticsPage` (KPIs, monthly trend, by district, by category, SLA rate, table), admin overview charts | `GET /supervisor|admin/reports/district-performance` | Done |

## Roles (brief §3)

| Role | Requirement | Where | Status |
|---|---|---|---|
| Citizen | register / log in by phone, report, photos, location, own reports, status, upvote, notifications, reopen, rate the fix | `/register`, `/login`, `/citizen/*`, public pages | Done |
| Officer | assigned issues only, details and photos, update status, after photos, resolve | `/officer`, `/officer/issues`, `/officer/issues/:id` | Done |
| Supervisor | new issues, assign, workload, SLA breaches, escalations, reassign or comment, heatmap and reports | `/supervisor/*` | Done |
| Admin | users and roles, districts, departments, categories, routing, SLAs, reroute, sensitive, analytics | `/admin/*` | Done |
| All | permissions enforced by the backend; pages guarded by role | `RequireRole` guards; wrong-role URLs redirect to the user's own workspace (tested for every role) | Done |

## Common requirements

| Requirement | How | Status |
|---|---|---|
| React, JavaScript, Tailwind, React Router, Axios | Vite 8, React 19, Tailwind 4, React Router 7, Axios 1; plus Leaflet, Recharts, Lucide | Done |
| Frontend never queries the database | all data through `src/api/services.js` → REST API | Done |
| Secure session | JWT from the API; only the token is stored; user and role re-read from `/auth/me`; expired session → login with a notice | Done |
| ≥ 2 charts from real queries | monthly trend, by district, by category, SLA rate (Recharts) — all from the report endpoint | Done |
| Somali and English everywhere, language switch | `LanguageContext`, `en.js`/`so.js` + `staff.en.js`/`staff.so.js`, switch in every header; error messages translated by API error code | Done (Somali texts need native review) |
| Phones and laptops | responsive layouts; no horizontal page scroll at 390 px (checked on citizen and admin pages) | Done |
| Simulated payments (EVC Plus, Zaad, eDahab) with confirmation and receipt | `/citizen/payments`, `/citizen/payments/:ref` (simulated PIN never stored), `/admin/payments` (read-only) | Done |
| SMS outbox | citizen notifications → "SMS outbox (simulated)" | Done |
| Demo checklist 1–5 (report with photo and pin; duplicate merge; SLA breach and escalation; resolve with before/after; heatmap and district report) | all five journeys are covered by the browser checks above | Done (needs demo data on the live database) |

## Not available (backend has no endpoint) — not faked in the UI

- **Audit log viewer.** The backend writes `audit_logs` but has no read endpoint, so there is no audit page. Issue-level history (who / when / comment) and escalation details are shown instead.
- **Duplicate review actions** (confirm duplicate / mark different): the backend only lists flagged issues.
- **Citizen comments / issue subscription management:** comments are staff-only in the backend; following an issue happens automatically when a citizen adds a report.
- **Server-side search** in staff lists: the APIs have no text search, so the search box filters the loaded page (labelled as such).
- **Password reset / staff phone change:** not supported by the admin API.

## Requires live verification

The browser checks used the real backend code on its in-memory test database.
Running the full application against Supabase still needs a check of the SQL
paths listed in `backend/REQUIREMENTS_COVERAGE.md` (PostGIS, locking, the
report and heatmap queries), real GPS on a phone, and map tiles over the
network.
