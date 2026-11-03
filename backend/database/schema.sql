-- =============================================================================
-- City Issue Reporting System — Database Schema
-- Version: 001 (initial schema)
-- Target:  PostgreSQL 15+ on Supabase, with the PostGIS extension
--
-- Safe to run on a fresh database:
--   * Uses CREATE ... IF NOT EXISTS everywhere.
--   * Never drops tables and never deletes data.
--   * Reference rows (roles, categories, default SLAs) use ON CONFLICT DO NOTHING.
--   * Runs inside one transaction, so a failure leaves nothing half-created.
--
-- Note: because tables are created with IF NOT EXISTS, re-running this file
-- does NOT change tables that already exist. Later changes to the structure
-- must go in new numbered migration files.
--
-- Contains no passwords, API keys or other secrets.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
-- PostGIS gives us real distance checks in metres (ST_DWithin on geography)
-- for duplicate detection (50 m / 10 m) and point-in-polygon checks for
-- district detection ("Outside service area").
-- Supabase recommends installing extensions in the "extensions" schema.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;

-- Supabase already includes "extensions" in the default search_path.
-- This line makes the script also work on a plain local PostgreSQL.
SET LOCAL search_path TO public, extensions;


-- =============================================================================
-- 1. ROLES
-- The four fixed user roles. Every user belongs to exactly one role.
-- =============================================================================
CREATE TABLE IF NOT EXISTS roles (
    id          SMALLINT    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        TEXT        NOT NULL UNIQUE
                CONSTRAINT roles_code_check
                CHECK (code IN ('citizen', 'officer', 'supervisor', 'admin')),
    description TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO roles (code, description) VALUES
    ('citizen',    'Resident who reports and follows city issues'),
    ('officer',    'Department officer who works on assigned issues'),
    ('supervisor', 'District supervisor who assigns and monitors issues'),
    ('admin',      'System administrator')
ON CONFLICT (code) DO NOTHING;


-- =============================================================================
-- 2. DISTRICTS
-- Service districts (e.g. Hodan, Wadajir in Mogadishu).
-- "boundary" is used to detect the district from a GPS point and to reject
-- reports outside every district ("Outside service area").
-- =============================================================================
CREATE TABLE IF NOT EXISTS districts (
    id          INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT        NOT NULL,
    city        TEXT        NOT NULL,
    region      TEXT,
    boundary    geography(MultiPolygon, 4326),   -- NULL = no boundary loaded yet
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT districts_name_city_unique UNIQUE (name, city),
    CONSTRAINT districts_name_not_blank CHECK (length(trim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS districts_boundary_gix
    ON districts USING GIST (boundary);


-- =============================================================================
-- 3. DEPARTMENTS
-- A department works in one district (e.g. "Hodan Public Works").
-- Issues are routed into a department's queue.
-- =============================================================================
CREATE TABLE IF NOT EXISTS departments (
    id          INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    district_id INTEGER     NOT NULL REFERENCES districts (id) ON DELETE RESTRICT,
    name        TEXT        NOT NULL,
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT departments_district_name_unique UNIQUE (district_id, name),
    CONSTRAINT departments_name_not_blank CHECK (length(trim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS departments_district_id_idx ON departments (district_id);


-- =============================================================================
-- 4. CATEGORIES
-- The six issue categories from the requirements. The CHECK on "code" keeps
-- the list fixed; Admin can still edit display names or deactivate one.
-- =============================================================================
CREATE TABLE IF NOT EXISTS categories (
    id          SMALLINT    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        TEXT        NOT NULL UNIQUE
                CONSTRAINT categories_code_check
                CHECK (code IN ('roads', 'street_lights', 'rubbish',
                                'water_leak', 'flooding_drainage', 'other')),
    name_en     TEXT        NOT NULL,
    name_so     TEXT        NOT NULL,
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Somali names should be checked by a native speaker.
INSERT INTO categories (code, name_en, name_so) VALUES
    ('roads',             'Roads',             'Waddooyin'),
    ('street_lights',     'Street lights',     'Nalalka waddooyinka'),
    ('rubbish',           'Rubbish',           'Qashin'),
    ('water_leak',        'Water leak',        'Biyo-daadasho'),
    ('flooding_drainage', 'Flooding/drainage', 'Fatahaad/bullaacad'),
    ('other',             'Other',             'Kale')
ON CONFLICT (code) DO NOTHING;


-- =============================================================================
-- 5. USERS
-- All people who log in: citizens, officers, supervisors and admins.
-- Users belong to a role. Officers and supervisors also belong to a
-- department (and through it, a district).
-- Login is by phone number, so phone_number is unique.
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    id                        BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_id                   SMALLINT    NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
    department_id             INTEGER     REFERENCES departments (id) ON DELETE SET NULL,
    full_name                 TEXT        NOT NULL,
    phone_number              TEXT        NOT NULL UNIQUE,
    password_hash             TEXT        NOT NULL,          -- bcrypt hash, never plain text
    preferred_language        TEXT        NOT NULL DEFAULT 'so'
                              CONSTRAINT users_language_check
                              CHECK (preferred_language IN ('so', 'en')),
    -- Citizens may turn SMS off. In-app notifications cannot be turned off,
    -- so there is deliberately no setting for them.
    sms_notifications_enabled BOOLEAN     NOT NULL DEFAULT TRUE,
    is_on_leave               BOOLEAN     NOT NULL DEFAULT FALSE,  -- officers on leave get no new work
    is_active                 BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Stored in international format, e.g. +252612345678
    CONSTRAINT users_phone_format_check CHECK (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
    CONSTRAINT users_full_name_not_blank CHECK (length(trim(full_name)) > 0)
);

CREATE INDEX IF NOT EXISTS users_role_id_idx       ON users (role_id);
CREATE INDEX IF NOT EXISTS users_department_id_idx ON users (department_id);


-- =============================================================================
-- 6. SLAS
-- Resolution time limit for each category (e.g. Water leak = 48 hours).
-- One SLA per category.
-- =============================================================================
CREATE TABLE IF NOT EXISTS slas (
    id               SMALLINT    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category_id      SMALLINT    NOT NULL UNIQUE REFERENCES categories (id) ON DELETE RESTRICT,
    resolution_hours INTEGER     NOT NULL CHECK (resolution_hours > 0),
    updated_by       BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Default SLA for every category, so a new issue can always get an SLA
-- deadline. Admin can change these values later.
-- Water leak, Street lights and Roads use the example values from the brief.
-- Rubbish, Flooding/drainage and Other are placeholder values to confirm.
INSERT INTO slas (category_id, resolution_hours)
SELECT c.id, d.resolution_hours
FROM (VALUES
        ('water_leak',         48),   -- 48 hours (from brief)
        ('street_lights',     120),   -- 5 days   (from brief)
        ('roads',             336),   -- 14 days  (from brief)
        ('rubbish',            72),   -- 3 days   (placeholder)
        ('flooding_drainage',  48),   -- 2 days   (placeholder)
        ('other',             168)    -- 7 days   (placeholder)
     ) AS d (category_code, resolution_hours)
JOIN categories c ON c.code = d.category_code
ON CONFLICT (category_id) DO NOTHING;


-- =============================================================================
-- SUPPORTING TABLE: ROUTING_RULES
-- Which department handles each (category, district) pair,
-- e.g. Roads + Hodan -> Hodan Public Works.
-- If no rule exists, the issue gets department_id = NULL and appears in the
-- Admin's Unassigned queue.
-- =============================================================================
CREATE TABLE IF NOT EXISTS routing_rules (
    id            INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category_id   SMALLINT    NOT NULL REFERENCES categories (id)  ON DELETE RESTRICT,
    district_id   INTEGER     NOT NULL REFERENCES districts (id)   ON DELETE RESTRICT,
    department_id INTEGER     NOT NULL REFERENCES departments (id) ON DELETE RESTRICT,
    created_by    BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT routing_rules_category_district_unique UNIQUE (category_id, district_id)
);

CREATE INDEX IF NOT EXISTS routing_rules_department_id_idx ON routing_rules (department_id);
CREATE INDEX IF NOT EXISTS routing_rules_district_id_idx   ON routing_rules (district_id);


-- =============================================================================
-- 7. ISSUES
-- One row per real-world problem. Several citizen reports can be merged
-- into one issue (see issue_reports).
--
-- Status values (stored as codes, translated in the UI):
--   new -> assigned -> in_progress -> resolved -> closed
--
-- Optional sub-status (only while status = 'in_progress'):
--   waiting_for_materials
-- The sub-status does NOT pause the SLA: sla_due_at is fixed at creation
-- and is never moved because of the sub-status.
-- =============================================================================
CREATE TABLE IF NOT EXISTS issues (
    id                          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Public reference such as CIT-000123 (grows past 6 digits if needed).
    reference_number            TEXT        GENERATED ALWAYS AS
                                ('CIT-' || lpad(id::text, greatest(6, length(id::text)), '0')) STORED
                                UNIQUE,
    category_id                 SMALLINT    NOT NULL REFERENCES categories (id)  ON DELETE RESTRICT,
    district_id                 INTEGER     NOT NULL REFERENCES districts (id)   ON DELETE RESTRICT,
    -- Current department queue. NULL = no routing rule -> Admin Unassigned queue.
    department_id               INTEGER     REFERENCES departments (id) ON DELETE RESTRICT,
    created_by                  BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    description                 TEXT        NOT NULL,
    location                    geography(Point, 4326) NOT NULL,
    status                      TEXT        NOT NULL DEFAULT 'new'
                                CONSTRAINT issues_status_check
                                CHECK (status IN ('new', 'assigned', 'in_progress', 'resolved', 'closed')),
    -- Optional detail inside 'in_progress'. NULL = no sub-status.
    sub_status                  TEXT
                                CONSTRAINT issues_sub_status_check
                                CHECK (sub_status IN ('waiting_for_materials')),
    -- Number of citizen reports merged into this issue (starts at 1).
    report_count                INTEGER     NOT NULL DEFAULT 1 CHECK (report_count >= 1),
    -- Admin can hide an issue from the public map.
    is_sensitive                BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Set when a citizen chose "This is different" but another issue of the
    -- same category is within 10 m.
    needs_supervisor_review     BOOLEAN     NOT NULL DEFAULT FALSE,
    similar_issue_id            BIGINT      REFERENCES issues (id) ON DELETE SET NULL,
    -- Reopen tracking. On the 2nd reopen the issue goes to the supervisor.
    reopen_count                INTEGER     NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
    -- SLA deadline, fixed when the issue is created (clock starts at creation).
    sla_due_at                  TIMESTAMPTZ NOT NULL,
    -- Escalation. is_escalated stays TRUE forever for reporting, even after resolve.
    is_escalated                BOOLEAN     NOT NULL DEFAULT FALSE,
    escalated_at                TIMESTAMPTZ,
    escalation_actioned_at      TIMESTAMPTZ,   -- supervisor reassigned or commented
    escalation_admin_alerted_at TIMESTAMPTZ,   -- no action within 24 h -> admin alerted
    resolved_at                 TIMESTAMPTZ,
    closed_at                   TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT issues_description_length_check CHECK (length(trim(description)) >= 10),
    CONSTRAINT issues_sla_after_created_check  CHECK (sla_due_at > created_at),
    CONSTRAINT issues_escalated_at_check       CHECK (NOT is_escalated OR escalated_at IS NOT NULL),
    CONSTRAINT issues_not_similar_to_self      CHECK (similar_issue_id IS NULL OR similar_issue_id <> id),
    CONSTRAINT issues_sub_status_in_progress_check
        CHECK (sub_status IS NULL OR status = 'in_progress')
);

-- Spatial index used by duplicate detection (ST_DWithin within 50 m).
CREATE INDEX IF NOT EXISTS issues_location_gix ON issues USING GIST (location);
-- Duplicate check filters: same category, open, last 7 days.
CREATE INDEX IF NOT EXISTS issues_category_status_created_idx
    ON issues (category_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS issues_district_id_idx   ON issues (district_id);
CREATE INDEX IF NOT EXISTS issues_department_id_idx ON issues (department_id);
CREATE INDEX IF NOT EXISTS issues_created_by_idx    ON issues (created_by);
CREATE INDEX IF NOT EXISTS issues_status_idx        ON issues (status);
-- Admin Unassigned queue.
CREATE INDEX IF NOT EXISTS issues_unassigned_idx
    ON issues (created_at) WHERE department_id IS NULL;
-- SLA breach scan over open issues only.
CREATE INDEX IF NOT EXISTS issues_open_sla_due_idx
    ON issues (sla_due_at) WHERE status NOT IN ('resolved', 'closed');
-- Auto-close job: resolved issues older than 7 days.
CREATE INDEX IF NOT EXISTS issues_resolved_at_idx
    ON issues (resolved_at) WHERE status = 'resolved';


-- =============================================================================
-- 8. ISSUE_REPORTS
-- Connects citizens to issues. The first report creates the issue; each
-- "Add my report to this issue" adds another row and raises report_count.
-- Each linked citizen can also rate the fix.
-- =============================================================================
CREATE TABLE IF NOT EXISTS issue_reports (
    id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issue_id       BIGINT      NOT NULL REFERENCES issues (id) ON DELETE RESTRICT,
    citizen_id     BIGINT      NOT NULL REFERENCES users (id)  ON DELETE RESTRICT,
    description    TEXT        NOT NULL,
    location       geography(Point, 4326) NOT NULL,
    is_original    BOOLEAN     NOT NULL DEFAULT FALSE,  -- TRUE for the report that created the issue
    fix_rating     SMALLINT    CHECK (fix_rating BETWEEN 1 AND 5),
    rated_at       TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A citizen is linked to an issue only once (stops report_count inflation).
    CONSTRAINT issue_reports_issue_citizen_unique UNIQUE (issue_id, citizen_id),
    CONSTRAINT issue_reports_description_length_check CHECK (length(trim(description)) >= 10),
    CONSTRAINT issue_reports_rating_time_check CHECK ((fix_rating IS NULL) = (rated_at IS NULL))
);

CREATE INDEX IF NOT EXISTS issue_reports_citizen_id_idx ON issue_reports (citizen_id);
-- Only one original report per issue.
CREATE UNIQUE INDEX IF NOT EXISTS issue_reports_one_original_idx
    ON issue_reports (issue_id) WHERE is_original;


-- =============================================================================
-- 9. ASSIGNMENTS
-- History of who is responsible for an issue: which department, which
-- supervisor, and which officer. Exactly one row per issue is "current".
-- Manual reroutes by Admin must include a reason.
-- =============================================================================
CREATE TABLE IF NOT EXISTS assignments (
    id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issue_id        BIGINT      NOT NULL REFERENCES issues (id)      ON DELETE RESTRICT,
    department_id   INTEGER     NOT NULL REFERENCES departments (id) ON DELETE RESTRICT,
    supervisor_id   BIGINT      REFERENCES users (id) ON DELETE RESTRICT,
    officer_id      BIGINT      REFERENCES users (id) ON DELETE RESTRICT,  -- NULL = waiting in department queue
    assigned_by     BIGINT      REFERENCES users (id) ON DELETE RESTRICT,  -- NULL = automatic routing
    assignment_type TEXT        NOT NULL
                    CONSTRAINT assignments_type_check
                    CHECK (assignment_type IN (
                        'auto_route',        -- routed by routing_rules
                        'officer_assign',    -- supervisor assigns an officer
                        'reassign',          -- supervisor changes the officer
                        'manual_reroute',    -- admin moves to another department
                        'reopen_escalation'  -- 2nd reopen -> straight to supervisor
                    )),
    reason          TEXT,
    is_current      BOOLEAN     NOT NULL DEFAULT TRUE,
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    CONSTRAINT assignments_reroute_reason_check
        CHECK (assignment_type <> 'manual_reroute' OR length(trim(coalesce(reason, ''))) > 0),
    CONSTRAINT assignments_current_not_ended_check
        CHECK (NOT is_current OR ended_at IS NULL)
);

-- Only one current assignment per issue.
CREATE UNIQUE INDEX IF NOT EXISTS assignments_one_current_idx
    ON assignments (issue_id) WHERE is_current;
-- Officer workload / "my issues" lists.
CREATE INDEX IF NOT EXISTS assignments_current_officer_idx
    ON assignments (officer_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS assignments_department_id_idx ON assignments (department_id);
CREATE INDEX IF NOT EXISTS assignments_supervisor_id_idx ON assignments (supervisor_id);


-- =============================================================================
-- 10. STATUS_HISTORY
-- Every status change: who made it, when, and the comment.
-- Sub-status changes (e.g. entering or leaving "Waiting for materials") are
-- recorded here too, with the same who/when/comment details.
-- changed_by is NULL only for automatic system actions (e.g. auto-close
-- after 7 days); the comment then explains the system action.
-- =============================================================================
CREATE TABLE IF NOT EXISTS status_history (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issue_id    BIGINT      NOT NULL REFERENCES issues (id) ON DELETE RESTRICT,
    from_status TEXT
                CONSTRAINT status_history_from_check
                CHECK (from_status IN ('new', 'assigned', 'in_progress', 'resolved', 'closed')),
    to_status   TEXT        NOT NULL
                CONSTRAINT status_history_to_check
                CHECK (to_status IN ('new', 'assigned', 'in_progress', 'resolved', 'closed')),
    from_sub_status TEXT
                CONSTRAINT status_history_from_sub_check
                CHECK (from_sub_status IN ('waiting_for_materials')),
    to_sub_status   TEXT
                CONSTRAINT status_history_to_sub_check
                CHECK (to_sub_status IN ('waiting_for_materials')),
    changed_by  BIGINT      REFERENCES users (id) ON DELETE RESTRICT,
    comment     TEXT        NOT NULL CHECK (length(trim(comment)) > 0),
    is_reopen   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Each row must change the status, the sub-status, or both.
    CONSTRAINT status_history_changes_status CHECK (
        from_status IS DISTINCT FROM to_status
        OR from_sub_status IS DISTINCT FROM to_sub_status
    ),
    CONSTRAINT status_history_to_sub_in_progress_check
        CHECK (to_sub_status IS NULL OR to_status = 'in_progress')
);

CREATE INDEX IF NOT EXISTS status_history_issue_created_idx
    ON status_history (issue_id, created_at);
CREATE INDEX IF NOT EXISTS status_history_changed_by_idx ON status_history (changed_by);


-- =============================================================================
-- 11. PHOTOS
-- Image files for an issue.
--   before = citizen photos when reporting (1–3 per report)
--   after  = officer photos proving the repair (needed before "resolved")
--   reopen = citizen photo when reopening a resolved issue
-- Only the file path is stored here; the file itself lives in file storage.
-- =============================================================================
CREATE TABLE IF NOT EXISTS photos (
    id                BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issue_id          BIGINT      NOT NULL REFERENCES issues (id) ON DELETE RESTRICT,
    issue_report_id   BIGINT      REFERENCES issue_reports (id)  ON DELETE RESTRICT,
    status_history_id BIGINT      REFERENCES status_history (id) ON DELETE RESTRICT,
    uploaded_by       BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    photo_type        TEXT        NOT NULL
                      CONSTRAINT photos_type_check
                      CHECK (photo_type IN ('before', 'after', 'reopen')),
    storage_path      TEXT        NOT NULL UNIQUE,
    mime_type         TEXT        NOT NULL
                      CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
    file_size_bytes   INTEGER     NOT NULL CHECK (file_size_bytes > 0),
    -- Optional: where the photo was taken, if the device provides GPS.
    -- The brief does not require GPS coordinates on photos, so this is
    -- not enforced.
    taken_location    geography(Point, 4326),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT photos_before_has_report_check
        CHECK (photo_type <> 'before' OR issue_report_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS photos_issue_type_idx         ON photos (issue_id, photo_type);
CREATE INDEX IF NOT EXISTS photos_issue_report_id_idx    ON photos (issue_report_id);
CREATE INDEX IF NOT EXISTS photos_status_history_id_idx  ON photos (status_history_id);

-- Database safety net for Feature 8: an issue cannot change to 'resolved'
-- unless at least one 'after' photo exists for it.
-- The backend should still check this first and show a friendly message.
-- Note: this runs on UPDATE only (a normal resolve is a status update).
CREATE OR REPLACE FUNCTION require_after_photo_before_resolve()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NEW.status = 'resolved' AND OLD.status IS DISTINCT FROM 'resolved' THEN
        IF NOT EXISTS (
            SELECT 1 FROM photos
            WHERE photos.issue_id = NEW.id AND photos.photo_type = 'after'
        ) THEN
            -- OLD is used because generated columns are not yet computed on NEW
            -- inside a BEFORE trigger.
            RAISE EXCEPTION 'An after photo is required before resolving issue %', OLD.reference_number
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER issues_require_after_photo
    BEFORE UPDATE OF status ON issues
    FOR EACH ROW
    EXECUTE FUNCTION require_after_photo_before_resolve();


-- =============================================================================
-- 12. UPVOTES ("Me too")
-- One upvote per citizen per issue, enforced by the primary key.
-- (Rejecting upvotes on closed issues is done in the service layer.)
-- =============================================================================
CREATE TABLE IF NOT EXISTS upvotes (
    issue_id    BIGINT      NOT NULL REFERENCES issues (id) ON DELETE RESTRICT,
    citizen_id  BIGINT      NOT NULL REFERENCES users (id)  ON DELETE RESTRICT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (issue_id, citizen_id)
);

CREATE INDEX IF NOT EXISTS upvotes_citizen_id_idx ON upvotes (citizen_id);


-- =============================================================================
-- SUPPORTING TABLE: ISSUE_SUBSCRIPTIONS
-- Citizens who receive updates for an issue: the original reporter and every
-- citizen whose report was merged into it.
-- =============================================================================
CREATE TABLE IF NOT EXISTS issue_subscriptions (
    issue_id    BIGINT      NOT NULL REFERENCES issues (id) ON DELETE RESTRICT,
    user_id     BIGINT      NOT NULL REFERENCES users (id)  ON DELETE RESTRICT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (issue_id, user_id)
);

CREATE INDEX IF NOT EXISTS issue_subscriptions_user_id_idx ON issue_subscriptions (user_id);


-- =============================================================================
-- SUPPORTING TABLE: ISSUE_COMMENTS
-- Supervisor/officer comments that are not status changes. Needed because
-- supervisors must "reassign or add a comment" on escalated issues.
-- =============================================================================
CREATE TABLE IF NOT EXISTS issue_comments (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issue_id    BIGINT      NOT NULL REFERENCES issues (id) ON DELETE RESTRICT,
    author_id   BIGINT      NOT NULL REFERENCES users (id)  ON DELETE RESTRICT,
    body        TEXT        NOT NULL CHECK (length(trim(body)) > 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS issue_comments_issue_created_idx
    ON issue_comments (issue_id, created_at);


-- =============================================================================
-- SUPPORTING TABLE: NOTIFICATIONS (in-app)
-- One row per user per event. Text is stored in both Somali and English so
-- the user sees the right language when they switch.
-- =============================================================================
CREATE TABLE IF NOT EXISTS notifications (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users (id)  ON DELETE RESTRICT,
    issue_id    BIGINT      REFERENCES issues (id)          ON DELETE RESTRICT,
    type        TEXT        NOT NULL
                CONSTRAINT notifications_type_check
                CHECK (type IN ('status_change', 'escalation', 'escalation_admin_alert',
                                'supervisor_review', 'assignment')),
    message_en  TEXT        NOT NULL,
    message_so  TEXT        NOT NULL,
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_created_idx
    ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_issue_id_idx ON notifications (issue_id);


-- =============================================================================
-- SUPPORTING TABLE: SMS_OUTBOX (simulated SMS)
-- Instead of sending real SMS, messages are saved here. Rows are only created
-- for users who have SMS turned on.
-- =============================================================================
CREATE TABLE IF NOT EXISTS sms_outbox (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT      NOT NULL REFERENCES users (id)  ON DELETE RESTRICT,
    issue_id     BIGINT      REFERENCES issues (id)          ON DELETE RESTRICT,
    phone_number TEXT        NOT NULL,   -- copied at send time
    language     TEXT        NOT NULL CHECK (language IN ('so', 'en')),
    message      TEXT        NOT NULL,
    status       TEXT        NOT NULL DEFAULT 'simulated_sent'
                 CHECK (status IN ('queued', 'simulated_sent', 'failed')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sms_outbox_user_created_idx ON sms_outbox (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_outbox_issue_id_idx     ON sms_outbox (issue_id);


-- =============================================================================
-- SUPPORTING TABLE: AUDIT_LOGS
-- Sensitive actions: who did what, to which record, and when
-- (e.g. role changes, reroutes, marking sensitive, SLA changes).
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id     BIGINT      REFERENCES users (id) ON DELETE SET NULL,  -- NULL = system
    action       TEXT        NOT NULL,          -- e.g. 'issue.reroute', 'user.role_change'
    entity_type  TEXT        NOT NULL,          -- e.g. 'issue', 'user', 'sla'
    entity_id    TEXT,
    details      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    ip_address   INET,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_actor_created_idx ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx        ON audit_logs (entity_type, entity_id);


-- =============================================================================
-- SUPPORTING TABLE: PAYMENTS (simulated mobile money)
-- Mock EVC Plus, Zaad and eDahab payments. No real money moves and no real
-- payment gateway is called; a backend payment adapter fills these rows and
-- can later be swapped for a real provider.
--
-- Flow: row created as 'pending' -> simulated confirmation -> 'confirmed'
-- (receipt number appears automatically) or 'failed' / 'cancelled'.
-- =============================================================================
CREATE TABLE IF NOT EXISTS payments (
    id                 BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Public payment reference such as PAY-000045.
    payment_reference  TEXT          GENERATED ALWAYS AS
                       ('PAY-' || lpad(id::text, greatest(6, length(id::text)), '0')) STORED
                       UNIQUE,
    -- Receipt number such as RCP-000045. Exists only once confirmed.
    receipt_number     TEXT          GENERATED ALWAYS AS (
                           CASE WHEN status = 'confirmed'
                                THEN 'RCP-' || lpad(id::text, greatest(6, length(id::text)), '0')
                           END
                       ) STORED UNIQUE,
    payer_id           BIGINT        NOT NULL REFERENCES users (id)  ON DELETE RESTRICT,
    issue_id           BIGINT        REFERENCES issues (id)          ON DELETE RESTRICT,  -- optional link
    provider           TEXT          NOT NULL
                       CONSTRAINT payments_provider_check
                       CHECK (provider IN ('evc_plus', 'zaad', 'edahab')),
    payer_phone        TEXT          NOT NULL,   -- mobile money number used
    amount             NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    currency           TEXT          NOT NULL DEFAULT 'USD'
                       CHECK (currency IN ('USD', 'SOS')),
    purpose            TEXT          NOT NULL CHECK (length(trim(purpose)) > 0),
    status             TEXT          NOT NULL DEFAULT 'pending'
                       CONSTRAINT payments_status_check
                       CHECK (status IN ('pending', 'confirmed', 'failed', 'cancelled')),
    -- Fake transaction ID returned by the mock provider adapter.
    simulated_transaction_id TEXT    UNIQUE,
    failure_reason     TEXT,
    confirmed_at       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT payments_phone_format_check CHECK (payer_phone ~ '^\+[1-9][0-9]{7,14}$'),
    CONSTRAINT payments_confirmed_fields_check CHECK (
        status <> 'confirmed'
        OR (confirmed_at IS NOT NULL AND simulated_transaction_id IS NOT NULL)
    ),
    CONSTRAINT payments_failure_reason_check CHECK (
        status <> 'failed' OR length(trim(coalesce(failure_reason, ''))) > 0
    )
);

CREATE INDEX IF NOT EXISTS payments_payer_created_idx ON payments (payer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_issue_id_idx      ON payments (issue_id);
CREATE INDEX IF NOT EXISTS payments_status_idx        ON payments (status);


-- =============================================================================
-- Supabase security
-- Our Express backend connects directly with the database owner role, which
-- is not affected by RLS. Turning RLS on with no policies blocks Supabase's
-- automatic public REST API from reading or writing these tables with the
-- anon key. All access must go through our backend.
-- =============================================================================
ALTER TABLE roles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE districts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE slas                ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_rules       ENABLE ROW LEVEL SECURITY;
ALTER TABLE issues              ENABLE ROW LEVEL SECURITY;
ALTER TABLE issue_reports       ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_history      ENABLE ROW LEVEL SECURITY;
ALTER TABLE photos              ENABLE ROW LEVEL SECURITY;
ALTER TABLE upvotes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE issue_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE issue_comments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_outbox          ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments            ENABLE ROW LEVEL SECURITY;

COMMIT;
