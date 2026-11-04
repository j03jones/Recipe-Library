import {
  Frac, UNIT_CHOICES, amountForEditing, factorForServings, formatIngredient, formatYield,
  ingredientFromFields, parseYield, recipeToText, scaleRecipe, splitCategories,
} from './units.js';
import { fromRecord, fromRow, toRecord } from './model.js';
import * as store from './store.js';
import { SECTIONS } from './groups.js';
import { addStars, emojiFor, icon, isStarred, starIds, tile, toggleStar } from './ui.js';

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

const listState = { q: '', sec: -1, cat: '', shown: PAGE, scroll: 0 };
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

  function chipState() {
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
        tile(r.categories),
        h('span', { class: 'txt' },
          h('span', { class: 't' }, r.title, r.source !== 'base' && h('span', { class: 'badge' }, r.source === 'mine' ? 'Mine' : 'Edited')),
          h('span', { class: 'c' }, r.categories.length ? r.categories.slice(0, 2).join(', ') : `${r.ings.length} ingredients`))),
      starButton(r.id));
  }

  function paint() {
    let pool = matches(listState.q, listState.cat);
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
    const filtered = listState.q || listState.cat;
    fill(empty, h('div', { class: 'empty' },
      h('span', { class: 'tile big', 'aria-hidden': 'true', 'data-sec': filtered ? 6 : 0 }, filtered ? '🔎' : '⭐'),
      h('h2', null, filtered ? 'Nothing matches' : 'Nothing starred yet'),
      h('p', { class: 'muted' }, filtered
        ? 'Try fewer words, or search by an ingredient like “lemon”.'
        : 'Tap the star on a recipe to keep it here for quick access.'),
      filtered
        ? h('button', { onclick: () => { listState.q = ''; listState.sec = -1; listState.cat = ''; input.value = ''; chipState(); paint(); } }, 'Clear search and filters')
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
    !starredOnly && secRow, !starredOnly && groupsRow, count, ul, empty, more);
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

function viewRecipe(id) {
  const r = lib.byId.get(id);
  if (!r) return viewMissing();
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
    try { await navigator.clipboard.writeText(text); toast('Recipe copied'); }
    catch { toast('Copy is not available here'); }
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
      h('a', { class: 'icon-btn', href: `#/edit/${r.id}`, 'aria-label': 'Edit recipe', title: 'Edit recipe' }, icon('edit'))),
    h('div', { class: 'rhead' }, tile(r.categories, true), h('h1', null, r.title)),
    r.categories.length > 0 && h('div', { class: 'labels' }, r.categories.map((c) => h('span', { class: 'label' }, c))),
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
      r.tags && r.tags.length > 0 && h('p', { class: 'muted small' }, 'Original labels: ', r.tags.join(', '))));
  paint();
  window.scrollTo(0, 0);
}

function viewEdit(id, template) {
  setView('edit', 'new');
  const existing = id ? lib.byId.get(id) : null;
  if (id && !existing) return viewMissing();
  const r = existing || template || { title: '', categories: [], tags: [], yq: null, yu: '', yr: '', dir: '', ings: [], source: 'mine' };

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
      h('button', { onclick: () => (template ? route() : goBack(existing ? `#/r/${existing.id}` : '#/')) }, 'Cancel')),
    existing && h('div', { class: 'actions row grow' },
      existing.source === 'edited' && h('button', { onclick: revert }, 'Revert to original'),
      h('button', { class: 'danger', onclick: del }, existing.source === 'mine' ? 'Delete recipe' : 'Remove from library')));
  window.scrollTo(0, 0);
  if (!existing && !template) title.focus();
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
  if (kind === 'starred') return viewList(true);
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
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
    const view = document.body.dataset.view;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape' && (view === 'recipe' || view === 'edit')) { goBack('#/'); }
    else if (e.key === '/' && view === 'list' && !typing) { const s = document.querySelector('input[type=search]'); if (s) { e.preventDefault(); s.focus(); } }
  });
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
