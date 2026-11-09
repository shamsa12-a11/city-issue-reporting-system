/**
 * Route guards. They only decide what to show; every permission is enforced
 * again by the backend on each request.
 */
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth, homeForRole } from './AuthContext';
import { PageSpinner } from '../components/ui/Spinner';

/** Logged in with one of `roles`; otherwise to /login (or the user's own home). */
export function RequireRole({ roles }) {
  const { status, user, loggedOutByUser } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <PageSpinner />;
  // After "Log out" go home; otherwise ask to log in and come back here.
  if (status !== 'authenticated') {
    return loggedOutByUser ? <Navigate to="/" replace /> : <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (roles && !roles.includes(user.role)) return <Navigate to={homeForRole(user.role)} replace />;
  return <Outlet />;
}

/** Login / register pages: a logged-in user goes to their home instead. */
export function GuestOnly() {
  const { status, user } = useAuth();
  if (status === 'loading') return <PageSpinner />;
  if (status === 'authenticated') return <Navigate to={homeForRole(user.role)} replace />;
  return <Outlet />;
}
