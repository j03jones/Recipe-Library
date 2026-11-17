// The Macronutrients section, shared by the recipe app's Nutrition card (costui.js), the restaurant pages and the
// meal prep client's dishes (web/portal/). It only draws: the numbers come from nutrition.js. `h` is the page's own
// element helper (both the app's and the portal's take (tag, attrs, ...children)).
import { DAILY, NUTRIENTS, dailyPct, macroSplit } from './nutrition.js';
import { formatIngredient } from './units.js';

const n0 = (v) => Math.round(v).toLocaleString();
const g1 = (v) => (v < 10 ? (Math.round(v * 10) / 10).toString() : n0(v));
const pctText = (v) => `${Math.round(v)}%`;
const MACRO = [['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']];
const ROWS = [['kcal', 'Calories', ''], ['protein', 'Protein', 'g'], ['carbs', 'Carbohydrates', 'g'], ['fat', 'Fat', 'g'], ['sodium', 'Sodium', 'mg']];
const amount = (f, v, unit) => (v == null ? '—' : `${f === 'kcal' || f === 'sodium' ? n0(v) : g1(v)}${unit ? ` ${unit}` : ''}`);

/** The five figures (calories, fat, carbs, protein, sodium) as tiles. */
export function nutrientTiles(h, values, cls = 'nstats') {
  return h('div', { class: cls }, NUTRIENTS.map(([f, label, unit]) =>
    h('div', null, h('strong', null, f === 'kcal' || f === 'sodium' ? n0(values[f] || 0) : g1(values[f] || 0), unit && h('em', null, unit)), h('span', null, label.toLowerCase()))));
}

/**
 * <details> "Macronutrients": calories by protein, carbs and fat; a table with % Daily Value; and, when the
 * ingredients' shares are given, where the calories come from. Null when there are no calories to split.
 *   per      values per serving (or null)        total   values for the whole recipe (or null)
 *   servings how many servings `per` is one of     parts   nutrition().parts, for "Where it comes from" (optional)
 *   open     start open                             onToggle(open) remembers it across repaints
 *   quiet    the class for small grey text on this page (the portal's is 'note')
 */
export function macroDetails(h, { per = null, total = null, servings = 0, parts = [], open = false, onToggle = null, cls = '', quiet = 'muted small' } = {}) {
  const shown = per || total;
  const split = macroSplit(shown);
  if (!split) return null;
  const div = per && servings ? servings : 1;
  const top = [...parts].sort((a, b) => b.kcal - a.kcal).slice(0, 8);
  const box = h('details', { class: `macros ${cls}`.trim(), open: open || null },
    h('summary', null, h('strong', null, 'Macronutrients'),
      h('span', { class: quiet }, MACRO.map(([f, label]) => `${label} ${pctText(split[f].pct)}`).join(' · '))),
    h('p', { class: quiet }, 'Share of calories from each, ', per ? 'per serving' : 'for the whole recipe', ':'),
    h('div', { class: 'macrobar', role: 'img', 'aria-label': MACRO.map(([f, label]) => `${label} ${pctText(split[f].pct)} of calories`).join(', ') },
      MACRO.map(([f]) => split[f].pct > 0 && h('span', { class: `m-${f}`, style: `width:${split[f].pct.toFixed(2)}%` }))),
    h('ul', { class: 'macrolegend' }, MACRO.map(([f, label]) => h('li', null, h('i', { class: `m-${f}`, 'aria-hidden': 'true' }),
      h('strong', null, label), ` ${g1(split[f].g)} g · ${pctText(split[f].pct)} of calories`))),
    h('div', { class: 'tablewrap' }, h('table', { class: 'macrotable' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Nutrient'), per && h('th', { scope: 'col' }, 'Per serving'),
        total && h('th', { scope: 'col' }, 'Whole recipe'), h('th', { scope: 'col' }, '% Daily Value'))),
      h('tbody', null, ROWS.map(([f, label, unit]) => h('tr', null,
        h('th', { scope: 'row' }, label),
        per && h('td', null, amount(f, per[f], unit)),
        total && h('td', null, amount(f, total[f], unit)),
        h('td', null, dailyPct(f, shown[f]) != null ? `${dailyPct(f, shown[f])}%` : '')))))),
    h('p', { class: quiet }, `% Daily Value: how much of a day's intake ${per ? 'one serving' : 'the whole recipe'} gives, on a 2,000-calorie diet (fat ${DAILY.fat} g, carbohydrates ${DAILY.carbs} g, protein ${DAILY.protein} g, sodium ${n0(DAILY.sodium)} mg).`),
    top.length > 0 && [h('h4', null, 'Where it comes from'),
      h('div', { class: 'tablewrap' }, h('table', { class: 'macrotable sources' },
        h('thead', null, h('tr', null, ['Ingredient', 'Calories', 'Protein', 'Carbs', 'Fat'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, top.map((p) => h('tr', null,
          h('th', { scope: 'row' }, formatIngredient(p.ing)),
          h('td', null, n0(p.kcal / div)), h('td', null, `${g1(p.protein / div)} g`), h('td', null, `${g1(p.carbs / div)} g`), h('td', null, `${g1(p.fat / div)} g`)))))),
      h('p', { class: quiet }, per ? 'Per serving. ' : 'Whole recipe. ', parts.length > top.length ? `The ${top.length} biggest of ${parts.length} counted ingredients.` : '')]);
  if (onToggle) box.addEventListener('toggle', () => onToggle(box.open));
  return box;
}
