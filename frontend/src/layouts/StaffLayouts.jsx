/** Officer, supervisor and admin workspaces: the shared layout with each role's menu. */
import {
  AlertTriangle,
  Bell,
  Building2,
  ClipboardList,
  CopyCheck,
  CreditCard,
  Inbox,
  LayoutDashboard,
  ListChecks,
  Map as MapIcon,
  MapPinned,
  Route,
  Settings,
  Tags,
  Users,
  UsersRound,
} from 'lucide-react';
import WorkspaceLayout from './WorkspaceLayout';
import { useLanguage } from '../i18n/LanguageContext';

export function OfficerLayout() {
  const { t } = useLanguage();
  const sections = [
    {
      items: [
        { to: '/officer', label: t('staffNav.overview'), icon: LayoutDashboard, end: true },
        { to: '/officer/issues', label: t('staffNav.myIssues'), icon: ClipboardList },
        { to: '/officer/notifications', label: t('nav.notifications'), icon: Bell, badge: 'unread' },
        { to: '/officer/settings', label: t('nav.settings'), icon: Settings },
      ],
    },
  ];
  return <WorkspaceLayout homePath="/officer" sections={sections} notificationsPath="/officer/notifications" settingsPath="/officer/settings" />;
}

export function SupervisorLayout() {
  const { t } = useLanguage();
  const sections = [
    {
      title: t('staffNav.sectionWork'),
      items: [
        { to: '/supervisor', label: t('staffNav.overview'), icon: LayoutDashboard, end: true },
        { to: '/supervisor/issues', label: t('staffNav.departmentIssues'), icon: ClipboardList },
        { to: '/supervisor/workload', label: t('staffNav.workload'), icon: UsersRound },
        { to: '/supervisor/escalations', label: t('staffNav.escalations'), icon: AlertTriangle },
        { to: '/supervisor/review', label: t('staffNav.review'), icon: CopyCheck },
      ],
    },
    {
      title: t('staffNav.sectionMonitoring'),
      items: [
        { to: '/supervisor/analytics', label: t('staffNav.analytics'), icon: MapIcon },
        { to: '/supervisor/notifications', label: t('nav.notifications'), icon: Bell, badge: 'unread' },
        { to: '/supervisor/settings', label: t('nav.settings'), icon: Settings },
      ],
    },
  ];
  return <WorkspaceLayout homePath="/supervisor" sections={sections} notificationsPath="/supervisor/notifications" settingsPath="/supervisor/settings" wide />;
}

export function AdminLayout() {
  const { t } = useLanguage();
  const sections = [
    {
      title: t('staffNav.sectionWork'),
      items: [
        { to: '/admin', label: t('staffNav.overview'), icon: LayoutDashboard, end: true },
        { to: '/admin/issues', label: t('staffNav.allIssues'), icon: ListChecks },
        { to: '/admin/unassigned', label: t('staffNav.unassigned'), icon: Inbox },
        { to: '/admin/escalations', label: t('staffNav.escalations'), icon: AlertTriangle },
        { to: '/admin/analytics', label: t('staffNav.analytics'), icon: MapPinned },
      ],
    },
    {
      title: t('staffNav.sectionOrganisation'),
      items: [
        { to: '/admin/users', label: t('staffNav.users'), icon: Users },
        { to: '/admin/districts', label: t('staffNav.districts'), icon: MapIcon },
        { to: '/admin/departments', label: t('staffNav.departments'), icon: Building2 },
        { to: '/admin/categories', label: t('staffNav.categories'), icon: Tags },
        { to: '/admin/routing', label: t('staffNav.routing'), icon: Route },
      ],
    },
    {
      title: t('staffNav.sectionMonitoring'),
      items: [
        { to: '/admin/payments', label: t('staffNav.payments'), icon: CreditCard },
        { to: '/admin/notifications', label: t('nav.notifications'), icon: Bell, badge: 'unread' },
        { to: '/admin/settings', label: t('nav.settings'), icon: Settings },
      ],
    },
  ];
  return <WorkspaceLayout homePath="/admin" sections={sections} notificationsPath="/admin/notifications" settingsPath="/admin/settings" wide />;
}
