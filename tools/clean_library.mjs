// Cleans the published library in web/data for good (run after tools/export_more.py; safe to run again):
//
//   node tools/clean_library.mjs            # rewrites web/data/recipes.json and a new web/data/more/<version>/
//   node tools/clean_library.mjs --dry-run  # only counts what it would change
//
// 1. Methods: the same tidying the app does when it shows a library recipe (web/js/dirtidy.js): no
//    mailing-list sign-offs, show tags, separator lines, emails, nutrition/yield lines, CAPITALS or
//    "500 DEG F". A "Source: ..." credit is kept as the last paragraph.
// 2. Ingredient lists: headings typed as ingredients ("For the sauce:", "Garnish:") become the group of the
//    lines under them; "Or 3 stalks celery" joins the line above; "6 slice / To 8 sl bacon" becomes
//    "6-8 slices bacon"; empty lines go.
// 3. Recipes with no ingredients, no method, or a method of a few words are tagged needs-work: the app
//    keeps them out of lists and search (they still open from a saved link), and they're left out of
//    the on-demand index.
// Ids never change, so stars, plans and edits made on phones stay attached.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tidyDirections } from '../web/js/dirtidy.js';
import { itemName } from '../web/js/shopping.js';
import { canonicalUnit } from '../web/js/units.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'web', 'data');
const DRY = process.argv.includes('--dry-run');
const NEEDS_WORK = 'needs-work';

const HEADING = /^(for (the )?[a-z][a-z ,'&-]{1,30}|garnish(es)?|optional|topping|filling|sauce|crust|glaze|frosting|icing|dressing|marinade|batter|dough|syrup|streusel|meringue|to serve|to garnish)\s*:?\s*$/i;
const RANGE = /^to\s+(\d+(?:\s+\d+\/\d+|\/\d+|\.\d+)?)\s*([a-z]+\.?)?\s+(.+)$/i;
// Meal-Master's two-letter units, as they turn up inside "To 2 ts garlic"
const MM = { ts: 'tsp', t: 'tsp', tb: 'Tbsp', tbs: 'Tbsp', c: 'cup', pt: 'pint', qt: 'quart', ga: 'gallon', oz: 'oz', lb: 'lb',
  sl: 'slice', md: 'medium', lg: 'large', sm: 'small', pk: 'package', pkg: 'package', cn: 'can', ea: '', dr: 'drop', pn: 'pinch', ds: 'dash', cl: 'clove' };
const unitOf = (w) => { const k = w.replace(/\.$/, '').toLowerCase(); return Object.hasOwn(MM, k) ? MM[k] : canonicalUnit(k); };
const label = (s) => s.replace(/:\s*$/, '').replace(/^for (the )?/i, '').trim().replace(/^./, (c) => c.toUpperCase());

const stats = { methods: 0, credits: 0, headings: 0, alternatives: 0, ranges: 0, empty: 0, needsWork: 0 };

/** Ingredient rows [q, raw, unit, item, group] with the notes sorted out. */
export function cleanIngredients(ings) {
  const out = [];
  let heading = '';
  for (const row of ings) {
    const [q, raw, unit, item = '', group = ''] = row;
    const it = item.trim();
    const noAmount = !q && !raw;
    if (!it && noAmount && !unit) { stats.empty++; continue; }
    if (noAmount && !unit && HEADING.test(it)) { heading = label(it); stats.headings++; continue; }
    if (noAmount && !unit && /^or\b/i.test(it) && out.length) {
      const prev = out[out.length - 1];
      prev[3] = `${prev[3].replace(/[,;\s]+$/, '')}, ${it.replace(/[,;\s]+$/, '').replace(/^OR\b/, 'or').replace(/^Or\b/, 'or')}`;
      stats.alternatives++;
      continue;
    }
    const m = it.match(RANGE);
    if (m && (q || raw) && !/-/.test(raw) && !/^to\s+\d/i.test(m[3])) {   // not one that's already a range
      const mu = m[2] ? unitOf(m[2]) : null;
      const u = mu || unit;
      const known = !m[2] || mu != null;
      out.push(['', `${raw || q}-${m[1]}`, u || '', known ? m[3] : `${m[2]} ${m[3]}`, group || heading]);
      stats.ranges++;
      continue;
    }
    out.push([q, raw, unit, item, group || heading]);
  }
  return out;
}

/** One library row [id, title, cats, yq, yu, yr, ings, dir, tags], cleaned. */
export function cleanRow(row) {
  const r = [...row];
  r[6] = cleanIngredients(row[6] || []);
  const t = tidyDirections(row[7] || '');
  const dir = t.text + (t.credits.length ? `\n\nSource: ${t.credits.join('; ')}` : '');
  if (dir !== (row[7] || '')) stats.methods++;
  if (t.credits.length) stats.credits++;
  r[7] = dir;
  const tags = [...(row[8] || [])].filter((x) => x !== NEEDS_WORK);
  if (!r[6].length || t.text.trim().length < 40) { tags.push(NEEDS_WORK); stats.needsWork++; }
  r[8] = tags;
  return r;
}

const indexRow = (row) => [row[0], row[1], row[2], [...new Set(row[6].map((i) => itemName(i[3])).filter(Boolean))]];

function main() {
  const corePath = path.join(DATA, 'recipes.json');
  const core = JSON.parse(fs.readFileSync(corePath, 'utf8'));
  const { v: oldVersion } = JSON.parse(fs.readFileSync(path.join(DATA, 'more.json'), 'utf8'));
  const oldDir = path.join(DATA, 'more', oldVersion);
  let more = [];
  for (const f of fs.readdirSync(oldDir).sort()) {
    if (f.endsWith('.json') && f !== 'index.json') more.push(...JSON.parse(fs.readFileSync(path.join(oldDir, f), 'utf8')).recipes);
  }
  const coreRows = core.recipes.map(cleanRow);
  more = more.map(cleanRow).sort((a, b) => (a[1].toLowerCase() < b[1].toLowerCase() ? -1 : a[1].toLowerCase() > b[1].toLowerCase() ? 1 : 0));
  console.log(`${coreRows.length.toLocaleString()} built-in and ${more.length.toLocaleString()} on-demand recipes`);
  console.log(`methods tidied ${stats.methods}, with a source kept ${stats.credits}; ingredient headings ${stats.headings}, `
    + `alternatives joined ${stats.alternatives}, ranges mended ${stats.ranges}, empty lines dropped ${stats.empty}; `
    + `tagged ${NEEDS_WORK} ${stats.needsWork}`);
  if (DRY) return;

  const dump = (o) => JSON.stringify(o);
  fs.writeFileSync(corePath, dump({ v: core.v ?? 1, recipes: coreRows }));
  // the version names the folder, and phones keep a folder's files for good, so a change needs a new one
  const version = createHash('sha1').update(dump(more)).digest('hex').slice(0, 8);
  const out = path.join(DATA, 'more', version);
  fs.rmSync(path.join(DATA, 'more'), { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const listed = more.filter((r) => !r[8].includes(NEEDS_WORK) && !r[8].includes('duplicate'));   // copies: tools/polish_library.py
  fs.writeFileSync(path.join(out, 'index.json'), dump({ v: version, recipes: listed.map(indexRow) }));
  const shards = new Map();
  for (const row of more) {
    if (!shards.has(row[0].slice(0, 2))) shards.set(row[0].slice(0, 2), []);
    shards.get(row[0].slice(0, 2)).push(row);
  }
  for (const [prefix, group] of shards) fs.writeFileSync(path.join(out, `${prefix}.json`), dump({ recipes: group }));
  fs.writeFileSync(path.join(DATA, 'more.json'), dump({ v: version, count: listed.length }));
  console.log(`wrote recipes.json and more/${version} (${listed.length.toLocaleString()} listed, ${shards.size} files)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
