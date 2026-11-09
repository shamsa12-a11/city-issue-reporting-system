/**
 * Translation check (npm run check:i18n):
 *   1. English and Somali dictionaries have exactly the same keys.
 *   2. Every literal t('some.key') used in src/ exists in both.
 * Keys built at runtime (t(`status.${s}`)) are covered by check 1.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from '../src/i18n/en.js';
import so from '../src/i18n/so.js';

const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`]));

const enKeys = new Set(flatten(en));
const soKeys = new Set(flatten(so));
const problems = [];
for (const k of enKeys) if (!soKeys.has(k)) problems.push(`missing in so.js: ${k}`);
for (const k of soKeys) if (!enKeys.has(k)) problems.push(`missing in en.js: ${k}`);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(jsx?|mjs)$/.test(name) && !path.includes('i18n')) files.push(path);
  }
};
walk(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

let used = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
    used += 1;
    const key = match[1];
    if (!enKeys.has(key)) problems.push(`${file.split('src')[1]}: unknown key '${key}'`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} translation problem(s)`);
  process.exit(1);
}
console.log(`i18n ok: ${enKeys.size} keys in both languages, ${used} t('…') uses checked in ${files.length} files`);
