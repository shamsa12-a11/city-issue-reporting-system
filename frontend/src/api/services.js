/**
 * Backend endpoints used by the frontend (Part 1: public pages, auth,
 * citizen). Every function returns the response body as documented in the
 * backend README / controllers; nothing is invented here.
 */
import client from './client';

const data = (promise) => promise.then((r) => r.data);

/** Removes undefined / empty-string query values. */
const clean = (params = {}) => Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));

// ---- Auth ------------------------------------------------------------------
export const authApi = {
  /** { token, tokenType, user } */
  login: (phoneNumber, password) => data(client.post('/auth/login', { phoneNumber, password })),
  /** { token, tokenType, user } — always a citizen */
  register: ({ fullName, phoneNumber, password, preferredLanguage }) =>
    data(client.post('/auth/register', { fullName, phoneNumber, password, preferredLanguage })),
  /** { user } */
  me: () => data(client.get('/auth/me')),
  /** { user } — smsNotificationsEnabled and/or preferredLanguage */
  updatePreferences: (prefs) => data(client.patch('/auth/me/preferences', prefs)),
};

// ---- Reference data (public) ------------------------------------------------
export const referenceApi = {
  /** { categories: [{ id, code, nameEn, nameSo }] } */
  categories: () => data(client.get('/categories')),
  /** { districts: [{ id, name, city }] } */
  districts: () => data(client.get('/districts')),
};

// ---- Public pages (no login) ------------------------------------------------
export const publicApi = {
  /** { issues: [...], pagination } — sort: newest | upvotes */
  issues: (params) => data(client.get('/public/issues', { params: clean(params) })),
  /** { issue: { ..., photos: { before, after } } } */
  issue: (referenceNumber) => data(client.get(`/public/issues/${encodeURIComponent(referenceNumber)}`)),
  /** { filters, points, summary, message, generatedAt } */
  heatmap: (params) => data(client.get('/public/heatmap', { params: clean(params) })),
  /** citizen: { referenceNumber, upvoted, upvotedAt, canUpvote, upvoteCount } */
  myUpvote: (referenceNumber) => data(client.get(`/public/issues/${encodeURIComponent(referenceNumber)}/upvote`)),
  /** citizen: 201 { referenceNumber, upvoted, upvotedAt, upvoteCount } */
  upvote: (referenceNumber) => data(client.post(`/public/issues/${encodeURIComponent(referenceNumber)}/upvote`)),
};

// ---- Citizen issues ------------------------------------------------------------
export const issueApi = {
  /** { candidates: [...] } */
  duplicates: ({ categoryId, latitude, longitude }) =>
    data(client.get('/issues/duplicates', { params: { categoryId, latitude, longitude } })),
  /**
   * multipart: categoryId, description, latitude, longitude, districtId?,
   * duplicateOfIssueId? | confirmDifferent='true', photos[1–3]
   * 201 { outcome: 'created' | 'merged', issue, report? }
   */
  create: ({ categoryId, description, latitude, longitude, districtId, duplicateOfIssueId, confirmDifferent, photos }) => {
    const form = new FormData();
    form.append('categoryId', String(categoryId));
    form.append('description', description);
    form.append('latitude', String(latitude));
    form.append('longitude', String(longitude));
    if (districtId) form.append('districtId', String(districtId));
    if (duplicateOfIssueId) form.append('duplicateOfIssueId', String(duplicateOfIssueId));
    if (confirmDifferent) form.append('confirmDifferent', 'true');
    photos.forEach((file) => form.append('photos', file));
    return data(client.post('/issues', form));
  },
  /** { issues, pagination } — status: all | open | resolved | closed */
  mine: (params) => data(client.get('/issues/mine', { params: clean(params) })),
  /** { issue: { ..., sla, canReopen }, history } */
  status: (id) => data(client.get(`/issues/${id}/status`)),
  /** { issue, photos: { before, after, reopen } } */
  photos: (id) => data(client.get(`/issues/${id}/photos`)),
  /** multipart: comment + 1–3 photos -> { issue, historyEntry, photos } */
  reopen: (id, { comment, photos }) => {
    const form = new FormData();
    form.append('comment', comment);
    photos.forEach((file) => form.append('photos', file));
    return data(client.post(`/issues/${id}/reopen`, form));
  },
  /** { issue, rating: { fixRating, ratedAt } } */
  rate: (id, rating) => data(client.put(`/issues/${id}/rating`, { rating })),
};

// ---- Notifications -------------------------------------------------------------
export const notificationApi = {
  /** { notifications, unreadCount, pagination } */
  list: (params) => data(client.get('/notifications', { params: clean(params) })),
  /** { unreadCount } */
  unreadCount: () => data(client.get('/notifications/unread-count')),
  /** { id, readAt, unreadCount } */
  markRead: (id) => data(client.post(`/notifications/${id}/read`)),
  /** { updated, unreadCount } */
  markAllRead: () => data(client.post('/notifications/read-all')),
  /** { sms, pagination } — own simulated SMS outbox */
  sms: (params) => data(client.get('/notifications/sms', { params: clean(params) })),
};

// ---- Simulated payments ---------------------------------------------------------
export const paymentApi = {
  /** { payments, pagination } */
  list: (params) => data(client.get('/payments', { params: clean(params) })),
  /** 201 { payment } */
  create: (body) => data(client.post('/payments', body)),
  /** { payment, receipt|null } */
  get: (reference) => data(client.get(`/payments/${encodeURIComponent(reference)}`)),
  /** { payment, receipt|null } — pin: simulated 4 digits, never stored */
  confirm: (reference, pin) => data(client.post(`/payments/${encodeURIComponent(reference)}/confirm`, { pin })),
  /** { payment } */
  cancel: (reference) => data(client.post(`/payments/${encodeURIComponent(reference)}/cancel`)),
  /** { receipt } */
  receipt: (reference) => data(client.get(`/payments/${encodeURIComponent(reference)}/receipt`)),
};

// =============================================================================
// Part 2: staff (officer, supervisor) and admin endpoints
// =============================================================================

// ---- Staff: issues --------------------------------------------------------------
export const staffIssueApi = {
  /** Full details (staff who may see the issue): { issue: {..., reports, photos, ...} } */
  detail: (id) => data(client.get(`/issues/${id}`)),
  /** assigned -> in_progress: { issue, historyEntry } */
  setStatus: (id, { status, comment }) => data(client.patch(`/issues/${id}/status`, { status, comment })),
  /** Waiting for materials on/off (null clears): { issue, historyEntry } */
  setSubStatus: (id, { subStatus, comment }) => data(client.patch(`/issues/${id}/status`, { subStatus, comment })),
  /** Assigned officer only. multipart: comment, latitude, longitude, photos[1–3] */
  resolve: (id, { comment, latitude, longitude, photos }) => {
    const form = new FormData();
    form.append('comment', comment);
    form.append('latitude', String(latitude));
    form.append('longitude', String(longitude));
    photos.forEach((file) => form.append('photos', file));
    return data(client.post(`/issues/${id}/resolve`, form));
  },
  /** Supervisor of the department: { issue, assignment, previousOfficer } */
  assign: (id, { officerId, reason, comment }) => data(client.post(`/issues/${id}/assign`, clean({ officerId, reason, comment }))),
  /** { comments, pagination } */
  comments: (id, params) => data(client.get(`/issues/${id}/comments`, { params: clean(params) })),
  /** 201 { comment, escalationActioned } */
  addComment: (id, body) => data(client.post(`/issues/${id}/comments`, { body })),
};

// ---- Officer ---------------------------------------------------------------------
export const officerApi = {
  /** Own current assignments: status open | resolved | closed | all */
  issues: (params) => data(client.get('/officer/issues', { params: clean(params) })),
};

// ---- Supervisor ------------------------------------------------------------------
export const supervisorApi = {
  /** Department issues: status new | assigned | in_progress | open */
  issues: (params) => data(client.get('/supervisor/issues', { params: clean(params) })),
  /** { department, officers: [{ id, name, isOnLeave, isActive, openAssignedCount }] } */
  workload: () => data(client.get('/supervisor/workload')),
  /** state pending | actioned | admin_alerted | all */
  escalations: (params) => data(client.get('/supervisor/escalations', { params: clean(params) })),
  /** Duplicate-review queue: status open | all */
  reviewIssues: (params) => data(client.get('/supervisor/review-issues', { params: clean(params) })),
  heatmap: (params) => data(client.get('/supervisor/heatmap', { params: clean(params) })),
  report: (params) => data(client.get('/supervisor/reports/district-performance', { params: clean(params) })),
};

// ---- Admin -----------------------------------------------------------------------
export const adminApi = {
  // users
  users: (params) => data(client.get('/admin/users', { params: clean(params) })),
  user: (id) => data(client.get(`/admin/users/${id}`)),
  createUser: (body) => data(client.post('/admin/users', clean(body))),
  updateUser: (id, changes) => data(client.patch(`/admin/users/${id}`, changes)),
  // districts
  districts: () => data(client.get('/admin/districts')),
  createDistrict: (body) => data(client.post('/admin/districts', body)),
  updateDistrict: (id, changes) => data(client.patch(`/admin/districts/${id}`, changes)),
  // departments
  departments: (params) => data(client.get('/admin/departments', { params: clean(params) })),
  createDepartment: (body) => data(client.post('/admin/departments', body)),
  updateDepartment: (id, changes) => data(client.patch(`/admin/departments/${id}`, changes)),
  // categories and SLAs
  categories: () => data(client.get('/admin/categories')),
  updateCategory: (id, changes) => data(client.patch(`/admin/categories/${id}`, changes)),
  slas: () => data(client.get('/admin/slas')),
  setSla: (categoryId, resolutionHours) => data(client.put(`/admin/slas/${categoryId}`, { resolutionHours })),
  // routing and the Unassigned queue
  routingRules: () => data(client.get('/admin/routing-rules')),
  setRoutingRule: (categoryId, districtId, departmentId) => data(client.put(`/admin/routing-rules/${categoryId}/${districtId}`, { departmentId })),
  unassigned: (params) => data(client.get('/admin/issues/unassigned', { params: clean(params) })),
  /** Every issue: { issues, pagination }; filters status, districtId, categoryId, departmentId, search (reference). */
  issues: (params) => data(client.get('/admin/issues', { params: clean(params) })),
  reroute: (id, { departmentId, reason }) => data(client.post(`/admin/issues/${id}/reroute`, { departmentId, reason })),
  setSensitive: (id, isSensitive) => data(client.patch(`/admin/issues/${id}/sensitive`, { isSensitive })),
  // monitoring and analytics
  escalations: (params) => data(client.get('/admin/escalations', { params: clean(params) })),
  heatmap: (params) => data(client.get('/admin/heatmap', { params: clean(params) })),
  report: (params) => data(client.get('/admin/reports/district-performance', { params: clean(params) })),
  payments: (params) => data(client.get('/admin/payments', { params: clean(params) })),
};
