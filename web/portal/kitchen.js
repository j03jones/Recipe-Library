// The restaurant side of the client portal (jonesridgekitchen.com/my-meals/): one restaurant's kitchen.
//
//   #kitchen/<id>                 Recipes: the collection, searchable; the team's own recipes marked Ours
//   #kitchen/<id>/<recipe id>     one recipe: scale, print, allergens, cost per portion; edit or delete if the team's
//   #kitchen/<id>/new             add a recipe (or /new/<recipe id>: start from a copy of one)
//   #kitchen/<id>/edit/<id>       change one of the team's recipes
//   #kitchen/<id>/costing         food cost: every recipe's cost per portion, menu price and food cost %
//   #kitchen/<id>/cost/<id>       one recipe's costing: a price for each ingredient
//   #kitchen/<id>/help            ask Joseph for help (emails him through the website's contact form)
//   #kitchen/<id>/team            owners: invite staff
//
// Who may do what is decided by the database (supabase/add_restaurant_kitchen.sql): the team adds recipes while
// the plan is on; the chef's recipes are read-only to them; staff change or delete the ones they added, owners any
// the team added. The price book is one shared document per restaurant (restaurant_kitchen).
import * as cloud from '../js/cloud.js';
import { detect } from '../js/allergens.js';
import { restaurantPlan } from '../js/clientcore.js';
import { toRecord, fromRecord } from '../js/model.js';
import { PRICE_UNITS, costing, defaultPriceUnit, foodCostPct, suggestedPrice } from '../js/nutrition.js';
import { clean as cleanPrices, DEFAULT_TARGET } from '../js/prices.js';
import { fromPlainText } from '../js/transfer.js';
import { Frac, adaptedLine, creditLine, formatIngredient, formatYield, scaleRecipe } from '../js/units.js';
import { busy, confirmBox, field, fill, h, screen, toast } from './ui.js';

const APP = 'https://recipes.jonesridgekitchen.com/';
const CONTACT_ANY = 'https://jonesridgekitchen.com/contact/';
const HELP_EMAIL = 'hello@jonesridgekitchen.com';
const DAYDATE = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' });
const money = (v) => (v == null || !Number.isFinite(v) ? '—' : `$${v.toFixed(2)}`);
const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v)}%`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

let deps = null;     // { root, top(key), me: { id, displayName, email }, preview }
/** portal.js hands over the page, its header and who is signed in. */
export function setup(d) { deps = d; }

// ------------------------------------------------------------------ data, kept for this visit
const cache = new Map();   // restaurant id -> { recipes, team: Set(user ids), kitchen }
export function reset() { cache.clear(); }

/** A database row as the app's recipe object (same reading as the recipe app), or null if unreadable. */
function toRecipe(row) {
  try {
    const rec = row.body && typeof row.body === 'object' ? row.body : {};
    const r = fromRecord({ ...rec, id: row.id, title: row.title, categories: (row.categories || []).filter((c) => typeof c === 'string'),
      tags: (Array.isArray(rec.tags) ? rec.tags : []).filter((t) => typeof t === 'string'),
      yu: String(rec.yu ?? ''), yr: String(rec.yr ?? ''), dir: String(rec.dir ?? ''),
      ings: (Array.isArray(rec.ings) ? rec.ings : []).filter(Array.isArray)
        .map(([q, raw, unit, item, group]) => [q, String(raw ?? ''), String(unit ?? ''), String(item ?? ''), String(group ?? '')])
        .filter(([q, raw, , item]) => q || raw || item) }, 'restaurant');
    r.row = row;
    r.photo = row.photo || null;
    r._hay = [row.title, r.categories.join(' '), r.ings.map((x) => x.item).join(' ')].join('\n').toLowerCase();
    return r;
  } catch { return null; }
}

/** The kitchen's price book, tidied: prices.js's shape plus portions per recipe. */
function cleanKitchen(v) {
  const out = cleanPrices(v);
  out.portions = {};
  const p = v && typeof v === 'object' ? v.portions : null;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    for (const [id, n] of Object.entries(p).slice(0, 5000)) { const x = Number(n); if (Number.isFinite(x) && x > 0 && x < 100000) out.portions[id] = Math.round(x * 100) / 100; }
  }
  return out;
}

async function load(rid, fresh = false) {
  if (!fresh && cache.has(rid)) return cache.get(rid);
  const [rows, members, kitchen] = await Promise.all([
    cloud.restaurantRecipes(rid),
    cloud.restaurantMembers(rid).catch(() => []),
    cloud.loadKitchen(rid).catch(() => ({})),
  ]);
  const team = new Set(members.map((m) => m.user_id));
  const recipes = rows.filter((x) => x.scope === 'restaurant' && x.restaurant_id === rid).map(toRecipe).filter(Boolean)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  for (const r of recipes) r.ours = team.has(r.row.owner_id);       // added by the restaurant's team, not the chef
  const data = { recipes, team, kitchen: cleanKitchen(kitchen) };
  cache.set(rid, data);
  return data;
}

/** Change the price book: read the latest (a colleague may have changed it), apply, save. */
async function changeKitchen(rid, fn) {
  const latest = cleanKitchen(await cloud.loadKitchen(rid));
  fn(latest);
  await cloud.saveKitchen(rid, latest);
  const data = cache.get(rid);
  if (data) data.kitchen = latest;
  return latest;
}

// ------------------------------------------------------------------ who may do what
function rights(m, plan) {
  const owner = m.member_role === 'owner';
  const on = plan.on && !deps.preview;
  return {
    owner,
    add: on,
    edit: (r) => on && r.ours && (owner || r.row.owner_id === deps.me.id),
    prices: on,
  };
}

// ------------------------------------------------------------------ the frame: header, tabs, plan state
function frame(m, tab, ...body) {
  const r = m.restaurant;
  const key = `kitchen/${r.id}`;
  const plan = restaurantPlan(r);
  const tabs = [['', 'Recipes'], ['costing', 'Costing'], ['help', 'Help']];
  if (m.member_role === 'owner' && !deps.preview) tabs.push(['team', 'Team']);
  fill(deps.root, ...deps.top(key),
    h('h2', { class: 'jrk-kitchen' }, r.name),
    plan.trial && plan.ends && !plan.ended && h('p', { class: 'note' }, `Free trial: ${plural(plan.daysLeft, 'day')} left (until ${DAYDATE.format(plan.ends)}).`),
    h('nav', { class: 'jrk-subnav jrk-noprint', 'aria-label': `${r.name}` }, tabs.map(([k, label]) =>
      h('a', { href: `#${key}${k ? `/${k}` : ''}`, 'aria-current': k === tab ? 'page' : null }, label))),
    body);
}

function paused(m) {
  const r = m.restaurant;
  const plan = restaurantPlan(r);
  return h('div', { class: 'jrk-card' }, h('h2', null, plan.ended ? 'Your trial has ended' : 'Your recipe collection is paused'),
    h('p', null, plan.ended
      ? `${r.name}’s free trial ended on ${DAYDATE.format(plan.ends)}, so the recipes are hidden. They are kept safe and come back as soon as the plan starts.`
      : `${r.name}’s plan with Jones Ridge Kitchen is not active right now, so the recipes are hidden. They are kept safe and come back as soon as the plan is renewed.`),
    h('p', null, h('a', { href: `#kitchen/${r.id}/help` }, 'Contact Jones Ridge Kitchen'), ' about the plan.'));
}

/** Loads the kitchen, or paints why not. Returns the data, or null when the screen is already painted. */
async function ready(m, tab, mine) {
  const plan = restaurantPlan(m.restaurant);
  if (!plan.on) { if (tab !== 'help') { frame(m, tab, paused(m)); return null; } return { recipes: [], team: new Set(), kitchen: cleanKitchen({}) }; }
  frame(m, tab, h('p', { class: 'note' }, 'Loading…'));
  try {
    const data = await load(m.restaurant.id);
    return mine === screen.id ? data : null;
  } catch (err) {
    if (mine !== screen.id) return null;
    frame(m, tab, h('p', { class: 'jrk-msg' }, `Could not load your kitchen: ${err.message}`),
      h('button', { class: 'btn', type: 'button', onclick: () => show(m, tab) }, 'Try again'));
    return null;
  }
}

/** portal.js's router hands over everything after #kitchen/<id>/. */
export function show(m, sub = '', arg = '', arg2 = '') {
  if (sub === 'costing') return viewCosting(m);
  if (sub === 'cost' && arg) return viewCostDetail(m, arg);
  if (sub === 'help') return viewHelp(m);
  if (sub === 'team') return viewTeam(m);
  if (sub === 'new') return viewEditor(m, null, arg || null);
  if (sub === 'edit' && arg) return viewEditor(m, arg);
  if (sub) return viewRecipe(m, sub);
  return viewList(m);
}

// ------------------------------------------------------------------ Recipes
async function viewList(m) {
  const mine = screen.next();
  const data = await ready(m, '', mine);
  if (!data) return;
  const r = m.restaurant;
  const key = `kitchen/${r.id}`;
  const can = rights(m, restaurantPlan(r));
  const list = data.recipes;
  const cats = [...new Set(list.flatMap((x) => x.categories))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  let q = '';
  try { q = sessionStorage.getItem(`jrk-q-${r.id}`) || ''; } catch { /* private mode */ }
  const search = h('input', { type: 'search', placeholder: 'Search by name or ingredient', 'aria-label': 'Search recipes', value: q });
  const cat = cats.length > 1 && h('select', { 'aria-label': 'Category' }, h('option', { value: '' }, 'All categories'), cats.map((c) => h('option', { value: c }, c)));
  const whose = list.some((x) => x.ours) && h('select', { 'aria-label': 'Whose recipes' },
    h('option', { value: '' }, 'Everyone’s'), h('option', { value: 'chef' }, 'From Jones Ridge Kitchen'), h('option', { value: 'ours' }, 'Ours'));
  const out = h('ul', { class: 'jrk-recipes' });
  const count = h('p', { class: 'note', role: 'status' });
  const paint = () => {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    try { sessionStorage.setItem(`jrk-q-${r.id}`, search.value); } catch { /* private mode */ }
    const c = cat ? cat.value : '';
    const w = whose ? whose.value : '';
    const hits = list.filter((x) => words.every((t) => x._hay.includes(t)) && (!c || x.categories.includes(c)) && (!w || (w === 'ours') === x.ours));
    count.textContent = hits.length === list.length ? plural(list.length, 'recipe') : `${hits.length} of ${plural(list.length, 'recipe')}`;
    fill(out, hits.length ? hits.map((x) => h('li', null, h('a', { href: `#${key}/${encodeURIComponent(x.id)}` },
      h('span', { class: 'jrk-rtitle' }, x.title, x.ours && h('span', { class: 'jrk-tag' }, 'Ours')),
      x.categories.length > 0 && h('span', { class: 'note' }, x.categories.join(' · ')))))
      : h('li', { class: 'note' }, 'No recipes match that search.'));
  };
  search.addEventListener('input', paint);
  if (cat) cat.addEventListener('change', paint);
  if (whose) whose.addEventListener('change', paint);
  paint();
  frame(m, '',
    can.add && h('div', { class: 'jrk-row jrk-actions' }, h('a', { class: 'btn', href: `#${key}/new` }, '+ Add a recipe')),
    list.length
      ? [h('div', { class: 'jrk-row jrk-find' }, search, cat, whose), count, out]
      : h('div', { class: 'jrk-card' }, h('h2', null, 'No recipes yet'),
        h('p', null, can.add ? 'Joseph is building your collection. You can add your own recipes too.' : 'Joseph is building your collection. Recipes appear here as soon as they are added.')),
    h('p', { class: 'note' }, 'Recipes from Jones Ridge Kitchen are kept up to date by Joseph. ',
      can.add ? 'Recipes marked Ours are your team’s: you can change them. ' : '',
      'Cooking from a phone or tablet? The ', h('a', { href: APP }, 'recipe app'), ' has the same collection with cook mode and timers, using this login.'));
}

/** Ingredient names as the allergen checker reads them. */
const allergensOf = (recipe) => detect(recipe.ings.map((i) => i.item)).map((d) => d.allergen);

async function viewRecipe(m, recipeId) {
  const mine = screen.next();
  const data = await ready(m, '', mine);
  if (!data) return;
  const r = m.restaurant;
  const key = `kitchen/${r.id}`;
  const can = rights(m, restaurantPlan(r));
  const base = data.recipes.find((x) => x.id === recipeId);
  const back = h('p', { class: 'jrk-back jrk-noprint' }, h('a', { href: `#${key}` }, `← All ${r.name} recipes`));
  if (!base) { frame(m, '', back, h('div', { class: 'jrk-card' }, h('h2', null, 'Recipe not found'), h('p', null, 'It may have been removed from your collection.'))); return; }

  const factorIn = h('input', { type: 'text', inputmode: 'decimal', value: '1', size: '4', 'aria-label': 'Multiplier' });
  const yieldLine = h('p', { class: 'jrk-yield' });
  const ingsBox = h('div', { class: 'jrk-ings-list' });
  const warn = h('p', { class: 'note' });
  const quick = h('div', { class: 'jrk-row jrk-scale jrk-noprint', role: 'group', 'aria-label': 'Scale the recipe' },
    h('span', { class: 'note' }, 'Scale'),
    ['1/2', '1', '2', '3', '4'].map((f) => h('button', { type: 'button', class: 'btn line small', onclick: () => { factorIn.value = f; paint(); } }, f === '1/2' ? '½×' : `${f}×`)),
    h('label', { class: 'jrk-row' }, '×', factorIn));
  factorIn.addEventListener('input', () => paint());
  function paint() {
    let f = Frac.parse(factorIn.value.trim().replace(/×|x$/i, ''));
    if (!f || f.n <= 0n) f = Frac.parse('1');
    let shown = base, warnings = [];
    try { ({ recipe: shown, warnings } = scaleRecipe(base, f)); } catch { /* leave it unscaled */ }
    const y = formatYield(shown);
    yieldLine.textContent = y ? `Makes ${y}${factorIn.value.trim() && factorIn.value.trim() !== '1' ? ` (${factorIn.value.trim()}×)` : ''}` : '';
    const groups = [];
    for (const ing of shown.ings) {
      if (!groups.length || groups[groups.length - 1].name !== ing.group) groups.push({ name: ing.group, items: [] });
      groups[groups.length - 1].items.push(ing);
    }
    fill(ingsBox, groups.map((g) => [g.name && h('h4', null, g.name), h('ul', null, g.items.map((ing) => h('li', null, formatIngredient(ing))))]));
    warn.textContent = warnings.join(' ');
  }
  paint();

  const steps = base.dir ? base.dir.split('\n').map((x) => x.trim()).filter(Boolean) : [];
  const photo = h('div', { class: 'jrk-photo' });
  if (base.photo) cloud.downloadPhoto(base.photo).then((blob) => { if (mine === screen.id) fill(photo, h('img', { src: URL.createObjectURL(blob), alt: base.title })); }).catch(() => {});
  const credit = [creditLine(base), adaptedLine(base)].filter(Boolean).join(' · ');
  const allergens = allergensOf(base);
  const c = costing(base, data.kitchen.items);
  const portions = data.kitchen.portions[base.id] || c.servings || 0;
  const perPortion = portions ? c.total / portions : null;

  const del = can.edit(base) && h('button', { class: 'btn line danger', type: 'button', onclick: async () => {
    if (!await confirmBox(`Delete “${base.title}”? Your whole team loses it. This cannot be undone.`, 'Delete', true)) return;
    try { await cloud.deleteKitchenRecipe(base.id); await load(r.id, true); toast('Deleted'); location.hash = `#${key}`; } catch (err) { toast(err.message); }
  } }, 'Delete');

  frame(m, '', back,
    h('article', { class: 'jrk-recipe' },
      h('h2', null, base.title),
      h('p', { class: 'note' }, [base.categories.join(' · '), base.ours ? 'Your team’s recipe' : 'From Jones Ridge Kitchen'].filter(Boolean).join(' · ')),
      credit && h('p', { class: 'note' }, credit),
      photo,
      yieldLine, quick, warn,
      h('h3', null, 'Ingredients'), ingsBox,
      steps.length > 0 && [h('h3', null, 'Method'), h('ol', { class: 'jrk-steps' }, steps.map((x) => h('li', null, x)))],
      h('div', { class: 'jrk-facts' },
        h('p', null, h('strong', null, 'Allergens: '), allergens.length ? allergens.join(', ') : 'none of the major allergens found in the ingredient names',
          h('span', { class: 'note' }, '. Worked out from the ingredient names: check bought sauces, stocks and mixes yourself.')),
        h('p', { class: 'jrk-noprint' }, h('strong', null, 'Food cost: '),
          c.total > 0 ? `${money(c.total)} a batch${perPortion != null ? `, ${money(perPortion)} a portion` : ''}${c.missing ? ` (${plural(c.missing, 'ingredient')} not priced yet)` : ''}. ` : 'not worked out yet. ',
          h('a', { href: `#${key}/cost/${encodeURIComponent(base.id)}` }, c.total > 0 ? 'See the costing' : 'Add prices'))),
      h('p', { class: 'note jrk-printnote' }, `${r.name} · Jones Ridge Kitchen recipe collection`),
      h('div', { class: 'jrk-row jrk-noprint' },
        h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, 'Print'),
        can.edit(base) && h('a', { class: 'btn line', href: `#${key}/edit/${encodeURIComponent(base.id)}` }, 'Edit'),
        !base.ours && can.add && h('a', { class: 'btn line', href: `#${key}/new/${encodeURIComponent(base.id)}` }, 'Make our own version'),
        del)));
  deps.root.scrollIntoView({ block: 'start' });
}

// ------------------------------------------------------------------ add or change a recipe
const linesOf = (recipe) => {
  const out = [];
  let group = '';
  for (const ing of recipe.ings) {
    if (ing.group !== group) { group = ing.group; if (group) out.push(`${group}:`); }
    out.push(formatIngredient(ing));
  }
  return out.join('\n');
};

async function viewEditor(m, recipeId, copyOf = null) {
  const mine = screen.next();
  const data = await ready(m, '', mine);
  if (!data) return;
  const r = m.restaurant;
  const key = `kitchen/${r.id}`;
  const can = rights(m, restaurantPlan(r));
  const existing = recipeId ? data.recipes.find((x) => x.id === recipeId) : null;
  const from = copyOf ? data.recipes.find((x) => x.id === copyOf) : null;
  if ((recipeId && (!existing || !can.edit(existing))) || (!recipeId && !can.add)) {
    frame(m, '', h('div', { class: 'jrk-card' }, h('h2', null, 'You can’t change this recipe'),
      h('p', null, existing && !existing.ours ? 'Recipes from Jones Ridge Kitchen are kept by Joseph. Use “Make our own version” to start your own from it.' : 'Ask your restaurant’s owner, or contact Jones Ridge Kitchen.'),
      h('p', null, h('a', { href: `#${key}` }, '← All recipes'))));
    return;
  }
  const start = existing || from;
  const title = h('input', { type: 'text', maxlength: '300', required: true, value: start ? (from ? `${from.title} (our version)` : start.title) : '', 'aria-label': 'Recipe name' });
  const cats = h('input', { type: 'text', maxlength: '200', value: start ? start.categories.join(', ') : '', placeholder: 'Sauces, Mains', 'aria-label': 'Categories' });
  const makes = h('input', { type: 'text', maxlength: '60', value: start ? formatYield(start) : '', placeholder: '4 servings, 2 quarts, 1 hotel pan', 'aria-label': 'Makes' });
  const ings = h('textarea', { rows: '10', maxlength: '20000', 'aria-label': 'Ingredients', placeholder: '2 lb ground beef\n1 cup onion, diced\nSauce:\n1/2 cup ketchup' });
  ings.value = start ? linesOf(start) : '';
  const dir = h('textarea', { rows: '10', maxlength: '20000', 'aria-label': 'Method', placeholder: 'One step per line.' });
  dir.value = start ? start.dir : '';
  const note = h('p', { class: 'jrk-msg', role: 'alert' });
  const save = h('button', { class: 'btn', type: 'submit' }, existing ? 'Save changes' : 'Add to our recipes');

  const form = h('form', { class: 'form jrk-editor', onsubmit: async (e) => {
    e.preventDefault();
    note.textContent = '';
    if (!title.value.trim()) { note.textContent = 'Give the recipe a name.'; title.focus(); return; }
    // read it the way the importer reads a pasted recipe: amounts, units, groups ("Sauce:"), tables
    const parsed = fromPlainText([title.value.trim(), makes.value.trim() && `Makes: ${makes.value.trim()}`, 'Ingredients', ings.value, 'Directions', dir.value].filter(Boolean).join('\n'));
    if (!parsed.ings.length && !parsed.dir.trim()) { note.textContent = 'Add the ingredients or the method.'; return; }
    const recipe = { ...parsed, title: title.value.trim(), categories: cats.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10), dir: dir.value.split('\n').map((x) => x.trim()).filter(Boolean).join('\n') };
    const { id, updated, ...record } = toRecord(recipe);
    busy(save, true);
    try {
      const row = existing ? await cloud.updateRecipe(existing.id, record) : await cloud.addToCollection(record, r.id);
      await load(r.id, true);
      try { sessionStorage.removeItem(`jrk-q-${r.id}`); } catch { /* private mode */ }   // so the list shows it, not an old search
      toast(existing ? 'Saved' : 'Added to your recipes');
      location.hash = `#${key}/${encodeURIComponent(row.id)}`;
    } catch (err) { note.textContent = err.message; } finally { busy(save, false); }
  } },
  h('div', { class: 'full' }, field('Recipe name', title)),
  h('div', { class: 'full' }, field('Categories', cats, '(separate with commas)')),
  h('div', { class: 'full' }, field('Makes', makes)),
  h('div', { class: 'full' }, field('Ingredients', ings, '(one per line: amount, unit, ingredient; a line ending in a colon starts a group)')),
  h('div', { class: 'full' }, field('Method', dir, '(one step per line)')),
  h('div', { class: 'full' }, note),
  h('div', { class: 'full jrk-row' }, save, h('a', { class: 'btn line', href: existing ? `#${key}/${encodeURIComponent(existing.id)}` : `#${key}` }, 'Cancel')));

  frame(m, '', h('p', { class: 'jrk-back' }, h('a', { href: `#${key}` }, `← All ${r.name} recipes`)),
    h('div', { class: 'jrk-card' }, h('h2', null, existing ? `Change “${existing.title}”` : from ? `Our version of “${from.title}”` : 'Add a recipe'),
      !existing && h('p', { class: 'note' }, 'It is added to your restaurant’s recipes, for your whole team. Recipes from Jones Ridge Kitchen stay as Joseph keeps them.'),
      form));
  title.focus();
}

// ------------------------------------------------------------------ Costing
function costRow(recipe, kitchen) {
  const c = costing(recipe, kitchen.items);
  const portions = kitchen.portions[recipe.id] || c.servings || 0;
  const per = portions && c.total > 0 ? c.total / portions : null;
  const menu = kitchen.menu[recipe.id] || null;
  return { c, portions, per, menu, fc: per != null && menu ? foodCostPct(per, menu) : null, suggested: per != null ? suggestedPrice(per, kitchen.target) : null };
}

async function viewCosting(m) {
  const mine = screen.next();
  const data = await ready(m, 'costing', mine);
  if (!data) return;
  const r = m.restaurant;
  const key = `kitchen/${r.id}`;
  const can = rights(m, restaurantPlan(r));
  const k = data.kitchen;
  const target = h('input', { type: 'number', min: '1', max: '100', step: '1', value: String(k.target || DEFAULT_TARGET), disabled: !can.prices, 'aria-label': 'Target food cost %' });
  target.addEventListener('change', async () => {
    try { await changeKitchen(r.id, (d) => { d.target = cleanPrices({ target: target.value }).target; }); viewCosting(m); } catch (err) { toast(err.message); }
  });
  const search = h('input', { type: 'search', placeholder: 'Search recipes', 'aria-label': 'Search costing' });
  const table = h('tbody');
  const paint = () => {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = data.recipes.filter((x) => words.every((t) => x._hay.includes(t)));
    fill(table, rows.map((x) => {
      const row = costRow(x, k);
      const over = row.fc != null && row.fc > k.target;
      return h('tr', null,
        h('th', { scope: 'row' }, h('a', { href: `#${key}/cost/${encodeURIComponent(x.id)}` }, x.title),
          row.c.missing > 0 && h('span', { class: 'note jrk-missing' }, ` ${plural(row.c.missing, 'price')} missing`)),
        h('td', { 'data-label': 'Batch' }, row.c.total > 0 ? money(row.c.total) : '—'),
        h('td', { 'data-label': 'Portion' }, row.per != null ? money(row.per) : row.c.total > 0 ? h('a', { href: `#${key}/cost/${encodeURIComponent(x.id)}` }, 'set portions') : '—'),
        h('td', { 'data-label': 'Menu price' }, row.menu ? money(row.menu) : '—'),
        h('td', { 'data-label': 'Food cost', class: over ? 'jrk-over' : '' }, pct(row.fc)),
        h('td', { 'data-label': `At ${k.target}%` }, row.suggested != null ? money(row.suggested) : '—'));
    }));
  };
  search.addEventListener('input', paint);
  paint();

  const items = Object.entries(k.items).sort(([a], [b]) => a.localeCompare(b));
  const priceSearch = h('input', { type: 'search', placeholder: 'Search prices', 'aria-label': 'Search ingredient prices' });
  const priceList = h('ul', { class: 'jrk-list' });
  const paintPrices = () => {
    const q = priceSearch.value.trim().toLowerCase();
    fill(priceList, items.filter(([name]) => !q || name.includes(q)).map(([name, p]) => h('li', null,
      h('span', null, name), h('span', { class: 'jrk-row' }, h('span', null, `${money(p.p)} / ${PRICE_UNITS[p.per]?.label || p.per}`),
        can.prices && h('button', { class: 'jrk-link', type: 'button', 'aria-label': `Remove the price of ${name}`, onclick: async () => {
          try { await changeKitchen(r.id, (d) => { delete d.items[name]; }); toast('Price removed'); viewCosting(m); } catch (err) { toast(err.message); }
        } }, 'Remove')))));
  };
  priceSearch.addEventListener('input', paintPrices);
  paintPrices();

  frame(m, 'costing',
    h('p', null, 'What each recipe costs to make, from your ingredient prices. Open a recipe to price its ingredients; a price you enter is used in every recipe with that ingredient.'),
    h('div', { class: 'jrk-row jrk-find' }, search, h('label', { class: 'jrk-row jrk-target' }, 'Target food cost', target, '%')),
    data.recipes.length
      ? h('div', { class: 'jrk-tablewrap' }, h('table', { class: 'jrk-cost' },
        h('thead', null, h('tr', null, ['Recipe', 'Batch', 'Portion', 'Menu price', 'Food cost', `Price at ${k.target}%`].map((t) => h('th', { scope: 'col' }, t)))), table))
      : h('p', { class: 'note' }, 'No recipes to cost yet.'),
    h('details', { class: 'jrk-card jrk-prices' }, h('summary', null, h('strong', null, `Ingredient prices (${items.length})`)),
      items.length ? [priceSearch, priceList] : h('p', { class: 'note' }, 'No prices yet. Open a recipe above and add a price for each ingredient.')),
    !can.prices && h('p', { class: 'note' }, deps.preview ? 'Preview: prices can’t be changed here.' : 'Prices can be changed while your plan is active.'));
}

async function viewCostDetail(m, recipeId) {
  const mine = screen.next();
  const data = await ready(m, 'costing', mine);
  if (!data) return;
  const r = m.restaurant;
  const key = `kitchen/${r.id}`;
  const can = rights(m, restaurantPlan(r));
  const recipe = data.recipes.find((x) => x.id === recipeId);
  const back = h('p', { class: 'jrk-back' }, h('a', { href: `#${key}/costing` }, '← All costing'));
  if (!recipe) { frame(m, 'costing', back, h('div', { class: 'jrk-card' }, h('h2', null, 'Recipe not found'))); return; }
  const k = data.kitchen;
  const row = costRow(recipe, k);
  const save = async (fn, msg) => { try { await changeKitchen(r.id, fn); if (msg) toast(msg); viewCostDetail(m, recipeId); } catch (err) { toast(err.message); } };

  const lines = row.c.lines.map((l) => {
    const unit = h('select', { 'aria-label': `Price unit for ${l.ing.item}`, disabled: !can.prices || l.state === 'free' || l.state === 'noamount' },
      Object.entries(PRICE_UNITS).map(([u, d]) => h('option', { value: u }, `per ${d.label}`)));
    unit.value = l.price?.per || defaultPriceUnit(l.ing, l.entry);
    const price = h('input', { type: 'number', min: '0', step: '0.01', inputmode: 'decimal', value: l.price ? String(l.price.p) : '', placeholder: '$',
      disabled: !can.prices || l.state === 'free' || l.state === 'noamount', 'aria-label': `Price of ${l.ing.item}` });
    const commit = () => {
      const v = price.value.trim();
      if (v === '' && !l.price) return;
      save((d) => { const p = parseFloat(v); if (v === '' || !(p >= 0)) delete d.items[l.key]; else d.items[l.key] = { p: Math.round(p * 10000) / 10000, per: unit.value }; }, 'Price saved');
    };
    price.addEventListener('change', commit);
    unit.addEventListener('change', () => { if (price.value.trim()) commit(); });
    const status = { free: 'not counted (water, salt…)', noamount: 'no amount to cost', noprice: 'needs a price', noconvert: 'unit doesn’t match: try another price unit' }[l.state];
    return h('tr', null,
      h('th', { scope: 'row' }, formatIngredient(l.ing), status && h('span', { class: 'note jrk-missing' }, ` ${status}`)),
      h('td', { 'data-label': 'Price' }, h('span', { class: 'jrk-row jrk-pricein' }, price, unit)),
      h('td', { 'data-label': 'Cost', class: 'jrk-linecost' }, l.cost != null ? money(l.cost) : '—'));
  });

  const portions = h('input', { type: 'number', min: '0', step: '1', value: k.portions[recipe.id] ? String(k.portions[recipe.id]) : '', placeholder: row.c.servings ? String(row.c.servings) : 'e.g. 20',
    disabled: !can.prices, 'aria-label': 'Portions per batch' });
  portions.addEventListener('change', () => save((d) => { const n = Number(portions.value); if (n > 0) d.portions[recipe.id] = n; else delete d.portions[recipe.id]; }));
  const menu = h('input', { type: 'number', min: '0', step: '0.01', value: row.menu ? String(row.menu) : '', placeholder: '$', disabled: !can.prices, 'aria-label': 'Menu price' });
  menu.addEventListener('change', () => save((d) => { const v = parseFloat(menu.value); if (v > 0) d.menu[recipe.id] = Math.round(v * 100) / 100; else delete d.menu[recipe.id]; }));

  frame(m, 'costing', back,
    h('h2', null, recipe.title),
    h('p', { class: 'note' }, formatYield(recipe) ? `The recipe makes ${formatYield(recipe)}.` : 'The recipe doesn’t say how much it makes: enter the portions below.',
      ' ', h('a', { href: `#${key}/${encodeURIComponent(recipe.id)}` }, 'Open the recipe')),
    h('div', { class: 'jrk-tablewrap' }, h('table', { class: 'jrk-cost jrk-costlines' },
      h('thead', null, h('tr', null, ['Ingredient', 'Price', 'Cost'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, lines),
      h('tfoot', null, h('tr', null, h('th', { scope: 'row' }, 'Batch'), h('td', { class: 'jrk-empty' }), h('td', { 'data-label': 'Batch', class: 'jrk-linecost' }, h('strong', null, money(row.c.total))))))),
    h('div', { class: 'jrk-card jrk-summary' },
      h('div', { class: 'jrk-row' }, field('Portions per batch', portions), field('Menu price', menu)),
      h('p', null, h('strong', null, 'Cost per portion: '), row.per != null ? money(row.per) : '—',
        row.fc != null && [' · ', h('strong', null, 'Food cost: '), h('span', { class: row.fc > k.target ? 'jrk-over' : '' }, pct(row.fc))]),
      row.suggested != null && h('p', null, h('strong', null, `Menu price for ${k.target}% food cost: `), money(row.suggested)),
      row.c.missing > 0 && h('p', { class: 'note' }, `${plural(row.c.missing, 'ingredient')} still ${row.c.missing === 1 ? 'needs' : 'need'} a price, so the cost is low.`)),
    !can.prices && h('p', { class: 'note' }, deps.preview ? 'Preview: prices can’t be changed here.' : 'Prices can be changed while your plan is active.'));
}

// ------------------------------------------------------------------ Help
function viewHelp(m) {
  screen.next();
  const r = m.restaurant;
  const topic = h('select', { 'aria-label': 'What it is about' },
    ['A recipe', 'Costing and prices', 'Logins and staff', 'Our plan', 'Something else'].map((t) => h('option', null, t)));
  const msg = h('textarea', { rows: '6', maxlength: '4000', required: true, 'aria-label': 'Your message', placeholder: 'What do you need? Mention the recipe if it is about one.' });
  const phone = h('input', { type: 'tel', maxlength: '40', autocomplete: 'tel', 'aria-label': 'Phone (optional)' });
  const note = h('p', { class: 'jrk-msg', role: 'status' });
  const send = h('button', { class: 'btn', type: 'submit', disabled: !!deps.preview }, 'Send to Joseph');
  const startedAt = Date.now();
  const mailto = `mailto:${HELP_EMAIL}?subject=${encodeURIComponent(`${r.name}: help`)}`;
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    if (!msg.value.trim()) { note.textContent = 'Please write your message.'; msg.focus(); return; }
    busy(send, true); note.textContent = '';
    const asEmail = `${mailto}&body=${encodeURIComponent(`${topic.value}\n\n${msg.value.trim()}`)}`;
    try {
      const res = await fetch('/api/inquiry', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Request-Id': `help-${startedAt}` },
        body: JSON.stringify({ name: deps.me.displayName || deps.me.email, email: deps.me.email, phone: phone.value.trim(), service: 'consulting', started: startedAt,
          message: `Help request from ${r.name} (client portal) · ${topic.value}\n\n${msg.value.trim()}` }) });
      // the website's own contact form sends it (its worker emails Joseph); elsewhere there is no such form
      if (res.status === 404 || res.status === 405 || res.status === 501) throw Object.assign(new Error('The message couldn’t be sent from this page.'), { email: true });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out.error) throw new Error(out.error || 'The message could not be sent.');
      fill(form.parentElement, h('h2', null, 'Sent'), h('p', null, `Thanks. Joseph will reply to ${deps.me.email}.`),
        h('p', null, h('a', { href: `#kitchen/${r.id}` }, '← Back to your recipes')));
    } catch (err) {
      note.replaceChildren(`${err.message} `, h('a', { class: 'btn line small', href: asEmail }, 'Send it as an email instead'));
    } finally { busy(send, false); }
  } },
  h('div', { class: 'full' }, field('What it is about', topic)),
  h('div', { class: 'full' }, field('Your message', msg)),
  h('div', { class: 'full' }, field('Phone', phone, '(optional, if a call is easier)')),
  h('div', { class: 'full' }, note),
  h('div', { class: 'full' }, send));
  frame(m, 'help',
    h('div', { class: 'jrk-card' }, h('h2', null, 'Ask Joseph'),
      h('p', null, `Questions about a recipe, costing, logins or ${r.name}’s plan. Joseph replies by email, to ${deps.me.email || 'you'}.`),
      deps.preview ? h('p', { class: 'note' }, 'Preview: the form is switched off here.') : form),
    h('p', { class: 'note' }, 'Or email ', h('a', { href: mailto }, HELP_EMAIL), ', or use the ', h('a', { href: CONTACT_ANY }, 'contact page'), '.'));
}

// ------------------------------------------------------------------ Team (owners)
function viewTeam(m) {
  screen.next();
  const r = m.restaurant;
  if (m.member_role !== 'owner' || deps.preview) { location.hash = `#kitchen/${r.id}`; return; }
  const out = h('div', { 'aria-live': 'polite' });
  const seats = h('p', { class: 'note' });
  cloud.restaurantMembers(r.id).then((rows) => { seats.textContent = `${rows.length} of ${r.seat_limit} logins in use.`; }).catch(() => {});
  const btn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    busy(btn, true);
    try {
      const code = await cloud.createInvite('restaurant', r.id, 'staff', 1, 14);
      const link = `${location.origin}${location.pathname}?join=${encodeURIComponent(code)}`;
      const subject = `Your ${r.name} recipe login`;
      const body = `Hi,\n\nHere is your login for the ${r.name} recipe collection from Jones Ridge Kitchen:\n${link}\n\nChoose "First time here", use your own email and a password. Your invite code is ${code} (it works once, for 14 days).\n`;
      fill(out, h('div', { class: 'jrk-invite' },
        h('p', null, 'Send this link to one person. It works once, for 14 days.'),
        h('p', null, h('code', null, link)),
        h('p', { class: 'note' }, `Invite code: ${code}`),
        h('div', { class: 'jrk-row' },
          h('button', { class: 'btn line small', type: 'button', onclick: async () => {
            try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { toast('Select the link and copy it'); }
          } }, 'Copy link'),
          h('a', { class: 'btn line small', href: `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` }, 'Email it'))));
    } catch (err) { toast(err.message); } finally { busy(btn, false); }
  } }, 'Invite someone');
  frame(m, 'team', h('div', { class: 'jrk-card' }, h('h2', null, 'Your team'),
    h('p', null, 'Give a cook or manager their own login. They see the same recipes and prices and can add recipes; staff can change only the recipes they added. Only owners can invite.'),
    seats, btn, out));
}
