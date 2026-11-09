/** 404 page. */
import { Compass } from 'lucide-react';
import Button from '../components/ui/Button';
import { useLanguage } from '../i18n/LanguageContext';

export function NotFoundPage() {
  const { t } = useLanguage();
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-royal-50 text-royal">
        <Compass className="h-7 w-7" aria-hidden="true" />
      </span>
      <h1 className="mt-5 text-2xl font-bold">{t('notFound.title')}</h1>
      <p className="mt-2 text-muted">{t('notFound.text')}</p>
      <Button to="/" className="mt-6">
        {t('notFound.home')}
      </Button>
    </div>
  );
}
