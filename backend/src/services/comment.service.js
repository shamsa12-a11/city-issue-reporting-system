/**
 * Internal staff comments on an issue (Feature 6, table issue_comments).
 *
 *   POST /api/issues/:id/comments  staff who may see the issue (same rule as
 *                                  the status view: assigned officer, supervisor
 *                                  of the department or the one it was sent to,
 *                                  admin). A comment by an eligible supervisor
 *                                  on an escalated issue is the supervisor's
 *                                  action (escalation_actioned_at, once).
 *   GET  /api/issues/:id/comments  the same staff (E13). Citizens never see
 *                                  comments (blocked by the route).
 *
 * The comment and the escalation marker are written in one transaction, with
 * the issue row locked first (so the escalation job and the action are
 * serialized).
 *
 * Tables: issue_comments, issues, users, roles, assignments, audit_logs.
 * All SQL is parameterized.
 */
const db = require('../config/db');
const { runIssueTransaction } = require('./issue.service');
const { lockVisibleIssue, findVisibleIssue } = require('./status.service');
const { markEscalationActioned } = require('./escalation.service');

const toComment = (row) => ({
  id: Number(row.id),
  body: row.body,
  author: { id: Number(row.author_id), name: row.author_name, role: row.author_role },
  createdAt: row.created_at,
});

/**
 * @throws {AppError} 404 ISSUE_NOT_FOUND (unknown or not visible), 503 TRY_AGAIN
 * @returns {Promise<{ comment: object, escalationActioned: null|{ actionedAt, onTime } }>}
 */
async function addComment({ user, issueId, body, ipAddress }) {
  return runIssueTransaction(async (client) => {
    const { issue, ctx } = await lockVisibleIssue(client, issueId, user);
    const {
      rows: [row],
    } = await client.query(
      `INSERT INTO issue_comments (issue_id, author_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, author_id, body, created_at`,
      [issue.id, user.id, body]
    );
    const escalationActioned = await markEscalationActioned(client, {
      issue,
      ctx,
      user,
      action: 'comment',
      details: { commentId: Number(row.id) },
      ipAddress,
    });
    return {
      comment: toComment({ ...row, author_name: user.fullName, author_role: user.role }),
      escalationActioned,
    };
  });
}

/** Oldest first. */
async function listComments({ user, issueId, limit, offset }) {
  const { issue } = await findVisibleIssue(db, issueId, user);
  const {
    rows: [{ total }],
  } = await db.query(`SELECT count(*)::int AS total FROM issue_comments c WHERE c.issue_id = $1`, [issue.id]);
  const { rows } = await db.query(
    `SELECT c.id, c.author_id, c.body, c.created_at,
            u.full_name AS author_name, r.code AS author_role
       FROM issue_comments c
       JOIN users u ON u.id = c.author_id
       JOIN roles r ON r.id = u.role_id
      WHERE c.issue_id = $1
      ORDER BY c.created_at, c.id
      LIMIT $2 OFFSET $3`,
    [issue.id, limit, offset]
  );
  return { comments: rows.map(toComment), pagination: { limit, offset, total } };
}

module.exports = { addComment, listComments };
