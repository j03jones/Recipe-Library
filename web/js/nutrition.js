// Nutrition and food cost for a recipe. Pure functions, no DOM (tested in Node).
//
// Each ingredient line is recognised against the table in nutridata.js, turned into grams (from its
// weight, its volume with the food's weight per cup, or a count of pieces), then
//   nutrition = grams x the food's values per 100 g
//   cost      = amount x the price you entered, in whatever unit you buy it by
// Anything that cannot be worked out (no amount, an unknown food, "1 jar") is listed as not counted
// instead of being guessed, and the totals say how much of the recipe they cover. Two things are
// estimated rather than skipped: a whole fruit or vegetable ("2 onions", "1 head cabbage", "12 Each garlic
// cloves") weighs a typical one, and a plain "can" is a standard 15 oz can (a can with its size written in,
// "can (15 oz)", uses that size).
import { FOODS, FREE } from './nutridata.js';
import { itemKey, itemName } from './shopping.js';
import { parseRange } from './units.js';

const ML = { tsp: 4.929, Tbsp: 14.787, 'fl oz': 29.574, cup: 236.588, pint: 473.176, quart: 946.353, gallon: 3785.41, ml: 1, dl: 100, l: 1000 };
const GRAMS = { oz: 28.3495, lb: 453.592, g: 1, kg: 1000 };
const CUP_ML = 236.588;
const SIZES = { small: 0.75, medium: 1, large: 1.25 };
const TINY = { pinch: 0.4, dash: 0.6, drop: 0.05 };          // grams: they barely count, but they are not "unknown"
const PIECES = new Set(['', 'piece', 'head', 'small', 'medium', 'large']);
// how kitchens write "one of them": "Each", "Ea", "whole", "pcs"...
const PIECE_WORDS = new Set(['each', 'ea', 'whole', 'pc', 'pcs', 'piece', 'pieces', 'ct', 'count', 'item', 'items', 'unit', 'units']);
const PLURAL_UNITS = { leaves: 'leaf', heads: 'head', bunches: 'bunch', stalks: 'stalk', ribs: 'rib', sprigs: 'sprig', ears: 'ear', cobs: 'cob',
  slices: 'slice', cloves: 'clove', wedges: 'wedge', inches: 'inch', knobs: 'knob', bulbs: 'bulb', crowns: 'crown', florets: 'floret', sticks: 'stick', cans: 'can' };
const CAN_G = 425;                                            // a standard 15 oz can, when the line doesn't say
// "can (15 oz)", "15-oz can", "(28 oz) cans", "can, 400 g": a container with its size written in
const SIZED = /^(?:\(?\s*(\d+(?:\.\d+)?)\s*-?\s*(oz|ounces?|g|grams?|kg|lb|lbs|ml|l|fl\.? ?oz)\.?\s*\)?\s*)?(can|cans|tin|tins|jar|jars|package|packages|pkg|bag|bags|box|boxes|carton|cartons|bottle|bottles|container|containers)\b[\s,]*(?:\(?\s*(\d+(?:\.\d+)?)\s*-?\s*(oz|ounces?|g|grams?|kg|lb|lbs|ml|l|fl\.? ?oz)\.?\s*\)?)?$/i;
const SIZE_UNIT = { oz: ['g', 28.3495], ounce: ['g', 28.3495], ounces: ['g', 28.3495], g: ['g', 1], gram: ['g', 1], grams: ['g', 1], kg: ['g', 1000],
  lb: ['g', 453.592], lbs: ['g', 453.592], ml: ['ml', 1], l: ['ml', 1000], 'fl oz': ['ml', 29.574], 'fl. oz': ['ml', 29.574], floz: ['ml', 29.574] };

// ---- recognising the food in an ingredient line
const table = new Map();                                      // folded name -> entry
for (const [name, kcal, protein, carbs, fat, sodium, cup, each, units] of FOODS) {
  // the first entry for a name wins: the shopping-list tidy folds "diced tomato" into "tomato", and the fresh one
  // (listed first) must not be replaced by the canned one
  if (!table.has(itemKey(name))) table.set(itemKey(name), { term: itemKey(name), name, kcal, protein, carbs, fat, sodium, cup, each, units });
}
const FREE_KEYS = new Set(FREE.map(itemKey));

/** { key, entry } for an ingredient name. `key` is what prices are saved under: the food's name when it
 *  is recognised ("Onions; chopped" and "chopped onion" are both "onion"), else the line's own name. */
export function identify(item) {
  const words = itemKey(item).split(' ').filter(Boolean);
  let best = null;                                            // [size, end position, entry]
  for (let size = Math.min(3, words.length); size > 0; size--) {
    for (let start = 0; start + size <= words.length; start++) {
      const e = table.get(words.slice(start, start + size).join(' '));
      if (e && (!best || size > best[0] || (size === best[0] && start + size > best[1]))) best = [size, start + size, e];
    }
    if (best) break;                                          // a longer name beats any shorter one
  }
  if (best) return { key: best[2].term, entry: best[2] };
  return { key: words.join(' '), entry: null };
}

/** The amount of an ingredient as a number (the middle of a range like "2-3"), or null ("to taste"). */
export function amountOf(ing) {
  if (ing.q != null) return ing.q.toNumber();
  if (ing.raw) {
    const r = parseRange(ing.raw);
    if (r) return (r[0].toNumber() + r[1].toNumber()) / 2;
  }
  return null;
}

/** What one ingredient line weighs or measures: { g, ml, n } with whatever can be worked out (else null). */
export function measure(ing, entry) {
  const q = amountOf(ing);
  if (q == null || !(q > 0)) return null;
  const raw = String(ing.unit || '').trim();
  const lower = raw.toLowerCase().replace(/\.$/, '');
  // "Each" and friends are pieces; "heads", "bunches" are their singular; the known units keep their spelling (Tbsp)
  const unit = PIECE_WORDS.has(lower) ? 'piece' : Object.hasOwn(PLURAL_UNITS, lower) ? PLURAL_UNITS[lower]
    : Object.hasOwn(GRAMS, raw) || Object.hasOwn(ML, raw) ? raw : lower;
  const sized = SIZED.exec(raw);
  let g = null, ml = null, n = null;
  if (sized && (sized[1] || sized[4])) {
    const [kind, per] = SIZE_UNIT[(sized[2] || sized[5]).toLowerCase().replace(/\s+/g, ' ')] || [];
    if (!kind) return null;
    const size = Number(sized[1] || sized[4]) * per;
    if (kind === 'g') g = q * size; else ml = q * size;
  } else if (sized && /^(can|cans|tin|tins)$/i.test(sized[3])) g = q * (entry?.units?.can || CAN_G);
  else if (Object.hasOwn(GRAMS, unit)) g = q * GRAMS[unit];
  else if (Object.hasOwn(ML, unit)) ml = q * ML[unit];
  else if (entry && Object.hasOwn(entry.units, unit)) g = q * entry.units[unit];
  else if (Object.hasOwn(TINY, unit)) g = q * TINY[unit];
  else if (PIECES.has(unit)) {
    n = q * (Object.hasOwn(SIZES, unit) ? SIZES[unit] : 1);
    if (entry && entry.each) g = n * entry.each;
  } else return null;
  if (g == null && ml != null && entry && entry.cup) g = (ml / CUP_ML) * entry.cup;
  if (ml == null && g != null && entry && entry.cup) ml = (g / entry.cup) * CUP_ML;
  if (n == null && g != null && entry && entry.each) n = g / entry.each;
  return { g, ml, n };
}

// ---- nutrition
export const NUTRIENTS = [['kcal', 'Calories', ''], ['fat', 'Fat', 'g'], ['carbs', 'Carbs', 'g'], ['protein', 'Protein', 'g'], ['sodium', 'Sodium', 'mg']];

/** Totals for the whole recipe as written (scale the recipe first to get a scaled total), and per serving. */
export function nutrition(recipe) {
  const total = { kcal: 0, fat: 0, carbs: 0, protein: 0, sodium: 0 };
  const counted = [];
  const skipped = [];
  const parts = [];                                           // what each counted line adds, for "where it comes from"
  for (const ing of recipe.ings) {
    const { key, entry } = identify(ing.item);
    if (FREE_KEYS.has(key) && !(entry && entry.kcal)) continue;     // water, ice: nothing to count
    const m = amountOf(ing) == null ? null : measure(ing, entry);
    if (!entry || !m || m.g == null) { skipped.push({ ing, why: !entry ? 'unknown food' : amountOf(ing) == null ? 'no amount' : 'cannot be weighed' }); continue; }
    const k = m.g / 100;
    const part = { ing, name: entry.name, g: m.g };
    for (const f of Object.keys(total)) { part[f] = k * entry[f]; total[f] += part[f]; }
    parts.push(part);
    counted.push(ing);
  }
  const yq = recipe.yq ? recipe.yq.toNumber() : 0;
  const servings = yq > 0 ? yq : 0;
  const per = servings ? Object.fromEntries(Object.entries(total).map(([f, v]) => [f, v / servings])) : null;
  const lines = counted.length + skipped.length;
  return { total, per, servings, counted: counted.length, skipped, lines, coverage: lines ? counted.length / lines : 0, parts };
}

/** Reference daily values for a 2,000-calorie diet (the ones US labels use). */
export const DAILY = { kcal: 2000, fat: 78, carbs: 275, protein: 50, sodium: 2300 };
/** Calories in a gram of each macronutrient. */
export const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 };

/**
 * How the calories split between protein, carbs and fat: { protein: { g, kcal, pct }, carbs, fat }, the percentages
 * of the calories the three account for (adding up to 100), or null when there are none.
 */
export function macroSplit(values) {
  const out = {};
  let sum = 0;
  for (const [f, per] of Object.entries(KCAL_PER_G)) { const g = Math.max(0, values?.[f] || 0); out[f] = { g, kcal: g * per }; sum += g * per; }
  if (!(sum > 0)) return null;
  for (const f of Object.keys(KCAL_PER_G)) out[f].pct = (out[f].kcal / sum) * 100;
  return out;
}

/** % of the daily value, rounded, or null. */
export const dailyPct = (f, v) => (DAILY[f] && v != null ? Math.round((v / DAILY[f]) * 100) : null);

// ---- cost
/** The ways a price can be given: what a price per X is measured in. */
export const PRICE_UNITS = {
  lb: { label: 'lb', kind: 'g', size: 453.592 }, oz: { label: 'oz', kind: 'g', size: 28.3495 },
  kg: { label: 'kg', kind: 'g', size: 1000 }, g: { label: 'g', kind: 'g', size: 1 },
  gallon: { label: 'gallon', kind: 'ml', size: 3785.41 }, quart: { label: 'quart', kind: 'ml', size: 946.353 },
  l: { label: 'liter', kind: 'ml', size: 1000 }, cup: { label: 'cup', kind: 'ml', size: CUP_ML },
  each: { label: 'each', kind: 'n', size: 1 }, dozen: { label: 'dozen', kind: 'n', size: 12 },
};

const LIQUID = /\b(oil|milk|cream|broth|stock|juice|wine|vinegar|sauce|syrup|water|beer|honey|molasses)\b/;
/** The sensible price unit to start with for an ingredient line. */
export function defaultPriceUnit(ing, entry) {
  const u = ing.unit || '';
  if (Object.hasOwn(GRAMS, u)) return u === 'g' || u === 'kg' ? 'kg' : 'lb';
  if (Object.hasOwn(ML, u)) return !entry || LIQUID.test(entry.term) ? 'quart' : 'lb';
  return !entry || entry.each ? 'each' : 'lb';
}

/** What one ingredient line costs at a saved price { p, per }; null if the amounts cannot be matched. */
export function lineCost(ing, entry, price) {
  if (!price || !(price.p >= 0) || !Object.hasOwn(PRICE_UNITS, price.per)) return null;
  const m = measure(ing, entry);
  if (!m) return null;
  const pu = PRICE_UNITS[price.per];
  const amount = m[pu.kind];
  return amount == null ? null : (amount / pu.size) * price.p;
}

/**
 * Cost of a recipe: `prices` is { [key]: { p, per } }. Returns each line's cost (or why not), the total of
 * what could be costed, and which lines still need a price.
 */
export function costing(recipe, prices) {
  const lines = [];
  let total = 0;
  let missing = 0;
  for (const ing of recipe.ings) {
    const { key, entry } = identify(ing.item);
    const free = FREE_KEYS.has(key);
    const price = prices && Object.hasOwn(prices, key) ? prices[key] : null;
    const hasAmount = amountOf(ing) != null;
    let cost = null;
    let state;
    if (free) state = 'free';
    else if (!hasAmount) state = 'noamount';
    else if (!price) { state = 'noprice'; missing++; }
    else {
      cost = lineCost(ing, entry, price);
      if (cost == null) { state = 'noconvert'; missing++; } else { state = 'ok'; total += cost; }
    }
    lines.push({ ing, key, entry, price, cost, state });
  }
  const yq = recipe.yq ? recipe.yq.toNumber() : 0;
  const servings = yq > 0 ? yq : 0;
  return { lines, total, servings, perServing: servings ? total / servings : null, missing, complete: missing === 0 };
}

/** Menu price that gives a target food cost % ("30" = cost is 30% of the price). */
export const suggestedPrice = (costPerServing, targetPct) => (targetPct > 0 ? costPerServing / (targetPct / 100) : null);
/** Food cost % at a menu price. */
export const foodCostPct = (costPerServing, price) => (price > 0 ? (costPerServing / price) * 100 : null);

export { itemName };
