/** Icon for each of the six fixed category codes (schema categories_code_check). */
import { CircleHelp, Construction, Droplets, Lightbulb, Trash2, Waves } from 'lucide-react';

export const CATEGORY_ICONS = {
  roads: Construction,
  street_lights: Lightbulb,
  rubbish: Trash2,
  water_leak: Droplets,
  flooding_drainage: Waves,
  other: CircleHelp,
};

export default function CategoryIcon({ code, className = 'h-5 w-5' }) {
  const Icon = CATEGORY_ICONS[code] || CircleHelp;
  return <Icon className={className} aria-hidden="true" />;
}
