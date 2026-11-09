/**
 * Routes. Every workspace is guarded by role (the backend checks again on
 * every request).
 *   Public (no login): /, /explore, /issues/:referenceNumber
 *   Guests only:       /login, /register
 *   Citizen:           /citizen/*
 *   Officer:           /officer/*
 *   Supervisor:        /supervisor/*
 *   Admin:             /admin/*
 */
import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LanguageProvider } from './i18n/LanguageContext';
import { AuthProvider, homeForRole, useAuth } from './auth/AuthContext';
import { GuestOnly, RequireRole } from './auth/guards';
import ErrorBoundary from './components/ErrorBoundary';
import { PageSpinner } from './components/ui/Spinner';
import PublicLayout from './layouts/PublicLayout';
import CitizenLayout from './layouts/CitizenLayout';
import { AdminLayout, OfficerLayout, SupervisorLayout } from './layouts/StaffLayouts';
import { NotFoundPage } from './pages/misc';

const LandingPage = lazy(() => import('./pages/public/LandingPage'));
const ExplorePage = lazy(() => import('./pages/public/ExplorePage'));
const PublicIssuePage = lazy(() => import('./pages/public/PublicIssuePage'));
const LoginPage = lazy(() => import('./pages/auth/LoginPage'));
const RegisterPage = lazy(() => import('./pages/auth/RegisterPage'));
const DashboardPage = lazy(() => import('./pages/citizen/DashboardPage'));
const ReportIssuePage = lazy(() => import('./pages/citizen/ReportIssuePage'));
const MyReportsPage = lazy(() => import('./pages/citizen/MyReportsPage'));
const ReportDetailPage = lazy(() => import('./pages/citizen/ReportDetailPage'));
const NotificationsPage = lazy(() => import('./pages/citizen/NotificationsPage'));
const PaymentsPage = lazy(() => import('./pages/citizen/PaymentsPage'));
const PaymentDetailPage = lazy(() => import('./pages/citizen/PaymentDetailPage'));
const SettingsPage = lazy(() => import('./pages/citizen/SettingsPage'));
const StaffIssuePage = lazy(() => import('./pages/staff/StaffIssuePage'));
const AnalyticsPage = lazy(() => import('./pages/staff/AnalyticsPage'));
const officer = () => import('./pages/staff/OfficerPages');
const supervisor = () => import('./pages/staff/SupervisorPages');
const adminWork = () => import('./pages/admin/AdminWorkPages');
const adminOrg = () => import('./pages/admin/AdminOrgPages');
const named = (loader, name) => lazy(() => loader().then((m) => ({ default: m[name] })));
const OfficerDashboard = named(officer, 'OfficerDashboard');
const OfficerIssuesPage = named(officer, 'OfficerIssuesPage');
const SupervisorDashboard = named(supervisor, 'SupervisorDashboard');
const SupervisorIssuesPage = named(supervisor, 'SupervisorIssuesPage');
const WorkloadPage = named(supervisor, 'WorkloadPage');
const EscalationsPage = named(supervisor, 'EscalationsPage');
const ReviewPage = named(supervisor, 'ReviewPage');
const AdminDashboard = named(adminWork, 'AdminDashboard');
const UnassignedPage = named(adminWork, 'UnassignedPage');
const AllIssuesPage = named(adminWork, 'AllIssuesPage');
const AdminPaymentsPage = named(adminWork, 'AdminPaymentsPage');
const UsersPage = named(adminOrg, 'UsersPage');
const DistrictsPage = named(adminOrg, 'DistrictsPage');
const DepartmentsPage = named(adminOrg, 'DepartmentsPage');
const CategoriesPage = named(adminOrg, 'CategoriesPage');
const RoutingPage = named(adminOrg, 'RoutingPage');

/** Scrolls to #section links (How it works, About) and to the top on page changes. */
function ScrollManager() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      const el = document.getElementById(hash.slice(1));
      if (el) {
        el.scrollIntoView({ behavior: 'smooth' });
        return;
      }
      // The section may render after a lazy load: try once more.
      const timer = setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth' }), 300);
      return () => clearTimeout(timer);
    }
    window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

/** Old /staff links go to the user's own workspace. */
function StaffRedirect() {
  const { user } = useAuth();
  return <Navigate to={homeForRole(user.role)} replace />;
}

function AppRoutes() {
  const location = useLocation();
  return (
    <ErrorBoundary resetKey={location.pathname}>
      <Suspense fallback={<PageSpinner />}>
        <Routes>
          <Route element={<PublicLayout />}>
            <Route index element={<LandingPage />} />
            <Route path="explore" element={<ExplorePage />} />
            <Route path="issues/:referenceNumber" element={<PublicIssuePage />} />
          </Route>

          <Route element={<GuestOnly />}>
            <Route path="login" element={<LoginPage />} />
            <Route path="register" element={<RegisterPage />} />
          </Route>

          <Route path="citizen" element={<RequireRole roles={['citizen']} />}>
            <Route element={<CitizenLayout />}>
              <Route index element={<DashboardPage />} />
              <Route path="report" element={<ReportIssuePage />} />
              <Route path="reports" element={<MyReportsPage />} />
              <Route path="reports/:id" element={<ReportDetailPage />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="payments" element={<PaymentsPage />} />
              <Route path="payments/:reference" element={<PaymentDetailPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Route>

          <Route path="officer" element={<RequireRole roles={['officer']} />}>
            <Route element={<OfficerLayout />}>
              <Route index element={<OfficerDashboard />} />
              <Route path="issues" element={<OfficerIssuesPage />} />
              <Route path="issues/:id" element={<StaffIssuePage backTo="/officer/issues" />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Route>

          <Route path="supervisor" element={<RequireRole roles={['supervisor']} />}>
            <Route element={<SupervisorLayout />}>
              <Route index element={<SupervisorDashboard />} />
              <Route path="issues" element={<SupervisorIssuesPage />} />
              <Route path="issues/:id" element={<StaffIssuePage backTo="/supervisor/issues" />} />
              <Route path="workload" element={<WorkloadPage />} />
              <Route path="escalations" element={<EscalationsPage />} />
              <Route path="review" element={<ReviewPage />} />
              <Route path="analytics" element={<AnalyticsPage />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Route>

          <Route path="admin" element={<RequireRole roles={['admin']} />}>
            <Route element={<AdminLayout />}>
              <Route index element={<AdminDashboard />} />
              <Route path="issues" element={<AllIssuesPage />} />
              <Route path="issues/:id" element={<StaffIssuePage backTo="/admin" />} />
              <Route path="unassigned" element={<UnassignedPage />} />
              <Route path="escalations" element={<EscalationsPage admin />} />
              <Route path="analytics" element={<AnalyticsPage admin />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="districts" element={<DistrictsPage />} />
              <Route path="departments" element={<DepartmentsPage />} />
              <Route path="categories" element={<CategoriesPage />} />
              <Route path="routing" element={<RoutingPage />} />
              <Route path="payments" element={<AdminPaymentsPage />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Route>

          <Route path="staff" element={<RequireRole roles={['officer', 'supervisor', 'admin']} />}>
            <Route index element={<StaffRedirect />} />
          </Route>

          <Route element={<PublicLayout />}>
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <LanguageProvider>
        <AuthProvider>
          <ScrollManager />
          <AppRoutes />
        </AuthProvider>
      </LanguageProvider>
    </BrowserRouter>
  );
}
