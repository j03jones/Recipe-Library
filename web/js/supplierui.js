// Importing a supplier's price list (Sysco, SGC, Ben E. Keith, US Foods, ...) into the price book: pick the
// file, check what each product was read as, fix anything, and add the prices. The reading and matching
// is in supplier.js.
import { FOODS } from './nutridata.js';
import { identify, PRICE_UNITS } from './nutrition.js';
import * as prices from './prices.js';
import { ROLES, defaultPicks, guessSupplier, headingKey, matchKey, readSupplierFile, roleLabel, toPrices } from './supplier.js';
import { readTable } from './xlsx.js';

const MAP_KEY = 'recipelib.supplierColumns';      // { [headingKey]: { role: column } }, remembered per file layout
const MATCH_KEY = 'recipelib.supplierMatches';    // { [product description]: food }, what you chose last time
const PAGE = 150;
const usd = (v) => `$${v < 1 ? v.toFixed(3).replace(/0$/, '') : v.toFixed(2)}`;
const loadMaps = () => { try { return JSON.parse(localStorage.getItem(MAP_KEY) || '{}') || {}; } catch { return {}; } };
const saveMap = (key, map) => { try { const all = loadMaps(); all[key] = map; localStorage.setItem(MAP_KEY, JSON.stringify(all)); } catch { /* private mode */ } };
const today = () => new Date().toISOString().slice(0, 10);
/** How a food is shown: its readable name ("half and half"), not the key prices are filed under. */
const label = (key) => identify(key).entry?.name || key;

const loadMatches = () => { try { return JSON.parse(localStorage.getItem(MATCH_KEY) || '{}') || {}; } catch { return {}; } };
/** Your own price book's save: the prices, and the matches to remember on this device. */
function saveOwn(items, matches) {
  try { localStorage.setItem(MATCH_KEY, JSON.stringify({ ...loadMatches(), ...matches })); } catch { /* private mode */ }
  return prices.addMany(items);
}

/** The file types the import accepts, for <input type=file accept>. */
export const ACCEPT = '.csv,.txt,.tsv,.xlsx,text/csv,text/plain,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** A chosen file as the importer takes it: rows (Excel) or text (CSV). Throws with a message to show. */
export const readImportFile = (file) => readTable(file);

/**
 * The import panel. `onDone(n, supplier)` is called after prices are added (or with 0 when cancelled).
 * `book` and `save` default to your own price book; a restaurant's kitchen passes its shared one
 * (`save(items, matches)` may be async and returns how many were saved). `text` is a CSV's text or an
 * Excel sheet's rows. `ingredients` are the names on the costing sheet: a product matches one of those
 * before anything else. `matches` are the choices made in earlier imports ({ description: food }).
 */
export function supplierImport({ h, fill, toast, file, text, onDone, book: bookIn, save = saveOwn, ingredients = [], matches: matchesIn }) {
  const root = h('section', { class: 'card supplier', 'aria-label': 'Import a supplier price list' });
  let override = null;
  let read;
  let picks;
  let foods;                                      // row index -> food key chosen (from the match, or typed)
  let filter = 'all';
  let shown = PAGE;
  const supplierIn = h('input', { type: 'text', maxlength: '40', value: guessSupplier(file?.name, text), placeholder: 'Sysco, SGC, Ben E. Keith…', 'aria-label': 'Supplier' });
  const book = bookIn || prices.load().items;
  const matches = matchesIn || loadMatches();
  const ownNames = [...new Set([...ingredients, ...Object.keys(book)])];
  const ours = new Set(ownNames);
  // your own ingredients first in the suggestions, then the food table
  const known = [...ownNames.sort(), ...[...new Set(FOODS.map((f) => f[0]))].filter((f) => !ours.has(f)).sort()];
  const listId = `foods-${Math.random().toString(36).slice(2, 8)}`;

  function load() {
    const saved = override || null;
    read = readSupplierFile(text, { map: saved, extraNames: ownNames, matches });
    // a layout seen before: use the columns chosen last time
    if (!override) {
      const remembered = loadMaps()[headingKey(read.headings)];
      if (remembered) { override = remembered; read = readSupplierFile(text, { map: remembered, extraNames: ownNames, matches }); }
    }
    picks = defaultPicks(read.rows);
    foods = read.rows.map((r) => r.food || '');
    shown = PAGE;
  }

  const per = (x) => (x.per === 'each' ? `${usd(x.p)} each` : `${usd(x.p)} per ${PRICE_UNITS[x.per]?.label || x.per}`);
  const priceText = (r) => (r.price ? per(r.price) : '');

  function columns() {
    const opts = (role) => h('select', { 'aria-label': roleLabel(role), onchange: (e) => {
      const m = { ...read.map };
      if (e.target.value === '') delete m[role]; else m[role] = Number(e.target.value);
      override = m;
      saveMap(headingKey(read.headings), m);
      load(); paint();
    } }, h('option', { value: '' }, '(none)'), read.headings.map((hd, c) => h('option', { value: String(c), selected: read.map[role] === c }, hd || `Column ${c + 1}`)));
    const found = ROLES.filter((r) => read.map[r] != null).map((r) => `${roleLabel(r)}: ${read.headings[read.map[r]]}`);
    return h('details', { class: 'cols' },
      h('summary', null, found.length ? `Columns: ${found.join(' · ')}` : 'No columns recognised: choose them here'),
      h('p', { class: 'muted small' }, 'Fix any column that was read wrong. Your choice is remembered for files laid out the same way.'),
      h('div', { class: 'colgrid' }, ROLES.map((role) => h('label', null, roleLabel(role), opts(role)))));
  }

  function paint() {
    const rows = read.rows;
    const matched = rows.filter((r, i) => r.price && foods[i]).length;
    const needFood = rows.filter((r, i) => r.price && !foods[i]).length;
    const noPrice = rows.filter((r) => !r.price).length;
    const tickedRows = [...picks].filter((i) => rows[i]?.price && foods[i]);
    const pass = (r, i) => filter === 'all' || (filter === 'ticked' && picks.has(i)) || (filter === 'matched' && r.price && foods[i])
      || (filter === 'food' && r.price && !foods[i]) || (filter === 'noprice' && !r.price);
    const visible = rows.map((r, i) => [r, i]).filter(([r, i]) => pass(r, i));
    const chip = (key, text, n) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(filter === key), onclick: () => { filter = key; shown = PAGE; paint(); } }, `${text} ${n}`);
    const add = h('button', { class: 'primary', type: 'button', disabled: !tickedRows.length, onclick: async (e) => {
      const supplier = supplierIn.value.trim();
      const items = toPrices(rows.map((r, i) => ({ ...r, food: foods[i] })), new Set(tickedRows), supplier, today());
      e.target.disabled = true;
      // remember what each ticked product was matched to, so the next order from this supplier matches itself
      const learned = {};
      for (const i of tickedRows) if (rows[i].description && foods[i]) learned[matchKey(rows[i].description)] = foods[i];
      let n;
      try { n = await save(items, learned); } catch (err) { e.target.disabled = false; toast(err?.message || 'Could not save the prices'); return; }
      toast(`Added ${n} price${n === 1 ? '' : 's'}${supplier ? ` from ${supplier}` : ''}`);
      onDone?.(n, supplier);
    } }, `Add ${tickedRows.length} price${tickedRows.length === 1 ? '' : 's'}`);

    fill(root,
      h('h2', null, 'Import a supplier price list'),
      h('label', { class: 'supname' }, 'Supplier ', supplierIn),
      rows.length
        ? h('p', { class: 'muted small', role: 'status' }, `${rows.length} products: ${matched} matched to a food, ${needFood} need a food chosen, ${noPrice} could not be priced. `,
          'Where several products match one food, the cheapest per pound (or gallon, or piece) is ticked.')
        : h('p', { class: 'note' }, 'No products were found in this file. Check the columns below, or export the order guide again as CSV with prices included.'),
      read.noPrices && h('p', { class: 'note' }, 'This file lists products but no prices (a Sysco purchase history leaves its Case $ column empty). '
        + 'Export an order guide or an invoice with prices, or choose the price column below if it has another name.'),
      columns(),
      rows.length > 0 && h('div', { class: 'chips', role: 'group', 'aria-label': 'Show' },
        chip('all', 'All', rows.length), chip('ticked', 'Ticked', tickedRows.length), chip('matched', 'Matched', matched), chip('food', 'Need a food', needFood), chip('noprice', 'Not priced', noPrice)),
      h('datalist', { id: listId }, known.map((k) => h('option', { value: k }))),
      h('ul', { class: 'suprows' }, visible.slice(0, shown).map(([r, i]) => {
        const box = h('input', { type: 'checkbox', checked: picks.has(i), disabled: !r.price, 'aria-label': `Add ${r.description}` });
        const foodIn = h('input', { type: 'text', list: listId, value: foods[i] ? label(foods[i]) : '', placeholder: r.price ? (r.suggest ? `e.g. ${r.suggest}` : 'Which food?') : '', 'aria-label': `Food for ${r.description}`, disabled: !r.price });
        box.addEventListener('change', () => {
          if (box.checked && !foods[i] && r.suggest) { foods[i] = r.suggest; }        // ticking an unmatched product uses its own name
          if (box.checked) picks.add(i); else picks.delete(i);
          paint();
        });
        foodIn.addEventListener('change', () => {
          const v = foodIn.value.trim();
          foods[i] = v ? identify(v).key : '';
          if (foods[i]) picks.add(i); else picks.delete(i);
          paint();
        });
        const now = foods[i] && book[foods[i]];
        return h('li', { class: `suprow${r.price ? '' : ' off'}` },
          h('label', { class: 'supbox' }, box),
          h('div', { class: 'supwhat' },
            h('strong', null, r.description || '(no description)'),
            h('span', { class: 'muted small' }, [r.brand, r.item && `#${r.item}`, r.packText, r.casePrice != null && `${usd(r.casePrice)} ${!r.price || r.price.from === 'case' ? 'case' : 'listed'}`].filter(Boolean).join(' · ')),
            r.price ? h('span', { class: 'supprice' }, priceText(r), r.price.from === 'catch weight' && h('span', { class: 'muted small' }, ' (priced by the pound)'),
              r.price.from === 'each unit' && h('span', { class: 'muted small' }, ' (price for one, not the case)'),
              now && h('span', { class: 'muted small' }, `  (now ${per(now)}${now.src ? `, ${now.src}` : ''})`))
              : h('span', { class: 'note small' }, r.why === 'pack size not understood' ? `Pack size “${r.packText}” not understood` : 'No price')),
          h('div', { class: 'supfood' }, foodIn,
            foods[i] && (foods[i] === r.food && r.remembered ? h('span', { class: 'muted small suptag' }, 'as you chose last time')
              : ours.has(foods[i]) ? h('span', { class: 'muted small suptag' }, 'on your costing sheet') : null)));
      })),
      visible.length > shown && h('button', { class: 'more', type: 'button', onclick: () => { shown += PAGE; paint(); } }, `Show more (${visible.length - shown})`),
      h('div', { class: 'row grow suptools' }, add, h('button', { type: 'button', onclick: () => onDone?.(0) }, 'Cancel')),
      h('p', { class: 'muted small' }, 'Prices are worked out per pound, gallon or piece from the case price and pack size, so recipes in cups or ounces are costed too. '
        + 'A price per pound in the file (catch-weight meat and cheese) is used as it is.'));
  }

  load();
  paint();
  return root;
}
