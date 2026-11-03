-- =============================================================================
-- City Issue Reporting System — Seed Data
-- Run AFTER schema.sql.
--
-- Contents:
--   * 6 Mogadishu (Banadir) districts with simplified demo boundaries
--   * 6 issue categories (English + Somali)   — same rows schema.sql creates
--   * 6 default SLAs, one per category         — same rows schema.sql creates
--   * 15 departments (3 per serviced district)
--   * 30 routing rules (every category in every serviced district)
--   * 15 demo users covering all 4 roles
--
-- Safe and repeatable:
--   * Every INSERT uses ON CONFLICT ... DO NOTHING, so running this file
--     twice does not create duplicates and never overwrites existing rows.
--   * No DROP, DELETE, TRUNCATE or UPDATE statements.
--   * Runs in one transaction: if anything fails, nothing is saved.
--
-- DEMO PASSWORD (for local demos only):
--   All demo accounts use the password:  CityDemo#2026
--   It is NOT a real credential. Passwords are hashed here with bcrypt
--   (pgcrypto's crypt() + gen_salt('bf', 10)), so only the hash is stored.
--   Never reuse this password, and never load these demo accounts into a
--   production database.
--
-- IMPORTANT NOTES:
--   * District boundaries are SIMPLIFIED RECTANGLES around each district's
--     approximate area. They are for the demo (district detection and
--     "Outside service area") and are NOT official boundaries.
--   * Phone numbers use the +25261 000 xxxx demo range. SMS is simulated, so
--     no real messages are ever sent to these numbers.
--   * Karaan district is intentionally left WITHOUT departments or routing
--     rules, so issues reported there land in the Admin Unassigned queue
--     (demonstrates Feature 3 fallback).
-- =============================================================================

BEGIN;

-- pgcrypto provides crypt()/gen_salt() for bcrypt hashing.
-- It is enabled by default on Supabase in the "extensions" schema.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Makes PostGIS and pgcrypto functions visible on plain PostgreSQL too.
SET LOCAL search_path TO public, extensions;


-- -----------------------------------------------------------------------------
-- 1. DISTRICTS (Mogadishu, Banadir region)
-- Boundaries are rectangles: (min longitude, min latitude, max longitude,
-- max latitude). Rectangles only touch at edges; they never overlap.
-- -----------------------------------------------------------------------------
INSERT INTO districts (name, city, region, boundary)
SELECT d.name, 'Mogadishu', 'Banadir',
       ST_Multi(ST_MakeEnvelope(d.min_lon, d.min_lat, d.max_lon, d.max_lat, 4326))::geography
FROM (VALUES
    ('Hodan',       45.290, 2.030, 45.315, 2.070),
    ('Wadajir',     45.255, 2.000, 45.290, 2.040),
    ('Waberi',      45.290, 2.000, 45.325, 2.030),
    ('Howlwadaag',  45.315, 2.035, 45.335, 2.060),
    ('Hamar Weyne', 45.335, 2.025, 45.355, 2.045),
    ('Karaan',      45.340, 2.060, 45.380, 2.095)   -- no departments yet (Unassigned demo)
) AS d (name, min_lon, min_lat, max_lon, max_lat)
ON CONFLICT (name, city) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 2. CATEGORIES (English + Somali)
-- schema.sql already inserts these; repeated here so seed.sql is complete.
-- ON CONFLICT keeps whatever is already in the database.
-- -----------------------------------------------------------------------------
INSERT INTO categories (code, name_en, name_so) VALUES
    ('roads',             'Roads',             'Waddooyin'),
    ('street_lights',     'Street lights',     'Nalalka waddooyinka'),
    ('rubbish',           'Rubbish',           'Qashin'),
    ('water_leak',        'Water leak',        'Biyo-daadasho'),
    ('flooding_drainage', 'Flooding/drainage', 'Fatahaad/bullaacad'),
    ('other',             'Other',             'Kale')
ON CONFLICT (code) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 3. SLAS (one per category)
-- Water leak, Street lights and Roads use the brief's example values.
-- Rubbish, Flooding/drainage and Other are placeholder values to confirm.
-- -----------------------------------------------------------------------------
INSERT INTO slas (category_id, resolution_hours)
SELECT c.id, s.resolution_hours
FROM (VALUES
    ('water_leak',         48),   -- 48 hours (brief)
    ('street_lights',     120),   -- 5 days   (brief)
    ('roads',             336),   -- 14 days  (brief)
    ('rubbish',            72),   -- 3 days   (placeholder)
    ('flooding_drainage',  48),   -- 2 days   (placeholder)
    ('other',             168)    -- 7 days   (placeholder)
) AS s (category_code, resolution_hours)
JOIN categories c ON c.code = s.category_code
ON CONFLICT (category_id) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 4. DEPARTMENTS
-- Each serviced district has three departments:
--   Public Works      -> Roads, Street lights, Other
--   Sanitation        -> Rubbish
--   Water & Drainage  -> Water leak, Flooding/drainage
-- -----------------------------------------------------------------------------
INSERT INTO departments (district_id, name)
SELECT dist.id, dist.name || ' ' || t.dept_type
FROM districts dist
CROSS JOIN (VALUES ('Public Works'), ('Sanitation'), ('Water & Drainage')) AS t (dept_type)
WHERE dist.city = 'Mogadishu'
  AND dist.name IN ('Hodan', 'Wadajir', 'Waberi', 'Howlwadaag', 'Hamar Weyne')
ON CONFLICT (district_id, name) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 5. ROUTING RULES
-- Every category in every serviced district -> the matching department.
-- Example: Roads + Hodan -> Hodan Public Works.
-- Karaan has no rules on purpose (its issues go to the Unassigned queue).
-- -----------------------------------------------------------------------------
INSERT INTO routing_rules (category_id, district_id, department_id)
SELECT c.id, dist.id, dept.id
FROM categories c
CROSS JOIN districts dist
JOIN departments dept
  ON dept.district_id = dist.id
 AND dept.name = dist.name || ' ' ||
     CASE c.code
         WHEN 'roads'             THEN 'Public Works'
         WHEN 'street_lights'     THEN 'Public Works'
         WHEN 'other'             THEN 'Public Works'
         WHEN 'rubbish'           THEN 'Sanitation'
         WHEN 'water_leak'        THEN 'Water & Drainage'
         WHEN 'flooding_drainage' THEN 'Water & Drainage'
     END
WHERE dist.city = 'Mogadishu'
  AND dist.name IN ('Hodan', 'Wadajir', 'Waberi', 'Howlwadaag', 'Hamar Weyne')
ON CONFLICT (category_id, district_id) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 6. DEMO USERS
-- department_name/district_name are NULL for citizens and the admin.
-- All passwords = demo password above, stored only as bcrypt hashes.
-- -----------------------------------------------------------------------------
INSERT INTO users (role_id, department_id, full_name, phone_number, password_hash,
                   preferred_language, sms_notifications_enabled, is_on_leave)
SELECT r.id,
       dept.id,
       u.full_name,
       u.phone_number,
       crypt('CityDemo#2026', gen_salt('bf', 10)),
       u.preferred_language,
       u.sms_enabled,
       u.is_on_leave
FROM (VALUES
    -- role,        full name,                   phone,           lang, sms,   leave, district,     department type
    -- Admin
    ('admin',      'Abdirahman Hassan Mohamed', '+252610000001', 'en', TRUE,  FALSE, NULL,         NULL),

    -- District supervisors
    ('supervisor', 'Fadumo Ali Warsame',        '+252610000101', 'so', TRUE,  FALSE, 'Hodan',      'Public Works'),
    ('supervisor', 'Abdullahi Omar Farah',      '+252610000102', 'so', TRUE,  FALSE, 'Hodan',      'Water & Drainage'),
    ('supervisor', 'Hawa Abdi Nur',             '+252610000103', 'en', TRUE,  FALSE, 'Wadajir',    'Public Works'),
    ('supervisor', 'Mohamed Yusuf Ahmed',       '+252610000104', 'so', TRUE,  FALSE, 'Howlwadaag', 'Sanitation'),

    -- Department officers
    ('officer',    'Ahmed Mahad Abdi',          '+252610000201', 'so', TRUE,  FALSE, 'Hodan',      'Public Works'),
    ('officer',    'Ismail Sheikh Ali',         '+252610000202', 'so', TRUE,  TRUE,  'Hodan',      'Public Works'),   -- on leave
    ('officer',    'Sahra Mohamud Hirsi',       '+252610000203', 'en', TRUE,  FALSE, 'Hodan',      'Water & Drainage'),
    ('officer',    'Bashir Ali Jama',           '+252610000204', 'so', TRUE,  FALSE, 'Wadajir',    'Public Works'),
    ('officer',    'Khadija Osman Aden',        '+252610000205', 'so', TRUE,  FALSE, 'Howlwadaag', 'Sanitation'),

    -- Citizens
    ('citizen',    'Amina Abdullahi Hussein',   '+252610000301', 'so', TRUE,  FALSE, NULL,         NULL),
    ('citizen',    'Hassan Ibrahim Guled',      '+252610000302', 'so', TRUE,  FALSE, NULL,         NULL),
    ('citizen',    'Ayaan Mohamed Ali',         '+252610000303', 'en', TRUE,  FALSE, NULL,         NULL),
    ('citizen',    'Yusuf Abdi Warsame',        '+252610000304', 'so', FALSE, FALSE, NULL,         NULL),   -- SMS turned off
    ('citizen',    'Faisal Nur Hassan',         '+252610000305', 'en', TRUE,  FALSE, NULL,         NULL)
) AS u (role_code, full_name, phone_number, preferred_language, sms_enabled, is_on_leave,
        district_name, dept_type)
JOIN roles r ON r.code = u.role_code
LEFT JOIN districts dist
       ON dist.name = u.district_name AND dist.city = 'Mogadishu'
LEFT JOIN departments dept
       ON dept.district_id = dist.id AND dept.name = dist.name || ' ' || u.dept_type
ON CONFLICT (phone_number) DO NOTHING;

COMMIT;


-- =============================================================================
-- Optional checks (read-only). Run after the seed to confirm the counts:
--
--   SELECT count(*) FROM districts;        -- expect 6
--   SELECT count(*) FROM categories;       -- expect 6
--   SELECT count(*) FROM slas;             -- expect 6
--   SELECT count(*) FROM departments;      -- expect 15
--   SELECT count(*) FROM routing_rules;    -- expect 30
--   SELECT r.code, count(*) FROM users u JOIN roles r ON r.id = u.role_id
--   GROUP BY r.code;                       -- admin 1, supervisor 4, officer 5, citizen 5
--
--   -- Staff accounts must all have a department (expect 0 rows):
--   SELECT u.full_name FROM users u JOIN roles r ON r.id = u.role_id
--   WHERE r.code IN ('officer', 'supervisor') AND u.department_id IS NULL;
-- =============================================================================
