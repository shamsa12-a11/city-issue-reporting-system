-- =============================================================================
-- Backfill: missing auto_route assignments (Feature 3)
--
-- DRY RUN BY DEFAULT: this script ends with ROLLBACK, so running it as it is
-- saves NOTHING. It only shows what it would insert and runs the checks.
--
-- WHY
--   Issues created before Feature 3 got a department_id from routing_rules but
--   no row in "assignments". Since Feature 3, issue creation writes the first
--   assignment (assignment_type = 'auto_route', is_current = TRUE) in the same
--   transaction, so only those older issues need this script.
--
-- WHAT IT DOES
--   For every issue that HAS a department and has NO assignment row at all,
--   inserts one current auto_route assignment to that department, dated at the
--   issue's creation (when it was routed). No officer, no supervisor,
--   assigned_by NULL (= automatic routing, see schema.sql).
--
-- SAFETY
--   * Transactional: everything runs between BEGIN and the final ROLLBACK
--     (or COMMIT). If any statement fails, nothing is saved.
--   * Idempotent: only issues with no assignment row are touched (NOT EXISTS),
--     so a second applied run inserts nothing. Issues that already have any
--     assignment history are never changed.
--   * ON CONFLICT DO NOTHING respects assignments_one_current_idx (one current
--     assignment per issue) if a row is created concurrently.
--   * Only INSERT. No UPDATE, DELETE, TRUNCATE, DROP or schema change.
--   * Issues without a department (Admin Unassigned queue, e.g. Karaan) are
--     left as they are: assignments.department_id cannot be NULL.
--   * lock_timeout: gives up after 5 s instead of waiting on a busy row.
--   * Note: even a dry run uses up assignment ids (identity values are not
--     returned on ROLLBACK). Harmless, but ids will have gaps.
--
-- HOW TO RUN (psql prints every result; stop at the first error):
--   psql "<connection string>" -v ON_ERROR_STOP=1 -f backfill_auto_route_assignments.sql
--
-- !!! APPLYING FOR REAL requires the project owner's explicit approval:
-- !!! review the dry-run output, then replace the final ROLLBACK with COMMIT
-- !!! (that is the ONLY change needed) and run it once more.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. Preview: the issues that would get an assignment.
SELECT i.id, i.reference_number, i.status, i.department_id, dep.name AS department,
       i.created_at
  FROM issues i
  JOIN departments dep ON dep.id = i.department_id
 WHERE i.department_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.issue_id = i.id)
 ORDER BY i.id;

-- 2. The backfill itself; lists every row it inserted.
WITH inserted AS (
    INSERT INTO assignments (issue_id, department_id, assignment_type, is_current, assigned_at)
    SELECT i.id, i.department_id, 'auto_route', TRUE, i.created_at
      FROM issues i
     WHERE i.department_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.issue_id = i.id)
     ORDER BY i.id
    ON CONFLICT DO NOTHING
    RETURNING id, issue_id, department_id
)
SELECT count(*) AS assignments_inserted,
       coalesce(string_agg(issue_id::text, ', ' ORDER BY issue_id), '') AS issue_ids
  FROM inserted;

-- 3. Checks (each should return 0).
SELECT count(*) AS routed_issues_still_without_assignment
  FROM issues i
 WHERE i.department_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.issue_id = i.id);

SELECT count(*) AS issues_with_more_than_one_current
  FROM (SELECT issue_id FROM assignments WHERE is_current
         GROUP BY issue_id HAVING count(*) > 1) x;

SELECT count(*) AS current_assignment_department_mismatch
  FROM assignments a
  JOIN issues i ON i.id = a.issue_id
 WHERE a.is_current
   AND a.department_id IS DISTINCT FROM i.department_id;

-- DRY RUN: undo everything above. Replace with COMMIT only when approved.
ROLLBACK;
