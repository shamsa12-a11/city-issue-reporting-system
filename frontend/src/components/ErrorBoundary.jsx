/** Catches rendering errors so one broken page never blanks the whole app. */
import { Component } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';

function Fallback() {
  const { t } = useLanguage();
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center px-4 text-center">
      <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-critical-50 text-critical">
        <TriangleAlert className="h-6 w-6" aria-hidden="true" />
      </span>
      <h1 className="text-lg font-semibold">{t('common.somethingWrong')}</h1>
      <p className="mt-1 text-sm text-muted">{t('common.pageError')}</p>
      <button type="button" onClick={() => window.location.reload()} className="mt-5 h-10 rounded-lg bg-royal px-4 text-sm font-semibold text-white hover:bg-royal-700">
        {t('common.reload')}
      </button>
    </div>
  );
}

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('[ui] render error', error);
  }

  componentDidUpdate(prevProps) {
    // Navigating to another page clears the error.
    if (this.state.failed && prevProps.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    return this.state.failed ? <Fallback /> : this.props.children;
  }
}
