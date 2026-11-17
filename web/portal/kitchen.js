// The restaurant side of the client portal (jonesridgekitchen.com/my-meals/): one restaurant's kitchen.
//
//   #kitchen/<id>                 Recipes: the collection, searchable; the team's own marked Ours, the chef's new ones New
//   #kitchen/<id>/<recipe id>     one recipe: scale, print, photo, allergens, cost per portion; edit or delete if the team's
//   #kitchen/<id>/new             add a recipe (or /new/<recipe id>: start from a copy of one)
//   #kitchen/<id>/edit/<id>       change one of the team's recipes
//   #kitchen/<id>/prep            prep list: recipes and batches, one combined ingredient list by aisle
//   #kitchen/<id>/costing         food cost: recipes and plates, menu prices, food cost % (if the owner allows)
//   #kitchen/<id>/cost/<id>       one recipe's costing: a price for each ingredient
//   #kitchen/<id>/sheet           the costing sheet: every ingredient in the recipes, once, with its price
//   #kitchen/<id>/plate/<id|new>  a plate: recipes and single ingredients ("1 oz tomato slices") in one menu item
//   #kitchen/<id>/help            ask Joseph for help (kept in his inbox, and emailed through the website's form)
//   #kitchen/<id>/team            owners: the team, who sees the costing, invites
//
// Who may do what is decided by the database (supabase/add_restaurant_kitchen.sql, add_restaurant_team.sql): the
// team adds recipes while the plan is on; the chef's recipes are read-only to them; staff change or delete the ones
// they added, owners any the team added. Costing is the owner's: each staff member has none, view or edit.
import * as cloud from '../js/cloud.js';
import { detect } from '../js/allergens.js';
import { PACKAGES, packageOf, restaurantPlan } from '../js/clientcore.js';
import { toRecord, fromRecord } from '../js/model.js';
import { PRICE_UNITS, costing, defaultPriceUnit, foodCostPct, nutrition, suggestedPrice } from '../js/nutrition.js';
import { macroDetails, nutrientTiles } from '../js/nutritionui.js';
import * as photos from '../js/photos.js';
import { clean as cleanPrices, DEFAULT_TARGET } from '../js/prices.js';
import { byAisle, itemName, shoppingList } from '../js/shopping.js';
import { fromPlainText } from '../js/transfer.js';
import { parseIngredientLine } from '../js/webimport.js';
import { supplierImport } from '../js/supplierui.js';
import { Frac, adaptedLine, creditLine, formatIngredient, formatYield, scaleRecipe } from '../js/units.js';
import { busy, confirmBox, field, fill, h, screen, toast } from './ui.js';

const APP = 'https://recipes.jonesridgekitchen.com/';
const CONTACT_ANY = 'https://jonesridgekitchen.com/contact/';
const HELP_EMAIL = 'hello@jonesridgekitchen.com';
const DAYDATE = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' });
const WHEN = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const money = (v) => (v == null || !Number.isFinite(v) ? '—' : `$${v.toFixed(2)}`);
const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v)}%`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const enc = encodeURIComponent;
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let deps = null;     // { root, top(key), me: { id, displayName, email }, preview }
/** portal.js hands over the page, its header and who is signed in. */
export function setup(d) { deps = d; }

// ------------------------------------------------------------------ data, kept for this visit
const cache = new Map();   // restaurant id -> { recipes, team: Set(user ids), kitchen, seenBefore }
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

/** The kitchen's price book, tidied: prices.js's shape, plus portions per recipe and plates. */
function cleanKitchen(v) {
  const out = cleanPrices(v);
  const obj = v && typeof v === 'object' ? v : {};
  out.portions = {};
  if (obj.portions && typeof obj.portions === 'object' && !Array.isArray(obj.portions)) {
    for (const [id, n] of Object.entries(obj.portions).slice(0, 5000)) { const x = Number(n); if (Number.isFinite(x) && x > 0 && x < 100000) out.portions[id] = Math.round(x * 100) / 100; }
  }
  out.plates = [];
  for (const p of (Array.isArray(obj.plates) ? obj.plates : []).slice(0, 500)) {
    if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name.trim()) continue;
    const menu = Number(p.menu);
    out.plates.push({
      id: String(p.id || '').slice(0, 40) || Math.random().toString(36).slice(2, 10),
      name: p.name.trim().slice(0, 100),
      menu: Number.isFinite(menu) && menu > 0 && menu < 100000 ? Math.round(menu * 100) / 100 : null,
      // a part is a recipe ({ id, n portions }) or a single ingredient line ({ t: '1 oz tomato slices' })
      parts: (Array.isArray(p.parts) ? p.parts : []).slice(0, 40)
        .map((x) => (x && typeof x.t === 'string' ? { t: x.t.replace(/\s+/g, ' ').trim().slice(0, 120) } : { id: String(x?.id || ''), n: Number(x?.n) }))
        .filter((x) => ('t' in x ? !!x.t : x.id && Number.isFinite(x.n) && x.n > 0 && x.n < 1000)),
    });
  }
  return out;
}

async function load(m, fresh = false) {
  const rid = m.restaurant.id;
  if (!fresh && cache.has(rid)) return cache.get(rid);
  const [rows, members, kitchen] = await Promise.all([
    cloud.restaurantRecipes(rid),
    cloud.restaurantMembers(rid).catch(() => []),
    seesCosting(m) ? cloud.loadKitchen(rid).catch(() => ({})) : Promise.resolve({}),
  ]);
  const team = new Set(members.map((x) => x.user_id));
  const recipes = rows.filter((x) => x.scope === 'restaurant' && x.restaurant_id === rid).map(toRecipe).filter(Boolean)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  for (const r of recipes) r.ours = team.has(r.row.owner_id);       // added by the restaurant's team, not the chef
  // "New": the chef's recipes added since this person's last visit on this device (none on a first visit)
  const seenKey = `jrk-seen-${rid}-${deps.me.id}`;
  const seenBefore = cache.get(rid)?.seenBefore ?? store.get(seenKey);
  if (!deps.preview) store.set(seenKey, new Date().toISOString());
  for (const r of recipes) r.isNew = !r.ours && !!seenBefore && !!r.row.created_at && r.row.created_at > seenBefore;
  const data = { recipes, team, kitchen: cleanKitchen(kitchen), seenBefore };
  cache.set(rid, data);
  return data;
}

/** Change the price book: read the latest (a colleague may have changed it), apply, save. */
async function changeKitchen(m, fn) {
  const rid = m.restaurant.id;
  const latest = cleanKitchen(await cloud.loadKitchen(rid));
  fn(latest);
  await cloud.saveKitchen(rid, latest);
  const data = cache.get(rid);
  if (data) data.kitchen = latest;
  return latest;
}

// ------------------------------------------------------------------ who may do what
/** Costing is the owner's to share: owners always; staff as the owner set them (none, view, edit). */
const costingLevel = (m) => (deps.preview ? 'edit' : m.member_role === 'owner' ? 'edit' : (m.costing || 'none'));   // the admin keeps their prices
const seesCosting = (m) => costingLevel(m) !== 'none';
function rights(m, plan) {
  const owner = m.member_role === 'owner';
  const on = plan.on && !deps.preview;
  return {
    owner,
    add: on,
    edit: (r) => on && r.ours && (owner || r.row.owner_id === deps.me.id),
    project: plan.project,   // kept after a project: read-only
    costView: seesCosting(m),
    costEdit: (deps.preview || plan.on) && costingLevel(m) === 'edit',
    // ingredient prices and supplier lists: the admin's on managed costing (the default), theirs on self-service
    prices: (deps.preview || plan.on) && costingLevel(m) === 'edit' && (deps.preview || selfService(m)),
  };
}
/** The package's cap on recipes the team adds itself (Small business: 50), and how many they have: { cap, ours, full }. */
function recipeRoom(m, data) {
  const cap = PACKAGES[packageOf(m.restaurant)].recipes;
  const ours = data.recipes.filter((x) => x.ours).length;
  return { cap, ours, full: !!cap && ours >= cap && !deps.preview };
}
/** Said on a Small business list: how many of the 50 are used, and what to do when they're full. */
const roomNote = (m, room) => room.cap && h('p', { class: `note${room.full ? ' jrk-newnote' : ''}` },
  room.full ? h('strong', null, `You have ${room.cap} recipes of your own, the most on the ${PACKAGES[packageOf(m.restaurant)].label} plan. `) : `${room.ours} of ${room.cap} recipes of your own on the ${PACKAGES[packageOf(m.restaurant)].label} plan (recipes from Jones Ridge Kitchen don’t count). `,
  room.full ? ['To add more, move to Self-service: ', h('a', { href: `#kitchen/${m.restaurant.id}/help` }, 'ask Joseph'), '.'] : '');
/** Costing tiers (add_costing_tiers.sql): 'managed' (Jones Ridge Kitchen keeps the ingredient prices) or 'self_service'. */
const selfService = (m) => m.restaurant.costing_tier === 'self_service';
/** A price, read only: "$2.50 / lb", or a dash. */
const priceText = (price) => h('span', { class: 'jrk-pricetext' }, price ? `${money(price.p)} / ${PRICE_UNITS[price.per]?.label || price.per}` : '—');
/** Said where ingredient prices are on managed costing (not to the admin previewing). */
const managedNote = (m) => !deps.preview && !selfService(m) && (restaurantPlan(m.restaurant).project
  ? h('p', { class: 'note jrk-managed' }, 'These costs are from your project and aren’t updated. To keep them current, choose a monthly package: ',
    h('a', { href: `#kitchen/${m.restaurant.id}/help` }, 'ask Joseph'), '.')
  : h('p', { class: 'note jrk-managed' }, 'Ingredient prices are kept for you by Jones Ridge Kitchen. If one looks wrong or is missing, ',
    h('a', { href: `#kitchen/${m.restaurant.id}/help` }, 'ask Joseph'), '.'));

// ------------------------------------------------------------------ the frame: header, tabs, plan state
function frame(m, tab, ...body) {
  const r = m.restaurant;
  const key = `kitchen/${r.id}`;
  const plan = restaurantPlan(r);
  const tabs = [['', 'Recipes'], ['prep', 'Prep list']];
  if (seesCosting(m)) tabs.push(['costing', 'Costing']);
  tabs.push(['help', 'Help']);
  if (m.member_role === 'owner' && !deps.preview) tabs.push(['team', 'Team']);
  fill(deps.root, ...deps.top(key),
    h('h2', { class: 'jrk-kitchen' }, r.name),
    plan.trial && plan.ends && !plan.ended && h('p', { class: 'note' }, `Free trial: ${plural(plan.daysLeft, 'day')} left (until ${DAYDATE.format(plan.ends)}).`),
    plan.project && !deps.preview && h('p', { class: 'note jrk-project' }, 'Your recipes from your project with Jones Ridge Kitchen, kept for you to read, scale and print. To add recipes or keep your costing up to date, choose a monthly package: ',
      h('a', { href: `#${key}/help` }, 'ask Joseph'), '.'),
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
  if (!plan.read) { if (tab !== 'help') { frame(m, tab, paused(m)); return null; } return { recipes: [], team: new Set(), kitchen: cleanKitchen({}) }; }
  frame(m, tab, h('p', { class: 'note' }, 'Loading…'));
  try {
    const data = await load(m);
    return mine === screen.id ? data : null;
  } catch (err) {
    if (mine !== screen.id) return null;
    frame(m, tab, h('p', { class: 'jrk-msg' }, `Could not load your kitchen: ${err.message}`),
      h('button', { class: 'btn', type: 'button', onclick: () => show(m, tab) }, 'Try again'));
    return null;
  }
}

const noCosting = (m) => frame(m, '', h('div', { class: 'jrk-card' }, h('h2', null, 'Costing is kept by your restaurant’s owner'),
  h('p', null, 'Ask your owner if you need to see or change food costs.'), h('p', null, h('a', { href: `#kitchen/${m.restaurant.id}` }, '← All recipes'))));

/** portal.js's router hands over everything after #kitchen/<id>/. */
export function show(m, sub = '', arg = '', arg2 = '') {
  const costPage = ['costing', 'cost', 'plate', 'sheet'].includes(sub);
  if (costPage && !seesCosting(m)) { screen.next(); return noCosting(m); }
  if (sub === 'costing') return viewCosting(m);
  if (sub === 'sheet') return viewSheet(m);
  if (sub === 'cost' && arg) return viewCostDetail(m, arg);
  if (sub === 'plate' && arg) return viewPlate(m, arg);
  if (sub === 'prep') return viewPrep(m);
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
  const room = recipeRoom(m, data);   // Small business: 50 recipes of their own
  const fresh = list.filter((x) => x.isNew);
  const cats = [...new Set(list.flatMap((x) => x.categories))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  let q = '';
  try { q = sessionStorage.getItem(`jrk-q-${r.id}`) || ''; } catch { /* private mode */ }
  const search = h('input', { type: 'search', placeholder: 'Search by name or ingredient', 'aria-label': 'Search recipes', value: q });
  const cat = cats.length > 1 && h('select', { 'aria-label': 'Category' }, h('option', { value: '' }, 'All categories'), cats.map((c) => h('option', { value: c }, c)));
  const whose = (list.some((x) => x.ours) || fresh.length > 0) && h('select', { 'aria-label': 'Whose recipes' },
    h('option', { value: '' }, 'Everyone’s'), h('option', { value: 'chef' }, 'From Jones Ridge Kitchen'), h('option', { value: 'ours' }, 'Ours'),
    fresh.length > 0 && h('option', { value: 'new' }, `New (${fresh.length})`));
  const out = h('ul', { class: 'jrk-recipes' });
  const count = h('p', { class: 'note', role: 'status' });
  const paint = () => {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    try { sessionStorage.setItem(`jrk-q-${r.id}`, search.value); } catch { /* private mode */ }
    const c = cat ? cat.value : '';
    const w = whose ? whose.value : '';
    const hits = list.filter((x) => words.every((t) => x._hay.includes(t)) && (!c || x.categories.includes(c))
      && (!w || (w === 'new' ? x.isNew : (w === 'ours') === x.ours)));
    count.textContent = hits.length === list.length ? plural(list.length, 'recipe') : `${hits.length} of ${plural(list.length, 'recipe')}`;
    fill(out, hits.length ? hits.map((x) => h('li', null, h('a', { href: `#${key}/${enc(x.id)}` },
      h('span', { class: 'jrk-rtitle' }, x.title, x.isNew && h('span', { class: 'jrk-tag new' }, 'New'), x.ours && h('span', { class: 'jrk-tag' }, 'Ours')),
      x.categories.length > 0 && h('span', { class: 'note' }, x.categories.join(' · ')))))
      : h('li', { class: 'note' }, 'No recipes match that search.'));
  };
  search.addEventListener('input', paint);
  if (cat) cat.addEventListener('change', paint);
  if (whose) whose.addEventListener('change', paint);
  paint();
  frame(m, '',
    fresh.length > 0 && h('p', { class: 'jrk-newnote', role: 'status' }, h('strong', null, `${plural(fresh.length, 'new recipe')} from Jones Ridge Kitchen`), ' since your last visit. ',
      h('button', { class: 'jrk-link', type: 'button', onclick: () => { if (whose) { whose.value = 'new'; paint(); } } }, 'Show them')),
    can.add && !room.full && h('div', { class: 'jrk-row jrk-actions' }, h('a', { class: 'btn', href: `#${key}/new` }, '+ Add a recipe')),
    can.add && roomNote(m, room),
    list.length
      ? [h('div', { class: 'jrk-row jrk-find' }, search, cat, whose), count, out]
      : h('div', { class: 'jrk-card' }, h('h2', null, 'No recipes yet'),
        h('p', null, can.add ? 'Joseph is building your collection. You can add your own recipes too.' : 'Joseph is building your collection. Recipes appear here as soon as they are added.')),
    h('p', { class: 'note' }, 'Recipes from Jones Ridge Kitchen are kept up to date by Joseph. ',
      can.add ? 'Recipes marked Ours are your team’s: you can change them. ' : '',
      'Cooking from a phone or tablet? The ', h('a', { href: APP }, 'recipe app'), ' has the same collection with cook mode and timers, using this login.'));
}

/** A recipe's Nutrition: the five figures per serving, the Macronutrients (with where the calories come from),
 *  and how much of the recipe could be counted. Folded away; remembers whether it was open. */
let nutritionOpen = false, macrosOpen = false;
function nutritionBlock(recipe) {
  const n = nutrition(recipe);
  if (!n.counted) return h('p', { class: 'note jrk-noprint' }, h('strong', null, 'Nutrition: '), 'not enough of the ingredients could be matched to estimate it.');
  const shown = n.per || n.total;
  const enough = n.coverage >= 0.5;
  const box = h('details', { class: 'jrk-nutri jrk-noprint', open: nutritionOpen || null },
    h('summary', null, h('strong', null, 'Nutrition'),
      h('span', { class: 'note' }, ` ${Math.round(shown.kcal).toLocaleString()} calories ${n.per ? 'per serving' : 'in the whole recipe'}${enough ? '' : ' (rough)'}`)),
    nutrientTiles(h, shown, 'jrk-nstats'),
    h('p', { class: 'note' }, n.per ? `Per serving. Whole recipe: ${Math.round(n.total.kcal).toLocaleString()} calories.` : 'The recipe doesn’t say how many servings, so this is the whole recipe.'),
    macroDetails(h, { per: n.per, total: n.total, servings: n.servings, parts: n.parts, quiet: 'note', cls: 'jrk-macrodetails', open: macrosOpen, onToggle: (o) => { macrosOpen = o; } }),
    h('p', { class: 'note' }, `Estimated from ${n.counted} of ${n.lines} ingredients${enough ? '' : ', so treat it as rough'}. Typical values, not a label: brands and cuts vary.`),
    n.skipped.length > 0 && h('details', { class: 'jrk-notcounted' }, h('summary', { class: 'note' }, `Not counted (${n.skipped.length})`),
      h('ul', { class: 'note' }, n.skipped.map((x) => h('li', null, `${formatIngredient(x.ing)}: ${x.why}`)))));
  box.addEventListener('toggle', () => { nutritionOpen = box.open; });
  return box;
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
  if (base.photo) photos.photoURL(base.photo).then((u) => { if (u && mine === screen.id) fill(photo, h('img', { src: u, alt: base.title })); });
  const photoBtns = can.edit(base) && h('div', { class: 'jrk-row jrk-noprint jrk-photobtns' },
    h('button', { class: 'btn line small', type: 'button', onclick: async (e) => {
      const file = await photos.pickPhoto();
      if (!file) return;
      busy(e.target, true);
      try {
        const path = await photos.upload('recipes', file);
        await cloud.setRecipePhoto(base.id, path);
        const old = base.photo;
        await load(m, true);
        if (old) photos.discard([old]);
        toast('Photo saved'); viewRecipe(m, base.id);
      } catch (err) { toast(err.message); } finally { busy(e.target, false); }
    } }, base.photo ? 'Change photo' : 'Add a photo'),
    base.photo && h('button', { class: 'jrk-link', type: 'button', onclick: async () => {
      if (!await confirmBox('Remove this photo?', 'Remove', true)) return;
      try { const old = base.photo; await cloud.setRecipePhoto(base.id, null); await load(m, true); photos.discard([old]); viewRecipe(m, base.id); } catch (err) { toast(err.message); }
    } }, 'Remove photo'));
  const credit = [creditLine(base), adaptedLine(base)].filter(Boolean).join(' · ');
  const allergens = allergensOf(base);
  const c = can.costView ? costing(base, data.kitchen.items) : null;
  const portions = c ? data.kitchen.portions[base.id] || c.servings || 0 : 0;
  const perPortion = c && portions ? c.total / portions : null;

  const del = can.edit(base) && h('button', { class: 'btn line danger', type: 'button', onclick: async () => {
    if (!await confirmBox(`Delete “${base.title}”? Your whole team loses it. This cannot be undone.`, 'Delete', true)) return;
    try {
      await cloud.deleteKitchenRecipe(base.id);
      if (base.photo) photos.discard([base.photo]);
      await load(m, true); toast('Deleted'); location.hash = `#${key}`;
    } catch (err) { toast(err.message); }
  } }, 'Delete');

  frame(m, '', back,
    h('article', { class: 'jrk-recipe' },
      h('h2', null, base.title, base.isNew && h('span', { class: 'jrk-tag new' }, 'New')),
      h('p', { class: 'note' }, [base.categories.join(' · '), base.ours ? 'Your team’s recipe' : 'From Jones Ridge Kitchen'].filter(Boolean).join(' · ')),
      credit && h('p', { class: 'note' }, credit),
      photo, photoBtns,
      yieldLine, quick, warn,
      h('h3', null, 'Ingredients'), ingsBox,
      steps.length > 0 && [h('h3', null, 'Method'), h('ol', { class: 'jrk-steps' }, steps.map((x) => h('li', null, x)))],
      h('div', { class: 'jrk-facts' },
        nutritionBlock(base),
        h('p', null, h('strong', null, 'Allergens: '), allergens.length ? allergens.join(', ') : 'none of the major allergens found in the ingredient names',
          h('span', { class: 'note' }, '. Worked out from the ingredient names: check bought sauces, stocks and mixes yourself.')),
        c && h('p', { class: 'jrk-noprint' }, h('strong', null, 'Food cost: '),
          c.total > 0 ? `${money(c.total)} a batch${perPortion != null ? `, ${money(perPortion)} a portion` : ''}${c.missing ? ` (${plural(c.missing, 'ingredient')} not priced yet)` : ''}. ` : 'not worked out yet. ',
          h('a', { href: `#${key}/cost/${enc(base.id)}` }, c.total > 0 ? 'See the costing' : can.prices ? 'Add prices' : 'See the costing'))),
      h('p', { class: 'note jrk-printnote' }, `${r.name} · Jones Ridge Kitchen recipe collection`),
      h('div', { class: 'jrk-row jrk-noprint' },
        h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, 'Print'),
        h('button', { class: 'btn line', type: 'button', onclick: () => { addToPrep(r.id, base.id, 1); toast('On the prep list'); } }, 'Add to prep list'),
        can.edit(base) && h('a', { class: 'btn line', href: `#${key}/edit/${enc(base.id)}` }, 'Edit'),
        !base.ours && can.add && !recipeRoom(m, data).full && h('a', { class: 'btn line', href: `#${key}/new/${enc(base.id)}` }, 'Make our own version'),
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
  if (!recipeId && can.add && recipeRoom(m, data).full) {
    frame(m, '', h('div', { class: 'jrk-card' }, h('h2', null, 'Your recipe book is full'), roomNote(m, recipeRoom(m, data)),
      h('p', null, h('a', { href: `#${key}` }, '← All recipes'))));
    return;
  }
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
      await load(m, true);
      try { sessionStorage.removeItem(`jrk-q-${r.id}`); } catch { /* private mode */ }   // so the list shows it, not an old search
      toast(existing ? 'Saved' : 'Added to your recipes');
      location.hash = `#${key}/${enc(row.id)}`;
    } catch (err) { note.textContent = err.message; } finally { busy(save, false); }
  } },
  h('div', { class: 'full' }, field('Recipe name', title)),
  h('div', { class: 'full' }, field('Categories', cats, '(separate with commas)')),
  h('div', { class: 'full' }, field('Makes', makes)),
  h('div', { class: 'full' }, field('Ingredients', ings, '(one per line: amount, unit, ingredient; a line ending in a colon starts a group)')),
  h('div', { class: 'full' }, field('Method', dir, '(one step per line)')),
  h('div', { class: 'full' }, note),
  h('div', { class: 'full jrk-row' }, save, h('a', { class: 'btn line', href: existing ? `#${key}/${enc(existing.id)}` : `#${key}` }, 'Cancel')));

  frame(m, '', h('p', { class: 'jrk-back' }, h('a', { href: `#${key}` }, `← All ${r.name} recipes`)),
    h('div', { class: 'jrk-card' }, h('h2', null, existing ? `Change “${existing.title}”` : from ? `Our version of “${from.title}”` : 'Add a recipe'),
      !existing && h('p', { class: 'note' }, 'It is added to your restaurant’s recipes, for your whole team. Recipes from Jones Ridge Kitchen stay as Joseph keeps them. You can add a photo once it is saved.'),
      form));
  title.focus();
}

// ------------------------------------------------------------------ Prep list (kept on this device)
const prepKey = (rid) => `jrk-prep-${rid}`;
const loadPrep = (rid) => {
  const v = store.get(prepKey(rid));
  return { items: (Array.isArray(v?.items) ? v.items : []).filter((x) => x && typeof x.id === 'string' && Number(x.x) > 0).map((x) => ({ id: x.id, x: Math.min(100, Number(x.x)) })).slice(0, 100) };
};
function addToPrep(rid, id, x) {
  const p = loadPrep(rid);
  const have = p.items.find((i) => i.id === id);
  if (have) have.x = Math.min(100, have.x + x); else p.items.push({ id, x });
  store.set(prepKey(rid), p);
}

async function viewPrep(m) {
  const mine = screen.next();
  const data = await ready(m, 'prep', mine);
  if (!data) return;
  const r = m.restaurant;
  const key = `kitchen/${r.id}`;
  const can = rights(m, restaurantPlan(r));
  const byId = new Map(data.recipes.map((x) => [x.id, x]));
  const prep = loadPrep(r.id);
  prep.items = prep.items.filter((i) => byId.has(i.id));
  const saveAndPaint = () => { store.set(prepKey(r.id), prep); paint(); };

  const pick = h('select', { 'aria-label': 'Add a recipe to the prep list' }, h('option', { value: '' }, 'Add a recipe…'),
    data.recipes.map((x) => h('option', { value: x.id }, x.title)));
  pick.addEventListener('change', () => {
    if (!pick.value) return;
    const have = prep.items.find((i) => i.id === pick.value);
    if (have) have.x += 1; else prep.items.push({ id: pick.value, x: 1 });
    pick.value = '';
    saveAndPaint();
  });
  const chosen = h('ul', { class: 'jrk-list jrk-prepitems' });
  const result = h('div', { class: 'jrk-prepout' });

  function paint() {
    fill(chosen, prep.items.map((i) => {
      const recipe = byId.get(i.id);
      const x = h('input', { type: 'number', min: '0.25', max: '100', step: '0.25', value: String(i.x), 'aria-label': `Batches of ${recipe.title}` });
      x.addEventListener('change', () => { const n = Number(x.value); i.x = n > 0 ? Math.min(100, n) : 1; saveAndPaint(); });
      const y = formatYield(recipe);
      return h('li', null, h('span', null, h('a', { href: `#${key}/${enc(recipe.id)}` }, recipe.title), y && h('span', { class: 'note' }, ` · makes ${y} a batch`)),
        h('span', { class: 'jrk-row' }, h('label', { class: 'jrk-row' }, x, 'batches'),
          h('button', { class: 'jrk-link', type: 'button', 'aria-label': `Take ${recipe.title} off the prep list`, onclick: () => { prep.items = prep.items.filter((o) => o !== i); saveAndPaint(); } }, 'Remove')));
    }));
    if (!prep.items.length) { fill(result, h('p', { class: 'note' }, 'Add the recipes you are making and how many batches. The ingredients are added up below, by aisle, ready to order or pull.')); return; }
    const picks = prep.items.map((i) => [byId.get(i.id), Frac.parse(String(i.x)) || new Frac(1n)]);
    let lines = [];
    try { lines = shoppingList(picks); } catch { lines = []; }
    let total = 0, missing = 0;
    if (can.costView) {
      for (const [recipe, f] of picks) {
        let scaled = recipe;
        try { scaled = scaleRecipe(recipe, f).recipe; } catch { /* as written */ }
        const c = costing(scaled, data.kitchen.items);
        total += c.total; missing += c.missing;
      }
    }
    fill(result,
      h('h3', null, `Ingredients for ${plural(prep.items.length, 'recipe')}`),
      byAisle(lines).map(([aisle, group]) => [h('h4', null, aisle),
        h('ul', { class: 'jrk-preplines' }, group.map((l) => h('li', null, h('label', null, h('input', { type: 'checkbox' }), ' ', l.text),
          l.recipes.length > 1 && h('span', { class: 'note' }, ` (${l.recipes.join(', ')})`))))]),
      can.costView && h('p', { class: 'jrk-prepcost' }, h('strong', null, 'Estimated food cost: '), money(total),
        missing ? h('span', { class: 'note' }, ` (${plural(missing, 'ingredient line')} without a price, so the real cost is higher)`) : ''),
      h('div', { class: 'jrk-row jrk-noprint' },
        h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, 'Print'),
        h('button', { class: 'btn line', type: 'button', onclick: async () => {
          const text = [`${r.name} prep list`, ...prep.items.map((i) => `${byId.get(i.id).title} × ${i.x}`), '',
            ...byAisle(lines).flatMap(([aisle, group]) => [aisle, ...group.map((l) => `[ ] ${l.text}`), ''])].join('\n');
          try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy did not work in this browser'); }
        } }, 'Copy as text'),
        h('button', { class: 'jrk-link', type: 'button', onclick: async () => { if (await confirmBox('Clear the prep list?', 'Clear')) { prep.items = []; saveAndPaint(); } } }, 'Clear the list')));
  }
  paint();
  frame(m, 'prep',
    h('p', null, 'Pick what you are making this shift or this week; the ingredients are scaled and added up. The list is kept on this device.'),
    h('div', { class: 'jrk-row jrk-find jrk-noprint' }, pick),
    chosen, result);
}

// ------------------------------------------------------------------ Costing (the owner decides who sees it)
function costRow(recipe, kitchen) {
  const c = costing(recipe, kitchen.items);
  const portions = kitchen.portions[recipe.id] || c.servings || 0;
  const per = portions && c.total > 0 ? c.total / portions : null;
  const menu = kitchen.menu[recipe.id] || null;
  return { c, portions, per, menu, fc: per != null && menu ? foodCostPct(per, menu) : null, suggested: per != null ? suggestedPrice(per, kitchen.target) : null };
}

/** One ingredient on a plate ("1 oz tomato slices") as a costing line: { ing, key, entry, price, cost, state }, or null. */
function plateLine(text, kitchen) {
  const ing = parseIngredientLine(text);
  if (!ing) return null;
  return costing({ ings: [{ ...ing, group: '' }], yq: null }, kitchen.items).lines[0] || null;
}

/** A plate's cost: its recipes' portion costs times how many portions of each, plus its single ingredients. */
function plateCost(plate, byId, kitchen) {
  let total = 0, missing = 0, unknown = 0;
  for (const part of plate.parts) {
    if ('t' in part) {
      const l = plateLine(part.t, kitchen);
      if (l?.state === 'ok') total += l.cost;
      else if (l?.state !== 'free') missing++;
      continue;
    }
    const recipe = byId.get(part.id);
    if (!recipe) { unknown++; continue; }
    const row = costRow(recipe, kitchen);
    if (row.per == null) { missing++; continue; }
    total += row.per * part.n;
    missing += row.c.missing ? 1 : 0;
  }
  const fc = plate.menu && total > 0 ? foodCostPct(total, plate.menu) : null;
  return { total, missing, unknown, fc, suggested: total > 0 ? suggestedPrice(total, kitchen.target) : null };
}

const viewOnly = (can) => (deps.preview
  ? h('p', { class: 'note jrk-adminnote' }, 'Preview: as the admin you can change this restaurant’s prices, menu prices and plates here. They see your changes straight away.')
  : !can.costEdit && !can.project && h('p', { class: 'note' }, can.costView ? 'You can see the costing. Ask your owner if you need to change it.' : ''));

/** The costing pages' own switch: recipes and plates, or the ingredient price sheet. */
const costSwitch = (m, here) => h('div', { class: 'jrk-costswitch', role: 'group', 'aria-label': 'Costing' },
  [['costing', 'Recipes & plates'], ['sheet', 'Ingredient prices']].map(([k, label]) =>
    h('a', { href: `#kitchen/${m.restaurant.id}/${k}`, 'aria-current': k === here ? 'page' : null }, label)));

async function viewCosting(m) {
  const mine = screen.next();
  const data = await ready(m, 'costing', mine);
  if (!data) return;
  const r = m.restaurant;
  const key = `kitchen/${r.id}`;
  const can = rights(m, restaurantPlan(r));
  const k = data.kitchen;
  const byId = new Map(data.recipes.map((x) => [x.id, x]));
  const target = h('input', { type: 'number', min: '1', max: '100', step: '1', value: String(k.target || DEFAULT_TARGET), disabled: !can.costEdit, 'aria-label': 'Target food cost %' });
  target.addEventListener('change', async () => {
    try { await changeKitchen(m, (d) => { d.target = cleanPrices({ target: target.value }).target; }); viewCosting(m); } catch (err) { toast(err.message); }
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
        h('th', { scope: 'row' }, h('a', { href: `#${key}/cost/${enc(x.id)}` }, x.title),
          row.c.missing > 0 && h('span', { class: 'note jrk-missing' }, ` ${plural(row.c.missing, 'price')} missing`)),
        h('td', { 'data-label': 'Batch' }, row.c.total > 0 ? money(row.c.total) : '—'),
        h('td', { 'data-label': 'Portion' }, row.per != null ? money(row.per) : row.c.total > 0 ? h('a', { href: `#${key}/cost/${enc(x.id)}` }, 'set portions') : '—'),
        h('td', { 'data-label': 'Menu price' }, row.menu ? money(row.menu) : '—'),
        h('td', { 'data-label': 'Food cost', class: over ? 'jrk-over' : '' }, pct(row.fc)),
        h('td', { 'data-label': `At ${k.target}%` }, row.suggested != null ? money(row.suggested) : '—'));
    }));
  };
  search.addEventListener('input', paint);
  paint();

  const plates = k.plates.map((p) => {
    const pc = plateCost(p, byId, k);
    const over = pc.fc != null && pc.fc > k.target;
    return h('tr', null,
      h('th', { scope: 'row' }, h('a', { href: `#${key}/plate/${enc(p.id)}` }, p.name),
        h('span', { class: 'note jrk-missing' }, p.parts.map((x) => ('t' in x ? x.t : byId.get(x.id)?.title)).filter(Boolean).join(' + ') || 'nothing on it yet')),
      h('td', { 'data-label': 'Plate cost' }, pc.total > 0 ? money(pc.total) : '—'),
      h('td', { 'data-label': 'Menu price' }, p.menu ? money(p.menu) : '—'),
      h('td', { 'data-label': 'Food cost', class: over ? 'jrk-over' : '' }, pct(pc.fc)),
      h('td', { 'data-label': `At ${k.target}%` }, pc.suggested != null ? money(pc.suggested) : '—'));
  });

  const sheet = ingredientSheet(data.recipes, k);
  const toPrice = sheet.filter((x) => !x.free && !x.price).length;
  frame(m, 'costing', costSwitch(m, 'costing'),
    can.project && !deps.preview
      ? [h('p', null, 'What each recipe and plate cost to make when your project with Jones Ridge Kitchen was finished.'), managedNote(m)]
      : can.prices || deps.preview
      ? h('p', null, 'What each recipe and plate costs to make, from your ingredient prices. Fill in prices on the ',
        h('a', { href: `#${key}/sheet` }, 'ingredient price sheet'), ', or open a recipe to price its ingredients; a price is used in every recipe with that ingredient.')
      : h('p', null, 'What each recipe and plate costs to make, from the ingredient prices Jones Ridge Kitchen keeps for you. Set your target food cost % and menu prices here; the suggested prices follow your target.'),
    can.prices && toPrice > 0 && h('p', { class: 'jrk-newnote' }, h('strong', null, `${plural(toPrice, 'ingredient')} still ${toPrice === 1 ? 'needs' : 'need'} a price. `),
      h('a', { href: `#${key}/sheet` }, 'Open the price sheet')),
    h('div', { class: 'jrk-row jrk-find' }, search, h('label', { class: 'jrk-row jrk-target' }, 'Target food cost', target, '%')),
    data.recipes.length
      ? h('div', { class: 'jrk-tablewrap' }, h('table', { class: 'jrk-cost' },
        h('thead', null, h('tr', null, ['Recipe', 'Batch', 'Portion', 'Menu price', 'Food cost', `Price at ${k.target}%`].map((t) => h('th', { scope: 'col' }, t)))), table))
      : h('p', { class: 'note' }, 'No recipes to cost yet.'),
    h('h3', null, 'Plates'),
    h('p', { class: 'note' }, 'A menu item made of recipes and single ingredients: a burger with its patty recipe, a bun, a slice of cheese, 1 oz of tomato and the fries.'),
    plates.length > 0 && h('div', { class: 'jrk-tablewrap' }, h('table', { class: 'jrk-cost jrk-plates' },
      h('thead', null, h('tr', null, ['Plate', 'Plate cost', 'Menu price', 'Food cost', `Price at ${k.target}%`].map((t) => h('th', { scope: 'col' }, t)))), h('tbody', null, plates))),
    can.costEdit && h('div', { class: 'jrk-row jrk-actions' }, h('a', { class: 'btn line', href: `#${key}/plate/new` }, '+ Add a plate')),
    viewOnly(can));
}

/**
 * Every ingredient the restaurant's recipes use, once each (matched the way costing matches them, so "Roma tomatoes"
 * and "tomatoes, diced" share a price), with the recipes it is in, the units they use, and its price.
 */
function ingredientSheet(recipes, kitchen) {
  const rows = new Map();
  const sources = [
    ...recipes.map((recipe) => [recipe.title, costing(recipe, kitchen.items).lines]),
    ...(kitchen.plates || []).map((p) => [`${p.name} (plate)`, p.parts.filter((x) => 't' in x).map((x) => plateLine(x.t, kitchen)).filter(Boolean)]),
  ];
  for (const [title, lines] of sources) {
    for (const l of lines) {
      if (!l.key) continue;
      let row = rows.get(l.key);
      if (!row) {
        const name = itemName(l.ing.item) || l.key;
        row = { key: l.key, name: name.charAt(0).toUpperCase() + name.slice(1), entry: l.entry, ing: l.ing, free: l.state === 'free', recipes: new Set(), units: new Set(), mismatch: new Set() };
        rows.set(l.key, row);
      }
      row.recipes.add(title);
      if (l.ing.unit) row.units.add(l.ing.unit);
      if (l.state === 'noconvert') row.mismatch.add(formatIngredient(l.ing));
    }
  }
  return [...rows.values()].map((r) => ({ ...r, price: kitchen.items[r.key] || null }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

async function viewSheet(m) {
  const mine = screen.next();
  const data = await ready(m, 'costing', mine);
  if (!data) return;
  const r = m.restaurant;
  const can = rights(m, restaurantPlan(r));
  let rows = ingredientSheet(data.recipes, data.kitchen);
  const search = h('input', { type: 'search', placeholder: 'Search ingredients', 'aria-label': 'Search ingredients' });
  const which = h('select', { 'aria-label': 'Show' },
    h('option', { value: 'all' }, 'All ingredients'), h('option', { value: 'missing' }, 'Needs a price'), h('option', { value: 'priced' }, 'Priced'));
  const summary = h('p', { class: 'note', role: 'status' });
  const body = h('tbody');
  const extra = h('div');

  // a purveyor's order guide or price list (Sysco, SGC, Ben E. Keith...): reviewed, then added to the kitchen's prices
  const supPanel = h('div');
  const supIn = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain,text/tab-separated-values', hidden: true, 'aria-label': 'Supplier price list file' });
  supIn.addEventListener('change', async () => {
    const f = supIn.files[0];
    supIn.value = '';
    if (!f) return;
    let text;
    try { text = await f.text(); } catch { toast('Could not read that file'); return; }
    fill(supPanel, supplierImport({ h, fill, toast, file: f, text, book: cache.get(r.id)?.kitchen.items || {},
      save: async (items) => { await changeKitchen(m, (d) => { Object.assign(d.items, items); }); return Object.keys(items).length; },
      onDone: () => {
        fill(supPanel);
        rows = ingredientSheet(data.recipes, cache.get(r.id).kitchen);
        paint();
        summary.scrollIntoView({ block: 'center' });
      } }));
    supPanel.scrollIntoView({ block: 'start' });
  });

  async function setPrice(key, value, per) {
    const v = String(value).trim();
    const p = parseFloat(v);
    try {
      await changeKitchen(m, (d) => { if (v === '' || !(p >= 0)) delete d.items[key]; else d.items[key] = { p: Math.round(p * 10000) / 10000, per }; });
      rows = ingredientSheet(data.recipes, cache.get(r.id).kitchen);
      toast(v === '' ? 'Price removed' : 'Price saved');
      paint(key);
    } catch (err) { toast(err.message); }
  }

  function paint(focusKey = null) {
    const q = search.value.trim().toLowerCase();
    const shown = rows.filter((x) => (!q || x.name.toLowerCase().includes(q) || x.key.includes(q))
      && (which.value === 'all' || (which.value === 'missing' ? !x.free && !x.price : !!x.price)));
    const costable = rows.filter((x) => !x.free);
    const priced = costable.filter((x) => x.price).length;
    summary.textContent = `${plural(costable.length, 'ingredient')} in your recipes · ${priced} priced · ${costable.length - priced} ${can.prices ? 'to go' : 'without a price yet'}`;
    fill(body, shown.length ? shown.map((x) => {
      const disabled = !can.prices || x.free;
      const price = h('input', { type: 'number', min: '0', step: '0.01', inputmode: 'decimal', value: x.price ? String(x.price.p) : '', placeholder: x.free ? '' : '$',
        disabled, 'aria-label': `Price of ${x.name}` });
      const unit = h('select', { 'aria-label': `Price unit for ${x.name}`, disabled },
        Object.entries(PRICE_UNITS).map(([u, d]) => h('option', { value: u }, `per ${d.label}`)));
      unit.value = x.price?.per || defaultPriceUnit(x.ing, x.entry);
      price.addEventListener('change', () => setPrice(x.key, price.value, unit.value));
      unit.addEventListener('change', () => { if (price.value.trim()) setPrice(x.key, price.value, unit.value); });
      const used = [...x.recipes];
      return h('tr', { 'data-key': x.key, class: x.price ? 'priced' : x.free ? 'free' : 'missing' },
        h('th', { scope: 'row' }, x.name,
          h('span', { class: 'note jrk-missing' }, `${used.length === 1 ? used[0] : `${used.length} recipes: ${used.slice(0, 3).join(', ')}${used.length > 3 ? '…' : ''}`}`
            + (x.units.size ? ` · used in ${[...x.units].join(', ')}` : '')),
          x.free && h('span', { class: 'note jrk-missing' }, 'not counted (water, salt…)'),
          x.mismatch.size > 0 && h('span', { class: 'note jrk-missing jrk-over' }, `can’t cost “${[...x.mismatch][0]}” at this unit: try another`)),
        h('td', { 'data-label': 'Price' }, can.prices ? h('span', { class: 'jrk-row jrk-pricein' }, price, unit) : priceText(x.price)),
        h('td', { 'data-label': '' }, x.price && can.prices && h('button', { class: 'jrk-link', type: 'button', 'aria-label': `Remove the price of ${x.name}`,
          onclick: () => setPrice(x.key, '', unit.value) }, 'Remove')));
    }) : h('tr', null, h('td', { colspan: '3', class: 'note' }, rows.length ? 'Nothing matches.' : 'Add recipes first: their ingredients appear here.')));
    // prices kept for ingredients no recipe uses any more
    const used = new Set(rows.map((x) => x.key));
    const unused = Object.entries(cache.get(r.id)?.kitchen.items || {}).filter(([key]) => !used.has(key));
    fill(extra, unused.length > 0 && h('details', { class: 'jrk-card jrk-prices' }, h('summary', null, h('strong', null, `Prices not used in any recipe (${unused.length})`)),
      h('ul', { class: 'jrk-list' }, unused.map(([key, p]) => h('li', null, h('span', null, key),
        h('span', { class: 'jrk-row' }, `${money(p.p)} / ${PRICE_UNITS[p.per]?.label || p.per}`,
          can.prices && h('button', { class: 'jrk-link', type: 'button', onclick: () => setPrice(key, '', p.per) }, 'Remove')))))));
    if (focusKey) {
      const next = body.querySelector(`tr[data-key="${CSS.escape(focusKey)}"]`)?.nextElementSibling?.querySelector('input:not([disabled])');
      if (next && which.value !== 'missing') next.focus();
      else body.querySelector('input:not([disabled])')?.focus();
    }
  }
  search.addEventListener('input', () => paint());
  which.addEventListener('change', () => paint());
  paint();
  frame(m, 'costing', costSwitch(m, 'sheet'),
    can.prices
      ? h('p', null, 'Every ingredient in your recipes and plates, once. Enter what you pay and per what (a case price works: per lb, per each, per gallon…); it is used in every recipe with that ingredient.')
      : h('p', null, 'Every ingredient in your recipes and plates, once, with the price used to cost it.'),
    managedNote(m),
    can.prices && h('div', { class: 'jrk-row jrk-supimport' },
      h('button', { class: 'btn line', type: 'button', onclick: () => supIn.click() }, 'Import a supplier price list'), supIn,
      h('span', { class: 'note' }, 'An order guide or price list exported as CSV from Sysco, SGC, Ben E. Keith, US Foods or any distributor, with prices.')),
    supPanel,
    h('div', { class: 'jrk-row jrk-find' }, search, which),
    summary,
    h('div', { class: 'jrk-tablewrap' }, h('table', { class: 'jrk-cost jrk-sheet' },
      h('thead', null, h('tr', null, ['Ingredient', 'Price', ''].map((t) => h('th', { scope: 'col' }, t)))), body)),
    extra,
    viewOnly(can));
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
  const save = async (fn, msg) => { try { await changeKitchen(m, fn); if (msg) toast(msg); viewCostDetail(m, recipeId); } catch (err) { toast(err.message); } };

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
    const status = { free: 'not counted (water, salt…)', noamount: 'no amount to cost', noprice: can.prices ? 'needs a price' : 'no price yet', noconvert: can.prices ? 'unit doesn’t match: try another price unit' : 'can’t be costed yet' }[l.state];
    return h('tr', null,
      h('th', { scope: 'row' }, formatIngredient(l.ing), status && h('span', { class: 'note jrk-missing' }, ` ${status}`)),
      h('td', { 'data-label': 'Price' }, can.prices ? h('span', { class: 'jrk-row jrk-pricein' }, price, unit) : priceText(l.price)),
      h('td', { 'data-label': 'Cost', class: 'jrk-linecost' }, l.cost != null ? money(l.cost) : '—'));
  });

  const portions = h('input', { type: 'number', min: '0', step: '1', value: k.portions[recipe.id] ? String(k.portions[recipe.id]) : '', placeholder: row.c.servings ? String(row.c.servings) : 'e.g. 20',
    disabled: !can.costEdit, 'aria-label': 'Portions per batch' });
  portions.addEventListener('change', () => save((d) => { const n = Number(portions.value); if (n > 0) d.portions[recipe.id] = n; else delete d.portions[recipe.id]; }));
  const menu = h('input', { type: 'number', min: '0', step: '0.01', value: row.menu ? String(row.menu) : '', placeholder: '$', disabled: !can.costEdit, 'aria-label': 'Menu price' });
  menu.addEventListener('change', () => save((d) => { const v = parseFloat(menu.value); if (v > 0) d.menu[recipe.id] = Math.round(v * 100) / 100; else delete d.menu[recipe.id]; }));

  frame(m, 'costing', back,
    h('h2', null, recipe.title),
    h('p', { class: 'note' }, formatYield(recipe) ? `The recipe makes ${formatYield(recipe)}.` : 'The recipe doesn’t say how much it makes: enter the portions below.',
      ' ', h('a', { href: `#${key}/${enc(recipe.id)}` }, 'Open the recipe')),
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
    managedNote(m),
    viewOnly(can));
}

async function viewPlate(m, plateId) {
  const mine = screen.next();
  const data = await ready(m, 'costing', mine);
  if (!data) return;
  const r = m.restaurant;
  const key = `kitchen/${r.id}`;
  const can = rights(m, restaurantPlan(r));
  const k = data.kitchen;
  const byId = new Map(data.recipes.map((x) => [x.id, x]));
  const back = h('p', { class: 'jrk-back' }, h('a', { href: `#${key}/costing` }, '← All costing'));
  const existing = plateId === 'new' ? null : k.plates.find((p) => p.id === plateId);
  if (plateId !== 'new' && !existing) { frame(m, 'costing', back, h('div', { class: 'jrk-card' }, h('h2', null, 'Plate not found'))); return; }
  if (!existing && !can.costEdit) { frame(m, 'costing', back, viewOnly(can)); return; }
  const plate = existing ? { ...existing, parts: existing.parts.map((x) => ({ ...x })) } : { id: Math.random().toString(36).slice(2, 10), name: '', menu: null, parts: [] };

  const name = h('input', { type: 'text', maxlength: '100', value: plate.name, placeholder: 'Smash burger plate', disabled: !can.costEdit, 'aria-label': 'Plate name' });
  const menu = h('input', { type: 'number', min: '0', step: '0.01', value: plate.menu ? String(plate.menu) : '', placeholder: '$', disabled: !can.costEdit, 'aria-label': 'Plate menu price' });
  const partsBox = h('div', { class: 'jrk-plateparts' });
  const summary = h('div', { class: 'jrk-card jrk-summary' });
  const pick = h('select', { 'aria-label': 'Add a recipe to the plate', disabled: !can.costEdit }, h('option', { value: '' }, 'Add a recipe…'),
    data.recipes.map((x) => h('option', { value: x.id }, x.title)));
  pick.addEventListener('change', () => { if (pick.value) { plate.parts.push({ id: pick.value, n: 1 }); pick.value = ''; paint(); } });
  const addIng = h('input', { type: 'text', maxlength: '120', placeholder: '1 oz tomato slices, 1 slice Monterey Jack', disabled: !can.costEdit, 'aria-label': 'Add an ingredient to the plate' });
  const addIngNow = () => {
    const t = addIng.value.replace(/\s+/g, ' ').trim();
    if (!t) { addIng.focus(); return; }
    if (!parseIngredientLine(t)) { toast('Write it like “1 oz tomato slices”'); return; }
    plate.parts.push({ t }); addIng.value = ''; paint(); addIng.focus();
  };
  addIng.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addIngNow(); } });

  /** A single ingredient on the plate: its line (editable), its price (saved to the price book straight away), its cost. */
  function ingredientRow(part, i) {
    const l = plateLine(part.t, data.kitchen);
    const label = l ? formatIngredient(l.ing) : part.t;
    const text = h('input', { type: 'text', maxlength: '120', value: part.t, disabled: !can.costEdit, 'aria-label': `Ingredient on the plate: ${label}` });
    text.addEventListener('change', () => { const t = text.value.replace(/\s+/g, ' ').trim(); if (t) part.t = t; else plate.parts.splice(i, 1); paint(); });
    const pricing = l && l.state !== 'free' && l.state !== 'noamount';
    const price = pricing && h('input', { type: 'number', min: '0', step: '0.01', inputmode: 'decimal', value: l.price ? String(l.price.p) : '', placeholder: '$',
      disabled: !can.prices, 'aria-label': `Price of ${l.ing.item}` });
    const unit = pricing && h('select', { 'aria-label': `Price unit for ${l.ing.item}`, disabled: !can.prices },
      Object.entries(PRICE_UNITS).map(([u, d]) => h('option', { value: u }, `per ${d.label}`)));
    if (unit) unit.value = l.price?.per || defaultPriceUnit(l.ing, l.entry);
    const savePrice = async () => {
      const v = price.value.trim(); const p = parseFloat(v);
      if (v === '' && !l.price) return;
      try {
        await changeKitchen(m, (d) => { if (v === '' || !(p >= 0)) delete d.items[l.key]; else d.items[l.key] = { p: Math.round(p * 10000) / 10000, per: unit.value }; });
        toast('Price saved'); paint();
      } catch (err) { toast(err.message); }
    };
    if (price) { price.addEventListener('change', savePrice); unit.addEventListener('change', () => { if (price.value.trim()) savePrice(); }); }
    const status = !l ? 'can’t read this line' : { free: 'not counted (water, salt…)', noamount: 'add an amount, like “1 oz”', noprice: can.prices ? 'needs a price' : 'no price yet',
      noconvert: 'this price unit can’t cost it: try another (per each for pieces)' }[l.state];
    return h('div', { class: 'jrk-row jrk-platepart jrk-plateing' },
      h('span', { class: 'jrk-ptitle' }, text, status && h('span', { class: 'note jrk-missing' }, status)),
      pricing && (can.prices ? h('span', { class: 'jrk-row jrk-pricein' }, price, unit) : priceText(l.price)),
      h('span', { class: 'jrk-linecost' }, l?.state === 'ok' ? money(l.cost) : '—'),
      can.costEdit && h('button', { class: 'jrk-link', type: 'button', 'aria-label': `Take ${label} off the plate`, onclick: () => { plate.parts.splice(i, 1); paint(); } }, 'Remove'));
  }

  function paint() {
    const k = data.kitchen;
    fill(partsBox, plate.parts.map((part, i) => {
      if ('t' in part) return ingredientRow(part, i);
      const recipe = byId.get(part.id);
      const row = recipe ? costRow(recipe, k) : null;
      const n = h('input', { type: 'number', min: '0.1', step: '0.25', value: String(part.n), disabled: !can.costEdit, 'aria-label': `Portions of ${recipe?.title || 'a recipe'}` });
      n.addEventListener('change', () => { part.n = Number(n.value) > 0 ? Number(n.value) : 1; paint(); });
      return h('div', { class: 'jrk-row jrk-platepart' },
        h('span', { class: 'jrk-ptitle' }, recipe ? h('a', { href: `#${key}/cost/${enc(recipe.id)}` }, recipe.title) : 'A recipe that was removed',
          h('span', { class: 'note' }, row?.per != null ? ` ${money(row.per)} a portion` : ' no portion cost yet')),
        h('label', { class: 'jrk-row' }, n, 'portions'),
        h('span', { class: 'jrk-linecost' }, row?.per != null ? money(row.per * part.n) : '—'),
        can.costEdit && h('button', { class: 'jrk-link', type: 'button', 'aria-label': `Take ${recipe?.title || 'it'} off the plate`, onclick: () => { plate.parts.splice(i, 1); paint(); } }, 'Remove'));
    }), !plate.parts.length && h('p', { class: 'note' }, 'Add the recipes that go on the plate (and how many portions of each), and single ingredients like a slice of cheese or 1 oz of tomato.'));
    const pc = plateCost({ ...plate, menu: Number(menu.value) || null }, byId, k);
    fill(summary,
      h('p', null, h('strong', null, 'Plate cost: '), pc.total > 0 ? money(pc.total) : '—',
        pc.fc != null && [' · ', h('strong', null, 'Food cost: '), h('span', { class: pc.fc > k.target ? 'jrk-over' : '' }, pct(pc.fc))]),
      pc.suggested != null && h('p', null, h('strong', null, `Menu price for ${k.target}% food cost: `), money(pc.suggested)),
      pc.missing > 0 && h('p', { class: 'note' }, `${plural(pc.missing, 'item')} on the plate still ${pc.missing === 1 ? 'needs' : 'need'} a price or portions, so the cost is low.`));
  }
  menu.addEventListener('input', paint);
  paint();

  const save = h('button', { class: 'btn', type: 'button', onclick: async () => {
    if (!name.value.trim()) { toast('Give the plate a name'); name.focus(); return; }
    busy(save, true);
    try {
      await changeKitchen(m, (d) => {
        const next = { id: plate.id, name: name.value.trim(), menu: Number(menu.value) > 0 ? Math.round(Number(menu.value) * 100) / 100 : null, parts: plate.parts };
        const at = d.plates.findIndex((p) => p.id === plate.id);
        if (at >= 0) d.plates[at] = next; else d.plates.push(next);
      });
      toast('Plate saved'); location.hash = `#${key}/costing`;
    } catch (err) { toast(err.message); } finally { busy(save, false); }
  } }, 'Save plate');
  const del = existing && can.costEdit && h('button', { class: 'btn line danger', type: 'button', onclick: async () => {
    if (!await confirmBox(`Delete the plate “${existing.name}”? The recipes and prices stay.`, 'Delete', true)) return;
    try { await changeKitchen(m, (d) => { d.plates = d.plates.filter((p) => p.id !== existing.id); }); location.hash = `#${key}/costing`; } catch (err) { toast(err.message); }
  } }, 'Delete plate');

  frame(m, 'costing', back,
    h('div', { class: 'jrk-card' }, h('h2', null, existing ? existing.name : 'A new plate'),
      h('div', { class: 'jrk-row' }, field('Plate name', name), field('Menu price', menu)),
      h('h3', null, 'On the plate'), partsBox,
      can.costEdit && h('div', { class: 'jrk-row jrk-find jrk-plateadd' }, pick),
      can.costEdit && h('div', { class: 'jrk-row jrk-find jrk-plateadd' }, addIng, h('button', { class: 'btn line', type: 'button', onclick: addIngNow }, 'Add ingredient'))),
    summary,
    can.costEdit ? h('div', { class: 'jrk-row' }, save, h('a', { class: 'btn line', href: `#${key}/costing` }, 'Cancel'), del) : viewOnly(can));
}

// ------------------------------------------------------------------ Help: a form that reaches Joseph (his inbox, and email)
const TOPICS = ['A recipe', 'Costing and prices', 'Adding or changing recipes', 'Logins and staff', 'Our plan or billing', 'Something else'];
const URGENCY = [['whenever', 'Whenever you can'], ['week', 'This week'], ['soon', 'Today or tomorrow'], ['urgent', 'Urgent: during service']];
const REACH = [['email', 'Email'], ['phone', 'Phone call'], ['text', 'Text message']];

async function viewHelp(m) {
  const mine = screen.next();
  const r = m.restaurant;
  const cached = cache.get(r.id);
  const recipes = cached ? cached.recipes : [];
  const select = (label, options, value) => {
    const el = h('select', { 'aria-label': label }, options.map(([v, t]) => h('option', { value: v }, t)));
    if (value) el.value = value;
    return el;
  };
  const name = h('input', { type: 'text', maxlength: '120', autocomplete: 'name', required: true, value: deps.me.displayName || '', 'aria-label': 'Your name' });
  const email = h('input', { type: 'email', maxlength: '200', autocomplete: 'email', required: true, value: deps.me.email || '', 'aria-label': 'Your email' });
  const phone = h('input', { type: 'tel', maxlength: '40', autocomplete: 'tel', 'aria-label': 'Phone (optional)' });
  const reach = select('Best way to reach you', REACH, 'email');
  const topic = select('What it is about', TOPICS.map((t) => [t, t]));
  const recipe = select('Which recipe (optional)', [['', 'Not about one recipe'], ...recipes.map((x) => [x.title, x.title])]);
  const urgency = select('How soon you need an answer', URGENCY, 'whenever');
  const msg = h('textarea', { rows: '6', maxlength: '3500', required: true, 'aria-label': 'Your message', placeholder: 'What do you need? The more detail, the quicker the answer.' });
  const note = h('p', { class: 'jrk-msg', role: 'status' });
  const send = h('button', { class: 'btn', type: 'submit', disabled: !!deps.preview }, 'Send to Joseph');
  const startedAt = Date.now();
  const mailto = `mailto:${HELP_EMAIL}?subject=${enc(`${r.name}: help`)}`;
  const earlier = h('div');
  const showRecipe = () => { recipe.closest('.field').hidden = !recipes.length || !['A recipe', 'Costing and prices', 'Adding or changing recipes'].includes(topic.value); };
  topic.addEventListener('change', showRecipe);

  const form = h('form', { class: 'form jrk-helpform', onsubmit: async (e) => {
    e.preventDefault();
    note.textContent = '';
    if (!name.value.trim()) { note.textContent = 'Please add your name.'; name.focus(); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) { note.textContent = 'Please check your email address: Joseph replies there.'; email.focus(); return; }
    if ((reach.value === 'phone' || reach.value === 'text') && !phone.value.trim()) { note.textContent = 'Add a phone number, or choose Email.'; phone.focus(); return; }
    const body = msg.value.trim();
    if (!body) { note.textContent = 'Please write your message.'; msg.focus(); return; }
    const urgent = URGENCY.find(([v]) => v === urgency.value)[1];
    const details = [
      ['Restaurant', r.name], ['From', `${name.value.trim()} <${email.value.trim()}>`], ['Phone', phone.value.trim()],
      ['Best way to reach them', REACH.find(([v]) => v === reach.value)[1]], ['About', topic.value],
      ['Recipe', recipe.closest('.field').hidden ? '' : recipe.value], ['Needed', urgent],
    ].filter(([, v]) => v);
    const full = `${details.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${body}`;
    busy(send, true);
    // two routes, so the form reaches Joseph if either works: his inbox in Admin tools, and an email through the
    // website's own contact form (only on jonesridgekitchen.com)
    const saved = cloud.sendHelpMessage({ restaurantId: r.id, topic: `${topic.value}${urgency.value === 'urgent' ? ' · URGENT' : urgency.value === 'soon' ? ' · soon' : ''}`.slice(0, 60),
      body: full.slice(0, 4000), name: name.value.trim(), email: email.value.trim() }).then(() => true, () => false);
    const emailed = fetch('/api/inquiry', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Request-Id': `help-${startedAt}` },
      body: JSON.stringify({ name: name.value.trim(), email: email.value.trim(), phone: phone.value.trim(), service: 'consulting', started: startedAt,
        message: `Help request from ${r.name} (client portal)\n${full}` }) })
      .then(async (res) => res.ok && !(await res.json().catch(() => ({}))).error, () => false);
    const [inInbox, inEmail] = await Promise.all([saved, emailed]);
    busy(send, false);
    if (!inInbox && !inEmail) {
      note.replaceChildren('The form couldn’t be sent from this page. ', h('a', { class: 'btn line small', href: `${mailto}&body=${enc(full)}` }, 'Send it as an email instead'));
      return;
    }
    fill(form.parentElement, h('h2', null, 'Sent'),
      h('p', null, `Thanks, ${name.value.trim().split(' ')[0]}. Joseph has your message and will get back to you by ${reach.value === 'email' ? `email at ${email.value.trim()}` : `${reach.value === 'phone' ? 'phone' : 'text'} at ${phone.value.trim()}`}.`),
      urgency.value === 'urgent' && h('p', { class: 'note' }, 'For something that can’t wait during service, a call is quickest.'),
      h('p', null, h('a', { href: `#kitchen/${r.id}` }, '← Back to your recipes')));
    listEarlier();
  } },
  h('div', { class: 'jrk-row jrk-pair' }, field('Your name', name), field('Your email', email)),
  h('div', { class: 'jrk-row jrk-pair' }, field('Phone', phone, '(optional)'), field('Best way to reach you', reach)),
  h('div', { class: 'jrk-row jrk-pair' }, field('What it is about', topic), field('How soon', urgency)),
  h('div', { class: 'full' }, field('Which recipe', recipe, '(optional)')),
  h('div', { class: 'full' }, field('Your message', msg)),
  h('div', { class: 'full' }, note),
  h('div', { class: 'full' }, send, deps.preview && h('span', { class: 'note' }, ' Preview: sending is switched off here.')));
  showRecipe();

  async function listEarlier() {
    if (deps.preview) return;
    let rows = [];
    try { rows = await cloud.listHelpMessages(r.id); } catch { return; }
    if (mine !== screen.id || !rows.length) return;
    fill(earlier, h('h3', null, 'Your messages'), h('ul', { class: 'jrk-list jrk-help' }, rows.slice(0, 20).map((x) => {
      const text = x.body.split('\n\n').slice(1).join('\n\n') || x.body;
      return h('li', null,
        h('span', null, h('strong', null, x.topic || 'Message'), h('span', { class: 'note' }, ` · ${WHEN.format(new Date(x.created_at))}`), h('br'), text.length > 140 ? `${text.slice(0, 140)}…` : text),
        h('span', { class: `jrk-tag${x.status === 'done' ? '' : ' new'}` }, x.status === 'done' ? 'Answered' : 'With Joseph'));
    })));
  }
  frame(m, 'help',
    h('div', { class: 'jrk-card' }, h('h2', null, 'Ask Joseph'),
      h('p', null, `Questions about a recipe, costing, logins or ${r.name}’s plan. Fill this in and it goes straight to Joseph.`),
      form),
    earlier,
    h('p', { class: 'note' }, 'Or email ', h('a', { href: mailto }, HELP_EMAIL), ', or use the ', h('a', { href: CONTACT_ANY }, 'contact page'), '.'));
  listEarlier();
  // the recipe list is there once the kitchen has loaded; load it if this page was opened first
  if (!cached && restaurantPlan(r).on) {
    load(m).then((d) => { if (mine === screen.id && d.recipes.length) viewHelpRecipes(recipe, d.recipes, showRecipe); }).catch(() => {});
  }
}
function viewHelpRecipes(select, recipes, after) {
  fill(select, h('option', { value: '' }, 'Not about one recipe'), recipes.map((x) => h('option', { value: x.title }, x.title)));
  after();
}

// ------------------------------------------------------------------ Team (owners)
const COSTING_TEXT = { none: 'No costing', view: 'Can view costing', edit: 'Can edit costing' };

async function viewTeam(m) {
  const mine = screen.next();
  const r = m.restaurant;
  if (m.member_role !== 'owner' || deps.preview) { location.hash = `#kitchen/${r.id}`; return; }
  const list = h('div', { class: 'jrk-team' }, h('p', { class: 'note' }, 'Loading your team…'));
  const out = h('div', { 'aria-live': 'polite' });
  async function paintTeam() {
    let team;
    try { team = await cloud.restaurantTeam(r.id); } catch (err) { fill(list, h('p', { class: 'jrk-msg' }, `Could not load the team: ${err.message}`)); return; }
    if (mine !== screen.id) return;
    fill(list,
      h('p', { class: 'note' }, `${PACKAGES[packageOf(r)].label} package · ${team.length} of ${r.seat_limit} logins in use. To change your package, `, h('a', { href: `#kitchen/${r.id}/help` }, 'ask Joseph'), '.'),
      h('ul', { class: 'jrk-list jrk-teamlist' }, team.map((p) => {
        const me = p.user_id === deps.me.id;
        const level = p.member_role === 'owner' ? null : h('select', { 'aria-label': `Costing for ${p.display_name || p.email}` },
          Object.entries(COSTING_TEXT).map(([v, t]) => h('option', { value: v, selected: v === p.costing }, t)));
        if (level) {
          level.value = p.costing;
          level.addEventListener('change', async () => {
            try { await cloud.setMemberCosting(r.id, p.user_id, level.value); toast('Saved'); } catch (err) { toast(err.message); level.value = p.costing; }
          });
        }
        return h('li', null,
          h('span', null, h('strong', null, p.display_name || p.email, me && ' (you)'), h('br'), h('span', { class: 'note' }, p.email)),
          h('span', { class: 'jrk-row' }, p.member_role === 'owner' ? h('span', { class: 'jrk-tag' }, 'Owner · costing') : level,
            p.member_role !== 'owner' && h('button', { class: 'jrk-link', type: 'button', onclick: async () => {
              if (!await confirmBox(`Remove ${p.display_name || p.email} from ${r.name}? They lose access to the recipes and costing. Their login stays, so you can invite them again later.`, 'Remove', true)) return;
              try { await cloud.removeMember(r.id, p.user_id); toast('Removed'); paintTeam(); } catch (err) { toast(err.message); }
            } }, 'Remove')));
      })));
  }
  const btn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    busy(btn, true);
    try {
      const code = await cloud.createInvite('restaurant', r.id, 'staff', 1, 14);
      const link = `${location.origin}${location.pathname}?join=${enc(code)}`;
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
          h('a', { class: 'btn line small', href: `mailto:?subject=${enc(subject)}&body=${enc(body)}` }, 'Email it'))));
    } catch (err) { toast(err.message); } finally { busy(btn, false); }
  } }, 'Invite someone');
  frame(m, 'team',
    h('div', { class: 'jrk-card' }, h('h2', null, 'Your team'),
      h('p', null, 'Everyone here sees the recipes and the prep list, and can add recipes; staff can change only the ones they added. ',
        h('strong', null, 'Costing is yours:'), ' choose who can view or edit food costs, prices and plates.'),
      list),
    h('div', { class: 'jrk-card' }, h('h2', null, 'Invite someone'),
      h('p', null, 'Give a cook or manager their own login. New staff start with no costing access.'), btn, out));
  paintTeam();
}
