# PROJECT REQUIREMENTS
## Project 13 — City Issue Reporting System

**Project Duration:** 7 Days  
**Project Type:** Solo project  
**Presentation:** Monday, November 9, 2026  
**Project Goal:** Build a functional web-based city issue reporting and management system.

---

## 1. Project Overview

The City Issue Reporting System allows residents to report problems in their city, such as broken roads, damaged street lights, rubbish, water leaks, and flooding.

Residents can submit reports with photos and locations, follow issue progress, upvote existing reports, and receive notifications.

District offices and departments can manage, assign, resolve, and monitor reported issues.

The system must provide transparency and help prevent repeated reports of the same problem.

The system must support real data and functional workflows, not just static screens.

## 2. Technology Stack

Use the following stack:

### Frontend
- React.js
- JavaScript (not TypeScript)
- Tailwind CSS
- React Router
- Axios

### Backend
- Node.js
- Express.js
- JWT authentication
- bcrypt for password hashing
- REST API

### Database
- PostgreSQL
- Supabase-hosted PostgreSQL
- Node PostgreSQL client (`pg`)

### Other
- Git and GitHub
- Environment variables using `.env`
- Unit and integration testing

Do not introduce additional technologies without a clear technical reason.

## 3. User Roles and Permissions

The system must support four roles:

### 3.1 Citizen
- Register and log in using a phone number.
- Report city issues.
- Upload issue photos.
- Provide issue location.
- View their reports.
- Follow issue status.
- Upvote open issues.
- Receive notifications.
- Reopen a resolved issue within 7 days if it has not been fixed.
- Rate the fix.

### 3.2 Department Officer
- View only issues assigned to them.
- View issue details and photos.
- Update issue status.
- Upload after-repair photos.
- Resolve assigned issues.

### 3.3 District Supervisor
- View new issues in their department.
- Assign issues to officers.
- View officer workloads.
- Monitor SLA breaches.
- Handle escalated issues.
- Reassign issues or add comments.
- View heatmaps and district performance reports.

### 3.4 Admin
- Manage users and roles.
- Manage districts.
- Manage departments.
- Manage issue categories.
- Configure category-and-district routing.
- Configure SLAs.
- Manually reroute issues with a reason.
- Mark issues as sensitive.
- View analytics and reports.

**Security requirement:** Permissions must be checked on the backend for every protected request. Hiding buttons in the frontend is not sufficient.

## 4. Required Features

### Feature 1 — Report an Issue

A logged-in citizen must be able to submit an issue report.

Required fields:
- Category
- Description
- 1–3 photos
- GPS location or map pin
- District

Allowed categories:
1. Roads
2. Street lights
3. Rubbish
4. Water leak
5. Flooding/drainage
6. Other

Rules:
- Photo is required.
- Location is required.
- Description must contain at least 10 characters.
- The system should detect the district from the location.
- If district detection is not possible, the citizen can choose the district.
- Every issue receives a reference number, for example `CIT-000123`.
- Reports outside all service districts must be rejected with the exact message: `Outside service area`.

### Feature 2 — Duplicate Detection and Merging

This is the core technical challenge.

Before submitting a new report, the system must check for existing open issues:
- Same category.
- Within 50 metres.
- Reported within the last 7 days.

If matching issues exist:
- Show the citizen the possible duplicate issues, including their photos.
- Allow the citizen to choose:
  - `Add my report to this issue`
  - `This is different`

If the citizen selects `Add my report to this issue`:
- Increase the original issue's report count.
- Link the new report to the existing issue.
- Subscribe the citizen to updates for that issue.

If the citizen selects `This is different` and the existing issue is within 10 metres:
- Save a separate issue.
- Flag it for supervisor review.

Different categories at the same location must remain separate issues.

### Feature 3 — Automatic Department Routing

Admin must configure routing for every category and district combination.

Example:
- Category: Roads
- District: Hodan
- Department: Hodan Public Works

Rules:
- New issues must automatically go to the configured department queue.
- Every category-and-district combination must have a department.
- If no routing rule exists, the issue must appear in the Admin's Unassigned queue.
- Admin can manually reroute an issue, but must provide a reason.

### Feature 4 — Issue Status Workflow

Required status sequence:

`New → Assigned → In progress → Resolved → Closed`

Rules:
- Officers and supervisors can update statuses according to their permissions.
- Citizens can see the current status.
- Every status change must record the user, timestamp, and comment.
- A citizen can reopen a Resolved issue within 7 days if it has not been fixed. A photo is required.
- A Resolved issue automatically becomes Closed after 7 days if it is not reopened.
- If an issue is reopened twice, it must go directly to the supervisor.

### Feature 5 — SLA Timers

Admin configures resolution time limits for each category.

Examples:
- Water leak: 48 hours.
- Street light: 5 days.
- Roads: 14 days.

Requirements:
- The SLA clock starts when the issue is created.
- Each issue displays its remaining resolution time.
- Show orange when 75% of the SLA time has elapsed.
- Show red when the SLA has been breached.
- Time spent in `Waiting for materials` still counts toward the SLA.

### Feature 6 — Escalation

When an issue breaches its SLA:
- It must appear in the supervisor's escalation list.
- The supervisor must receive a notification.
- The supervisor must reassign the issue or add a comment within 24 hours.
- If no action is taken within 24 hours, Admin must be alerted.
- An issue that has been escalated must remain marked as escalated for reporting, even if it is later resolved.

### Feature 7 — Officer Assignment and Workload

District supervisors must:
- View new issues in their department.
- Assign issues to officers.
- View the number of open issues assigned to each officer.

Officers must:
- See only issues assigned to them.
- Be unable to receive new assignments while marked as on leave.

### Feature 8 — Before and After Photos

- Citizen-submitted photos count as before photos.
- Before an issue can become Resolved, the officer must upload at least one after photo taken at the issue location.
- The system must prevent resolution if no after photo exists.
- Public issue pages must show before and after photos side by side.

### Feature 9 — Citizen Notifications

Every status change must generate:
- An in-app notification.
- A simulated SMS notification.

Notifications must:
- Be available in Somali and English.
- Include the issue reference number and new status.
- Be sent to every citizen linked to the issue, including citizens whose reports were merged.
- Allow citizens to turn off SMS notifications.
- Never allow citizens to disable in-app notifications.

Real SMS integration is not required. Simulate SMS by saving messages in an in-app SMS outbox.

### Feature 10 — Public Issue Status Page

Anyone must be able to view public issues without logging in.

Display:
- Issue category.
- District.
- Status.
- Report count.
- Report date.
- Issue location on a map.

Provide filters for:
- District.
- Category.
- Status.

Privacy rules:
- Never display reporters' names or phone numbers.
- Issues marked Sensitive by Admin must be hidden from the public map.

### Feature 11 — Upvotes

Citizens must be able to select the `Me too` button on any open issue.

Rules:
- One upvote per citizen per issue.
- Closed issues cannot be upvoted.
- Issues must be sortable by upvote count.

### Feature 12 — Live Heatmap

The heatmap must be accessible to:
- Public users.
- District supervisors.
- Admin.

Requirements:
- Display issue density using map colors.
- Filter by category.
- Filter by date range.
- Use actual issue locations from the database.
- Weight locations using report count.
- Update using live database data, not a static image.
- When no issues match the selected filters, show an empty map with an appropriate message.

### Feature 13 — District Performance Report

Admin and supervisors must be able to view performance by district.

Required metrics:
- Total issues received.
- Total issues resolved.
- Average resolution time.
- Number of SLA breaches.
- SLA breach percentage.
- Reopened issue rate.
- Monthly performance chart.

Requirements:
- Calculate metrics from issue history and database records.
- Allow filtering by date range and category.
- Districts with no issues must display zero values.
- Charts must use real database query results, never hard-coded sample chart values.

## 5. Required Database Tables

The database must include at least these 12 related tables:

1. `issues`
2. `issue_reports`
3. `categories`
4. `departments`
5. `districts`
6. `assignments`
7. `status_history`
8. `photos`
9. `upvotes`
10. `slas`
11. `users`
12. `roles`

Requirements:
- Use primary keys and foreign keys.
- Establish appropriate relationships.
- Use constraints and indexes where necessary.
- Include a versioned SQL schema script or migrations.
- Include realistic seed data using Somali names, real Somali cities/districts, and realistic values.
- Keep the database structure documented.

Additional tables may be added when genuinely needed for notifications, routing, subscriptions, or audit logs. Do not omit the 12 required tables.

## 6. Common Technical Requirements

### 6.1 Layered Architecture
Separate the application into:
- Presentation/UI layer.
- Business logic/service layer.
- Data access layer.

Frontend screens must not query the database directly.

Document the main modules and API endpoints.

### 6.2 Authentication and Security
- Secure login using JWT or sessions.
- Hash passwords using bcrypt or argon2.
- Support role-based access control.
- Validate all input on the backend.
- Use rate limiting for exposed API endpoints.
- Keep secrets in `.env`.
- Provide `.env.example`.
- Never commit real credentials to GitHub.
- Record sensitive actions in an audit log with who, what, and when.

### 6.3 Testing
- Write at least 15 unit or integration tests.
- Test core technical challenges and business rules.
- Tests must run with one local command.
- Configure CI using GitHub Actions.

### 6.4 Analytics
- Provide at least two charts based on real database queries.
- Do not hard-code chart data.

### 6.5 Somali and English
- Every screen, button, message, and PDF must support Somali and English.
- Provide a language switch.
- Ensure layouts work on phones and laptops.

### 6.6 Simulated Payments and SMS
Real payment and SMS integrations are not required.

Payment simulation:
- Provide a mock mobile money flow for EVC Plus, Zaad, and eDahab.
- Show a confirmation and receipt.

SMS simulation:
- Save generated messages in an in-app outbox.

Keep simulated payment and SMS functionality behind clean adapter interfaces so they can be replaced with real integrations later.

## 7. Required Demo Checklist

The final presentation must demonstrate these five actions:

1. Report an issue with a photo and map pin.
2. Report the same issue nearby and demonstrate duplicate merging.
3. Allow one issue to breach its SLA and demonstrate escalation.
4. Resolve an issue using before and after photos.
5. Show the live heatmap and district performance report.

These are the five required demo actions.

## 8. GitHub and Documentation Requirements

The GitHub repository must contain:

### README.md
Include:
- Project overview and problem statement.
- Features completed and partially completed.
- Architecture description and diagram.
- Technology stack and versions.
- Setup instructions for a fresh computer.
- Database setup instructions.
- Seed data instructions.
- How to run frontend and backend.
- How to run tests.
- Demo accounts for every role.
- Screenshots.
- Known limitations.

### Code Documentation
- Add comments or docstrings to every main module, class, function, and endpoint.
- Explain purpose, inputs, outputs, and possible errors.
- Document every API endpoint with method, path, request, and response.
- Include a database diagram or database relationship description.

### Git Workflow
- Keep the project in GitHub.
- Share the repository with the judges.
- Make at least one meaningful commit on every working day.
- Do not wait until the final day to upload all code.
- Do not push to GitHub automatically. Push only when explicitly requested.

## 9. Project Constraints

- This is a solo project.
- Total available development time is 7 days.
- AI tools are allowed, but the developer must understand and explain the code.
- Do not copy another candidate's work.
- No Docker is required.
- Online application hosting is not required.
- The application must run from the developer's own computer for presentation.
- Real SMS and payment integrations are not required.

## 10. Scoring Criteria

| Area | Points |
|---|---:|
| Core technical challenge | 25 |
| Completeness | 25 |
| Code quality and tests | 15 |
| Security and reliability | 15 |
| Live demo and pitch | 10 |
| UX and Somali usability | 10 |
| **Total** | **100** |

Completeness includes:
- 10 points for the 8 common technical requirements.
- 15 points for project-specific features.

Ties are decided first by core technical challenge score, then by code quality and tests.

## 11. Definition of Done

The project is ready for presentation when:

- The application runs locally from a fresh setup.
- Database schema and seed data load successfully.
- All four roles can log in using demo accounts.
- Backend permissions are enforced.
- The core duplicate detection and merging challenge works.
- Different categories at the same location remain separate.
- Heatmap uses real database data.
- Required demo actions can be demonstrated.
- At least 15 tests pass with one command.
- Both Somali and English are available.
- README and API documentation are complete.
- GitHub contains meaningful daily commits.
- All features are honestly marked as Done or Partial.

## 12. Development Instructions for AI Coding Tools

Follow these instructions throughout development:

1. Treat this document as the source of truth.
2. Do not silently remove or change mandatory requirements.
3. Do not build unnecessary features that are not required by this project.
4. Work in small, understandable modules.
5. Explain the purpose and logic of each module before or while implementing it.
6. Keep frontend, backend, business logic, and database access separated.
7. Validate data on the backend.
8. Do not use hard-coded data for features that must use database records.
9. Test each major feature before moving to the next.
10. Do not claim a feature is complete unless it has been implemented and tested.
11. If a requirement cannot be completed within the time limit, report it honestly as Partial and explain what remains.
12. Preserve the existing project structure and working code when making changes.
13. Do not commit or push to GitHub unless the developer explicitly requests it.

**Priority:** Complete and demonstrate the core technical challenge and the five required demo actions before spending time on optional visual enhancements.