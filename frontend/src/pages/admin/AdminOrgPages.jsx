/**
 * Admin organisation management (brief §3.4):
 *   users        GET/POST /admin/users, PATCH /admin/users/:id
 *   districts    GET/POST /admin/districts, PATCH /admin/districts/:id
 *   departments  GET/POST /admin/departments, PATCH /admin/departments/:id
 *   categories   GET /admin/categories, PATCH /admin/categories/:id,
 *                GET /admin/slas, PUT /admin/slas/:categoryId
 *   routing      GET /admin/routing-rules, PUT /admin/routing-rules/:c/:d
 * The backend enforces every rule (last admin, own access, open work,
 * duplicates); errors are shown by their code.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Building2, Pencil, Plus, Route as RouteIcon, Users as UsersIcon } from 'lucide-react';
import Button from '../../components/ui/Button';
import { Alert, Card, EmptyState, LoadError, Modal, Pagination, SelectField, TextArea, TextField } from '../../components/ui/primitives';
import { PageSpinner } from '../../components/ui/Spinner';
import CategoryIcon from '../../components/CategoryIcon';
import { adminApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { useAuth } from '../../auth/AuthContext';
import { useLanguage } from '../../i18n/LanguageContext';
import { isName, isPhone, normalizePhone, passwordProblem } from '../../utils/validation';

function PageHeader({ title, subtitle, action }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="mt-1 text-sm text-muted">{subtitle}</p>
      </div>
      {action}
    </div>
  );
}

function ActiveBadge({ active }) {
  const { t } = useLanguage();
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${active ? 'bg-success-50 text-success ring-success/25' : 'bg-slate-100 text-muted ring-line'}`}>
      {active ? t('staffCommon.active') : t('staffCommon.inactive')}
    </span>
  );
}

function Toggle({ label, checked, onChange, disabled }) {
  return (
    <label className={`flex items-center justify-between gap-4 rounded-lg border border-line p-3 text-sm ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <span className="font-medium">{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 rounded border-line text-royal focus:ring-royal" />
    </label>
  );
}

const Th = ({ children, right }) => <th className={`px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted ${right ? 'text-right' : 'text-left'}`}>{children}</th>;

/** Shared save handling for the edit dialogs. */
function useSave(onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async (call) => {
    setBusy(true);
    setError(null);
    try {
      const result = await call();
      onDone(result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, save };
}

// =============================================================================
// Users
// =============================================================================

const ROLES = ['citizen', 'officer', 'supervisor', 'admin'];
const STAFF_ROLES = ['officer', 'supervisor', 'admin'];

export function UsersPage() {
  const { t } = useLanguage();
  const [params, setParams] = useSearchParams();
  const role = params.get('role') || '';
  const isActive = params.get('isActive') || '';
  const search = params.get('search') || '';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const [searchDraft, setSearchDraft] = useState(search);
  const [editing, setEditing] = useState(null); // user | 'new'
  const departments = useAsync(() => adminApi.departments(), []);
  const { data, loading, error, reload } = useAsync(() => adminApi.users({ role, isActive, search, limit: 20, offset }), [role, isActive, search, offset]);
  const update = (changes) => {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    if (!('offset' in changes)) next.delete('offset');
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        action={
          <Button icon={Plus} onClick={() => setEditing('new')}>
            {t('users.newStaff')}
          </Button>
        }
      />
      <Card
        as="form"
        className="mt-6 grid items-end gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          update({ search: searchDraft.trim() });
        }}
      >
        <TextField label={t('users.search')} type="search" value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} maxLength={100} />
        <SelectField label={t('users.role')} value={role} onChange={(e) => update({ role: e.target.value })}>
          <option value="">{t('users.anyRole')}</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`roles.${r}`)}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('users.status')} value={isActive} onChange={(e) => update({ isActive: e.target.value })}>
          <option value="">{t('users.anyState')}</option>
          <option value="true">{t('users.onlyActive')}</option>
          <option value="false">{t('users.onlyInactive')}</option>
        </SelectField>
        <Button type="submit">{t('staffCommon.apply')}</Button>
      </Card>

      <div className="mt-5">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <LoadError error={error} onRetry={reload} />
        ) : data.users.length === 0 ? (
          <EmptyState icon={UsersIcon} title={t('users.empty')} />
        ) : (
          <>
            <Card className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="border-b border-line">
                  <tr>
                    <Th>{t('staffCommon.name')}</Th>
                    <Th>{t('users.phone')}</Th>
                    <Th>{t('users.role')}</Th>
                    <Th>{t('users.department')}</Th>
                    <Th>{t('users.status')}</Th>
                    <Th right>{t('staffCommon.actions')}</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.users.map((u) => (
                    <tr key={u.id}>
                      <td className="px-4 py-3 font-medium">{u.fullName}</td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">{u.phoneNumber}</td>
                      <td className="px-4 py-3">{t(`roles.${u.role}`)}</td>
                      <td className="px-4 py-3 text-muted">{u.department ? `${u.department.name}` : '—'}</td>
                      <td className="px-4 py-3">
                        <span className="flex flex-wrap gap-1.5">
                          <ActiveBadge active={u.isActive} />
                          {u.isOnLeave && <span className="rounded-full bg-warning-50 px-2.5 py-1 text-xs font-semibold text-amber-800">{t('users.onLeave')}</span>}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button variant="ghost" size="sm" icon={Pencil} onClick={() => setEditing(u)}>
                          {t('staffCommon.edit')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <div className="mt-4">
              <Pagination pagination={data.pagination} onChange={(o) => update({ offset: o ? String(o) : '' })} />
            </div>
          </>
        )}
      </div>

      {editing && (
        <UserModal
          user={editing === 'new' ? null : editing}
          departments={departments.data?.departments || []}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function UserModal({ user, departments, onClose, onDone }) {
  const { t, errorMessage } = useLanguage();
  const { user: me } = useAuth();
  const creating = !user;
  const [form, setForm] = useState({
    fullName: user?.fullName || '',
    phoneNumber: '',
    password: '',
    role: user?.role || 'officer',
    departmentId: user?.department ? String(user.department.id) : '',
    isActive: user?.isActive ?? true,
    isOnLeave: user?.isOnLeave ?? false,
  });
  const [errors, setErrors] = useState({});
  const { busy, error, save } = useSave(onDone);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const needsDepartment = form.role === 'officer' || form.role === 'supervisor';
  const isCitizen = user?.role === 'citizen';
  const isSelf = user && user.id === me.id;
  const activeDepartments = departments.filter((d) => d.isActive || String(d.id) === form.departmentId);

  const submit = () => {
    const next = {};
    if (!isName(form.fullName)) next.fullName = t('validation.nameLength');
    if (creating) {
      if (!isPhone(form.phoneNumber)) next.phoneNumber = t('validation.phone');
      const pw = passwordProblem(form.password);
      if (pw) next.password = t(pw);
    }
    if (needsDepartment && !form.departmentId) next.departmentId = t('errors.DEPARTMENT_REQUIRED');
    setErrors(next);
    if (Object.keys(next).length) return;

    if (creating) {
      save(() =>
        adminApi.createUser({
          fullName: form.fullName.trim(),
          phoneNumber: normalizePhone(form.phoneNumber),
          password: form.password,
          role: form.role,
          departmentId: needsDepartment ? Number(form.departmentId) : undefined,
        })
      );
      return;
    }
    // Only changed fields are sent.
    const changes = {};
    if (form.fullName.trim() !== user.fullName) changes.fullName = form.fullName.trim();
    if (!isCitizen) {
      if (form.role !== user.role) changes.role = form.role;
      const dept = needsDepartment ? Number(form.departmentId) : null;
      if (dept !== (user.department ? user.department.id : null)) changes.departmentId = dept;
      if (form.role === 'officer' && form.isOnLeave !== user.isOnLeave) changes.isOnLeave = form.isOnLeave;
    }
    if (form.isActive !== user.isActive) changes.isActive = form.isActive;
    if (Object.keys(changes).length === 0) return onDone();
    save(() => adminApi.updateUser(user.id, changes));
  };

  return (
    <Modal
      open
      title={creating ? t('users.createTitle') : t('users.editTitle', { name: user.fullName })}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={busy}>
            {creating ? t('staffCommon.create') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{errorMessage(error)}</Alert>}
        <TextField label={t('auth.fullName')} value={form.fullName} maxLength={100} onChange={(e) => set('fullName')(e.target.value)} error={errors.fullName} />
        {creating ? (
          <>
            <TextField label={t('auth.phone')} type="tel" placeholder="+252 61 000 0000" value={form.phoneNumber} onChange={(e) => set('phoneNumber')(e.target.value)} error={errors.phoneNumber} hint={t('auth.phoneHint')} />
            <TextField label={t('users.initialPassword')} type="password" autoComplete="new-password" value={form.password} onChange={(e) => set('password')(e.target.value)} error={errors.password} hint={t('auth.passwordHint')} />
          </>
        ) : (
          <p className="text-sm text-muted">
            {t('users.phone')}: <span className="font-mono text-ink">{user.phoneNumber}</span>
          </p>
        )}
        {!isCitizen && (
          <>
            <SelectField label={t('users.role')} value={form.role} onChange={(e) => set('role')(e.target.value)} disabled={isSelf}>
              {STAFF_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`roles.${r}`)}
                </option>
              ))}
            </SelectField>
            {needsDepartment && (
              <SelectField label={t('users.department')} value={form.departmentId} onChange={(e) => set('departmentId')(e.target.value)} error={errors.departmentId}>
                <option value="">{t('users.chooseDepartment')}</option>
                {activeDepartments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.district.name} — {d.name}
                  </option>
                ))}
              </SelectField>
            )}
          </>
        )}
        {!creating && (
          <>
            <Toggle label={t('users.accountActive')} checked={form.isActive} onChange={set('isActive')} disabled={isSelf} />
            {form.role === 'officer' && !isCitizen && <Toggle label={t('users.officerOnLeave')} checked={form.isOnLeave} onChange={set('isOnLeave')} />}
          </>
        )}
        <p className="text-xs text-muted">{t('users.lastAdminNote')}</p>
      </div>
    </Modal>
  );
}

// =============================================================================
// Districts
// =============================================================================

export function DistrictsPage() {
  const { t } = useLanguage();
  const [editing, setEditing] = useState(null);
  const { data, loading, error, reload } = useAsync(() => adminApi.districts(), []);
  return (
    <div>
      <PageHeader
        title={t('districts.title')}
        subtitle={t('districts.subtitle')}
        action={
          <Button icon={Plus} onClick={() => setEditing('new')}>
            {t('districts.newDistrict')}
          </Button>
        }
      />
      <div className="mt-6">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <LoadError error={error} onRetry={reload} />
        ) : (
          <Card className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-line">
                <tr>
                  <Th>{t('districts.name')}</Th>
                  <Th>{t('districts.city')}</Th>
                  <Th>{t('districts.region')}</Th>
                  <Th right>{t('districts.departments')}</Th>
                  <Th>{t('districts.hasBoundary')}</Th>
                  <Th>{t('common.status')}</Th>
                  <Th right>{t('staffCommon.actions')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.districts.map((d) => (
                  <tr key={d.id}>
                    <td className="px-4 py-3 font-medium">{d.name}</td>
                    <td className="px-4 py-3">{d.city}</td>
                    <td className="px-4 py-3 text-muted">{d.region || '—'}</td>
                    <td className="px-4 py-3 text-right">{d.departmentCount}</td>
                    <td className="px-4 py-3 text-muted">{d.hasBoundary ? t('districts.hasBoundary') : t('districts.noBoundary')}</td>
                    <td className="px-4 py-3">
                      <ActiveBadge active={d.isActive} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="ghost" size="sm" icon={Pencil} onClick={() => setEditing(d)}>
                        {t('staffCommon.edit')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
      {editing && (
        <DistrictModal
          district={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function DistrictModal({ district, onClose, onDone }) {
  const { t, errorMessage } = useLanguage();
  const creating = !district;
  const [form, setForm] = useState({ name: district?.name || '', city: district?.city || 'Mogadishu', region: district?.region || '', boundary: '', clearBoundary: false, isActive: district?.isActive ?? true });
  const [errors, setErrors] = useState({});
  const { busy, error, save } = useSave(onDone);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = () => {
    const next = {};
    if (!isName(form.name)) next.name = t('validation.nameLength');
    if (!isName(form.city)) next.city = t('validation.nameLength');
    let boundary;
    if (form.boundary.trim()) {
      try {
        boundary = JSON.parse(form.boundary);
      } catch {
        next.boundary = t('districts.boundaryInvalid');
      }
    }
    setErrors(next);
    if (Object.keys(next).length) return;
    const region = form.region.trim() || null;
    if (creating) {
      save(() => adminApi.createDistrict({ name: form.name.trim(), city: form.city.trim(), ...(region ? { region } : {}), ...(boundary ? { boundary } : {}) }));
      return;
    }
    const changes = {};
    if (form.name.trim() !== district.name) changes.name = form.name.trim();
    if (form.city.trim() !== district.city) changes.city = form.city.trim();
    if (region !== (district.region || null)) changes.region = region;
    if (boundary) changes.boundary = boundary;
    else if (form.clearBoundary) changes.boundary = null;
    if (form.isActive !== district.isActive) changes.isActive = form.isActive;
    if (Object.keys(changes).length === 0) return onDone();
    save(() => adminApi.updateDistrict(district.id, changes));
  };

  return (
    <Modal
      open
      wide
      title={creating ? t('districts.createTitle') : t('districts.editTitle', { name: district.name })}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={busy}>
            {creating ? t('staffCommon.create') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{errorMessage(error)}</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField label={t('districts.name')} value={form.name} maxLength={100} onChange={(e) => set('name')(e.target.value)} error={errors.name} />
          <TextField label={t('districts.city')} value={form.city} maxLength={100} onChange={(e) => set('city')(e.target.value)} error={errors.city} />
          <TextField label={t('districts.region')} optional value={form.region} maxLength={100} onChange={(e) => set('region')(e.target.value)} />
        </div>
        <TextArea
          label={t('districts.boundary')}
          optional
          rows={5}
          className="font-mono text-xs"
          placeholder='{"type":"Polygon","coordinates":[[[45.29,2.03],[45.31,2.03],[45.31,2.07],[45.29,2.07],[45.29,2.03]]]}'
          value={form.boundary}
          onChange={(e) => set('boundary')(e.target.value)}
          error={errors.boundary}
          hint={creating ? t('districts.boundaryHint') : `${t('districts.boundaryHint')} ${t('districts.keepBoundary')}`}
        />
        {!creating && district.hasBoundary && <Toggle label={t('districts.clearBoundary')} checked={form.clearBoundary} onChange={set('clearBoundary')} disabled={!!form.boundary.trim()} />}
        {!creating && <Toggle label={t('staffCommon.active')} checked={form.isActive} onChange={set('isActive')} />}
      </div>
    </Modal>
  );
}

// =============================================================================
// Departments
// =============================================================================

export function DepartmentsPage() {
  const { t } = useLanguage();
  const [districtId, setDistrictId] = useState('');
  const [editing, setEditing] = useState(null);
  const districts = useAsync(() => adminApi.districts(), []);
  const { data, loading, error, reload } = useAsync(() => adminApi.departments({ districtId }), [districtId]);
  return (
    <div>
      <PageHeader
        title={t('departments.title')}
        subtitle={t('departments.subtitle')}
        action={
          <Button icon={Plus} onClick={() => setEditing('new')}>
            {t('departments.newDepartment')}
          </Button>
        }
      />
      <div className="mt-6 max-w-xs">
        <SelectField label={t('departments.district')} value={districtId} onChange={(e) => setDistrictId(e.target.value)}>
          <option value="">{t('common.anyDistrict')}</option>
          {(districts.data?.districts || []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="mt-5">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <LoadError error={error} onRetry={reload} />
        ) : data.departments.length === 0 ? (
          <EmptyState icon={Building2} title={t('departments.empty')} />
        ) : (
          <Card className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-line">
                <tr>
                  <Th>{t('departments.name')}</Th>
                  <Th>{t('departments.district')}</Th>
                  <Th>{t('common.status')}</Th>
                  <Th right>{t('staffCommon.actions')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.departments.map((d) => (
                  <tr key={d.id}>
                    <td className="px-4 py-3 font-medium">{d.name}</td>
                    <td className="px-4 py-3">
                      {d.district.name}, {d.district.city}
                    </td>
                    <td className="px-4 py-3">
                      <ActiveBadge active={d.isActive} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="ghost" size="sm" icon={Pencil} onClick={() => setEditing(d)}>
                        {t('staffCommon.edit')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
      {editing && (
        <DepartmentModal
          department={editing === 'new' ? null : editing}
          districts={(districts.data?.districts || []).filter((d) => d.isActive)}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function DepartmentModal({ department, districts, onClose, onDone }) {
  const { t, errorMessage } = useLanguage();
  const creating = !department;
  const [form, setForm] = useState({ districtId: '', name: department?.name || '', isActive: department?.isActive ?? true });
  const [errors, setErrors] = useState({});
  const { busy, error, save } = useSave(onDone);
  const submit = () => {
    const next = {};
    if (creating && !form.districtId) next.districtId = t('validation.required');
    if (!isName(form.name)) next.name = t('validation.nameLength');
    setErrors(next);
    if (Object.keys(next).length) return;
    if (creating) return save(() => adminApi.createDepartment({ districtId: Number(form.districtId), name: form.name.trim() }));
    const changes = {};
    if (form.name.trim() !== department.name) changes.name = form.name.trim();
    if (form.isActive !== department.isActive) changes.isActive = form.isActive;
    if (Object.keys(changes).length === 0) return onDone();
    save(() => adminApi.updateDepartment(department.id, changes));
  };
  return (
    <Modal
      open
      title={creating ? t('departments.createTitle') : t('departments.editTitle', { name: department.name })}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={busy}>
            {creating ? t('staffCommon.create') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{errorMessage(error)}</Alert>}
        {creating ? (
          <SelectField label={t('departments.district')} value={form.districtId} onChange={(e) => setForm({ ...form, districtId: e.target.value })} error={errors.districtId}>
            <option value="">{t('common.anyDistrict')}</option>
            {districts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}, {d.city}
              </option>
            ))}
          </SelectField>
        ) : (
          <p className="text-sm text-muted">
            {t('departments.district')}: <span className="text-ink">{department.district.name}</span>
          </p>
        )}
        <TextField label={t('departments.name')} value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })} error={errors.name} />
        {!creating && (
          <>
            <Toggle label={t('staffCommon.active')} checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} />
            <p className="text-xs text-muted">{t('departments.deactivateNote')}</p>
          </>
        )}
      </div>
    </Modal>
  );
}

// =============================================================================
// Categories and SLAs
// =============================================================================

export function CategoriesPage() {
  const { t, categoryName } = useLanguage();
  const [editing, setEditing] = useState(null);
  const { data, loading, error, reload } = useAsync(() => Promise.all([adminApi.categories(), adminApi.slas()]), []);
  const rows = data ? data[0].categories.map((c) => ({ ...c, sla: data[1].slas.find((s) => s.category.id === c.id) })) : [];
  return (
    <div>
      <PageHeader title={t('categoriesAdmin.title')} subtitle={t('categoriesAdmin.subtitle')} />
      <div className="mt-6">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <LoadError error={error} onRetry={reload} />
        ) : (
          <Card className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-line">
                <tr>
                  <Th>{t('common.category')}</Th>
                  <Th>{t('categoriesAdmin.nameEn')}</Th>
                  <Th>{t('categoriesAdmin.nameSo')}</Th>
                  <Th right>{t('categoriesAdmin.slaHours')}</Th>
                  <Th>{t('common.status')}</Th>
                  <Th right>{t('staffCommon.actions')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2 font-medium">
                        <CategoryIcon code={c.code} className="h-4 w-4 text-royal" />
                        {categoryName(c)}
                      </span>
                    </td>
                    <td className="px-4 py-3">{c.nameEn}</td>
                    <td className="px-4 py-3">{c.nameSo}</td>
                    <td className="px-4 py-3 text-right">
                      {c.sla?.resolutionHours != null ? (
                        <>
                          <span className="font-semibold">{c.sla.resolutionHours}</span> <span className="text-xs text-muted">{t('categoriesAdmin.days', { n: Math.round((c.sla.resolutionHours / 24) * 10) / 10 })}</span>
                        </>
                      ) : (
                        <span className="text-muted">{t('categoriesAdmin.noSla')}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <ActiveBadge active={c.isActive} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="ghost" size="sm" icon={Pencil} onClick={() => setEditing(c)}>
                        {t('staffCommon.edit')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
      {editing && (
        <CategoryModal
          category={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function CategoryModal({ category, onClose, onDone }) {
  const { t, errorMessage, categoryName } = useLanguage();
  const [form, setForm] = useState({ nameEn: category.nameEn, nameSo: category.nameSo, isActive: category.isActive, hours: category.sla?.resolutionHours != null ? String(category.sla.resolutionHours) : '' });
  const [errors, setErrors] = useState({});
  const { busy, error, save } = useSave(onDone);
  const submit = () => {
    const next = {};
    if (!isName(form.nameEn)) next.nameEn = t('validation.nameLength');
    if (!isName(form.nameSo)) next.nameSo = t('validation.nameLength');
    const hours = Number(form.hours);
    if (form.hours !== '' && (!/^\d{1,4}$/.test(form.hours) || hours < 1 || hours > 8760)) next.hours = t('categoriesAdmin.slaHint');
    setErrors(next);
    if (Object.keys(next).length) return;
    save(async () => {
      const changes = {};
      if (form.nameEn.trim() !== category.nameEn) changes.nameEn = form.nameEn.trim();
      if (form.nameSo.trim() !== category.nameSo) changes.nameSo = form.nameSo.trim();
      if (form.isActive !== category.isActive) changes.isActive = form.isActive;
      if (Object.keys(changes).length) await adminApi.updateCategory(category.id, changes);
      if (form.hours !== '' && hours !== category.sla?.resolutionHours) await adminApi.setSla(category.id, hours);
    });
  };
  return (
    <Modal
      open
      title={t('categoriesAdmin.editTitle', { name: categoryName(category) })}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={busy}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="error">{errorMessage(error)}</Alert>}
        <TextField label={t('categoriesAdmin.nameEn')} value={form.nameEn} maxLength={100} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} error={errors.nameEn} />
        <TextField label={t('categoriesAdmin.nameSo')} value={form.nameSo} maxLength={100} onChange={(e) => setForm({ ...form, nameSo: e.target.value })} error={errors.nameSo} />
        <TextField label={t('categoriesAdmin.slaHours')} inputMode="numeric" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value.replace(/\D/g, '') })} error={errors.hours} hint={t('categoriesAdmin.slaHint')} />
        <Toggle label={t('staffCommon.active')} checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} />
      </div>
    </Modal>
  );
}

// =============================================================================
// Routing rules
// =============================================================================

export function RoutingPage() {
  const { t, categoryName, errorMessage } = useLanguage();
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [saving, setSaving] = useState(null);
  const [message, setMessage] = useState(null);
  const { data, loading, error, reload } = useAsync(() => Promise.all([adminApi.routingRules(), adminApi.departments()]), []);
  const byDistrict = useMemo(() => {
    if (!data) return [];
    const groups = new Map();
    for (const rule of data[0].rules) {
      if (onlyMissing && rule.routed) continue;
      if (!groups.has(rule.district.id)) groups.set(rule.district.id, { district: rule.district, rules: [] });
      groups.get(rule.district.id).rules.push(rule);
    }
    return [...groups.values()];
  }, [data, onlyMissing]);

  const setRule = async (rule, departmentId) => {
    if (!departmentId) return;
    const key = `${rule.category.id}:${rule.district.id}`;
    setSaving(key);
    setMessage(null);
    try {
      await adminApi.setRoutingRule(rule.category.id, rule.district.id, Number(departmentId));
      setMessage({ tone: 'success', key: 'routing.saved' });
      await reload();
    } catch (err) {
      setMessage({ tone: 'error', error: err });
    } finally {
      setSaving(null);
    }
  };

  return (
    <div>
      <PageHeader title={t('routing.title')} subtitle={t('routing.subtitle')} />
      {loading ? (
        <PageSpinner />
      ) : error ? (
        <div className="mt-6">
          <LoadError error={error} onRetry={reload} />
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <p className="inline-flex items-center gap-2 text-sm text-muted">
              <RouteIcon className="h-4 w-4" aria-hidden="true" />
              {t('routing.summary', data[0].summary)}
            </p>
            <label className="inline-flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} className="h-4 w-4 rounded border-line text-royal focus:ring-royal" />
              {t('routing.filterMissing')}
            </label>
          </div>
          {message && (
            <Alert tone={message.tone} className="mt-4">
              {message.key ? t(message.key) : errorMessage(message.error)}
            </Alert>
          )}
          <div className="mt-5 space-y-6">
            {byDistrict.map(({ district, rules }) => {
              const options = data[1].departments.filter((d) => d.district.id === district.id && d.isActive);
              return (
                <Card key={district.id} className="overflow-x-auto">
                  <p className="border-b border-line px-4 py-3 text-sm font-semibold">
                    {district.name}, {district.city}
                  </p>
                  <table className="min-w-full text-sm">
                    <tbody className="divide-y divide-line">
                      {rules.map((rule) => {
                        const key = `${rule.category.id}:${rule.district.id}`;
                        return (
                          <tr key={key}>
                            <td className="w-1/3 px-4 py-2.5">
                              <span className="inline-flex items-center gap-2 font-medium">
                                <CategoryIcon code={rule.category.code} className="h-4 w-4 text-royal" />
                                {categoryName(rule.category)}
                              </span>
                            </td>
                            <td className="px-4 py-2.5">
                              {!rule.department ? (
                                <span className="rounded-full bg-warning-50 px-2.5 py-1 text-xs font-semibold text-amber-800">{t('routing.missing')}</span>
                              ) : !rule.routed ? (
                                <span className="rounded-full bg-critical-50 px-2.5 py-1 text-xs font-semibold text-critical">{t('routing.inactiveDepartment')}</span>
                              ) : null}
                            </td>
                            <td className="px-4 py-2.5">
                              {options.length === 0 ? (
                                <span className="text-xs text-muted">{t('routing.noDepartments')}</span>
                              ) : (
                                <select
                                  aria-label={`${categoryName(rule.category)} — ${district.name}`}
                                  className="h-9 w-full min-w-48 rounded-lg border border-line bg-white px-3 text-sm focus:border-royal focus:outline-none focus:ring-2 focus:ring-royal/20 disabled:opacity-60"
                                  value={rule.department ? String(rule.department.id) : ''}
                                  disabled={saving === key}
                                  onChange={(e) => setRule(rule, e.target.value)}
                                >
                                  {!rule.department && <option value="">{t('routing.chooseDepartment')}</option>}
                                  {rule.department && !rule.department.isActive && <option value={rule.department.id}>{rule.department.name}</option>}
                                  {options.map((d) => (
                                    <option key={d.id} value={d.id}>
                                      {d.name}
                                    </option>
                                  ))}
                                </select>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
