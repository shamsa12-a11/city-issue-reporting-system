import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

const VARIANTS = {
  primary: 'bg-royal text-white hover:bg-royal-700 shadow-sm',
  secondary: 'bg-white text-ink border border-line hover:bg-page shadow-sm',
  ghost: 'text-ink hover:bg-page',
  navy: 'bg-navy text-white hover:bg-navy-700 shadow-sm',
  danger: 'bg-critical text-white hover:bg-red-700 shadow-sm',
  light: 'bg-white text-navy hover:bg-royal-50 shadow-sm',
  outlineLight: 'border border-white/40 text-white hover:bg-white/10',
};
const SIZES = {
  sm: 'h-9 px-3 text-sm gap-1.5',
  md: 'h-11 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2',
};

/**
 * Button or link with one look. `to` renders a router Link, `href` an <a>.
 * `loading` disables the button and shows a spinner.
 */
export default function Button({
  variant = 'primary',
  size = 'md',
  to,
  href,
  loading = false,
  disabled = false,
  className = '',
  children,
  icon: Icon,
  type = 'button',
  ...rest
}) {
  const classes = `inline-flex items-center justify-center rounded-lg font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60 ${VARIANTS[variant]} ${SIZES[size]} ${className}`;
  const content = (
    <>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : Icon ? <Icon className="h-4 w-4" aria-hidden="true" /> : null}
      {children}
    </>
  );
  if (to) {
    return (
      <Link to={to} className={classes} {...rest}>
        {content}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} className={classes} {...rest}>
        {content}
      </a>
    );
  }
  return (
    <button type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {content}
    </button>
  );
}
