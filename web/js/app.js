import {
  Frac, UNIT_CHOICES, adaptedLine, amountForEditing, creditLine, factorForServings, formatIngredient, formatYield,
  ingredientFromFields, parseYield, recipeToText, scaleRecipe, splitCategories,
} from './units.js';
import { fromRecord, fromRow, hasSource, isAdapted, toRecord } from './model.js';
import { COLLECTIONS } from './linkdata.js';
import { MAX_OVERLAP, VEGAN_GROUP, recipeFromSchema, wordingOverlap } from './webimport.js';
import * as store from './store.js';
import { SECTIONS } from './groups.js';
import { addStars, copyText, emojiFor, icon, isStarred, onStarsChange, replaceStars, starIds, tile, toggleStar } from './ui.js';
import * as cloud from './cloud.js';
import { accountCard, viewAdmin, viewJoin } from './account.js';
import * as photos from './photos.js';

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
const PAGE = 60;

// ------------------------------------------------------------------- helpers

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  const props = {};
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'disabled', 'selected'].includes(k)) props[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  Object.assign(el, props); // after children, so <select> values stick
  return el;
}

// Like el.replaceChildren(), but skips null/false/'' and flattens arrays (the DOM method would
// turn those into the text "null" or "false").
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== ''));
}

let toastTimer;
function toast(msg, ms = 2600) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), ms);
}

/** A message with one OK button (sign-in / sign-up confirmations and the like). */
function infoDialog(title, message, okLabel = 'OK') {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'infodialog', 'aria-labelledby': 'dlg-title' },
      h('h2', { id: 'dlg-title' }, title),
      message && h('p', null, message),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => dlg.close() }, okLabel)));
    dlg.addEventListener('close', () => { resolve(); dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

function confirmDialog(message, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    const dlg = h('dialog', null,
      h('p', null, message),
      h('div', { class: 'row' },
        h('button', { onclick: () => dlg.close('no') }, 'Cancel'),
        h('button', { class: danger ? 'primary danger' : 'primary', onclick: () => dlg.close('yes') }, okLabel)));
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'yes'); dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

const trim0 = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
const num = (f, places) => trim0(f.toNumber().toFixed(places));

// ------------------------------------------------------------------- library

const lib = { base: [], mine: new Map(), all: [], byId: new Map(), cats: [], cloud: [], me: null, restaurants: [], syncError: '', libPhotos: {}, avatars: {} };

// ---- hosted account data (cached so it still opens offline)
const CACHE_KEY = 'recipelib.cloudcache';
function loadCloudCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    const u = cloud.currentUser();
    if (c && u && c.uid === u.id) { lib.me = c.me; lib.cloud = c.rows; lib.libPhotos = c.libPhotos || {}; lib.avatars = c.avatars || {}; }
  } catch { /* no cache */ }
}
function saveCloudCache() {
  if (!lib.me) return;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ uid: lib.me.id, me: lib.me, rows: lib.cloud, libPhotos: lib.libPhotos, avatars: lib.avatars })); } catch { /* full */ }
}
function clearCloud() {
  lib.me = null; lib.cloud = []; lib.libPhotos = {}; lib.avatars = {};
  try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
  rebuild();
}
async function refreshCloud() {
  if (!cloud.isSignedIn()) { clearCloud(); return; }
  try {
    const [me, rows] = await Promise.all([cloud.loadMe(), cloud.listRecipes()]);
    lib.me = me; lib.cloud = rows;
    try { lib.avatars = Object.fromEntries((await cloud.communityAvatars()).map((a) => [a.id, a.avatar])); } catch { /* keep the old ones */ }
    saveCloudCache();
  } catch (err) {
    if (!cloud.isSignedIn()) clearCloud();      // the session was no longer valid
    else if (!lib.me) loadCloudCache();         // offline: fall back to what we saved last time
  }
  rebuild();
  if (lib.me) await syncStars();
}

// ---- stars follow the person between devices. This device pushes its list whenever it changes.
const SYNC_KEY = 'recipelib.starsync';
const readSync = () => { try { return JSON.parse(localStorage.getItem(SYNC_KEY) || '{}'); } catch { return {}; } };
const writeSync = (v) => { try { localStorage.setItem(SYNC_KEY, JSON.stringify(v)); } catch { /* ignore */ } };
let pushTimer;
async function pushStars() {
  if (!lib.me) return;
  try {
    const row = await cloud.saveStars(starIds());
    writeSync({ uid: lib.me.id, at: row.updated_at, dirty: false });
    lib.syncError = '';
  } catch (err) { lib.syncError = err.status === 0 ? 'Offline. Will retry.' : err.message; }   // stays marked unsent; goes out next time
}
onStarsChange(() => {
  if (!lib.me) return;
  writeSync({ ...readSync(), uid: lib.me.id, dirty: true });
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushStars, 800);
});
async function syncStars() {
  try {
    const sync = readSync();
    const row = await cloud.loadUserData();
    if (row) { lib.libPhotos = row.library_photos || {}; saveCloudCache(); }
    if (sync.uid !== lib.me.id) {                         // first time this device meets this account: combine both
      if (row) addStars(row.stars);
      await pushStars();
    } else if (!row || sync.dirty) await pushStars();     // this device has unsent changes
    else if (row.updated_at !== sync.at) { replaceStars(row.stars); writeSync({ ...sync, at: row.updated_at }); }
    if (!lib.syncError || !/\boffline\b/i.test(lib.syncError)) lib.syncError = lib.syncError || '';
  } catch (err) { lib.syncError = err.status === 0 ? 'Offline. Will retry.' : err.message; }
}

const restaurantName = (id) => {
  const m = (lib.me?.memberships || []).find((x) => x.restaurant?.id === id);
  return m?.restaurant.name || lib.restaurants.find((x) => x.id === id)?.name || 'Restaurant';
};
/** Where a cloud row shows up in the app. */
function cloudSource(row) {
  const mineRow = row.owner_id === lib.me?.id;
  if (row.scope === 'restaurant') return 'collection';
  if (row.scope === 'community') return mineRow && row.status !== 'approved' ? 'shared' : 'community';
  return 'account';
}
const SOURCE_GROUP = { base: 'library', edited: 'library', mine: 'mine', account: 'mine', shared: 'mine', community: 'community', collection: 'collection' };
const canEdit = (r) => !['community', 'collection', 'shared'].includes(r.source) || lib.me?.role === 'admin';

// ---- photos: cloud recipes keep theirs in recipes.photo; built-in library recipes in the person's own list
const isLibrary = (r) => r.source === 'base' || r.source === 'edited';
const photoOf = (r) => (r.cloud ? r.row.photo : (lib.me && isLibrary(r) ? lib.libPhotos[r.id] : null)) || null;
const canPhoto = (r) => !!lib.me && cloud.isSignedIn() && (r.cloud ? (r.source === 'account' || lib.me.role === 'admin') : isLibrary(r));
/** True while any recipe or library entry still uses this file (a shared Community copy can use the same photo). */
const photoInUse = (path) => lib.cloud.some((x) => x.photo === path) || Object.values(lib.libPhotos).includes(path);
/** After a change, delete the old file if it is this person's and nothing uses it any more. */
async function tidyPhoto(path) {
  if (!path || !lib.me) return;
  const mine = path.startsWith(`recipes/${lib.me.id}/`) || path.startsWith(`library/${lib.me.id}/`);
  if (mine && !photoInUse(path)) await photos.discard([path]);
}
async function setLibraryPhotos(map) {
  await cloud.saveLibraryPhotos(map);
  lib.libPhotos = map;
  saveCloudCache();
}
async function setPhoto(r, file) {
  const old = photoOf(r);
  const path = await photos.upload(r.cloud ? 'recipes' : 'library', file);
  try {
    if (r.cloud) { await cloud.setRecipePhoto(r.id, path); await refreshCloud(); }
    else await setLibraryPhotos({ ...lib.libPhotos, [r.id]: path });
  } catch (err) { await photos.discard([path]); throw err; }
  await tidyPhoto(old);
}
async function clearPhoto(r) {
  const old = photoOf(r);
  if (r.cloud) { await cloud.setRecipePhoto(r.id, null); await refreshCloud(); }
  else { const m = { ...lib.libPhotos }; delete m[r.id]; await setLibraryPhotos(m); }
  await tidyPhoto(old);
}
// list thumbnails load only when they scroll into view
const thumbObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbObserver.unobserve(e.target);
    const el = e.target;
    photos.photoURL(el.dataset.photo).then((u) => { if (u) { el.style.backgroundImage = `url("${u}")`; el.classList.add('pic'); el.textContent = ''; } });
  }
}, { rootMargin: '300px' }) : null;
function thumb(r) {
  const t = tile(r.categories);
  const path = photoOf(r);
  if (path && thumbObserver) { t.dataset.photo = path; thumbObserver.observe(t); }
  return t;
}

function rebuild() {
  const map = new Map(lib.base.map((r) => [r.id, r]));
  for (const rec of lib.mine.values()) {
    if (rec.deleted) map.delete(rec.id);
    else map.set(rec.id, fromRecord(rec, lib.base.some((b) => b.id === rec.id) ? 'edited' : 'mine'));
  }
  for (const row of lib.cloud) {
    if (row.scope === 'private' && row.owner_id !== lib.me?.id) continue;          // admins can read these; the app never lists them
    const src = cloudSource(row);
    const r = fromRecord({ ...row.body, id: row.id, title: row.title, categories: row.categories || [] }, src);
    r.cloud = true; r.row = row;
    r.hidden = row.scope === 'community' && row.status !== 'approved' && row.owner_id !== lib.me?.id;   // pending items from others live in Admin tools
    map.set(row.id, r);
  }
  lib.byId = map;
  lib.all = [...map.values()].filter((r) => !r.hidden).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  const cats = new Map();
  for (const r of lib.all) {
    r._hay = [r.title, r.categories.join(' '), (r.tags || []).join(' '), r.ings.map((i) => i.item).join(' '), r.dir].join('\n').toLowerCase();
    r._title = r.title.toLowerCase();
    for (const c of r.categories) {
      const k = c.toLowerCase();
      if (!cats.has(k)) cats.set(k, { name: c, n: 0 });
      cats.get(k).n++;
    }
  }
  lib.cats = [...cats.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

async function saveRecord(rec) {
  await store.put(rec);
  lib.mine.set(rec.id, rec);
  rebuild();
}
async function dropRecord(id) {
  await store.remove(id);
  lib.mine.delete(id);
  rebuild();
}

function matches(q, cat, src = '') {
  const tokens = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out = [];
  for (const r of lib.all) {
    if (src && SOURCE_GROUP[r.source] !== src) continue;
    if (cat && !r.categories.some((c) => c.toLowerCase() === cat.toLowerCase())) continue;
    if (tokens.every((t) => r._hay.includes(t))) out.push(r);
  }
  if (tokens.length) { // titles that contain every word first
    const inTitle = (r) => tokens.every((t) => r._title.includes(t));
    return [...out.filter(inTitle), ...out.filter((r) => !inTitle(r))];
  }
  return out;
}

// -------------------------------------------------------------------- views

const listState = { q: '', sec: -1, cat: '', src: '', shown: PAGE, scroll: 0 };
let onScroll = null;
let releaseWake = null;

function clearView() {
  if (onScroll) { window.removeEventListener('scroll', onScroll); onScroll = null; }
  if (releaseWake) { releaseWake(); releaseWake = null; }
}

function setView(view, tab) {
  document.body.dataset.view = view;
  for (const a of document.querySelectorAll('#tabs a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

function starButton(id, onChange) {
  const btn = h('button', { class: 'star', type: 'button' });
  const paintStar = () => {
    const on = isStarred(id);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Remove from starred' : 'Star this recipe');
    fill(btn, icon('star', { size: 26, fill: on }));
  };
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const on = toggleStar(id);
    paintStar();
    if (on) { btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop'); }
    toast(on ? 'Starred' : 'Removed from starred', 1400);
    onChange?.(on);
  });
  paintStar();
  return btn;
}

function badgeText(r) {
  switch (r.source) {
    case 'mine': case 'account': return 'Mine';
    case 'community': return r.row.owner_id === lib.me?.id ? 'Shared' : 'Community';
    case 'shared': return r.row.status === 'declined' ? 'Declined' : 'Awaiting approval';
    case 'collection': return restaurantName(r.row.restaurant_id);
    default: return 'Edited';
  }
}

function viewList(starredOnly = false) {
  setView('list', starredOnly ? 'starred' : 'list');
  const input = h('input', {
    type: 'search', placeholder: 'Search recipes or ingredients',
    value: listState.q, enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Search recipes',
  });
  const counts = new Map(lib.cats.map((c) => [c.name, c.n]));
  const known = new Set(SECTIONS.flatMap(([, groups]) => groups));
  const sections = SECTIONS.map(([name, groups]) => [name, groups.filter((g) => counts.has(g)).map((g) => [g, counts.get(g)])]);
  const extra = lib.cats.filter((c) => !known.has(c.name)).map((c) => [c.name, c.n]);
  if (extra.length) {
    const other = sections.find(([name]) => name === 'Other');
    if (other) other[1].push(...extra); else sections.push(['Other', extra]);
  }
  const visible = sections.map((s, i) => [...s, i]).filter(([, rows]) => rows.length);
  if (listState.cat && listState.sec < 0) {
    const hit = visible.find(([, rows]) => rows.some(([g]) => g === listState.cat));
    if (hit) listState.sec = hit[2];
  }

  const count = h('p', { class: 'count muted small' });
  const promo = h('div');
  const paintPromo = () => {
    const cols = COLLECTIONS.filter((c) => listState.cat === c.group || (!listState.cat && visible.some(([, rows, i]) => i === listState.sec && rows.some(([g]) => g === c.group))));
    fill(promo, !starredOnly && cols.map((c) => h('a', { class: 'promo card', href: `#/links/${c.id}` },
      h('span', { class: 'tile', 'aria-hidden': 'true', 'data-sec': 2 }, '🌱'),
      h('span', null, h('strong', null, `More vegan recipes from ${c.site}`), h('span', { class: 'muted small' }, `By ${c.author}. Opens on her website.`)))));
  };
  const ul = h('ul', { class: 'rows' });
  const empty = h('div');
  const more = h('button', { class: 'more', onclick: () => { listState.shown += PAGE; paint(); } }, 'Show more');
  const groupsRow = h('div', { class: 'chips groups', role: 'group', 'aria-label': 'Categories' });
  let results = [];

  const secButtons = [];
  const allBtn = h('button', { class: 'chip', type: 'button', onclick: () => { listState.sec = -1; listState.cat = ''; listState.shown = PAGE; chipState(); paint(); } }, 'All');
  secButtons.push([-1, allBtn]);
  const secRow = h('div', { class: 'chips', role: 'group', 'aria-label': 'Kinds of recipe' }, allBtn,
    visible.map(([name, , i]) => {
      const b = h('button', { class: 'chip', type: 'button', onclick: () => {
        listState.sec = listState.sec === i ? -1 : i; listState.cat = ''; listState.shown = PAGE; chipState(); paint();
      } }, name);
      secButtons.push([i, b]);
      return b;
    }));

  const srcLabels = [['', 'Everything'], ['library', 'Library'], ['mine', 'My recipes'], ['community', 'Community']];
  if (lib.cloud.some((x) => x.scope === 'restaurant')) srcLabels.push(['collection', 'Restaurant']);
  const srcButtons = srcLabels.map(([k, label]) => [k, h('button', { class: 'chip', type: 'button', onclick: () => {
    listState.src = k; listState.shown = PAGE; chipState(); paint();
  } }, label)]);
  const srcRow = h('div', { class: 'chips src', role: 'group', 'aria-label': 'Where recipes come from' }, srcButtons.map(([, b]) => b));
  srcRow.hidden = !lib.me;

  function chipState() {
    paintPromo();
    for (const [k, b] of srcButtons) b.setAttribute('aria-pressed', String(k === listState.src));
    for (const [i, b] of secButtons) b.setAttribute('aria-pressed', String(i === listState.sec));
    const sec = visible.find(([, , i]) => i === listState.sec);
    groupsRow.hidden = !sec;
    if (sec) {
      fill(groupsRow, sec[1].map(([g, n]) => h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(listState.cat === g),
        onclick: () => { listState.cat = listState.cat === g ? '' : g; listState.shown = PAGE; chipState(); paint(); },
      }, h('span', { class: 'e', 'aria-hidden': 'true' }, emojiFor(g)), g, ' ', h('span', { class: 'muted small' }, n.toLocaleString()))));
    }
  }

  function row(r) {
    return h('li', null,
      h('a', { class: 'rc', href: `#/r/${r.id}` },
        thumb(r),
        h('span', { class: 'txt' },
          h('span', { class: 't' }, r.title, r.source !== 'base' && h('span', { class: 'badge' }, badgeText(r))),
          h('span', { class: 'c' }, r.kind === 'link' ? `Link · ${r.src?.name || 'another website'} ↗`
            : r.categories.length ? r.categories.slice(0, 2).join(', ') : `${r.ings.length} ingredients`))),
      starButton(r.id));
  }

  function paint() {
    let pool = matches(listState.q, listState.cat, lib.me ? listState.src : '');
    if (starredOnly) pool = pool.filter((r) => isStarred(r.id));
    results = pool;
    const shown = results.slice(0, listState.shown);
    count.textContent = starredOnly
      ? `${results.length.toLocaleString()} starred`
      : results.length === lib.all.length ? `${results.length.toLocaleString()} recipes`
        : `${results.length.toLocaleString()} of ${lib.all.length.toLocaleString()} recipes`;
    ul.replaceChildren(...shown.map(row));
    more.hidden = shown.length >= results.length;
    if (results.length) { fill(empty); return; }
    const filtered = listState.q || listState.cat || (lib.me && listState.src);
    fill(empty, h('div', { class: 'empty' },
      h('span', { class: 'tile big', 'aria-hidden': 'true', 'data-sec': filtered ? 6 : 0 }, filtered ? '🔎' : '⭐'),
      h('h2', null, filtered ? 'Nothing matches' : 'Nothing starred yet'),
      h('p', { class: 'muted' }, filtered
        ? 'Try fewer words, or search by an ingredient like “lemon”.'
        : 'Tap the star on a recipe to keep it here for quick access.'),
      filtered
        ? h('button', { onclick: () => { listState.q = ''; listState.sec = -1; listState.cat = ''; listState.src = ''; input.value = ''; chipState(); paint(); } }, 'Clear search and filters')
        : h('button', { onclick: () => { location.hash = '#/'; } }, 'Browse recipes')));
  }

  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { listState.q = input.value; listState.shown = PAGE; paint(); }, 120);
  });

  fill($app,
    h('header', { class: 'hero' },
      h('h1', null, starredOnly ? 'Starred' : 'What are we cooking?'),
      starredOnly && h('p', { class: 'muted' }, 'Your go-to recipes, saved on this device.')),
    h('div', { class: 'searchbar' }, h('label', { class: 'search' }, icon('search', { size: 22 }), input)),
    !starredOnly && srcRow, !starredOnly && secRow, !starredOnly && groupsRow, promo, count, ul, empty, more);
  chipState();
  paint();
  window.scrollTo(0, listState.scroll);
  onScroll = () => { listState.scroll = window.scrollY; };
  window.addEventListener('scroll', onScroll, { passive: true });
}

function amountSplit(text) {
  const m = text.match(/^([\d¼½¾⅓⅔⅛⅜⅝⅞][\d\s/.\-–¼½¾⅓⅔⅛⅜⅝⅞]*)/);
  if (!m) return [text];
  const amt = m[1].trimEnd();
  return [h('b', null, amt), text.slice(amt.length)];
}

function tick(kids, extraClass = '') {
  const btn = h('button', { class: `tick ${extraClass}`.trim(), type: 'button', 'aria-pressed': 'false' }, kids);
  btn.addEventListener('click', () => btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true')));
  return btn;
}

function credit(r) {
  if (r.source === 'community') {
    const av = lib.avatars[r.row.owner_id] || (r.row.owner_id === lib.me?.id ? lib.me.avatar : null);
    return h('p', { class: 'credit' }, av && photos.photoImg(av, { class: 'avatar sm', alt: '' }),
      r.row.owner_id === lib.me?.id ? 'Shared by you' : `Shared by ${r.row.author_name || 'a chef'}`);
  }
  if (r.source === 'collection') return h('p', { class: 'credit' }, `From the ${restaurantName(r.row.restaurant_id)} collection`);
  if (r.source === 'shared') return h('p', { class: 'credit' }, r.row.status === 'declined'
    ? `Not approved${r.row.review_note ? `: ${r.row.review_note}` : '.'}` : 'Waiting for approval. Only you can see it until then.');
  return null;
}

/** "Recipe by Nora Taylor, Nora Cooks · View the original" for recipes that came from somewhere else. */
function sourceCredit(r) {
  const safe = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
  if (hasSource(r)) {
    return h('p', { class: 'srccredit' },
      h('span', null, creditLine(r) || 'From another source'),
      safe(r.src.url) && h('a', { href: safe(r.src.url), target: '_blank', rel: 'noopener' }, 'View the original recipe'));
  }
  if (isAdapted(r)) {
    return h('p', { class: 'srccredit' },
      h('span', null, adaptedLine(r) || 'Adapted from another recipe'),
      safe(r.adapted.url) && h('a', { href: safe(r.adapted.url), target: '_blank', rel: 'noopener' }, 'See the original'));
  }
  return null;
}

/** The dish photo on the recipe page, with Add / Change / Remove when this person may change it. */
function photoBlock(r) {
  const path = photoOf(r);
  const allowed = canPhoto(r);
  if (!path && !allowed) return null;
  const box = h('div', { class: 'photo' });
  const choose = async () => {
    const file = await photos.pickPhoto();
    if (!file) return;
    fill(box, h('p', { class: 'muted small' }, 'Saving photo…'));
    try { await setPhoto(r, file); toast('Photo saved'); } catch (err) { toast(err.message, 4500); }
    route();
  };
  const drop = async () => {
    if (!await confirmDialog('Remove this photo?', 'Remove', true)) return;
    try { await clearPhoto(r); toast('Photo removed'); } catch (err) { toast(err.message, 4500); }
    route();
  };
  const note = isLibrary(r) && allowed ? h('span', { class: 'muted small' }, 'Only you can see this photo.') : null;
  if (!path) {
    fill(box, h('button', { type: 'button', class: 'addphoto', onclick: choose }, icon('camera'), 'Add a photo of your dish'), note);
    return box;
  }
  fill(box, photos.photoImg(path, { class: 'dish', alt: `Photo of ${r.title}` }),
    allowed && h('div', { class: 'row' },
      h('button', { type: 'button', onclick: choose }, 'Change photo'),
      h('button', { type: 'button', class: 'danger', onclick: drop }, 'Remove photo'),
      note));
  return box;
}

const RIGHTS = 'Share a copy of this recipe with the Community? Everyone signed in will be able to read it and see your name. Only share a recipe that is yours or that you have the right to share. Chef-owned or restaurant recipes should stay private. The administrator reviews every recipe before it appears, and you can withdraw it later.';

/** Share / withdraw buttons for the recipe page. */
const RIGHTS_LINK = 'Share a link to this recipe with the Community? People will see its name, who wrote it and a button that opens it on the original website. None of the recipe’s text is copied. The administrator reviews it before it appears, and you can withdraw it later.';

/** Start the person's own version of an imported recipe: ingredients kept, method rewritten in their words. */
function adaptRecipe(r) {
  viewEdit(null, {
    ...r, id: null, source: 'mine', title: `${r.title} (my version)`, dir: '', src: null,
    adapted: { ...r.src }, adaptFrom: r.dir, adapting: true,
  });
}

function sharing(r) {
  if (!lib.me) return null;
  const out = h('div', { class: 'stack' });
  const copy = lib.cloud.find((x) => x.scope === 'community' && x.source_recipe_id === r.id && x.owner_id === lib.me.id);
  const withdraw = (row) => h('button', { onclick: async () => {
    if (!await confirmDialog('Withdraw this recipe from the Community? Your own copy stays in your account.', 'Withdraw', true)) return;
    try { await cloud.deleteRecipe(row.id); await refreshCloud(); await tidyPhoto(row.photo); toast('Withdrawn'); route(); } catch (err) { toast(err.message, 4000); }
  } }, 'Withdraw from Community');
  const status = (row) => h('p', { class: 'muted small' }, row.status === 'approved'
    ? (row.body?.kind === 'link' ? 'A link to this recipe is in the Community.' : 'A copy of this recipe is in the Community.')
    : row.status === 'declined' ? `Not approved${row.review_note ? `: ${row.review_note}` : '.'}`
      : (row.body?.kind === 'link' ? 'A link to this recipe is waiting for approval.' : 'A copy is waiting for approval.'));
  if (r.source === 'account' && hasSource(r)) {
    const canLink = /^https?:\/\//i.test(r.src.url || '');
    fill(out,
      h('p', { class: 'muted small' }, 'This recipe came from another website, so its full text stays in your private recipes. To share it with the Community, share a link to the original, or make your own version in your own words.'),
      copy && [status(copy), withdraw(copy)],
      h('div', { class: 'row grow' },
        !copy && canLink && h('button', { onclick: async () => {
          if (!await confirmDialog(RIGHTS_LINK, 'Share link')) return;
          try { await cloud.shareLinkToCommunity(r.id); await refreshCloud(); toast('Link sent for approval'); route(); } catch (err) { toast(err.message, 4000); }
        } }, 'Share a link to the Community'),
        h('button', { onclick: () => adaptRecipe(r) }, 'Make my own version')));
  } else if (r.source === 'account') {
    if (copy) fill(out, status(copy), withdraw(copy));
    else fill(out, h('button', { onclick: async () => {
      if (!await confirmDialog(RIGHTS, 'Share')) return;
      try { await cloud.submitToCommunity(r.id); await refreshCloud(); toast('Sent for approval'); route(); } catch (err) { toast(err.message, 4000); }
    } }, 'Share with the Community'));
  } else if ((r.source === 'community' || r.source === 'shared') && r.row.owner_id === lib.me.id) fill(out, withdraw(r.row));
  else return null;
  return out;
}

/** A Community link card: name, credit and a button that opens the recipe on its own website. */
function viewLinkCard(r) {
  setView('recipe', 'list');
  const url = /^https?:\/\//i.test(r.src?.url || '') ? r.src.url : '';
  fill($app,
    h('div', { class: 'topbar' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: () => goBack('#/') }, icon('back')),
      h('span', { class: 'sp' }),
      starButton(r.id)),
    h('div', { class: 'rhead' }, tile(r.categories, true), h('h1', null, r.title)),
    r.categories.length > 0 && h('div', { class: 'labels' }, r.categories.map((c) => h('span', { class: 'label' }, c))),
    credit(r),
    h('div', { class: 'card stack linkcard' },
      h('p', null, h('strong', null, creditLine(r) || 'A recipe from another website')),
      h('p', { class: 'muted small' }, `This is a link to a recipe on ${r.src?.name || 'another website'}. Open it there to cook from it. The author keeps the visit and the credit.`),
      url && h('a', { class: 'linkbtn primary', href: url, target: '_blank', rel: 'noopener' }, `Open the recipe on ${r.src?.name || 'their website'} ↗`)),
    h('section', { class: 'tools stack' }, sharing(r)));
  window.scrollTo(0, 0);
}

function viewRecipe(id) {
  const r = lib.byId.get(id);
  if (!r) return viewMissing();
  if (r.kind === 'link') return viewLinkCard(r);
  setView('recipe', 'list');
  let factor = new Frac(1n);
  let smart = true;

  const factorIn = h('input', { type: 'number', inputmode: 'decimal', step: '0.25', min: '0.01', value: '1', 'aria-label': 'Multiplier' });
  const servIn = h('input', {
    type: 'number', inputmode: 'decimal', step: '1', min: '0.01', 'aria-label': 'Servings to make',
    disabled: !(r.yq && r.yq.n > 0n), value: r.yq ? num(r.yq, 2) : '',
  });
  const smartIn = h('input', { type: 'checkbox', checked: true, onchange: () => { smart = smartIn.checked; paint(); } });
  const ingBox = h('div');
  const dirBox = h('div');
  const yieldLabel = r.yu || (r.yq ? '' : 'servings');

  const presets = [['½×', new Frac(1n, 2n)], ['1×', new Frac(1n)], ['2×', new Frac(2n)], ['3×', new Frac(3n)]]
    .map(([label, f]) => [f, h('button', { type: 'button', onclick: () => setFactor(f) }, label)]);

  function setFactor(f, source) {
    factor = f;
    if (source !== 'factor') factorIn.value = num(f, 3);
    if (source !== 'servings' && r.yq) servIn.value = num(f.mul(r.yq), 2);
    paint();
  }
  factorIn.addEventListener('input', () => {
    const v = parseFloat(factorIn.value);
    if (v > 0) setFactor(Frac.parse(trim0(v.toFixed(3))), 'factor');
  });
  servIn.addEventListener('input', () => {
    const v = parseFloat(servIn.value);
    if (v > 0 && r.yq) setFactor(factorForServings(r, Frac.parse(trim0(v.toFixed(2)))), 'servings');
  });
  const stepServings = (dir) => {
    if (!r.yq) return;
    const cur = parseFloat(servIn.value) || r.yq.toNumber();
    const next = Math.max(1, dir > 0 ? Math.floor(cur + 1e-9) + 1 : Math.ceil(cur - 1e-9) - 1);
    setFactor(factorForServings(r, Frac.parse(String(next))), null);
  };

  function paint() {
    const { recipe: s, warnings } = scaleRecipe(r, factor, smart);
    for (const [f, b] of presets) b.setAttribute('aria-pressed', String(f.eq(factor)));
    const groups = [];
    for (const ing of s.ings) {
      let g = groups[groups.length - 1];
      if (!g || g.name !== ing.group) groups.push((g = { name: ing.group, items: [] }));
      g.items.push(ing);
    }
    const y = formatYield(s);
    const steps = s.dir ? s.dir.split('\n').filter((l) => l.trim()) : [];
    fill(ingBox,
      h('div', { class: 'facts' },
        y && h('span', null, h('strong', null, 'Makes '), y),
        s.ings.length > 0 && h('span', null, h('strong', null, s.ings.length), s.ings.length === 1 ? ' ingredient' : ' ingredients')),
      s.ings.length > 0 && h('h2', null, 'Ingredients'),
      groups.map((g) => [g.name && h('h3', null, g.name),
        h('ul', { class: 'ing' }, g.items.map((i) => h('li', null,
          tick([h('span', { class: 'box' }, icon('check', { size: 16 })), h('span', { class: 'what' }, amountSplit(formatIngredient(i)))]))))]));
    fill(dirBox,
      steps.length > 0 && h('h2', null, 'Method'),
      steps.length > 1
        ? h('ol', { class: 'steps' }, steps.map((l, n) => h('li', null,
          tick([h('span', { class: 'n' }, n + 1), h('span', { class: 'what' }, l)]))))
        : steps.length === 1 && h('div', { class: 'dir' }, h('p', null, steps[0])),
      warnings.length > 0 && h('p', { class: 'note' }, warnings.join(' ')));
  }

  // keep the screen awake while cooking
  let sentinel = null;
  let awake = false;
  const awakeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Keep screen on while cooking', title: 'Keep screen on while cooking', hidden: !('wakeLock' in navigator), onclick: () => setWake(!awake) }, icon('sun'));
  async function acquire() {
    try { sentinel = await navigator.wakeLock.request('screen'); } catch { awake = false; awakeBtn.setAttribute('aria-pressed', 'false'); toast('Could not keep the screen on'); }
  }
  const onVisible = () => { if (awake && document.visibilityState === 'visible') acquire(); };
  function setWake(on) {
    awake = on;
    awakeBtn.setAttribute('aria-pressed', String(on));
    if (on) { acquire(); document.addEventListener('visibilitychange', onVisible); toast('Screen will stay on', 1800); }
    else { sentinel?.release().catch(() => {}); sentinel = null; document.removeEventListener('visibilitychange', onVisible); }
  }
  releaseWake = () => setWake(false);

  const copy = async () => {
    const text = recipeToText(scaleRecipe(r, factor, smart).recipe);
    toast(await copyText(text) ? 'Recipe copied' : 'Could not copy on this browser');
  };
  const share = () => navigator.share({ title: r.title, text: recipeToText(scaleRecipe(r, factor, smart).recipe) }).catch(() => {});
  const saveCopy = () => {
    const s = scaleRecipe(r, factor, smart).recipe;
    s.title = factor.eq(new Frac(1n)) ? `${r.title} (copy)` : `${r.title} (scaled)`;
    viewEdit(null, s);
  };

  const [primary, ...rest] = r.categories;
  fill($app,
    h('div', { class: 'topbar' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: () => goBack('#/') }, icon('back')),
      h('span', { class: 'sp' }),
      awakeBtn,
      starButton(r.id),
      canEdit(r) && h('a', { class: 'icon-btn', href: `#/edit/${r.id}`, 'aria-label': 'Edit recipe', title: 'Edit recipe' }, icon('edit'))),
    h('div', { class: 'rhead' }, tile(r.categories, true), h('h1', null, r.title)),
    photoBlock(r),
    r.categories.length > 0 && h('div', { class: 'labels' }, r.categories.map((c) => h('span', { class: 'label' }, c))),
    credit(r),
    sourceCredit(r),
    h('div', { class: 'cols' },
      h('div', { class: 'side' },
    h('section', { class: 'dock', 'aria-label': 'Scale this recipe' },
          h('div', { class: 'seg' }, presets.map(([, b]) => b),
            h('label', { class: 'mult' }, h('span', { 'aria-hidden': 'true' }, '×'), factorIn)),
          r.yq
            ? h('div', { class: 'makes' },
              h('span', { class: 'lbl' }, 'Makes'),
              h('button', { class: 'step', type: 'button', 'aria-label': 'Fewer servings', onclick: () => stepServings(-1) }, icon('minus')),
              servIn,
              h('button', { class: 'step', type: 'button', 'aria-label': 'More servings', onclick: () => stepServings(1) }, icon('plus')),
              h('span', { class: 'lbl' }, yieldLabel))
            : h('p', { class: 'note', style: 'margin:.5rem .3rem .1rem' }, 'No yield is listed, so scale with the multiplier.')),
        ingBox),
      dirBox),
    h('section', { class: 'tools stack' },
      h('label', { class: 'check' }, smartIn, 'Smart units (8 Tbsp becomes ½ cup)'),
      h('div', { class: 'row grow' },
        h('button', { onclick: copy }, 'Copy'),
        navigator.share && h('button', { onclick: share }, 'Share'),
        h('button', { onclick: saveCopy }, 'Save scaled copy'),
        h('button', { onclick: () => window.print() }, 'Print')),
      sharing(r),
      r.tags && r.tags.length > 0 && h('p', { class: 'muted small' }, 'Original labels: ', r.tags.join(', '))));
  paint();
  window.scrollTo(0, 0);
}

function viewEdit(id, template) {
  setView('edit', 'new');
  const existing = id ? lib.byId.get(id) : null;
  if (id && !existing) return viewMissing();
  if (existing && !canEdit(existing)) { fill($app, h('h1', null, 'Read only'), h('p', { class: 'muted' }, 'This recipe belongs to someone else. Open it and use “Save scaled copy” to make your own version.'), h('p', null, h('a', { href: `#/r/${existing.id}` }, 'Back to the recipe'))); return; }
  const r = existing || template || { title: '', categories: [], tags: [], yq: null, yu: '', yr: '', dir: '', ings: [], source: 'mine' };

  const title = h('input', { class: 'full', value: r.title, autocomplete: 'off', 'aria-label': 'Title' });
  const cats = h('input', { class: 'full', value: r.categories.join(', '), placeholder: 'e.g. Soups, Main dish', 'aria-label': 'Categories' });
  const yld = h('input', { class: 'full', value: formatYield(r) || r.yr, placeholder: 'e.g. 4 servings, 24 cookies', 'aria-label': 'Yield' });
  const dir = h('textarea', { 'aria-label': 'Directions', placeholder: 'Directions. Leave a blank line between paragraphs.' });
  dir.value = r.dir;
  const adapting = !!r.adapting;
  const src0 = r.src || {};
  const srcAuthor = h('input', { class: 'full', value: src0.author || '', placeholder: 'e.g. Nora Taylor (blank if it’s yours)', autocomplete: 'off', 'aria-label': 'Recipe by' });
  const srcName = h('input', { class: 'full', value: src0.name || '', placeholder: 'Website, book or person, e.g. Nora Cooks', autocomplete: 'off', 'aria-label': 'From' });
  const srcUrl = h('input', { class: 'full', type: 'url', value: src0.url || '', placeholder: 'https://…', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Link to the original' });
  const rowsBox = h('div');
  const datalist = h('datalist', { id: 'units' }, UNIT_CHOICES.filter(Boolean).map((u) => h('option', { value: u })));

  function addRow(vals = { amount: '', unit: '', item: '', group: '' }, focus = false) {
    const amount = h('input', { class: 'amt', value: vals.amount, placeholder: 'Amt', inputmode: 'text', 'aria-label': 'Amount' });
    const unit = h('input', { class: 'unit', value: vals.unit, placeholder: 'Unit', list: 'units', autocapitalize: 'off', 'aria-label': 'Unit' });
    const item = h('input', { class: 'item', value: vals.item, placeholder: 'Ingredient', 'aria-label': 'Ingredient' });
    const grp = h('input', { class: 'grp', value: vals.group, placeholder: 'Group (optional, e.g. Sauce)', 'aria-label': 'Group' });
    const row = h('div', { class: 'card ing-row' },
      h('div', { class: 'row' }, amount, unit), item, grp,
      h('div', { class: 'rowtools' },
        h('button', { type: 'button', 'aria-label': 'Move up', onclick: () => row.previousElementSibling && row.previousElementSibling.before(row) }, '↑'),
        h('button', { type: 'button', 'aria-label': 'Move down', onclick: () => row.nextElementSibling && row.nextElementSibling.after(row) }, '↓'),
        h('button', { type: 'button', class: 'danger', onclick: () => row.remove() }, 'Remove')));
    row._get = () => [amount.value, unit.value, item.value, grp.value];
    rowsBox.append(row);
    if (focus) amount.focus();
  }
  for (const i of r.ings) addRow({ amount: amountForEditing(i), unit: i.unit, item: i.item, group: i.group });
  if (!r.ings.length) addRow();

  async function save() {
    if (!title.value.trim()) { toast('Please give the recipe a title'); title.focus(); return; }
    const ings = [...rowsBox.children].map((row) => ingredientFromFields(...row._get())).filter(Boolean);
    const text = yld.value.trim();
    const [yq, yu] = text ? parseYield(text) : [null, ''];
    const recipe = {
      id: existing ? existing.id : `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title: title.value.trim(), categories: splitCategories(cats.value), tags: (existing || template || {}).tags || [], yq, yu, yr: text,
      dir: dir.value.trim(), ings,
      src: { author: srcAuthor.value.trim(), name: srcName.value.trim(), url: srcUrl.value.trim() },
    };
    if (recipe.src.url && !/^https?:\/\//i.test(recipe.src.url)) recipe.src.url = `https://${recipe.src.url}`;
    const base = existing || template || {};
    if (isAdapted(base)) recipe.adapted = { ...base.adapted };
    if (adapting) {
      if (!recipe.dir) { toast('Write the method in your own words first'); dir.focus(); return; }
      if (wordingOverlap(recipe.dir, base.adaptFrom) > MAX_OVERLAP) {
        toast('Your method is still too close to the original wording. Rewrite the steps in your own words.', 5000);
        dir.focus();
        return;
      }
    }
    const rec = toRecord(recipe);
    let target = recipe.id;
    if ((existing && existing.cloud) || (!existing && lib.me && cloud.isSignedIn())) {
      try {
        if (existing) await cloud.updateRecipe(existing.id, rec);
        else target = (await cloud.createRecipe(rec)).id;
        await refreshCloud();
      } catch (err) {
        if (err.status !== 0 || existing) { toast(err.message, 4500); return; }
        await saveRecord(rec);                                   // offline: keep it on this device
        toast('You are offline, so this was saved on this device only.', 4500);
      }
    } else await saveRecord(rec);
    toast('Saved');
    location.replace(`${location.pathname}${location.search}#/r/${target}`);
  }

  async function del() {
    const mine = existing.source === 'mine' || existing.cloud;
    const ok = await confirmDialog(
      mine ? `Delete "${existing.title}"?` : `Remove "${existing.title}" from your library? You can restore it later in Settings.`,
      mine ? 'Delete' : 'Remove', true);
    if (!ok) return;
    if (existing.cloud) {
      try { await cloud.deleteRecipe(existing.id); await refreshCloud(); await tidyPhoto(existing.row.photo); } catch (err) { toast(err.message, 4500); return; }
    } else if (mine) await dropRecord(existing.id);
    else await saveRecord({ id: existing.id, deleted: true });
    toast('Removed');
    location.replace(`${location.pathname}${location.search}#/`);
  }
  async function revert() {
    if (!await confirmDialog(`Discard your edits to "${existing.title}" and go back to the original?`, 'Revert')) return;
    await dropRecord(existing.id);
    toast('Reverted to original');
    location.replace(`${location.pathname}${location.search}#/r/${existing.id}`);
  }

  fill($app, 
    h('h1', null, existing ? 'Edit recipe' : adapting ? 'Make your own version' : template?.imported ? 'Check and save' : template ? 'Save as new recipe' : 'New recipe'),
    !existing && !template && h('p', null, h('a', { class: 'linkbtn', href: '#/import' }, '⤓ Import a recipe from a web page')),
    adapting && h('p', { class: 'muted' }, 'Keep or change the ingredients, then write the method in your own words. Your version can be shared with the Community and will say “Adapted from” with a link to the original.'),
    h('label', { class: 'field' }, h('span', null, 'Title'), title),
    h('label', { class: 'field' }, h('span', null, 'Categories'), cats),
    h('label', { class: 'field' }, h('span', null, 'Yield'), yld),
    h('h2', null, 'Ingredients'),
    h('p', { class: 'muted small' }, 'Amounts can be 2, 1/2, 1 1/2, 1.5 or ½. Use Group for headings like Sauce or Topping.'),
    datalist, rowsBox,
    h('button', { type: 'button', class: 'full', onclick: () => addRow(undefined, true) }, '+ Add ingredient'),
    adapting && r.adaptFrom && h('details', { class: 'card original' },
      h('summary', null, 'The original method, for reference'),
      h('p', { class: 'muted small' }, 'Write your own steps below in your own words. Don’t copy these. Change what you like: technique, timing, seasoning.'),
      h('ol', null, r.adaptFrom.split('\n').filter((l) => l.trim()).map((l) => h('li', null, l)))),
    h('label', { class: 'field' }, h('span', null, adapting ? 'Your method, in your own words' : 'Directions'), dir),
    h('h2', null, 'Credit'),
    isAdapted(r)
      ? [h('p', { class: 'srccredit' }, h('span', null, adaptedLine(r) || 'Adapted from another recipe'),
        /^https?:\/\//i.test(r.adapted.url || '') && h('a', { href: r.adapted.url, target: '_blank', rel: 'noopener' }, 'See the original')),
      h('p', { class: 'muted small' }, 'This credit stays on your version, including in the Community.')]
      : [h('p', { class: 'muted small' }, 'For a recipe from someone else, say who wrote it and link to the original. It is shown on the recipe.'),
        h('label', { class: 'field' }, h('span', null, 'Recipe by'), srcAuthor),
        h('label', { class: 'field' }, h('span', null, 'From'), srcName),
        h('label', { class: 'field' }, h('span', null, 'Link to the original'), srcUrl)],
    h('div', { class: 'row grow' },
      h('button', { class: 'primary', onclick: save }, 'Save'),
      h('button', { onclick: () => (template ? route() : goBack(existing ? `#/r/${existing.id}` : '#/')) }, 'Cancel')),
    existing && h('div', { class: 'actions row grow' },
      existing.source === 'edited' && h('button', { onclick: revert }, 'Revert to original'),
      h('button', { class: 'danger', onclick: del }, existing.source === 'mine' || existing.cloud ? 'Delete recipe' : 'Remove from library')));
  window.scrollTo(0, 0);
  if (!existing && !template) title.focus();
}

// ------------------------------------------------------ outside collections and web import

/** Recipe titles from an outside author, each opening on their own website (nothing is copied). */
function viewLinks(collectionId) {
  const c = COLLECTIONS.find((x) => x.id === collectionId);
  if (!c) return viewMissing();
  setView('list', 'list');
  const input = h('input', { type: 'search', placeholder: `Search ${c.site} recipes`, autocomplete: 'off', 'aria-label': `Search ${c.site} recipes` });
  const box = h('div');
  const paint = () => {
    const q = input.value.trim().toLowerCase();
    fill(box, c.sections.map(([name, rows]) => {
      const hits = rows.filter(([t]) => !q || t.toLowerCase().includes(q));
      return hits.length > 0 && [h('h2', null, name), h('ul', { class: 'rows' }, hits.map(([t, url]) => h('li', null,
        h('a', { class: 'rc', href: url, target: '_blank', rel: 'noopener' },
          h('span', { class: 'tile', 'aria-hidden': 'true', 'data-sec': 2 }, '🌱'),
          h('span', { class: 'txt' }, h('span', { class: 't' }, t), h('span', { class: 'c' }, `${c.site} · opens her website ↗`))))))];
    }));
  };
  input.addEventListener('input', paint);
  fill($app,
    h('div', { class: 'topbar' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: () => goBack('#/') }, icon('back')),
      h('span', { class: 'sp' })),
    h('header', { class: 'hero' }, h('h1', null, `Vegan recipes from ${c.site}`),
      h('p', { class: 'muted' }, c.blurb)),
    h('div', { class: 'card stack' },
      h('p', { class: 'small' }, `These recipes belong to ${c.author}. Each one opens on ${c.site}, so she gets the visit and the credit. To keep one you cook often, open it, copy the address, then tap Import below. It is saved in your own recipes with her name and a link back.`),
      h('div', { class: 'row grow' },
        h('a', { class: 'linkbtn', href: '#/import' }, '⤓ Import one from a link'),
        h('a', { class: 'linkbtn', href: c.home, target: '_blank', rel: 'noopener' }, `Browse all of ${c.site} ↗`))),
    h('div', { class: 'searchbar' }, h('label', { class: 'search' }, icon('search', { size: 22 }), input)),
    box);
  paint();
  window.scrollTo(0, 0);
}

/** Paste one recipe link; the recipe is read, checked in the editor, then saved with credit. */
function viewImport() {
  setView('edit', 'new');
  const signedIn = !!lib.me && cloud.isSignedIn();
  const url = h('input', { class: 'full', type: 'url', placeholder: 'https://www.noracooks.com/…', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Recipe page address' });
  const status = h('p', { class: 'muted small', role: 'status' });
  const go = h('button', { class: 'primary', type: 'button', disabled: !signedIn, onclick: run }, 'Get recipe');
  async function run() {
    let link = url.value.trim();
    if (!link) { url.focus(); return; }
    if (!/^https?:\/\//i.test(link)) link = `https://${link}`;
    go.disabled = true;
    status.textContent = 'Reading the page…';
    try {
      const res = await cloud.fetchRecipePage(link);
      if (!res || !res.recipe) throw new Error((res && res.error) || 'No recipe was found on that page.');
      const r = recipeFromSchema(res.recipe, res.url || link, res.site || '');
      r.imported = true;
      const dup = lib.all.find((x) => x.src?.url && x.src.url === r.src.url);
      if (dup) { toast('That recipe is already in your recipes'); location.hash = `#/r/${encodeURIComponent(dup.id)}`; return; }
      viewEdit(null, r);
    } catch (err) {
      status.textContent = err.message;
      go.disabled = false;
    }
  }
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  fill($app,
    h('div', { class: 'topbar' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: () => goBack('#/new') }, icon('back')),
      h('span', { class: 'sp' })),
    h('h1', null, 'Import from a web page'),
    h('p', { class: 'muted' }, 'Paste the address of one recipe page. You check it before it is saved. It goes into your own private recipes with the author’s name and a link back to the original. Only the ingredients, method and yield are taken. Photos and stories stay on their site.'),
    !signedIn && h('p', { class: 'note' }, 'Sign in first (Settings). The phone can’t read other websites on its own, so the page is read through your account.'),
    h('label', { class: 'field' }, h('span', null, 'Recipe page address'), url),
    h('div', { class: 'row grow' }, go),
    status,
    COLLECTIONS.map((c) => h('p', { class: 'small' }, h('a', { href: `#/links/${c.id}` }, `Browse vegan recipes from ${c.site}`))));
  window.scrollTo(0, 0);
  if (signedIn) url.focus();
}

function viewMissing() {
  setView('list', 'list');
  fill($app, h('h1', null, 'Recipe not found'), h('p', null, h('a', { href: '#/' }, 'Back to the library')));
}

// ----------------------------------------------------------------- settings

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

async function viewSettings() {
  setView('settings', 'settings');
  const mine = [...lib.mine.values()];
  const counts = {
    new: mine.filter((m) => !m.deleted && !lib.base.some((b) => b.id === m.id)).length,
    edited: mine.filter((m) => !m.deleted && lib.base.some((b) => b.id === m.id)).length,
    removed: mine.filter((m) => m.deleted).length,
  };
  const swReady = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;
  const persisted = (await navigator.storage?.persisted?.().catch(() => false)) || false;
  const stat = (k, v) => h('div', { class: 'stat' }, h('span', null, k), h('strong', null, v));
  const appVersion = await (async () => {
    try { const k = (await caches.keys()).find((x) => x.startsWith('recipelib-')); return k ? k.slice(10) : 'not cached yet'; } catch { return 'unknown'; }
  })();

  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: importBackup });

  async function importBackup() {
    const file = fileIn.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'recipelib' || !Array.isArray(data.records)) throw new Error('not a backup');
      const recs = data.records.filter((x) => x && typeof x.id === 'string');
      addStars(Array.isArray(data.stars) ? data.stars : []);
      await store.putMany(recs);
      for (const x of recs) lib.mine.set(x.id, x);
      rebuild();
      toast(`Imported ${recs.length} recipe change${recs.length === 1 ? '' : 's'}`);
      viewSettings();
    } catch { toast('That file is not a Recipe Library backup'); }
  }

  const localNew = mine.filter((m) => !m.deleted && !lib.base.some((b) => b.id === m.id));
  async function moveToAccount() {
    if (!await confirmDialog(`Move ${localNew.length} recipe${localNew.length === 1 ? '' : 's'} from this device into your account? They will then be saved online and available on every device you sign in on.`, 'Move')) return;
    let moved = 0; let problem = null;
    for (const rec of localNew) {
      try {
        const row = await cloud.createRecipe(rec);
        if (isStarred(rec.id)) addStars([row.id]);
        await store.remove(rec.id); lib.mine.delete(rec.id); moved++;
      } catch (err) { problem = err; break; }
    }
    await refreshCloud();
    toast(problem ? `Moved ${moved}. Stopped: ${problem.message}` : `Moved ${moved} recipe${moved === 1 ? '' : 's'} to your account`, problem ? 6000 : 3000);
    viewSettings();
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify({ app: 'recipelib', v: 1, records: [...lib.mine.values()], stars: starIds() }, null, 1)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `recipe-library-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function restoreRemoved() {
    const ids = mine.filter((m) => m.deleted).map((m) => m.id);
    await store.removeMany(ids);
    ids.forEach((id) => lib.mine.delete(id));
    rebuild();
    toast(`Restored ${ids.length} recipe${ids.length === 1 ? '' : 's'}`);
    viewSettings();
  }

  fill($app, 
    h('h1', null, 'Settings & backup'),
    accountCard(ctx),
    h('h2', null, 'This device'),
    h('section', { class: 'card stack' },
      h('strong', null, 'Status'),
      stat('Recipes in library', lib.all.length.toLocaleString()),
      stat('Works offline', swReady ? 'Yes' : 'Not yet (open once while online)'),
      stat('App version', appVersion),
      stat('Your changes are saved on this device', store.persistent ? 'Yes' : 'No (private browsing?)'),
      stat('Protected from automatic cleanup', persisted ? 'Yes' : 'No'),
      !persisted && navigator.storage?.persist && h('button', { onclick: async () => { toast((await navigator.storage.persist()) ? 'Done' : 'The browser declined'); viewSettings(); } }, 'Ask the browser to keep my data'),
      installPrompt && h('button', { class: 'primary', onclick: async () => { installPrompt.prompt(); installPrompt = null; viewSettings(); } }, 'Install app on this device')),
    h('h2', null, 'Your recipes'),
    lib.me && localNew.length > 0 && h('section', { class: 'card stack' },
      h('strong', null, `${localNew.length} recipe${localNew.length === 1 ? ' is' : 's are'} only on this device`),
      h('p', { class: 'muted small' }, 'Move them into your account so they are backed up online and open on your other devices.'),
      h('button', { class: 'primary', onclick: moveToAccount }, 'Move them to my account')),
    h('section', { class: 'card stack' },
      stat('Added by you', counts.new), stat('Edited built-in recipes', counts.edited), stat('Removed built-in recipes', counts.removed),
      h('p', { class: 'muted small' }, 'Your additions and edits are stored only on this device. Export a backup to move them to another phone or keep a safe copy.'),
      h('div', { class: 'row grow' },
        h('button', { class: 'primary', onclick: exportBackup }, 'Export backup'),
        h('button', { onclick: () => fileIn.click() }, 'Import backup'),
        counts.removed > 0 && h('button', { onclick: restoreRemoved }, 'Restore removed')),
      fileIn),
    h('h2', null, 'Install on your phone'),
    h('section', { class: 'card' },
      h('p', null, h('strong', null, 'iPhone / iPad: '), 'open this page in Safari, tap the Share button, then “Add to Home Screen”.'),
      h('p', null, h('strong', null, 'Android: '), 'open it in Chrome, tap the ⋮ menu, then “Install app” (or “Add to Home screen”).'),
      h('p', { class: 'muted small' }, 'Open it once with a connection first so the recipes download. After that it works with no signal. Installing it to the home screen also stops iPhones from clearing its data after a few weeks of not using it.')));
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------- router

// Back button: browsers differ on history.length (Firefox counts the new-tab page), so the app
// numbers its own history entries and only calls history.back() when an earlier app page exists.
let appIndex = 0;
let stamped = false;
function stampHistory() {
  const st = history.state;
  if (st && typeof st.i === 'number') appIndex = st.i;
  else {
    appIndex = stamped ? appIndex + 1 : 0;
    try { history.replaceState({ i: appIndex }, ''); } catch { /* ignore */ }
  }
  stamped = true;
}
function goBack(fallback = '#/') {
  if (appIndex > 0) history.back(); else location.hash = fallback;
}


function route() {
  stampHistory();
  clearView();
  const hash = location.hash.replace(/^#\/?/, '');
  const [kind, arg] = hash.split('/');
  const id = arg ? decodeURIComponent(arg) : null;
  if (kind === 'r' && id) return viewRecipe(id);
  if (kind === 'edit' && id) return viewEdit(id);
  if (kind === 'new') return viewEdit(null);
  if (kind === 'settings') return viewSettings();
  if (kind === 'links') return viewLinks(id || COLLECTIONS[0].id);
  if (kind === 'import') return viewImport();
  if (kind === 'admin') return viewAdmin(ctx);
  if (kind === 'join') return viewJoin(ctx, id);
  if (kind === 'starred') return viewList(true);
  return viewList();
}

const ctx = {
  h, fill, toast, icon, lib, $app, setView, goBack, refreshCloud, clearCloud, confirmDialog, infoDialog,
  rerender: () => route(), joinCode: '',
};

async function boot() {
  const linkType = cloud.takeSessionFromHash();      // arriving from a confirmation / reset email
  if (linkType) history.replaceState(history.state, '', `${location.pathname}${location.search}#/settings`);
  loadCloudCache();
  try {
    const [res, mine] = await Promise.all([fetch('data/recipes.json'), store.all()]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    lib.base = data.recipes.map(fromRow);
    for (const rec of mine) lib.mine.set(rec.id, rec);
    rebuild();
  } catch (err) {
    fill($app, h('div', { class: 'pad' }, h('h1', null, 'Could not load the recipes'),
      h('p', null, 'Connect to the internet and reload once, then it will work offline.'), h('p', { class: 'muted small' }, String(err))));
    return;
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
    const view = document.body.dataset.view;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape' && (view === 'recipe' || view === 'edit')) { goBack('#/'); }
    else if (e.key === '/' && view === 'list' && !typing) { const s = document.querySelector('input[type=search]'); if (s) { e.preventDefault(); s.focus(); } }
  });
  route();
  registerWorker();
  if (linkType === 'recovery') ctx.recovery = true;
  if (linkType === 'invite') ctx.recovery = 'invite';      // signed in by the invite email: choose a password
  if (linkType?.startsWith('error:')) {
    infoDialog('That link didn’t work', `${linkType.slice(6)} Ask for a new invite, or use “Forgot password?” to get a new sign-in link.`);
  } else if (linkType) {
    const [t, m] = {
      recovery: ['Choose a new password', 'You’re signed in. Choose a new password below.'],
      invite: ['Welcome to Jones Ridge Recipes!', 'Your invite worked and you’re signed in. Choose a password below so you can sign in on other devices.'],
    }[linkType] || ['Email confirmed', 'Your account is ready and you’re signed in.'];
    infoDialog(t, m);
  }
  if (cloud.isSignedIn()) {
    const hadAccount = !!lib.me;
    await refreshCloud();
    const view = document.body.dataset.view;
    if (view === 'list' || (view === 'recipe' && !hadAccount) || (view === 'settings' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '') && location.hash.indexOf('admin') < 0)) route();
  }
}

function showUpdate() {
  if (document.querySelector('.updatebar')) return;
  document.body.append(h('div', { class: 'updatebar', role: 'status' },
    h('span', null, 'A new version is ready.'),
    h('button', { type: 'button', onclick: () => location.reload() }, 'Update now'),
    h('button', { type: 'button', class: 'later', 'aria-label': 'Dismiss', onclick: (e) => e.target.closest('.updatebar').remove() }, '×')));
}

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) showUpdate(); else toast('Ready to use offline', 5000);
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // look for a newer version now, whenever the app comes back to the front, and hourly
    const check = () => reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    setInterval(check, 60 * 60 * 1000);
  }).catch((err) => console.warn('Service worker failed:', err));
}

boot();
