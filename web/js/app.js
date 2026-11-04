import {
  Frac, UNIT_CHOICES, amountForEditing, factorForServings, formatIngredient, formatYield,
  ingredientFromFields, parseYield, recipeToText, scaleRecipe, splitCategories,
} from './units.js';
import { fromRecord, fromRow, toRecord } from './model.js';
import * as store from './store.js';

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

const lib = { base: [], mine: new Map(), all: [], byId: new Map(), cats: [] };

function rebuild() {
  const map = new Map(lib.base.map((r) => [r.id, r]));
  for (const rec of lib.mine.values()) {
    if (rec.deleted) map.delete(rec.id);
    else map.set(rec.id, fromRecord(rec, lib.base.some((b) => b.id === rec.id) ? 'edited' : 'mine'));
  }
  lib.byId = map;
  lib.all = [...map.values()].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  const cats = new Map();
  for (const r of lib.all) {
    r._hay = [r.title, r.categories.join(' '), r.ings.map((i) => i.item).join(' '), r.dir].join('\n').toLowerCase();
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

function matches(q, cat) {
  const tokens = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out = [];
  for (const r of lib.all) {
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

const listState = { q: '', cat: '', shown: PAGE, scroll: 0 };
let onScroll = null;
let releaseWake = null;

function clearView() {
  if (onScroll) { window.removeEventListener('scroll', onScroll); onScroll = null; }
  if (releaseWake) { releaseWake(); releaseWake = null; }
}

function viewList() {
  const input = h('input', {
    type: 'search', class: 'full', placeholder: 'Search recipes or ingredients',
    value: listState.q, enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Search recipes',
  });
  const select = h('select', { class: 'full', 'aria-label': 'Category' },
    h('option', { value: '' }, `All categories (${lib.all.length.toLocaleString()})`),
    lib.cats.map((c) => h('option', { value: c.name, selected: c.name === listState.cat }, `${c.name} (${c.n})`)));
  select.value = listState.cat;
  const count = h('p', { class: 'count muted small' });
  const ul = h('ul', { class: 'list' });
  const more = h('button', { class: 'more', onclick: () => { listState.shown += PAGE; paint(); } }, 'Show more');
  let results = [];

  function paint() {
    results = matches(listState.q, listState.cat);
    const shown = results.slice(0, listState.shown);
    count.textContent = results.length === lib.all.length
      ? `${results.length.toLocaleString()} recipes`
      : `${results.length.toLocaleString()} of ${lib.all.length.toLocaleString()} recipes`;
    ul.replaceChildren(...shown.map((r) => h('li', null,
      h('a', { href: `#/r/${r.id}` },
        h('span', { class: 't' }, r.title, r.source !== 'base' && h('span', { class: 'badge' }, r.source === 'mine' ? 'Mine' : 'Edited')),
        r.categories.length > 0 && h('span', { class: 'c' }, r.categories.join(', '))))));
    more.hidden = shown.length >= results.length;
    if (!results.length) ul.replaceChildren(h('li', { class: 'muted pad' }, 'No recipes match.'));
  }

  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { listState.q = input.value; listState.shown = PAGE; paint(); }, 120);
  });
  select.addEventListener('change', () => { listState.cat = select.value; listState.shown = PAGE; paint(); });

  fill($app, h('div', { class: 'filters' }, input, select), count, ul, more);
  paint();
  window.scrollTo(0, listState.scroll);
  onScroll = () => { listState.scroll = window.scrollY; };
  window.addEventListener('scroll', onScroll, { passive: true });
}

function viewRecipe(id) {
  const r = lib.byId.get(id);
  if (!r) return viewMissing();
  let factor = new Frac(1n);
  let smart = true;

  const factorIn = h('input', { type: 'number', inputmode: 'decimal', step: '0.25', min: '0.01', value: '1', 'aria-label': 'Multiplier' });
  const servIn = h('input', {
    type: 'number', inputmode: 'decimal', step: '1', min: '0.01', 'aria-label': 'Servings to make',
    disabled: !(r.yq && r.yq.n > 0n), value: r.yq ? num(r.yq, 2) : '',
  });
  const smartIn = h('input', { type: 'checkbox', checked: true, onchange: () => { smart = smartIn.checked; paint(); } });
  const body = h('div');
  const yieldLabel = r.yu || (r.yq ? '' : '(no yield listed)');

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

  function paint() {
    const { recipe: s, warnings } = scaleRecipe(r, factor, smart);
    const groups = [];
    for (const ing of s.ings) {
      let g = groups[groups.length - 1];
      if (!g || g.name !== ing.group) groups.push((g = { name: ing.group, items: [] }));
      g.items.push(ing);
    }
    const y = formatYield(s);
    fill(body, 
      y && h('p', { class: 'muted' }, h('strong', null, 'Yield: '), y),
      s.ings.length > 0 && h('h2', null, 'Ingredients'),
      groups.map((g) => [g.name && h('h3', null, g.name), h('ul', { class: 'ing' }, g.items.map((i) => h('li', null, formatIngredient(i))))]),
      s.dir && h('h2', null, 'Directions'),
      s.dir && h('div', { class: 'dir' }, s.dir.split('\n').filter((l) => l.trim()).map((l) => h('p', null, l))),
      warnings.length > 0 && h('p', { class: 'note' }, warnings.join(' ')));
  }

  const quick = [['½×', new Frac(1n, 2n)], ['1×', new Frac(1n)], ['2×', new Frac(2n)], ['3×', new Frac(3n)]]
    .map(([label, f]) => h('button', { onclick: () => setFactor(f) }, label));

  const wakeBox = h('input', { type: 'checkbox', checked: false, onchange: () => setWake(wakeBox.checked) });
  let sentinel = null;
  async function acquire() {
    try { sentinel = await navigator.wakeLock.request('screen'); } catch { wakeBox.checked = false; toast('Could not keep the screen on'); }
  }
  const onVisible = () => { if (wakeBox.checked && document.visibilityState === 'visible') acquire(); };
  function setWake(on) {
    if (on) { acquire(); document.addEventListener('visibilitychange', onVisible); }
    else { sentinel?.release().catch(() => {}); sentinel = null; document.removeEventListener('visibilitychange', onVisible); }
  }
  releaseWake = () => setWake(false);

  const copy = async () => {
    const text = recipeToText(scaleRecipe(r, factor, smart).recipe);
    try { await navigator.clipboard.writeText(text); toast('Recipe copied'); }
    catch { toast('Copy is not available here'); }
  };
  const share = () => navigator.share({ title: r.title, text: recipeToText(scaleRecipe(r, factor, smart).recipe) }).catch(() => {});
  const saveCopy = () => {
    const s = scaleRecipe(r, factor, smart).recipe;
    s.title = factor.eq(new Frac(1n)) ? `${r.title} (copy)` : `${r.title} (scaled)`;
    viewEdit(null, s);
  };

  fill($app, 
    h('h1', null, r.title),
    r.categories.length > 0 && h('p', { class: 'muted small' }, r.categories.join(', ')),
    h('section', { class: 'card scale', 'aria-label': 'Scale this recipe' },
      h('strong', null, 'Scale'),
      h('div', { class: 'row' }, quick, h('label', { class: 'row' }, factorIn, ' ×')),
      h('div', { class: 'row' }, h('label', { class: 'row' }, 'Make', servIn, yieldLabel)),
      h('label', { class: 'check' }, smartIn, 'Smart units (8 Tbsp → ½ cup)')),
    body,
    h('div', { class: 'actions stack' },
      h('label', { class: 'check', hidden: !('wakeLock' in navigator) }, wakeBox, 'Keep screen on while cooking'),
      h('div', { class: 'row grow' },
        h('button', { onclick: () => { location.hash = `#/edit/${r.id}`; } }, 'Edit'),
        h('button', { onclick: copy }, 'Copy'),
        navigator.share && h('button', { onclick: share }, 'Share'),
        h('button', { onclick: saveCopy }, 'Save scaled copy'),
        h('button', { onclick: () => window.print() }, 'Print'))));
  paint();
  window.scrollTo(0, 0);
}

function viewEdit(id, template) {
  const existing = id ? lib.byId.get(id) : null;
  if (id && !existing) return viewMissing();
  const r = existing || template || { title: '', categories: [], yq: null, yu: '', yr: '', dir: '', ings: [], source: 'mine' };

  const title = h('input', { class: 'full', value: r.title, autocomplete: 'off', 'aria-label': 'Title' });
  const cats = h('input', { class: 'full', value: r.categories.join(', '), placeholder: 'e.g. Soups, Main dish', 'aria-label': 'Categories' });
  const yld = h('input', { class: 'full', value: formatYield(r) || r.yr, placeholder: 'e.g. 4 servings, 24 cookies', 'aria-label': 'Yield' });
  const dir = h('textarea', { 'aria-label': 'Directions', placeholder: 'Directions. Leave a blank line between paragraphs.' });
  dir.value = r.dir;
  const rowsBox = h('div');
  const datalist = h('datalist', { id: 'units' }, UNIT_CHOICES.filter(Boolean).map((u) => h('option', { value: u })));

  function addRow(vals = { amount: '', unit: '', item: '', group: '' }, focus = false) {
    const amount = h('input', { class: 'amt', value: vals.amount, placeholder: 'Amt', inputmode: 'text', 'aria-label': 'Amount' });
    const unit = h('input', { class: 'unit', value: vals.unit, placeholder: 'Unit', list: 'units', autocapitalize: 'off', 'aria-label': 'Unit' });
    const item = h('input', { class: 'item', value: vals.item, placeholder: 'Ingredient', 'aria-label': 'Ingredient' });
    const grp = h('input', { class: 'grp', value: vals.group, placeholder: 'Group (optional, e.g. Sauce)', 'aria-label': 'Group' });
    const row = h('div', { class: 'card ing-row' },
      h('div', { class: 'row' }, amount, unit), item, grp,
      h('div', { class: 'tools' },
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
      title: title.value.trim(), categories: splitCategories(cats.value), yq, yu, yr: text,
      dir: dir.value.trim(), ings,
    };
    await saveRecord(toRecord(recipe));
    toast('Saved');
    location.replace(`${location.pathname}${location.search}#/r/${recipe.id}`);
  }

  async function del() {
    const mine = existing.source === 'mine';
    const ok = await confirmDialog(
      mine ? `Delete "${existing.title}"?` : `Remove "${existing.title}" from your library? You can restore it later in Settings.`,
      mine ? 'Delete' : 'Remove', true);
    if (!ok) return;
    if (mine) await dropRecord(existing.id);
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
    h('h1', null, existing ? 'Edit recipe' : template ? 'Save as new recipe' : 'New recipe'),
    h('label', { class: 'field' }, h('span', null, 'Title'), title),
    h('label', { class: 'field' }, h('span', null, 'Categories'), cats),
    h('label', { class: 'field' }, h('span', null, 'Yield'), yld),
    h('h2', null, 'Ingredients'),
    h('p', { class: 'muted small' }, 'Amounts can be 2, 1/2, 1 1/2, 1.5 or ½. Use Group for headings like Sauce or Topping.'),
    datalist, rowsBox,
    h('button', { type: 'button', class: 'full', onclick: () => addRow(undefined, true) }, '+ Add ingredient'),
    h('label', { class: 'field' }, h('span', null, 'Directions'), dir),
    h('div', { class: 'row grow' },
      h('button', { class: 'primary', onclick: save }, 'Save'),
      h('button', { onclick: () => (template ? route() : history.back()) }, 'Cancel')),
    existing && h('div', { class: 'actions row grow' },
      existing.source === 'edited' && h('button', { onclick: revert }, 'Revert to original'),
      h('button', { class: 'danger', onclick: del }, existing.source === 'mine' ? 'Delete recipe' : 'Remove from library')));
  window.scrollTo(0, 0);
  if (!existing && !template) title.focus();
}

function viewMissing() {
  fill($app, h('h1', null, 'Recipe not found'), h('p', null, h('a', { href: '#/' }, 'Back to the library')));
}

// ----------------------------------------------------------------- settings

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

async function viewSettings() {
  const mine = [...lib.mine.values()];
  const counts = {
    new: mine.filter((m) => !m.deleted && !lib.base.some((b) => b.id === m.id)).length,
    edited: mine.filter((m) => !m.deleted && lib.base.some((b) => b.id === m.id)).length,
    removed: mine.filter((m) => m.deleted).length,
  };
  const swReady = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;
  const persisted = (await navigator.storage?.persisted?.().catch(() => false)) || false;
  const stat = (k, v) => h('div', { class: 'stat' }, h('span', null, k), h('strong', null, v));

  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: importBackup });

  async function importBackup() {
    const file = fileIn.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'recipelib' || !Array.isArray(data.records)) throw new Error('not a backup');
      const recs = data.records.filter((x) => x && typeof x.id === 'string');
      await store.putMany(recs);
      for (const x of recs) lib.mine.set(x.id, x);
      rebuild();
      toast(`Imported ${recs.length} recipe change${recs.length === 1 ? '' : 's'}`);
      viewSettings();
    } catch { toast('That file is not a Recipe Library backup'); }
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify({ app: 'recipelib', v: 1, records: [...lib.mine.values()] }, null, 1)], { type: 'application/json' });
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
    h('section', { class: 'card stack' },
      h('strong', null, 'Status'),
      stat('Recipes in library', lib.all.length.toLocaleString()),
      stat('Works offline', swReady ? 'Yes' : 'Not yet (open once while online)'),
      stat('Your changes are saved on this device', store.persistent ? 'Yes' : 'No (private browsing?)'),
      stat('Protected from automatic cleanup', persisted ? 'Yes' : 'No'),
      !persisted && navigator.storage?.persist && h('button', { onclick: async () => { toast((await navigator.storage.persist()) ? 'Done' : 'The browser declined'); viewSettings(); } }, 'Ask the browser to keep my data'),
      installPrompt && h('button', { class: 'primary', onclick: async () => { installPrompt.prompt(); installPrompt = null; viewSettings(); } }, 'Install app on this device')),
    h('h2', null, 'Your recipes'),
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

function route() {
  clearView();
  const hash = location.hash.replace(/^#\/?/, '');
  const [kind, arg] = hash.split('/');
  const id = arg ? decodeURIComponent(arg) : null;
  if (kind === 'r' && id) return viewRecipe(id);
  if (kind === 'edit' && id) return viewEdit(id);
  if (kind === 'new') return viewEdit(null);
  if (kind === 'settings') return viewSettings();
  return viewList();
}

async function boot() {
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
  route();
  registerWorker();
}

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    toast(hadController ? 'App updated. Reload to use the new version.' : 'Ready to use offline', 5000);
  });
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker failed:', err));
}

boot();
