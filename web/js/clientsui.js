// Meal prep clients: the screens. The chef builds a week for each client; the client approves it
// meal by meal, looks back at what they have had, marks favourites and asks for dishes again.
// The rules live in clients.js and allergens.js; the database side is supabase/add_clients.sql.
import * as cloud from './cloud.js';
import * as planner from './planner.js';
import * as shop from './shopping.js';
import * as prices from './prices.js';
import { ALLERGENS, clean as cleanAllergens, conflicts, detect } from './allergens.js';
import {
  MACROS, PLANS, cleanTargets, defaultApproveBy, factorFor, groceryCost, history, labelFor, menuStatus,
  nutritionSummary, planOf, prepSheet, snapshot, tally, warnings,
} from './clients.js';

const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const SHORT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const WHEN = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const weekLabel = (iso) => `Week of ${SHORT.format(planner.parseDate(iso))}`;
const money = (v) => `$${Number(v || 0).toFixed(2).replace(/\.00$/, '')}`;
const parts = () => location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
const nextMonday = () => planner.addDays(planner.weekStart(planner.isoDate(new Date())), 7);
const localInput = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Ask for a line of text in the app's own dialog. Resolves to the text, or null if cancelled. */
function askText(ctx, message, { value = '', placeholder = '', ok = 'OK', optional = false } = {}) {
  const { h } = ctx;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; if (dlg.open) dlg.close(); dlg.remove(); resolve(v); };
    const input = h('input', { type: 'text', class: 'full', maxlength: '500', value, placeholder, 'aria-label': message });
    const dlg = h('dialog', { class: 'askdialog' }, h('form', { onsubmit: (e) => { e.preventDefault(); if (input.value.trim() || optional) done(input.value.trim()); } },
      h('p', null, message), input,
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => done(null) }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, ok))));
    dlg.addEventListener('close', () => done(null));
    document.body.append(dlg);
    dlg.showModal();
    input.focus();
  });
}

/** Shown when the database has not had supabase/add_clients.sql run yet. */
function notSetUp(ctx, err) {
  const { h, fill, $app, pageHead } = ctx;
  fill($app, pageHead('Clients'), h('p', { class: 'note' },
    /client|schema cache|does not exist|404/i.test(err.message || '')
      ? 'The client section needs a database update first: run supabase/add_clients.sql in the Supabase SQL Editor.'
      : `Could not load: ${err.message}`),
  h('p', null, h('a', { class: 'linkbtn', href: '#/settings' }, 'Back to Settings')));
}

function nutritionLine(h, n) {
  if (!n || !n.kcal) return h('p', { class: 'muted small' }, 'Nutrition not available for this dish.');
  return h('div', { class: 'macros' }, MACROS.map(([key, label, unit]) =>
    h('span', { class: 'macro' }, h('b', null, `${n[key] ?? 0}${unit}`), h('span', { class: 'muted small' }, ` ${label.toLowerCase()}`))),
  h('span', { class: 'muted small per' }, 'per serving'));
}

const allergenChips = (h, list, mine = []) => {
  const a = cleanAllergens(list);
  const bad = conflicts(a, mine);
  return h('div', { class: 'labels allergens' }, a.length
    ? a.map((x) => h('span', { class: `label${bad.includes(x) ? ' danger' : ''}` }, x))
    : h('span', { class: 'muted small' }, 'No major allergens listed'));
};

// =====================================================================================
// The chef's side
// =====================================================================================

/** #/clients: everyone you cook for, where each week stands, and what they have asked for. */
export async function viewClients(ctx) {
  const { h, fill, toast, $app, setView, pageHead, lib } = ctx;
  setView('clients', 'settings');
  if (lib.me?.role !== 'admin') { fill($app, pageHead('Clients'), h('p', { class: 'muted' }, 'Only the chef can see this page.')); return; }
  fill($app, pageHead('Clients', 'Meal prep clients and their weekly menus'), h('div', { class: 'sk' }), h('div', { class: 'sk' }));
  let clients, requests, menus;
  const week = nextMonday();
  try {
    [clients, requests, menus] = await Promise.all([cloud.listClients(), cloud.listRequests(), cloud.listMenusForWeek(week)]);
  } catch (err) { return notSetUp(ctx, err); }
  if (!parts()[0].startsWith('clients') || parts()[1]) return;      // moved on while loading

  const nameIn = h('input', { type: 'text', class: 'full', maxlength: '120', placeholder: 'Client name', 'aria-label': 'Client name', required: true });
  const emailIn = h('input', { type: 'email', class: 'full', maxlength: '200', placeholder: 'Their email (to link their login)', 'aria-label': 'Client email' });
  const planIn = h('select', { 'aria-label': 'Plan' }, Object.entries(PLANS).map(([k, p]) => h('option', { value: k }, `${p.label}${p.fee ? ` · $${p.fee}/week` : ''}`)));
  const form = h('form', { class: 'stack card addclient', onsubmit: async (e) => {
    e.preventDefault();
    const plan = PLANS[planIn.value];
    try {
      const row = await cloud.saveClient({ name: nameIn.value.trim(), email: emailIn.value.trim().toLowerCase(), plan: planIn.value, entrees: plan.entrees, servings: plan.servings, weekly_fee: plan.fee });
      location.hash = `#/clients/${row.id}`;
    } catch (err) { toast(err.message, 4500); }
  } }, h('h2', null, 'Add a client'), nameIn, emailIn, planIn, h('button', { class: 'primary', type: 'submit' }, 'Add client'));

  const open = requests.filter((r) => r.status === 'open');
  fill($app, pageHead('Clients', 'Meal prep clients and their weekly menus'),
    h('div', { class: 'row' },
      h('a', { class: 'linkbtn', href: `#/prep/${week}` }, `Prep sheet: ${weekLabel(week).toLowerCase()}`),
      h('a', { class: 'linkbtn', href: `#/prep/${planner.weekStart(planner.isoDate(new Date()))}` }, 'This week')),
    clients.length
      ? h('ul', { class: 'clientlist' }, clients.map((c) => {
        const menu = menus.find((m) => m.client_id === c.id);
        const asks = open.filter((r) => r.client_id === c.id).length;
        return h('li', null, h('a', { href: `#/clients/${c.id}` },
          h('strong', null, c.name), !c.active && h('span', { class: 'label' }, 'Paused'),
          h('span', { class: 'muted small' }, `${planOf(c).label} · ${c.entrees} × ${c.servings} servings${c.user_id ? '' : ' · has not signed in yet'}`),
          h('span', { class: 'small' }, `${weekLabel(week)}: ${menu ? menuStatus(menu) : 'no menu yet'}`),
          asks > 0 && h('span', { class: 'label danger' }, `${asks} ${asks === 1 ? 'request' : 'requests'}`)));
      }))
      : h('div', { class: 'empty' }, h('h2', null, 'No clients yet'),
        h('p', { class: 'muted' }, 'Add your first client below. They get their own page where they see the week you planned, with nutrition and allergens, and approve it meal by meal.')),
    form);
}

/** #/clients/<id>: one client: who they are, what they avoid, their menus, requests and history. */
export async function viewClient(ctx, id) {
  const { h, fill, toast, $app, setView, pageHead, confirmDialog } = ctx;
  setView('clients', 'settings');
  fill($app, pageHead('Client'), h('div', { class: 'sk' }), h('div', { class: 'sk' }));
  let client, menus, requests, favorites;
  try {
    const all = await cloud.listClients();
    client = all.find((c) => c.id === id);
    if (!client) { fill($app, pageHead('Client not found'), h('p', null, h('a', { href: '#/clients' }, 'Back to clients'))); return; }
    [menus, requests, favorites] = await Promise.all([cloud.listMenus(id), cloud.listRequests(id), cloud.listFavorites(id)]);
  } catch (err) { return notSetUp(ctx, err); }
  if (parts()[1] !== id || parts()[2]) return;

  // ---- profile
  const f = {
    name: h('input', { type: 'text', class: 'full', maxlength: '120', value: client.name, 'aria-label': 'Name' }),
    email: h('input', { type: 'email', class: 'full', maxlength: '200', value: client.email, 'aria-label': 'Email' }),
    plan: h('select', { 'aria-label': 'Plan', value: client.plan }, Object.entries(PLANS).map(([k, p]) => h('option', { value: k }, p.label))),
    entrees: h('input', { type: 'number', min: '1', max: '30', value: String(client.entrees), 'aria-label': 'Dishes per week' }),
    servings: h('input', { type: 'number', min: '1', max: '20', value: String(client.servings), 'aria-label': 'Servings of each dish' }),
    fee: h('input', { type: 'number', min: '0', step: '0.01', value: String(client.weekly_fee), 'aria-label': 'Weekly fee' }),
    notes: h('textarea', { rows: '3', maxlength: '5000', placeholder: 'Only you see this: gate code, kitchen notes…', 'aria-label': 'Private notes' }),
    allergyNotes: h('input', { type: 'text', class: 'full', maxlength: '1000', value: client.allergy_notes, placeholder: 'How severe, and anything else to know', 'aria-label': 'Allergy notes' }),
    dislikes: h('input', { type: 'text', class: 'full', maxlength: '1000', value: client.dislikes, placeholder: 'Foods to avoid, diets: no mushrooms, pescatarian…', 'aria-label': 'Foods to avoid' }),
    active: h('input', { type: 'checkbox', checked: client.active }),
  };
  f.notes.value = client.notes?.notes ?? (Array.isArray(client.notes) ? client.notes[0]?.notes : '') ?? '';
  f.plan.addEventListener('change', () => { const p = PLANS[f.plan.value]; if (f.plan.value !== 'custom') { f.entrees.value = p.entrees; f.servings.value = p.servings; f.fee.value = p.fee; } });
  const allergyBoxes = ALLERGENS.map((a) => [a, h('input', { type: 'checkbox', checked: client.allergens.includes(a) })]);
  const targets = cleanTargets(client.targets);
  const targetIns = MACROS.map(([key, label, unit]) => [key, h('input', { type: 'number', min: '0', value: targets[key] ? String(targets[key]) : '', placeholder: label, 'aria-label': `Daily ${label.toLowerCase()} target${unit ? ` (${unit})` : ''}` })]);
  const save = async () => {
    try {
      await cloud.saveClient({
        id, name: f.name.value.trim() || client.name, email: f.email.value.trim().toLowerCase(), plan: f.plan.value,
        entrees: Number(f.entrees.value) || client.entrees, servings: Number(f.servings.value) || client.servings,
        weekly_fee: Number(f.fee.value) || 0, allergens: allergyBoxes.filter(([, b]) => b.checked).map(([a]) => a),
        allergy_notes: f.allergyNotes.value.trim(), dislikes: f.dislikes.value.trim(),
        targets: cleanTargets(Object.fromEntries(targetIns.map(([k, i]) => [k, i.value]))), active: f.active.checked,
        notes: f.notes.value,
      });
      toast('Saved');
      viewClient(ctx, id);
    } catch (err) { toast(err.message, 4500); }
  };
  const invite = async () => {
    if (!f.email.value.trim()) { toast('Add their email first'); return; }
    try { await cloud.sendInvite({ email: f.email.value.trim().toLowerCase(), name: f.name.value.trim(), kind: 'student' }); toast('Invitation sent'); } catch (err) { toast(err.message, 4500); }
  };

  // ---- menus
  const weekIn = h('input', { type: 'date', value: nextMonday(), 'aria-label': 'Week starting' });
  const newMenu = async () => {
    const week = planner.weekStart(weekIn.value || nextMonday());
    const existing = menus.find((m) => m.week_start === week);
    if (existing) { location.hash = `#/clients/${id}/${existing.id}`; return; }
    try {
      const menu = await cloud.createMenu(id, week, { approve_by: defaultApproveBy(week).toISOString() });
      location.hash = `#/clients/${id}/${menu.id}`;
    } catch (err) { toast(err.message, 4500); }
  };

  const past = history(menus.filter((m) => m.status !== 'draft'));
  const openAsks = requests.filter((r) => r.status === 'open');
  fill($app,
    pageHead(client.name, `${planOf(client).label} · ${client.entrees} dishes × ${client.servings} servings · ${money(client.weekly_fee)} a week`),
    h('p', null, h('a', { class: 'linkbtn', href: '#/clients' }, '‹ All clients')),
    client.allergens.length > 0 && h('p', { class: 'note danger' }, h('strong', null, `Allergies: ${client.allergens.join(', ')}`), client.allergy_notes ? ` (${client.allergy_notes})` : ''),

    h('section', { class: 'stack' }, h('h2', null, 'Menus'),
      h('div', { class: 'row' }, h('label', { class: 'small' }, 'Week starting ', weekIn), h('button', { class: 'primary', type: 'button', onclick: newMenu }, 'Plan this week')),
      menus.length
        ? h('ul', { class: 'clientlist' }, menus.map((m) => h('li', null, h('a', { href: `#/clients/${id}/${m.id}` },
          h('strong', null, weekLabel(m.week_start)), h('span', { class: 'muted small' }, `${m.meals.length} ${m.meals.length === 1 ? 'meal' : 'meals'}`),
          h('span', { class: 'small' }, menuStatus(m))))))
        : h('p', { class: 'muted' }, 'No menus yet. Pick a week and plan the first one.')),

    openAsks.length > 0 && h('section', { class: 'stack' }, h('h2', null, 'They asked for'),
      h('ul', { class: 'asks' }, openAsks.map((r) => h('li', null,
        h('span', null, h('strong', null, r.title), r.note && h('span', { class: 'muted' }, ` — ${r.note}`)),
        h('span', { class: 'row' },
          h('button', { type: 'button', onclick: async () => { await cloud.updateRequest(r.id, 'planned'); viewClient(ctx, id); } }, 'Planned'),
          h('button', { type: 'button', onclick: async () => { await cloud.updateRequest(r.id, 'dismissed'); viewClient(ctx, id); } }, 'Dismiss')))))),

    past.length > 0 && h('section', { class: 'stack' }, h('h2', null, 'What they have had'),
      h('ul', { class: 'asks' }, past.slice(0, 40).map((d) => h('li', null,
        h('span', null, favorites.some((x) => x.dish === d.key) && h('span', { title: 'A favourite', 'aria-label': 'Favourite' }, '♥ '), d.title),
        h('span', { class: 'muted small' }, `${d.times === 1 ? 'once' : `${d.times} times`}${d.rating ? ` · ${'★'.repeat(Math.round(d.rating))} ${d.rating}` : ''} · last ${SHORT.format(planner.parseDate(d.last))}`))))),

    h('section', { class: 'stack card' }, h('h2', null, 'About this client'),
      h('label', null, 'Name', f.name), h('label', null, 'Email', f.email),
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: invite }, client.user_id ? 'Send the invitation again' : 'Email an invitation'),
        h('span', { class: 'muted small' }, client.user_id ? 'They have signed in.' : 'Not signed in yet. Their page links to this email address when they join.')),
      h('label', null, 'Plan', f.plan),
      h('div', { class: 'row trio' }, h('label', null, 'Dishes a week', f.entrees), h('label', null, 'Servings each', f.servings), h('label', null, 'Weekly fee ($)', f.fee)),
      h('fieldset', { class: 'allergybox' }, h('legend', null, 'Allergies'),
        h('div', { class: 'checks' }, allergyBoxes.map(([a, box]) => h('label', { class: 'check' }, box, a))), f.allergyNotes),
      h('label', null, 'Foods to avoid', f.dislikes),
      h('fieldset', null, h('legend', null, 'Daily targets (optional)'), h('div', { class: 'row quad' }, targetIns.map(([, i]) => i))),
      h('label', null, 'Private notes', f.notes),
      h('label', { class: 'check' }, f.active, 'Active client'),
      h('div', { class: 'row' }, h('button', { class: 'primary', type: 'button', onclick: save }, 'Save'),
        h('button', { type: 'button', onclick: async () => {
          if (await confirmDialog(`Remove ${client.name} and all their menus and history? This cannot be undone.`, 'Remove client', true)) {
            try { await cloud.deleteClient(id); location.hash = '#/clients'; } catch (err) { toast(err.message, 4500); }
          }
        } }, 'Remove client'))));
  window.scrollTo(0, 0);
}

/** #/clients/<id>/<menuId>: build a week, check allergens, send it, and see the answers. */
export async function viewMenu(ctx, clientId, menuId) {
  const { h, fill, toast, icon, $app, setView, pageHead, confirmDialog, lib } = ctx;
  setView('clients', 'settings');
  fill($app, pageHead('Menu'), h('div', { class: 'sk' }), h('div', { class: 'sk' }));
  let client, menu, templates;
  async function load() {
    const [all, menus, tpl] = await Promise.all([cloud.listClients(), cloud.listMenus(clientId), cloud.listTemplates().catch(() => [])]);
    client = all.find((c) => c.id === clientId);
    menu = menus.find((m) => m.id === menuId);
    templates = tpl;
  }
  try { await load(); } catch (err) { return notSetUp(ctx, err); }
  if (!client || !menu) { fill($app, pageHead('Menu not found'), h('p', null, h('a', { href: '#/clients' }, 'Back to clients'))); return; }
  const priceBook = () => prices.load().items;

  /** Add one recipe to the menu as a snapshot, at this client's servings. */
  async function addRecipe(recipeId, extra = {}) {
    const [missing] = await ctx.ensureFull([recipeId]);
    const r = lib.byId.get(recipeId);
    if (!r || missing) { toast('That recipe needs a connection the first time'); return null; }
    const servings = extra.servings || client.servings;
    const snap = snapshot(r, servings);
    const factor = factorFor(r, servings);
    const cost = groceryCost(r, factor, priceBook());
    return cloud.addMeal(menu.id, { ...snap, ...extra.fields, position: menu.meals.length + (extra.offset || 0) },
      { recipe_id: recipeId, factor: String(factor), grocery_cost: cost ? cost.total : null });
  }

  async function paint() {
    if (parts()[2] !== menuId) return;
    const t = tally(menu.meals);
    const editable = menu.status !== 'closed';
    const noteIn = h('textarea', { rows: '2', maxlength: '2000', placeholder: 'A note at the top of their menu (optional)', 'aria-label': 'Note to the client' });
    noteIn.value = menu.note || '';
    const byIn = h('input', { type: 'datetime-local', value: localInput(menu.approve_by ? new Date(menu.approve_by) : defaultApproveBy(menu.week_start)), 'aria-label': 'Answer by' });
    const saveHead = () => cloud.updateMenu(menu.id, { note: noteIn.value.trim(), approve_by: byIn.value ? new Date(byIn.value).toISOString() : null });
    const flagged = menu.meals.map((m) => [m, warnings(m, client)]).filter(([, w]) => w.length);
    const groceries = menu.meals.reduce((s, m) => s + (Number(m.private?.grocery_cost) || 0), 0);
    const unpriced = menu.meals.filter((m) => m.private?.grocery_cost == null).length;

    const mealCard = (m) => {
      const w = warnings(m, client);
      const suggested = detect(m.ingredients).map((d) => d.allergen);
      const boxes = ALLERGENS.map((a) => [a, h('input', { type: 'checkbox', checked: m.allergens.includes(a), disabled: !editable })]);
      const titleIn = h('input', { type: 'text', class: 'full', maxlength: '200', value: m.title, 'aria-label': 'Dish name', disabled: !editable });
      const descIn = h('textarea', { rows: '2', maxlength: '1000', placeholder: 'A sentence or two about the dish', 'aria-label': 'Description', disabled: !editable });
      descIn.value = m.description || '';
      const reheatIn = h('input', { type: 'text', class: 'full', maxlength: '1000', value: m.reheat || '', placeholder: 'Reheat: 350°F for 15 minutes, covered', 'aria-label': 'Reheating', disabled: !editable });
      const storeIn = h('input', { type: 'text', class: 'full', maxlength: '500', value: m.storage || '', placeholder: 'Keep: refrigerated, or freezes well', 'aria-label': 'Storage', disabled: !editable });
      const useByIn = h('input', { type: 'date', value: m.use_by || '', 'aria-label': 'Use by', disabled: !editable });
      const saveMeal = async () => {
        try {
          await cloud.updateMeal(m.id, { title: titleIn.value.trim() || m.title, description: descIn.value.trim(), reheat: reheatIn.value.trim(), storage: storeIn.value.trim(),
            use_by: useByIn.value || null, allergens: boxes.filter(([, b]) => b.checked).map(([a]) => a) });
          toast('Saved'); await load(); paint();
        } catch (err) { toast(err.message, 4500); }
      };
      const r = m.private?.recipe_id ? lib.byId.get(m.private.recipe_id) : null;
      return h('li', { class: `mealcard ${m.status}` },
        h('div', { class: 'row mealhead' },
          h('span', { class: `label ${m.status === 'swap' ? 'danger' : m.status === 'approved' ? 'ok' : ''}` },
            menu.status === 'draft' ? 'Draft' : m.status === 'approved' ? 'Approved' : m.status === 'swap' ? 'Swap requested' : 'Waiting'),
          h('span', { class: 'muted small' }, `${m.servings} ${m.servings === 1 ? 'serving' : 'servings'}`),
          r && h('a', { class: 'small', href: `#/r/${r.id}` }, 'Open the recipe'),
          m.private?.grocery_cost != null && h('span', { class: 'muted small' }, `groceries about ${money(m.private.grocery_cost)}`),
          editable && h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${m.title}`, title: 'Remove from the menu',
            onclick: async () => { if (await confirmDialog(`Take “${m.title}” off this menu?`, 'Remove', true)) { await cloud.deleteMeal(m.id); await load(); paint(); } } }, icon('close', { size: 18 }))),
        m.client_note && h('p', { class: 'note' }, h('strong', null, `${client.name}: `), m.client_note),
        m.rating && h('p', { class: 'small' }, `${'★'.repeat(m.rating)} ${m.feedback || ''}`),
        w.map((x) => h('p', { class: 'note danger' }, h('strong', null, x.text))),
        titleIn, descIn,
        h('p', { class: 'small muted ingline' }, m.ingredients.join(', ') || 'No ingredients listed'),
        nutritionLine(h, m.nutrition),
        m.nutrition?.coverage != null && m.nutrition.coverage < 70 && h('p', { class: 'muted small' }, `Only about ${m.nutrition.coverage}% of the ingredients could be counted, so treat these numbers as rough.`),
        h('fieldset', { class: 'allergybox' }, h('legend', null, 'Allergens (check them: this is what the client and the label will say)'),
          h('div', { class: 'checks' }, boxes.map(([a, box]) => h('label', { class: `check${suggested.includes(a) ? ' suggested' : ''}${client.allergens.includes(a) ? ' theirs' : ''}` }, box, a))),
          h('p', { class: 'muted small' }, suggested.length ? `Suggested from the ingredients: ${suggested.join(', ')}. Bought sauces and stocks are not checked.` : 'Nothing suggested from the ingredient names. Bought sauces and stocks are not checked.')),
        reheatIn, storeIn, h('label', { class: 'small' }, 'Use by ', useByIn),
        editable && h('div', { class: 'row' }, h('button', { type: 'button', onclick: saveMeal }, 'Save this meal'),
          m.status === 'swap' && h('button', { type: 'button', onclick: async () => {
            const pick = await ctx.pickRecipe(`replace “${m.title}”`);
            if (!pick?.id) return;
            const added = await addRecipe(pick.id, { servings: m.servings });
            if (added) { await cloud.deleteMeal(m.id); await load(); paint(); toast('Swapped. They will be asked to approve the new dish.'); }
          } }, 'Swap for another recipe')));
    };

    fill($app,
      pageHead(`${client.name}: ${weekLabel(menu.week_start).toLowerCase()}`, menuStatus(menu)),
      h('p', null, h('a', { class: 'linkbtn', href: `#/clients/${clientId}` }, `‹ ${client.name}`)),
      client.allergens.length > 0 && h('p', { class: 'note danger' }, h('strong', null, `${client.name} avoids: ${client.allergens.join(', ')}`), client.allergy_notes ? ` (${client.allergy_notes})` : '', client.dislikes ? `. Also: ${client.dislikes}` : ''),
      !client.allergens.length && client.dislikes && h('p', { class: 'note' }, `Avoid: ${client.dislikes}`),
      h('p', { class: 'muted small' }, `${menu.meals.length} of ${client.entrees} dishes planned · ${planOf(client).blurb}`),
      h('ul', { class: 'meals' }, menu.meals.map(mealCard)),
      editable && h('div', { class: 'row' },
        h('button', { class: 'primary', type: 'button', onclick: async () => {
          const pick = await ctx.pickRecipe(`${client.name}’s menu`);
          if (!pick?.id) return;
          try { if (await addRecipe(pick.id)) { await load(); paint(); } } catch (err) { toast(err.message, 4500); }
        } }, icon('plus', { size: 18 }), 'Add a dish'),
        templates.length > 0 && !menu.meals.length && h('select', { 'aria-label': 'Start from a saved week', onchange: async (e) => {
          const tpl = templates.find((x) => x.id === e.target.value);
          if (!tpl) return;
          let n = 0;
          for (const item of tpl.meals) {
            try { if (item.recipe_id && await addRecipe(item.recipe_id, { fields: { description: item.description || '', reheat: item.reheat || '', storage: item.storage || '' }, offset: n })) n++; } catch { /* a recipe that is gone: skip it */ }
          }
          await load(); paint(); toast(`${n} of ${tpl.meals.length} dishes added from “${tpl.name}”`);
        } }, h('option', { value: '' }, 'Start from a saved week…'), templates.map((x) => h('option', { value: x.id }, x.name)))),

      h('section', { class: 'stack card' }, h('h2', null, 'Send it'),
        noteIn, h('label', { class: 'small' }, 'Please answer by ', byIn),
        flagged.length > 0 && h('p', { class: 'note danger' }, `${flagged.length} ${flagged.length === 1 ? 'dish needs' : 'dishes need'} a second look for ${client.name} before this goes out.`),
        h('div', { class: 'row' },
          menu.status === 'draft' && h('button', { class: 'primary', type: 'button', disabled: !menu.meals.length, onclick: async () => {
            const bad = flagged.filter(([, w]) => w.some((x) => x.kind === 'allergen'));
            if (bad.length && !await confirmDialog(`${bad.map(([m]) => m.title).join(', ')} ${bad.length === 1 ? 'contains' : 'contain'} something ${client.name} is allergic to. Send it anyway?`, 'Send anyway', true)) return;
            try { await saveHead(); await cloud.updateMenu(menu.id, { status: 'sent', sent_at: new Date().toISOString() }); await load(); paint(); toast(`Sent. ${client.name} can see it now.`); } catch (err) { toast(err.message, 4500); }
          } }, `Send to ${client.name}`),
          menu.status === 'sent' && h('button', { type: 'button', onclick: async () => { await saveHead(); toast('Saved'); } }, 'Save note and deadline'),
          menu.status === 'sent' && h('button', { type: 'button', onclick: async () => {
            if (await confirmDialog(t.proposed || t.swap ? `${t.proposed + t.swap} ${t.proposed + t.swap === 1 ? 'dish is' : 'dishes are'} not approved. Finish this menu anyway? ${client.name} will not be able to answer after that.` : 'Finish this menu? It moves to their history.', 'Finish menu')) {
              await cloud.updateMenu(menu.id, { status: 'closed' }); await load(); paint();
            }
          } }, 'Finish this menu'),
          menu.status === 'sent' && h('button', { type: 'button', onclick: async () => { await cloud.updateMenu(menu.id, { status: 'draft' }); await load(); paint(); toast('Taken back. They cannot see it until you send it again.'); } }, 'Take it back'),
          menu.status === 'closed' && h('button', { type: 'button', onclick: async () => { await cloud.updateMenu(menu.id, { status: 'sent' }); await load(); paint(); } }, 'Reopen'))),

      h('section', { class: 'stack card' }, h('h2', null, 'For you'),
        h('p', null, h('strong', null, money(client.weekly_fee)), ' service fee · groceries about ', h('strong', null, money(groceries)),
          unpriced ? h('span', { class: 'muted small' }, ` (${unpriced} ${unpriced === 1 ? 'dish has' : 'dishes have'} no prices in your price book yet)`) : ''),
        h('p', { class: 'muted small' }, 'Groceries are billed to the client at receipt cost, so the fee is what you keep. The grocery figure is an estimate from your price book for planning.'),
        h('div', { class: 'row' },
          menu.meals.length > 0 && h('a', { class: 'linkbtn', href: `#/labels/${clientId}/${menuId}` }, 'Print labels'),
          h('a', { class: 'linkbtn', href: `#/prep/${menu.week_start}` }, 'Prep sheet for this week'),
          menu.meals.length > 0 && h('button', { type: 'button', onclick: async () => {
            const name = await askText(ctx, 'Name this week so you can reuse it', { value: `${planOf(client).label} week`, ok: 'Save' });
            if (!name) return;
            try {
              await cloud.saveTemplate(name.trim(), menu.meals.filter((m) => m.private?.recipe_id).map((m) => ({ recipe_id: m.private.recipe_id, title: m.title, description: m.description, reheat: m.reheat, storage: m.storage })));
              toast('Saved as a week you can reuse'); await load(); paint();
            } catch (err) { toast(err.message, 4500); }
          } }, 'Save as a reusable week'),
          menu.status === 'draft' && h('button', { type: 'button', onclick: async () => { if (await confirmDialog('Delete this draft menu?', 'Delete', true)) { await cloud.deleteMenu(menu.id); location.hash = `#/clients/${clientId}`; } } }, 'Delete draft'))));
  }
  paint();
  window.scrollTo(0, 0);
}

/** #/prep/<week>: everything approved for a week, across every client, as one cooking and shopping list. */
export async function viewPrep(ctx, weekArg) {
  const { h, fill, toast, $app, setView, pageHead, lib } = ctx;
  setView('clients', 'settings');
  const week = planner.weekStart(/^\d{4}-\d{2}-\d{2}$/.test(weekArg || '') ? weekArg : nextMonday());
  fill($app, pageHead('Prep sheet', weekLabel(week)), h('div', { class: 'sk' }), h('div', { class: 'sk' }));
  let menus;
  try {
    const [clients, rows] = await Promise.all([cloud.listClients(), cloud.listMenusForWeek(week)]);
    menus = rows.map((m) => ({ ...m, client: clients.find((c) => c.id === m.client_id) }));
  } catch (err) { return notSetUp(ctx, err); }
  const sheet = prepSheet(menus);
  const fee = menus.filter((m) => m.status !== 'draft').reduce((s, m) => s + Number(m.client?.weekly_fee || 0), 0);
  const groceries = menus.reduce((s, m) => s + m.meals.filter((x) => x.status === 'approved').reduce((a, x) => a + (Number(x.private?.grocery_cost) || 0), 0), 0);
  const listable = sheet.dishes.filter((d) => d.recipeId && lib.byId.get(d.recipeId));
  fill($app, pageHead('Prep sheet', weekLabel(week)),
    h('div', { class: 'row weeknav' },
      h('a', { class: 'linkbtn', href: `#/prep/${planner.addDays(week, -7)}` }, '‹ Earlier'),
      h('a', { class: 'linkbtn', href: '#/clients' }, 'Clients'),
      h('a', { class: 'linkbtn', href: `#/prep/${planner.addDays(week, 7)}` }, 'Later ›')),
    h('p', { class: 'muted small' }, `${menus.filter((m) => m.status !== 'draft').length} ${menus.length === 1 ? 'client' : 'clients'} this week · ${money(fee)} in fees · groceries about ${money(groceries)}`),
    sheet.dishes.length
      ? h('ul', { class: 'prep' }, sheet.dishes.map((d) => h('li', null,
        h('div', null, d.recipeId && lib.byId.get(d.recipeId) ? h('a', { href: `#/r/${d.recipeId}` }, h('strong', null, d.title)) : h('strong', null, d.title),
          h('span', { class: 'label' }, `${d.portions} ${d.portions === 1 ? 'portion' : 'portions'}`)),
        h('div', { class: 'muted small' }, d.clients.map((c) => `${c.name} × ${c.servings}`).join(' · ')))))
      : h('div', { class: 'empty' }, h('h2', null, 'Nothing approved yet'), h('p', { class: 'muted' }, 'Dishes appear here as clients approve them.')),
    sheet.waiting.length > 0 && h('section', { class: 'stack' }, h('h2', null, 'Still waiting'),
      h('ul', { class: 'asks' }, sheet.waiting.map((w) => h('li', null, h('span', null, w.title), h('span', { class: 'muted small' }, `${w.client} · ${w.status === 'swap' ? 'asked to swap' : 'no answer yet'}`))))),
    h('section', { class: 'tools stack' }, h('div', { class: 'row grow' },
      h('button', { class: 'primary', type: 'button', disabled: !listable.length, onclick: () => {
        for (const d of listable) shop.add(d.recipeId, d.factor);
        toast(`${listable.length} ${listable.length === 1 ? 'dish' : 'dishes'} on the shopping list, scaled for everyone`);
        location.hash = '#/shop';
      } }, 'Put it all on my shopping list'),
      h('button', { type: 'button', onclick: () => window.print() }, 'Print'))));
  window.scrollTo(0, 0);
}

/** #/labels/<clientId>/<menuId>: a sheet of container labels to print. */
export async function viewLabels(ctx, clientId, menuId) {
  const { h, fill, $app, setView, pageHead } = ctx;
  setView('labels', 'settings');
  let client, menu;
  try {
    const [all, menus] = await Promise.all([cloud.listClients(), cloud.listMenus(clientId)]);
    client = all.find((c) => c.id === clientId);
    menu = menus.find((m) => m.id === menuId);
  } catch (err) { return notSetUp(ctx, err); }
  if (!client || !menu) { fill($app, pageHead('Labels'), h('p', null, h('a', { href: '#/clients' }, 'Back to clients'))); return; }
  const madeIn = h('input', { type: 'date', value: planner.isoDate(new Date()), 'aria-label': 'Date made' });
  const eachIn = h('input', { type: 'checkbox', checked: planOf(client).servings === 1 });
  const sheet = h('div', { class: 'labelsheet' });
  function paint() {
    const made = madeIn.value ? SHORT.format(planner.parseDate(madeIn.value)) : '';
    const meals = menu.meals.filter((m) => m.status !== 'swap');
    fill(sheet, meals.flatMap((m) => {
      const L = labelFor(m, client, made);
      const one = () => h('div', { class: 'foodlabel' },
        h('strong', { class: 'lt' }, L.title),
        h('span', { class: 'lc' }, `${L.client}${L.made ? ` · made ${L.made}` : ''}${L.useBy ? ` · use by ${SHORT.format(planner.parseDate(L.useBy))}` : ''}`),
        L.macros && h('span', { class: 'lm' }, L.macros),
        L.lines.map((x) => h('span', { class: 'll' }, x)),
        h('span', { class: 'la' }, L.allergens));
      return Array.from({ length: eachIn.checked ? m.servings : 1 }, one);
    }));
  }
  madeIn.addEventListener('change', paint); eachIn.addEventListener('change', paint);
  fill($app, pageHead('Labels', `${client.name} · ${weekLabel(menu.week_start).toLowerCase()}`),
    h('div', { class: 'row labeltools' }, h('a', { class: 'linkbtn', href: `#/clients/${clientId}/${menuId}` }, '‹ Menu'),
      h('label', { class: 'small' }, 'Made on ', madeIn), h('label', { class: 'check' }, eachIn, 'One label per serving'),
      h('button', { class: 'primary', type: 'button', onclick: () => window.print() }, 'Print')),
    sheet);
  paint();
}

// =====================================================================================
// The client's side
// =====================================================================================

/** #/meals: the client's own page: this week's menu to approve, what they have had, favourites and requests. */
export async function viewMyMeals(ctx) {
  const { h, fill, toast, icon, $app, setView, pageHead, lib } = ctx;
  setView('meals', 'meals');
  const client = lib.clients?.[0];
  if (!client) {
    fill($app, pageHead('My meals'), h('p', { class: 'muted' }, lib.me
      ? 'This page is for Jones Ridge Kitchen meal prep clients. If you are one, sign in with the email address your chef has for you.'
      : 'Sign in to see the menu your chef planned for you.'),
    h('p', null, h('a', { class: 'linkbtn', href: '#/settings' }, lib.me ? 'Settings' : 'Sign in'), ' ',
      h('a', { class: 'linkbtn', href: 'https://jonesridgekitchen.com/meal-prep/', target: '_blank', rel: 'noopener' }, 'About meal prep')));
    return;
  }
  fill($app, pageHead('My meals'), h('div', { class: 'sk' }), h('div', { class: 'sk' }));
  let menus, favorites, requests;
  async function load() {
    [menus, favorites, requests] = await Promise.all([cloud.myMenus(client.id), cloud.listFavorites(client.id), cloud.listRequests(client.id)]);
  }
  try { await load(); } catch (err) { fill($app, pageHead('My meals'), h('p', { class: 'note' }, `Could not load your meals: ${err.message}`)); return; }

  function paint() {
    if (parts()[0] !== 'meals') return;
    const current = menus.find((m) => m.status === 'sent');
    const fav = new Set(favorites.map((x) => x.dish));
    const past = history(menus);
    const openAsks = requests.filter((r) => r.status === 'open');
    const plan = planOf(client);

    const answer = async (meal, approve) => {
      let note = '';
      if (!approve) {
        note = await askText(ctx, `What would you like instead of “${meal.title}”, or what should change?`, { value: meal.client_note || '', placeholder: 'No fish this week, something with chicken…', ok: 'Ask for a swap', optional: true });
        if (note === null) return;
      }
      try { await cloud.respondToMeal(meal.id, approve, note); await load(); paint(); toast(approve ? 'Approved' : 'Your chef will swap it'); } catch (err) { toast(err.message, 4500); }
    };
    const heart = (title) => {
      const on = fav.has(title.trim().toLowerCase());
      return h('button', { class: 'heart', type: 'button', 'aria-pressed': String(on), 'aria-label': on ? `Remove ${title} from favourites` : `Add ${title} to favourites`, title: on ? 'A favourite' : 'Mark as a favourite',
        onclick: async () => { try { await cloud.setFavorite(client.id, title, !on); await load(); paint(); } catch (err) { toast(err.message, 4500); } } }, on ? '♥' : '♡');
    };
    const again = (title) => h('button', { type: 'button', onclick: async () => {
      const note = await askText(ctx, `Ask for “${title}” again. Anything to add?`, { placeholder: 'Optional', ok: 'Send request', optional: true });
      if (note === null) return;
      try { await cloud.requestMeal(client.id, title, note); await load(); paint(); toast('Request sent to your chef'); } catch (err) { toast(err.message, 4500); }
    } }, 'Have this again');
    const stars = (meal) => h('div', { class: 'ratingrow', role: 'group', 'aria-label': `Rate ${meal.title}` }, [1, 2, 3, 4, 5].map((n) =>
      h('button', { class: 'ratestar', type: 'button', 'aria-pressed': String((meal.rating || 0) >= n), 'aria-label': `${n} ${n === 1 ? 'star' : 'stars'}`,
        onclick: async () => {
          const feedback = meal.rating ? meal.feedback : (await askText(ctx, 'Anything to tell your chef about it?', { placeholder: 'Optional', ok: 'Send', optional: true }) ?? '');
          try { await cloud.rateMeal(meal.id, n, feedback); await load(); paint(); } catch (err) { toast(err.message, 4500); }
        } }, icon('star', { size: 22, fill: (meal.rating || 0) >= n }))));

    const mealCard = (meal, open) => h('li', { class: `mealcard ${meal.status}` },
      h('div', { class: 'row mealhead' }, h('h3', null, meal.title), heart(meal.title)),
      meal.description && h('p', null, meal.description),
      conflicts(meal.allergens, client.allergens).length > 0 && h('p', { class: 'note danger' }, h('strong', null, `Contains ${conflicts(meal.allergens, client.allergens).join(', ')}, which is on your allergy list. Ask for a swap.`)),
      h('p', { class: 'small ingline' }, h('strong', null, 'Ingredients: '), meal.ingredients.join(', ') || 'Ask your chef'),
      nutritionLine(h, meal.nutrition),
      allergenChips(h, meal.allergens, client.allergens),
      (meal.reheat || meal.storage || meal.use_by) && h('p', { class: 'muted small' }, [meal.reheat && `Reheat: ${meal.reheat}`, meal.storage && `Keep: ${meal.storage}`, meal.use_by && `Use by ${SHORT.format(planner.parseDate(meal.use_by))}`].filter(Boolean).join(' · ')),
      h('p', { class: 'muted small' }, `${meal.servings} ${meal.servings === 1 ? 'serving' : 'servings'}`),
      open
        ? h('div', { class: 'row answer' },
          h('button', { class: meal.status === 'approved' ? 'primary' : '', type: 'button', 'aria-pressed': String(meal.status === 'approved'), onclick: () => answer(meal, true) }, meal.status === 'approved' ? '✓ Approved' : 'Approve'),
          h('button', { type: 'button', 'aria-pressed': String(meal.status === 'swap'), onclick: () => answer(meal, false) }, meal.status === 'swap' ? 'Swap requested' : 'Swap this'))
        : h('div', { class: 'row' }, stars(meal), again(meal.title)),
      meal.status === 'swap' && meal.client_note && h('p', { class: 'note' }, `You asked: ${meal.client_note}`));

    const t = current ? tally(current.meals) : null;
    const summary = current ? nutritionSummary(current.meals, client.targets) : null;
    const boxes = ALLERGENS.map((a) => [a, h('input', { type: 'checkbox', checked: client.allergens.includes(a) })]);
    const notesIn = h('input', { type: 'text', class: 'full', maxlength: '1000', value: client.allergy_notes || '', placeholder: 'How severe, and anything else we should know', 'aria-label': 'Allergy notes' });
    const avoidIn = h('input', { type: 'text', class: 'full', maxlength: '1000', value: client.dislikes || '', placeholder: 'Diets and foods to avoid', 'aria-label': 'Foods to avoid' });
    const askIn = h('input', { type: 'text', class: 'full', maxlength: '200', placeholder: 'Ask for a dish: shrimp and grits, something with salmon…', 'aria-label': 'Ask for a dish' });

    fill($app,
      pageHead(`Hello, ${client.name.split(' ')[0]}`, `${plan.label} · ${plan.blurb}`),
      current
        ? h('section', { class: 'stack' },
          h('h2', null, weekLabel(current.week_start)),
          current.note && h('p', { class: 'note' }, current.note),
          h('p', { class: 'small', role: 'status' }, t.proposed
            ? `${t.proposed} of ${t.total} ${t.total === 1 ? 'dish is' : 'dishes are'} waiting for your answer${current.approve_by ? `. Please answer by ${WHEN.format(new Date(current.approve_by))}` : ''}.`
            : t.swap ? `Thank you. ${t.swap} ${t.swap === 1 ? 'swap is' : 'swaps are'} with your chef.` : 'All approved. Thank you!'),
          t.proposed > 1 && h('button', { class: 'primary', type: 'button', onclick: async () => {
            try { for (const m of current.meals.filter((x) => x.status === 'proposed')) await cloud.respondToMeal(m.id, true, ''); await load(); paint(); toast('All approved'); } catch (err) { toast(err.message, 4500); }
          } }, `Approve all ${t.proposed} waiting`),
          summary && h('p', { class: 'muted small' }, `On average each serving is about ${summary.avg.kcal} calories, ${summary.avg.protein}g protein, ${summary.avg.carbs}g carbs and ${summary.avg.fat}g fat`,
            summary.share.kcal ? ` (${summary.share.kcal}% of your daily calorie target)` : '', '. These are estimates from typical values.'),
          h('ul', { class: 'meals' }, current.meals.map((m) => mealCard(m, true))))
        : h('div', { class: 'empty' }, h('h2', null, 'No menu waiting'),
          h('p', { class: 'muted' }, 'When your chef plans your next week it will appear here for you to approve, dish by dish.')),

      h('section', { class: 'stack card' }, h('h2', null, 'Ask for something'),
        h('form', { class: 'row addextra', onsubmit: async (e) => {
          e.preventDefault();
          if (!askIn.value.trim()) return;
          try { await cloud.requestMeal(client.id, askIn.value.trim(), ''); askIn.value = ''; await load(); paint(); toast('Request sent to your chef'); } catch (err) { toast(err.message, 4500); }
        } }, askIn, h('button', { type: 'submit' }, 'Ask')),
        openAsks.length > 0 && h('ul', { class: 'asks' }, openAsks.map((r) => h('li', null, h('span', null, r.title, r.note && h('span', { class: 'muted' }, ` — ${r.note}`)), h('span', { class: 'muted small' }, 'with your chef'))))),

      past.length > 0 && h('section', { class: 'stack' }, h('h2', null, 'What you have had'),
        h('ul', { class: 'meals' }, menus.filter((m) => m.status === 'closed').slice(0, 8).flatMap((m) => [
          h('li', { class: 'weekhead' }, weekLabel(m.week_start)),
          ...m.meals.filter((x) => x.status !== 'swap').map((x) => mealCard(x, false))])),
        h('h3', null, 'Every dish so far'),
        h('ul', { class: 'asks' }, past.map((d) => h('li', null,
          h('span', null, heart(d.title), ' ', d.title),
          h('span', { class: 'row' }, h('span', { class: 'muted small' }, `${d.times === 1 ? 'once' : `${d.times} times`}${d.rating ? ` · ${d.rating}★` : ''}`), again(d.title)))))),

      h('section', { class: 'stack card' }, h('h2', null, 'Allergies and foods to avoid'),
        h('p', { class: 'muted small' }, 'Keep this up to date. Your chef checks every dish against it.'),
        h('div', { class: 'checks' }, boxes.map(([a, box]) => h('label', { class: 'check' }, box, a))),
        notesIn, avoidIn,
        h('button', { type: 'button', onclick: async () => {
          try {
            await cloud.updateMyPreferences(client.id, boxes.filter(([, b]) => b.checked).map(([a]) => a), notesIn.value, avoidIn.value);
            lib.clients = await cloud.myClients();
            toast('Saved. Your chef will see it.'); viewMyMeals(ctx);
          } catch (err) { toast(err.message, 4500); }
        } }, 'Save')),
      h('p', { class: 'muted small' }, 'Questions about your plan? ', h('a', { href: 'https://jonesridgekitchen.com/contact/', target: '_blank', rel: 'noopener' }, 'Contact Jones Ridge Kitchen'), '.'));
  }
  paint();
  window.scrollTo(0, 0);
}
