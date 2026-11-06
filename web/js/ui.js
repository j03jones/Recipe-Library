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
  camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.5"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  timer: '<circle cx="12" cy="13.5" r="7"/><path d="M12 10v3.8l2.4 1.4M9.5 3h5M12 3v3.5"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.6" cy="6" r=".9"/><circle cx="4.6" cy="12" r=".9"/><circle cx="4.6" cy="18" r=".9"/>',
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
let changed = () => {};
/** Called after the star list changes on this device (used to sync it to the account). */
export const onStarsChange = (fn) => { changed = fn; };
export function toggleStar(id) {
  const s = load();
  if (s.has(id)) s.delete(id); else s.add(id);
  save();
  changed();
  return s.has(id);
}
export function replaceStars(ids) {
  stars = new Set(ids.filter((id) => typeof id === 'string'));
  save();
}
export const starIds = () => [...load()];
export function addStars(ids) {
  const s = load();
  ids.forEach((id) => typeof id === 'string' && s.add(id));
  save();
  changed();
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


// ------------------------------------------------------------------ ridge art, motion, feedback

/** The website's contour lines. `tall` is the home-page version; the other is for page headers.
 *  The clay line draws itself once when the page opens. */
export function ridge(tall = false) {
  const wrap = document.createElement('span');
  wrap.innerHTML = tall
    ? `<svg class="ridge" viewBox="0 0 1200 200" preserveAspectRatio="none" aria-hidden="true" focusable="false">
  <path d="M0 150 C 180 96, 330 88, 520 118 S 860 176, 1200 104" stroke="#F4F1EA" stroke-opacity=".10" stroke-width="1.5"/>
  <path d="M0 168 C 200 118, 360 112, 560 136 S 900 190, 1200 126" stroke="#F4F1EA" stroke-opacity=".14" stroke-width="1.5"/>
  <path d="M0 184 C 210 142, 380 138, 590 156 S 930 200, 1200 150" stroke="#F4F1EA" stroke-opacity=".18" stroke-width="1.5"/>
  <path d="M0 132 C 170 72, 320 60, 500 98 S 830 160, 1200 80" stroke="#F4F1EA" stroke-opacity=".08" stroke-width="1.5"/>
  <path class="draw" d="M0 120 C 160 52, 300 42, 480 82 S 800 148, 1200 58" stroke="#C8693E" stroke-width="2.5"/>
</svg>`
    : `<svg class="ridge" viewBox="0 0 1200 80" preserveAspectRatio="none" aria-hidden="true" focusable="false">
  <path d="M0 62 C 200 30, 360 26, 560 44 S 900 78, 1200 40" stroke="#F4F1EA" stroke-opacity=".14" stroke-width="1.5"/>
  <path d="M0 74 C 210 46, 380 44, 590 58 S 930 82, 1200 58" stroke="#F4F1EA" stroke-opacity=".10" stroke-width="1.5"/>
  <path class="draw" d="M0 50 C 160 18, 300 12, 480 32 S 800 66, 1200 22" stroke="#C8693E" stroke-width="2"/>
</svg>`;
  return wrap.firstElementChild;
}

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** A short buzz on phones that support it (Android; iPhones ignore it). */
export function buzz(ms = 10) { try { if (!reduced()) navigator.vibrate?.(ms); } catch { /* unsupported */ } }

/** A burst of confetti in the brand colours, from the middle of `from` (or the screen). */
export function confetti(from) {
  if (reduced()) return;
  const box = document.createElement('div');
  box.className = 'confetti';
  box.setAttribute('aria-hidden', 'true');
  const r = from?.getBoundingClientRect?.();
  const x = r ? r.left + r.width / 2 : innerWidth / 2;
  const y = r ? r.top + r.height / 2 : innerHeight * 0.45;
  const colors = ['#C8693E', '#E9C9B4', '#23402F', '#F6C25B', '#4FA37A', '#A84A24'];
  for (let i = 0; i < 36; i++) {
    const p = document.createElement('i');
    const a = Math.random() * Math.PI * 2;
    const d = 80 + Math.random() * 170;
    p.style.cssText = `left:${x}px;top:${y}px;background:${colors[i % colors.length]};` +
      `--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d - 90}px;--rot:${Math.random() * 720 - 360}deg;` +
      `animation-delay:${Math.random() * 60}ms;width:${5 + Math.random() * 6}px;height:${8 + Math.random() * 8}px`;
    box.append(p);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 1700);
}

/** Time of day greeting for the home page. */
export function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 5 ? 'Late night in the kitchen' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
