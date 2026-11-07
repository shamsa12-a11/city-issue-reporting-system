/**
 * Static safety checks for database/backfill_auto_route_assignments.sql.
 * The script is never executed by the tests (or against Supabase); these
 * checks only make sure it stays a safe, idempotent, dry-run-by-default script.
 */
const fs = require('fs');
const path = require('path');

const SQL = fs.readFileSync(
  path.join(__dirname, '..', 'database', 'backfill_auto_route_assignments.sql'),
  'utf8'
);
// Executable SQL only: comment lines removed.
const code = SQL.split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');
const statements = code
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

describe('backfill_auto_route_assignments.sql', () => {
  test('is one transaction: starts with BEGIN and ends with ROLLBACK (dry run by default)', () => {
    expect(statements[0]).toBe('BEGIN');
    expect(statements[statements.length - 1]).toBe('ROLLBACK');
    expect(code).not.toMatch(/\bCOMMIT\b/i);
  });

  test('only inserts: no UPDATE, DELETE, TRUNCATE, DROP, ALTER or CREATE', () => {
    expect(code).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE)\b/i);
    expect(code.match(/\bINSERT INTO\b/gi)).toEqual(['INSERT INTO']);
    expect(code).toMatch(/INSERT INTO assignments/);
  });

  test('idempotent: only issues with a department and no assignment row, ON CONFLICT DO NOTHING', () => {
    const insert = code.slice(code.indexOf('INSERT INTO assignments'));
    expect(insert).toMatch(/i\.department_id IS NOT NULL/);
    expect(insert).toMatch(/NOT EXISTS \(SELECT 1 FROM assignments a WHERE a\.issue_id = i\.id\)/);
    expect(insert).toMatch(/ON CONFLICT DO NOTHING/);
  });

  test("inserts current auto_route rows with no officer, supervisor or assigned_by", () => {
    expect(code).toMatch(
      /INSERT INTO assignments \(issue_id, department_id, assignment_type, is_current, assigned_at\)/
    );
    expect(code).toMatch(/SELECT i\.id, i\.department_id, 'auto_route', TRUE, i\.created_at/);
    expect(code).not.toMatch(/officer_id|supervisor_id|assigned_by/);
  });

  test('sets a lock timeout inside the transaction', () => {
    expect(statements[1]).toBe("SET LOCAL lock_timeout = '5s'");
  });
});
