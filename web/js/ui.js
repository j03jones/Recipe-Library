// Small presentation helpers: icons, the emoji "photo" tile for each category, and starred recipes.
import { SECTIONS } from './groups.js';

const ICON_PATHS = {
  book: '<path d="M5 4.5h9a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3z"/><path d="M17 8h2v12h-2"/><path d="M9 9h5M9 12.5h4"/>',
  star: '<path d="m12 3.6 2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 17l-5.3 2.8 1.1-5.9L3.5 9.8l5.9-.8z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  sun: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>',
  minus: '<path d="M6 12h12"/>',
  more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
};

export function icon(name, { size = 24, fill = false } = {}) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'ico');
  s.setAttribute('fill', fill ? 'currentColor' : 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = ICON_PATHS[name] || '';
  return s;
}

// ----------------------------------------------------------------- category tiles

const EMOJI = {
  'Appetizers & Snacks': '🥟', 'Soups & Stews': '🍲', 'Salads & Dressings': '🥗', 'Breakfast & Brunch': '🍳',
  'Main Dishes': '🍽️', 'Vegetables & Sides': '🥦', 'Pasta, Rice & Grains': '🍝', 'Breads & Baking': '🍞',
  'Sauces & Condiments': '🥫', 'Beverages & Cocktails': '🍹',
  'Desserts': '🍨', 'Cakes': '🍰', 'Cookies & Bars': '🍪', 'Pies & Pastries': '🥧', 'Candy & Chocolate': '🍫',
  'Meats': '🥩', 'Beef': '🍖', 'Pork': '🥓', 'Poultry': '🍗', 'Seafood': '🦐', 'Eggs & Cheese': '🧀', 'Fruit': '🍓',
  'Vegetarian & Vegan': '🌱', 'Light & Special Diets': '🥒',
  'Mexican & Southwestern': '🌮', 'Italian': '🍕', 'Asian & Indian': '🍜', 'Cajun & Creole': '🌶️',
  'British, Irish & Canadian': '🫖', 'German & Pennsylvania Dutch': '🥨', 'Other World Cuisines': '🌍',
  'Quick & Easy': '⚡', 'Microwave & Slow Cooker': '🥘', 'Grill & BBQ': '🔥', 'Holidays & Entertaining': '🎉',
  'Uncategorized': '🍽️',
};
// Broad groups say less about the dish than a specific one, so a specific group wins the tile.
const BROAD = new Set(['Main Dishes', 'Desserts', 'Meats', 'Uncategorized', 'Quick & Easy', 'Holidays & Entertaining',
  'Light & Special Diets', 'Vegetarian & Vegan', 'Other World Cuisines', 'Microwave & Slow Cooker']);

// Tile colours cycle through 7 hues by group, so neighbouring kinds of dish look different.
const HUE_OF = new Map();
SECTIONS.flatMap(([, groups]) => groups).forEach((g, i) => HUE_OF.set(g, i % 7));

export const emojiFor = (group) => EMOJI[group] || '🍽️';
export const hueIndex = (group) => (HUE_OF.has(group) ? HUE_OF.get(group) : 6);

export function primaryGroup(categories) {
  const known = categories.filter((c) => EMOJI[c]);
  return known.find((c) => !BROAD.has(c)) || known[0] || '';
}

/** An emoji on a soft colour square: stands in for a photo (the recipes have none). */
export function tile(categories, big = false) {
  const g = primaryGroup(categories);
  const el = document.createElement('span');
  el.className = big ? 'tile big' : 'tile';
  el.dataset.sec = hueIndex(g);
  el.setAttribute('aria-hidden', 'true');
  el.textContent = emojiFor(g);
  return el;
}

// ------------------------------------------------------------------------ stars
// Kept in localStorage: a per-device convenience that is also included in backups.

const KEY = 'recipelib.stars';
let stars = null;

function load() {
  if (stars) return stars;
  try { stars = new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { stars = new Set(); }
  return stars;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify([...stars])); } catch { /* private mode: stars last until reload */ }
}
export const isStarred = (id) => load().has(id);
export function toggleStar(id) {
  const s = load();
  if (s.has(id)) s.delete(id); else s.add(id);
  save();
  return s.has(id);
}
export const starIds = () => [...load()];
export function addStars(ids) {
  const s = load();
  ids.forEach((id) => typeof id === 'string' && s.add(id));
  save();
}

/** Copy text. Uses the modern clipboard API, and falls back to the older method that also works on pages
 *  without https (such as a custom domain whose certificate is still being set up). Returns true on success. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}
