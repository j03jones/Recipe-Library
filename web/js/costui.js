// The "Nutrition" and "Food cost" cards on a recipe page, and the price book page.
// All the arithmetic is in nutrition.js; this file only shows it and saves what you type.
import { DAILY, NUTRIENTS, PRICE_UNITS, costing, dailyPct, defaultPriceUnit, foodCostPct, identify, macroSplit, nutrition, suggestedPrice } from './nutrition.js';
import { formatIngredient } from './units.js';
import * as prices from './prices.js';

const usd = (v) => `$${v.toFixed(2)}`;
const n0 = (v) => Math.round(v).toLocaleString();
const nutrientText = (f, v) => (f === 'kcal' || f === 'sodium' ? n0(v) : v < 10 ? (Math.round(v * 10) / 10).toString() : n0(v));
const num = (text) => { const v = parseFloat(String(text).replace(/[$,\s]/g, '')); return Number.isFinite(v) ? v : null; };
const unitOptions = (h) => Object.entries(PRICE_UNITS).map(([k, u]) => h('option', { value: k }, u.label));

/**
 * { nutri, cost, paint }: two <details> cards for a recipe page. Call paint() whenever the scale or units
 * change. `scaled()` returns the recipe as shown (scaled); `recipeId` keys the menu price (null = none kept).
 */
export function recipeCosting({ h, fill, scaled, recipeId }) {
  const nutri = h('details', { class: 'card nutri' });
  const cost = h('details', { class: 'card costcard' });
  let refresh = () => {};

  /** The Macronutrients expansion: calories by protein, carbs and fat; a table with daily values; where they come from. */
  const MACRO = [['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']];
  let macrosOpen = false;
  function macroBox(n) {
    const shown = n.per || n.total;
    const div = n.per ? n.servings : 1;
    const split = macroSplit(shown);
    if (!split) return null;
    const g1 = (v) => (v < 10 ? (Math.round(v * 10) / 10).toString() : n0(v));
    const pctText = (v) => `${Math.round(v)}%`;
    const rows = [['kcal', 'Calories', ''], ['protein', 'Protein', 'g'], ['carbs', 'Carbohydrates', 'g'], ['fat', 'Fat', 'g'], ['sodium', 'Sodium', 'mg']];
    const top = [...n.parts].sort((a, b) => b.kcal - a.kcal).slice(0, 8);
    const box = h('details', { class: 'macros', open: macrosOpen || null },
      h('summary', null, h('strong', null, 'Macronutrients'),
        h('span', { class: 'muted small' }, MACRO.map(([f, label]) => `${label} ${pctText(split[f].pct)}`).join(' · '))),
      h('p', { class: 'small muted' }, 'Share of calories from each, ', n.per ? 'per serving' : 'for the whole recipe', ':'),
      h('div', { class: 'macrobar', role: 'img', 'aria-label': MACRO.map(([f, label]) => `${label} ${pctText(split[f].pct)} of calories`).join(', ') },
        MACRO.map(([f]) => split[f].pct > 0 && h('span', { class: `m-${f}`, style: `width:${split[f].pct.toFixed(2)}%` }))),
      h('ul', { class: 'macrolegend' }, MACRO.map(([f, label]) => h('li', null, h('i', { class: `m-${f}`, 'aria-hidden': 'true' }),
        h('strong', null, label), ` ${g1(split[f].g)} g · ${pctText(split[f].pct)} of calories`))),
      h('div', { class: 'tablewrap' }, h('table', { class: 'macrotable' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Nutrient'), n.per && h('th', { scope: 'col' }, 'Per serving'),
          h('th', { scope: 'col' }, 'Whole recipe'), h('th', { scope: 'col' }, '% Daily Value'))),
        h('tbody', null, rows.map(([f, label, unit]) => h('tr', null,
          h('th', { scope: 'row' }, label),
          n.per && h('td', null, `${f === 'kcal' || f === 'sodium' ? n0(n.per[f]) : g1(n.per[f])}${unit ? ` ${unit}` : ''}`),
          h('td', null, `${f === 'kcal' || f === 'sodium' ? n0(n.total[f]) : g1(n.total[f])}${unit ? ` ${unit}` : ''}`),
          h('td', null, dailyPct(f, shown[f]) != null ? `${dailyPct(f, shown[f])}%` : '')))))),
      h('p', { class: 'small muted' }, `% Daily Value: how much of a day's ${n.per ? 'intake one serving' : 'intake the whole recipe'} gives, on a 2,000-calorie diet (fat ${DAILY.fat} g, carbohydrates ${DAILY.carbs} g, protein ${DAILY.protein} g, sodium ${n0(DAILY.sodium)} mg).`),
      top.length > 0 && [h('h4', null, 'Where it comes from'),
        h('div', { class: 'tablewrap' }, h('table', { class: 'macrotable sources' },
          h('thead', null, h('tr', null, ['Ingredient', 'Calories', 'Protein', 'Carbs', 'Fat'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, top.map((p) => h('tr', null,
            h('th', { scope: 'row' }, formatIngredient(p.ing)),
            h('td', null, n0(p.kcal / div)), h('td', null, `${g1(p.protein / div)} g`), h('td', null, `${g1(p.carbs / div)} g`), h('td', null, `${g1(p.fat / div)} g`)))))),
        h('p', { class: 'small muted' }, n.per ? 'Per serving. ' : 'Whole recipe. ', n.parts.length > top.length ? `The ${top.length} biggest of ${n.parts.length} counted ingredients.` : '')]);
    box.addEventListener('toggle', () => { macrosOpen = box.open; });
    return box;
  }

  function paintNutrition(s) {
    const n = nutrition(s);
    const enough = n.counted > 0 && n.coverage >= 0.5;
    const shown = n.per || n.total;
    const summary = !n.counted ? 'Not enough to estimate'
      : `${n0(shown.kcal)} calories${n.per ? ' per serving' : ' in the whole recipe'}${enough ? '' : ' (rough)'}`;
    fill(nutri,
      h('summary', null, h('strong', null, 'Nutrition'), h('span', { class: 'muted' }, summary)),
      n.counted > 0 && h('div', { class: 'nstats' }, NUTRIENTS.map(([f, label, unit]) =>
        h('div', null, h('strong', null, nutrientText(f, shown[f]), unit && h('em', null, unit)), h('span', null, label.toLowerCase())))),
      n.counted > 0 && h('p', { class: 'muted small' }, n.per ? 'Per serving. ' : 'No yield is listed, so this is the whole recipe. ',
        n.per && `Whole recipe: ${n0(n.total.kcal)} calories.`),
      n.counted > 0 && macroBox(n),
      h('p', { class: `small ${enough ? 'muted' : 'note'}` },
        n.counted ? `Estimated from ${n.counted} of ${n.lines} ingredients${enough ? '' : ', so treat it as rough'}.` : 'None of the ingredients could be matched or weighed.',
        ' Typical values, not a label: brands and cuts vary.'),
      n.skipped.length > 0 && h('details', { class: 'notcounted' },
        h('summary', { class: 'small' }, `Not counted (${n.skipped.length})`),
        h('ul', { class: 'small muted' }, n.skipped.map((x) => h('li', null, `${formatIngredient(x.ing)}: ${x.why}`)))));
  }

  function paintCost(s) {
    const book = prices.load();
    const c = costing(s, book.items);
    const rows = [];                       // refs to update in place while typing
    const unitsFor = (line) => (line.price ? line.price.per : defaultPriceUnit(line.ing, line.entry));
    const lineEls = c.lines.map((line, i) => {
      if (line.state === 'free') return null;
      const text = formatIngredient(line.ing);
      const name = h('span', { class: 'cl-what' }, h('strong', null, text),
        line.key && !text.toLowerCase().includes(line.key) && h('span', { class: 'muted small' }, ` priced as ${line.key}`));
      if (line.state === 'noamount') return h('li', { class: 'costline' }, name, h('span', { class: 'muted small' }, 'no amount, not counted'));
      const price = h('input', { class: 'pin', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00',
        'aria-label': `Price of ${line.key}`, value: line.price ? String(line.price.p) : '' });
      const per = h('select', { 'aria-label': `Priced per`, value: unitsFor(line) }, unitOptions(h));
      per.value = unitsFor(line);
      const out = h('span', { class: 'cl-cost' });
      const save = () => {
        const v = num(price.value);
        prices.setPrice(line.key, v == null ? '' : v, per.value);
        refresh();
      };
      price.addEventListener('input', save);
      per.addEventListener('change', save);
      rows.push({ i, out, price });
      return h('li', { class: 'costline' }, name,
        h('span', { class: 'cl-price' }, h('span', { 'aria-hidden': 'true' }, '$'), price, h('span', { class: 'muted' }, 'per'), per, out));
    }).filter(Boolean);

    const totals = h('div', { class: 'costtotals' });
    const target = h('input', { class: 'pin', type: 'text', inputmode: 'decimal', value: String(book.target), 'aria-label': 'Target food cost percent' });
    const menu = recipeId ? h('input', { class: 'pin', type: 'text', inputmode: 'decimal', placeholder: '0.00', 'aria-label': 'Menu price per serving',
      value: book.menu[recipeId] ? String(book.menu[recipeId]) : '' }) : null;
    const summary = h('summary', null);

    refresh = () => {
      const d = prices.load();
      const k = costing(scaled(), d.items);
      for (const r of rows) {
        const line = k.lines[r.i];
        r.out.textContent = line.state === 'ok' ? usd(line.cost) : line.state === 'noconvert' ? 'check unit' : '';
        r.out.classList.toggle('warn', line.state === 'noconvert');
      }
      const any = k.lines.some((l) => l.state === 'ok');
      const per = k.perServing;
      const sugg = per != null ? suggestedPrice(per, d.target) : null;
      const menuPrice = recipeId ? d.menu[recipeId] : null;
      const pct = per != null && menuPrice ? foodCostPct(per, menuPrice) : null;
      fill(summary, h('strong', null, 'Food cost'),
        h('span', { class: 'muted' }, !any ? 'Add prices to see it'
          : `${per != null ? `${usd(per)} per serving` : `${usd(k.total)} for the recipe`}${k.missing ? ` (+${k.missing} unpriced)` : ''}`));
      fill(totals,
        h('p', { class: 'ctline' }, h('span', null, 'Recipe total'), h('strong', null, any ? usd(k.total) : '–')),
        per != null && h('p', { class: 'ctline' }, h('span', null, `Per serving (${Math.round(k.servings * 100) / 100})`), h('strong', null, any ? usd(per) : '–')),
        k.missing > 0 && h('p', { class: 'note small' }, `${k.missing} ingredient${k.missing === 1 ? ' has' : 's have'} no price yet, so the total is low.`),
        per != null && any && h('div', { class: 'pricing' },
          h('label', { class: 'ctline' }, h('span', null, 'Target food cost'), h('span', { class: 'pin-wrap' }, target, h('span', null, '%'))),
          sugg != null && h('p', { class: 'ctline' }, h('span', null, 'Menu price for that'), h('strong', null, usd(Math.ceil(sugg * 4) / 4))),
          menu && h('label', { class: 'ctline' }, h('span', null, 'My menu price'), h('span', { class: 'pin-wrap' }, h('span', null, '$'), menu)),
          pct != null && h('p', { class: 'ctline' }, h('span', null, 'Food cost at that price'), h('strong', null, `${Math.round(pct * 10) / 10}%`)),
          pct != null && h('p', { class: 'ctline' }, h('span', null, 'Left over per serving'), h('strong', null, usd(menuPrice - per)))));
    };
    target.addEventListener('input', () => { const v = num(target.value); if (v != null && v >= 1 && v <= 100) { prices.setTarget(v); refresh(); } });
    menu?.addEventListener('input', () => { prices.setMenuPrice(recipeId, num(menu.value) ?? ''); refresh(); });

    fill(cost, summary,
      lineEls.length > 0
        ? h('ul', { class: 'costlines' }, lineEls)
        : h('p', { class: 'muted' }, 'This recipe has no ingredients to cost.'),
      totals,
      h('p', { class: 'muted small' }, 'Prices are yours alone and are remembered for every recipe that uses the same food. ',
        h('a', { href: '#/prices' }, `Price book (${Object.keys(book.items).length})`)));
    refresh();
  }

  return {
    nutri, cost,
    paint() { const s = scaled(); paintNutrition(s); paintCost(s); },
  };
}

// ---- the price book: every price you have saved, in one place
export function priceBook({ h, fill, toast }) {
  const root = h('div', { class: 'pricebook' });
  const search = h('input', { class: 'full', type: 'search', placeholder: 'Search your prices', 'aria-label': 'Search your prices', autocomplete: 'off' });
  const list = h('ul', { class: 'costlines' });
  const fileIn = h('input', { type: 'file', accept: '.csv,text/csv,text/plain', hidden: true });
  const status = h('p', { class: 'muted small', role: 'status' });

  function paint() {
    const book = prices.load();
    const q = search.value.trim().toLowerCase();
    const keys = Object.keys(book.items).filter((k) => !q || k.includes(q)).sort();
    fill(list, keys.length ? keys.map((key) => {
      const e = book.items[key];
      const price = h('input', { class: 'pin', type: 'text', inputmode: 'decimal', value: String(e.p), 'aria-label': `Price of ${key}` });
      const per = h('select', { 'aria-label': 'Priced per' }, unitOptions(h));
      per.value = e.per;
      const save = () => { const v = num(price.value); if (v != null) prices.setPrice(key, v, per.value); };
      price.addEventListener('change', save);
      per.addEventListener('change', save);
      return h('li', { class: 'costline' }, h('span', { class: 'cl-what' }, h('strong', null, key)),
        h('span', { class: 'cl-price' }, h('span', { 'aria-hidden': 'true' }, '$'), price, h('span', { class: 'muted' }, 'per'), per,
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${key}`, onclick: () => { prices.removePrice(key); paint(); } }, '✕')));
    }) : h('li', { class: 'muted' }, Object.keys(book.items).length ? 'No prices match.' : 'No prices yet. Open a recipe and fill in its Food cost card, or import a list.'));
  }
  search.addEventListener('input', paint);

  function exportCsv() {
    const blob = new Blob([prices.toCsv(prices.load())], { type: 'text/csv' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `ingredient-prices-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    fileIn.value = '';
    if (!f) return;
    try {
      const { items, bad } = prices.fromCsv(await f.text(), (name) => identify(name).key);
      const n = Object.keys(items).length;
      if (n) { const d = prices.load(); prices.save({ ...d, items: { ...d.items, ...items } }); }
      status.textContent = n ? `Added or updated ${n} price${n === 1 ? '' : 's'}.${bad.length ? ` ${bad.length} row${bad.length === 1 ? '' : 's'} could not be read.` : ''}`
        : 'No prices were found. Use three columns: food, price, per (lb, oz, kg, g, gallon, quart, liter, cup, each, dozen).';
      paint();
    } catch { toast('Could not read that file'); }
  });

  fill(root,
    h('p', { class: 'muted' }, 'Every price you have entered. A price applies to every recipe that uses the food, so you set “butter” once. Prices are yours alone and follow your account.'),
    h('div', { class: 'row grow' },
      h('button', { type: 'button', onclick: exportCsv }, 'Export CSV'),
      h('button', { type: 'button', onclick: () => fileIn.click() }, 'Import CSV'), fileIn),
    status,
    search,
    list,
    h('p', { class: 'muted small' }, 'A CSV has three columns: food, price, per. For example: butter, 4.50, lb.'));
  paint();
  return root;
}
