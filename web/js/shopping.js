// Shopping list: the ingredients of several recipes combined into one list.
// combine() and friends are a line-by-line port of recipelib/shopping.py (pure functions, tested
// against it in tests/test_shopping.py). The saved list at the bottom lives on this device.
import { Frac, displayUnit, formatIngredient, formatQuantity, promoteUnit, scaleRecipe } from './units.js';

const F = (n, d = 1) => new Frac(BigInt(n), BigInt(d));

// unit -> [family, how many of the family's base unit it is]
const FAMILIES = {
  tsp: ['volume', F(1)], Tbsp: ['volume', F(3)], 'fl oz': ['volume', F(6)], cup: ['volume', F(48)],
  pint: ['volume', F(96)], quart: ['volume', F(192)], gallon: ['volume', F(768)],
  oz: ['weight', F(1)], lb: ['weight', F(16)],
  ml: ['metric volume', F(1)], dl: ['metric volume', F(100)], l: ['metric volume', F(1000)],
  g: ['metric weight', F(1)], kg: ['metric weight', F(1000)],
};
const FAMILY_ORDER = ['', 'volume', 'weight', 'metric volume', 'metric weight'];

const squash = (s) => s.replace(/\s+/g, ' ');

/** 'Onions; finely chopped' -> 'Onions' (the part you buy, without the preparation). */
export function itemName(item) {
  item = item.replace(/^\s*(\([^)]*\)\s*)+/, '') || item;   // "(10 oz) raspberries" -> "raspberries"
  const name = squash(item.split(/[;,(]/)[0]).replace(/^[ .-]+|[ .-]+$/g, '');
  return name || squash(item).trim();
}

/** Lower-case name with simple plurals folded, so 'Onion' and 'onions' share a line. */
export function itemKey(item) {
  return itemName(item).toLowerCase().split(' ').map((w) => {
    if (w.length > 3 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 3 && w.endsWith('oes')) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  }).join(' ');
}

/** The friendliest unit for a family total (given in the family's base unit). */
function display(family, total) {
  if (family === 'volume') {
    if (total.cmp(F(768)) >= 0) return [total.div(F(192)), 'quart'];   // a gallon or more: quarts read better than 64 cups
    const [q, unit] = promoteUnit(total, 'tsp');
    if (unit === 'tsp' && total.cmp(F(12)) >= 0) return [total.div(F(48)), 'cup'];   // nothing reads nicely: still cups
    if (unit === 'tsp' && total.cmp(F(3)) >= 0) return [total.div(F(3)), 'Tbsp'];
    return [q, unit];
  }
  if (family === 'weight') return total.cmp(F(16)) >= 0 ? [total.div(F(16)), 'lb'] : [total, 'oz'];
  if (family === 'metric volume') return total.cmp(F(1000)) >= 0 ? [total.div(F(1000)), 'l'] : [total, 'ml'];
  if (family === 'metric weight') return total.cmp(F(1000)) >= 0 ? [total.div(F(1000)), 'kg'] : [total, 'g'];
  return [total, family.slice(1)];   // "=can" -> "can"; "" -> no unit
}

const cmpText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const lineText = (line) => {
  const parts = [...line.amounts, ...line.notes];
  return parts.length ? `${line.name}: ${parts.join(' + ')}` : line.name;
};

/** One line per ingredient across the given (already scaled) recipes, sorted by name. */
export function combine(recipes) {
  const lines = new Map();
  const totals = new Map();
  for (const recipe of recipes) {
    for (const ing of recipe.ings) {
      const key = itemKey(ing.item);
      if (!key) continue;
      let line = lines.get(key);
      if (!line) {
        const name = itemName(ing.item);
        line = { key, name: name.slice(0, 1).toUpperCase() + name.slice(1), amounts: [], notes: [], recipes: [] };
        lines.set(key, line);
        totals.set(key, new Map());
      }
      if (!line.recipes.includes(recipe.title)) line.recipes.push(recipe.title);
      if (ing.q != null) {
        const [family, per] = Object.hasOwn(FAMILIES, ing.unit) ? FAMILIES[ing.unit] : ['=' + ing.unit, F(1)];
        const t = totals.get(key);
        t.set(family, (t.get(family) || F(0)).add(ing.q.mul(per)));
      } else if (ing.raw) {
        line.notes.push(formatIngredient({ q: null, raw: ing.raw, unit: ing.unit, item: '' }));
      }
    }
  }
  const order = (family) => (FAMILY_ORDER.includes(family) ? FAMILY_ORDER.indexOf(family) : FAMILY_ORDER.length);
  for (const [key, line] of lines) {
    const t = totals.get(key);
    const families = [...t.keys()].sort((a, b) => order(a) - order(b) || cmpText(a, b));
    for (const family of families) {
      const [q, unit] = display(family === '=' ? '' : family, t.get(family));
      line.amounts.push(`${formatQuantity(q)} ${displayUnit(unit, q)}`.trim());
    }
    line.text = lineText(line);
  }
  return [...lines.values()].sort((a, b) => cmpText(a.name.toLowerCase(), b.name.toLowerCase()) || cmpText(a.key, b.key));
}

/** picks: [[recipe, factor Frac], ...] */
export function shoppingList(picks) {
  return combine(picks.map(([r, f]) => (f.eq(F(1)) ? r : scaleRecipe(r, f).recipe)));
}

export const toText = (lines) => lines.map((l) => `[ ] ${l.text}`).join('\n');

// ------------------------------------------------------------ the saved list
// { items: [{ id, f }], done: [line keys] }  (f is the scale factor as text, e.g. "3/2")

const KEY = 'recipelib.shop';

export function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    const items = Array.isArray(v?.items) ? v.items.filter((i) => i && typeof i.id === 'string') : [];
    return { items: items.map((i) => ({ id: i.id, f: Frac.parse(i.f || '1') ? String(i.f || '1') : '1' })),
      done: Array.isArray(v?.done) ? v.done.filter((k) => typeof k === 'string') : [] };
  } catch { return { items: [], done: [] }; }
}

export function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; }
}

export const has = (id) => load().items.some((i) => i.id === id);

/** Add a recipe (or change its scale if it is already on the list). */
export function add(id, factor) {
  const list = load();
  const f = String(factor);
  const at = list.items.find((i) => i.id === id);
  if (at) at.f = f; else list.items.push({ id, f });
  return save(list);
}

export function remove(id) {
  const list = load();
  list.items = list.items.filter((i) => i.id !== id);
  if (!list.items.length) list.done = [];
  return save(list);
}

export function setDone(key, done) {
  const list = load();
  list.done = list.done.filter((k) => k !== key);
  if (done) list.done.push(key);
  return save(list);
}

export const clear = () => save({ items: [], done: [] });
