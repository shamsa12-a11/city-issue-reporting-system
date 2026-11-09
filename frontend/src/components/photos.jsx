/** Photo display (grid, before/after) and the photo picker for uploads. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff, ImagePlus, X } from 'lucide-react';
import { assetUrl, LIMITS } from '../config';
import { useLanguage } from '../i18n/LanguageContext';

export function Photo({ photo, alt, className = '' }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className={`flex items-center justify-center bg-page text-muted ${className}`}>
        <ImageOff className="h-6 w-6" aria-hidden="true" />
      </div>
    );
  }
  return (
    <a href={assetUrl(photo.url)} target="_blank" rel="noreferrer" className={`block overflow-hidden bg-page ${className}`}>
      <img src={assetUrl(photo.url)} alt={alt} loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover transition-transform duration-200 hover:scale-[1.02]" />
    </a>
  );
}

export function PhotoGrid({ photos = [], alt, emptyText }) {
  if (photos.length === 0) {
    return <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-line bg-page px-4 text-center text-sm text-muted">{emptyText}</div>;
  }
  return (
    <div className={`grid gap-2 ${photos.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
      {photos.map((p, i) => (
        <Photo key={p.id} photo={p} alt={`${alt} ${i + 1}`} className={`rounded-lg ${photos.length === 1 ? 'aspect-[4/3]' : 'aspect-square'}`} />
      ))}
    </div>
  );
}

/** Feature 8: before and after photos side by side. */
export function BeforeAfter({ before = [], after = [] }) {
  const { t } = useLanguage();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <p className="mb-2 inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-navy">{t('publicIssue.before')}</p>
        <PhotoGrid photos={before} alt={t('publicIssue.before')} emptyText={t('publicIssue.noBefore')} />
      </div>
      <div>
        <p className="mb-2 inline-flex rounded-full bg-success-50 px-2.5 py-1 text-xs font-semibold text-success">{t('publicIssue.after')}</p>
        <PhotoGrid photos={after} alt={t('publicIssue.after')} emptyText={t('publicIssue.noAfter')} />
      </div>
    </div>
  );
}

/** Checks files against the backend rules (type, size, 1–3); returns error texts. */
export function validatePhotos(files, t) {
  const errors = [];
  if (files.length < LIMITS.photosMin || files.length > LIMITS.photosMax) errors.push(t('validation.photosCount'));
  for (const f of files) {
    if (!LIMITS.photoTypes.includes(f.type)) errors.push(t('validation.photoType', { name: f.name }));
    else if (f.size > LIMITS.photoMaxBytes) errors.push(t('validation.photoSize', { name: f.name }));
  }
  return errors;
}

/** Up to 3 photos with previews. The server re-checks the real file type. */
export function PhotoPicker({ files, onChange, error, label }) {
  const { t } = useLanguage();
  const input = useRef(null);
  const previews = useMemo(() => files.map((f) => ({ file: f, url: URL.createObjectURL(f) })), [files]);
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);

  const add = (list) => {
    const next = [...files, ...Array.from(list)].slice(0, LIMITS.photosMax);
    onChange(next);
    if (input.current) input.current.value = '';
  };

  return (
    <div>
      {label && <p className="mb-1.5 text-sm font-medium text-ink">{label}</p>}
      <div className="grid grid-cols-3 gap-3">
        {previews.map((p, i) => (
          <div key={p.url} className="relative aspect-square overflow-hidden rounded-lg border border-line bg-page">
            <img src={p.url} alt={`${i + 1}`} className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => onChange(files.filter((f) => f !== p.file))}
              className="absolute right-1.5 top-1.5 rounded-full bg-navy/80 p-1 text-white hover:bg-navy"
              aria-label={t('report.removePhoto')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
        {files.length < LIMITS.photosMax && (
          <button
            type="button"
            onClick={() => input.current?.click()}
            className={`flex aspect-square flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed bg-white text-sm font-medium text-royal transition-colors hover:bg-royal-50 ${
              error ? 'border-critical' : 'border-line'
            }`}
          >
            <ImagePlus className="h-6 w-6" aria-hidden="true" />
            {t('report.addPhotos')}
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => add(e.target.files)}
      />
      {error ? <p className="mt-1.5 text-xs font-medium text-critical">{error}</p> : <p className="mt-1.5 text-xs text-muted">{t('report.photosHelp')}</p>}
    </div>
  );
}
