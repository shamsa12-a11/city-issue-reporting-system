/**
 * "Me too" upvotes (Feature 11).
 *
 * Rules:
 *   - Citizens only; one upvote per citizen per issue (upvotes primary key
 *     (issue_id, citizen_id); a repeat -> 409 ALREADY_UPVOTED).
 *   - Only open issues (new, assigned, in_progress): resolved or closed
 *     issues -> 409 ISSUE_NOT_OPEN.
 *   - Issues are addressed by the public reference number (the public pages
 *     do not expose internal ids). Sensitive issues are not public: 404, the
 *     same as an unknown reference.
 *   - The issue row is share-locked while voting, so a vote and a status
 *     change (resolve, auto-close) never interleave.
 *
 * Tables: upvotes, issues. All SQL is parameterized.
 */
const db = require('../config/db');
const AppError = require('../utils/AppError');
const { runIssueTransaction, OPEN_STATUSES } = require('./issue.service');

const notFound = () => new AppError(404, 'ISSUE_NOT_FOUND', 'Issue not found');

async function findPublicIssue(executor, referenceNumber, { lock = false } = {}) {
  const { rows } = await executor.query(
    `SELECT i.id, i.reference_number, i.status, i.is_sensitive AS upvote_issue_sensitive
       FROM issues i
      WHERE i.reference_number = $1${lock ? '\n        FOR SHARE' : ''}`,
    [referenceNumber]
  );
  const issue = rows[0];
  if (!issue || issue.upvote_issue_sensitive !== false) throw notFound();
  return issue;
}

async function countUpvotes(executor, issueId) {
  const {
    rows: [{ upvote_total: total }],
  } = await executor.query(`SELECT count(*)::int AS upvote_total FROM upvotes v WHERE v.issue_id = $1`, [issueId]);
  return total;
}

/**
 * POST /api/public/issues/:referenceNumber/upvote
 * @throws {AppError} 404 ISSUE_NOT_FOUND, 409 ISSUE_NOT_OPEN / ALREADY_UPVOTED, 503 TRY_AGAIN
 */
async function upvote({ user, referenceNumber }) {
  return runIssueTransaction(async (client) => {
    const issue = await findPublicIssue(client, referenceNumber, { lock: true });
    if (!OPEN_STATUSES.includes(issue.status)) {
      throw new AppError(409, 'ISSUE_NOT_OPEN', 'Only open issues can be upvoted', { status: issue.status });
    }
    const { rows } = await client.query(
      `INSERT INTO upvotes (issue_id, citizen_id)
       VALUES ($1, $2)
       ON CONFLICT (issue_id, citizen_id) DO NOTHING
       RETURNING created_at`,
      [issue.id, user.id]
    );
    if (rows.length === 0) {
      throw new AppError(409, 'ALREADY_UPVOTED', 'You have already upvoted this issue');
    }
    return {
      referenceNumber: issue.reference_number,
      upvoted: true,
      upvotedAt: rows[0].created_at,
      upvoteCount: await countUpvotes(client, issue.id),
    };
  });
}

/**
 * GET /api/public/issues/:referenceNumber/upvote — the citizen's own vote
 * state (for the "Me too" button).
 * @throws {AppError} 404 ISSUE_NOT_FOUND
 */
async function getMyUpvote({ user, referenceNumber }) {
  const issue = await findPublicIssue(db, referenceNumber);
  const { rows } = await db.query(
    `SELECT v.created_at AS my_upvote_at FROM upvotes v WHERE v.issue_id = $1 AND v.citizen_id = $2`,
    [issue.id, user.id]
  );
  const upvoted = rows.length > 0;
  return {
    referenceNumber: issue.reference_number,
    upvoted,
    upvotedAt: upvoted ? rows[0].my_upvote_at : null,
    canUpvote: !upvoted && OPEN_STATUSES.includes(issue.status),
    upvoteCount: await countUpvotes(db, issue.id),
  };
}

module.exports = { upvote, getMyUpvote };
