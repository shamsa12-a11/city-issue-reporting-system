/** Citizen workspace: the shared WorkspaceLayout with the citizen menu. */
import { Bell, CreditCard, FilePlus2, FileText, LayoutDashboard, Settings } from 'lucide-react';
import WorkspaceLayout from './WorkspaceLayout';
import { useLanguage } from '../i18n/LanguageContext';

export { NOTIFICATIONS_CHANGED } from './WorkspaceLayout';

export default function CitizenLayout() {
  const { t } = useLanguage();
  const sections = [
    {
      items: [
        { to: '/citizen', label: t('nav.dashboard'), icon: LayoutDashboard, end: true },
        { to: '/citizen/report', label: t('nav.report'), icon: FilePlus2 },
        { to: '/citizen/reports', label: t('nav.myReports'), icon: FileText },
        { to: '/citizen/notifications', label: t('nav.notifications'), icon: Bell, badge: 'unread' },
        { to: '/citizen/payments', label: t('nav.payments'), icon: CreditCard },
        { to: '/citizen/settings', label: t('nav.settings'), icon: Settings },
      ],
    },
  ];
  return <WorkspaceLayout homePath="/citizen" sections={sections} notificationsPath="/citizen/notifications" settingsPath="/citizen/settings" />;
}
