// Supplier price lists (Sysco, SGC, Ben E. Keith, US Foods, ...) into the price book.
//
// A distributor's order guide or invoice export is a CSV with one row per product: an item number, a
// description like "CHEESE CHEDDAR SHRD MILD", a pack and size like "4/5 LB" or "6/#10", and a case price.
// Every distributor names its columns a little differently, so columns are found by name (with a manual
// choice for anything that is not recognised), the pack is read to find how many pounds, gallons or pieces
// a case holds, and the case price becomes a price per lb, gallon or each: what the price book uses to
// cost a recipe in any unit. The description is matched to the food it is, the same way recipe lines are.
// Pure functions, no DOM (tested in Node: tests/test_supplier.py).
import { identify } from './nutrition.js';
import { FOODS } from './nutridata.js';
import { itemKey } from './shopping.js';

// ------------------------------------------------------------------ reading the file

/** Rows of cells. Handles quoted cells (with commas, quotes and line breaks inside), a byte-order mark,
 *  and comma, tab or semicolon separators (whichever the first lines use most). */
export function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const sample = s.split(/\r?\n/).slice(0, 8).join('\n');
  const count = (c) => (sample.match(new RegExp(c === '\t' ? '\t' : `\\${c}`, 'g')) || []).length;
  const sep = [',', '\t', ';'].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"' && cur.trim() === '') { q = true; cur = ''; }
    else if (c === sep) { row.push(cur.trim()); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur.trim()); cur = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur.trim());
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

// ------------------------------------------------------------------ finding the columns

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9$#/%]+/g, ' ').trim();
// What a column is, from its heading. Earlier patterns win when a heading could be two things.
export const ROLES = ['description', 'item', 'brand', 'packsize', 'pack', 'size', 'unit', 'price', 'perlb', 'each', 'shipped', 'qty', 'total'];
const ROLE_LABEL = { description: 'Description', item: 'Item number', brand: 'Brand', packsize: 'Pack and size together', pack: 'Pack (how many)',
  size: 'Size (of each)', unit: 'Unit of the size', price: 'Case price', perlb: 'Price per pound (or Y/N)', each: 'Price per piece, or Y/N split', shipped: 'Quantity shipped', qty: 'Quantity ordered', total: 'Line total' };
export const roleLabel = (r) => ROLE_LABEL[r] || r;
const HEADINGS = [
  ['total', /^(total|extended|ext|line)( price| \$| amount| total| cost)?$|^total \$$|^amount due$/],
  ['shipped', /^(confirmed|shipped|qty shipped|delivered|filled|ship qty|qty delivered|qty confirmed)$/],
  ['qty', /^(ordered|qty|quantity|qty ordered|order qty|cases|cases ordered|qty ord)$/],
  ['perlb', /^(price )?per (lb|pound)$|^\$ ?\/ ?lb$|^lb price$|^price \/ ?lb$|^cost per lb$|^per lb \$$/],
  ['each', /^split( \$| price)?$|^each( \$| price)?$|^unit \$$|^price per (each|unit|piece)$|^ea price$|^split cost$/],
  ['price', /^case( \$| price| cost)?$|^(your |net |unit |sell |invoice |current )?price$|^\$$|^cost$|^case \$ price$|^price \/ ?(case|cs)$|^cs price$|^amount$|^price each case$/],
  ['packsize', /^pack ?(\/|and|&)? ?size$|^pk ?\/ ?sz$|^pack size$|^packsize$|^pack \/ size$|^pack desc(ription)?$/],
  ['pack', /^pack$|^pk$|^pack qty$|^case pack$|^units per case$|^qty per case$|^inner pack$/],
  ['size', /^size$|^sz$|^item size$|^unit size$|^net (wt|weight)$|^weight$/],
  ['unit', /^(size )?unit$|^uom$|^size uom$|^u ?o ?m$|^unit of measure$|^measure$/],
  ['item', /^supc$|^item ?(#|no|num|number|code)?$|^product ?(#|no|number|code|id)$|^sku$|^code$|^item id$|^bek ?#$|^sgc ?#$|^usf ?#$|^mfr ?#$|^mfg ?#$/],
  ['brand', /^brand( name)?$|^mfr$|^manufacturer$|^label$/],
  ['description', /^desc(ription)?$|^(item|product) (desc(ription)?|name)$|^name$|^item$|^product$|^long description$/],
];

function roleOf(heading) {
  const n = norm(heading);
  if (!n) return null;
  for (const [role, re] of HEADINGS) if (re.test(n)) return role;
  return null;
}

/**
 * Where the products are: the heading row, the rows after it, and which column is which.
 * Sysco-style files put a record type in the first column ("H" heading, "F" field names, "P" product);
 * that column is skipped. Returns { headIndex, headings, map: { role: column }, rows, skipCols }.
 */
export function findTable(rows) {
  let best = { score: -1, index: 0 };
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const roles = new Set(rows[i].map(roleOf).filter(Boolean));
    const score = roles.size + (roles.has('description') ? 2 : 0) + (roles.has('price') || roles.has('perlb') ? 2 : 0);
    if (score > best.score) best = { score, index: i };
  }
  const headings = rows[best.index] || [];
  const map = {};
  headings.forEach((h, c) => { const r = roleOf(h); if (r && map[r] == null) map[r] = c; });
  // a record-type first column (Sysco: F = field names, P = product): keep only product rows
  const typed = /^[A-Z]$/.test(headings[0] || '') && rows.slice(best.index + 1, best.index + 6).every((r) => /^[A-Z]$/.test(r[0] || ''));
  let body = rows.slice(best.index + 1);
  if (typed) body = body.filter((r) => r[0] === 'P' || r[0] === 'D');
  return { headIndex: best.index, headings, map, rows: body, typed };
}

/** A short fingerprint of a file's headings, so a column choice made once is remembered for that supplier. */
export const headingKey = (headings) => headings.map(norm).filter(Boolean).join('|').slice(0, 300);

// ------------------------------------------------------------------ pack and size

const UNIT = {
  lb: ['g', 453.592], lbs: ['g', 453.592], pound: ['g', 453.592], pounds: ['g', 453.592], '#': ['g', 453.592],
  oz: ['g', 28.3495], ounce: ['g', 28.3495], ounces: ['g', 28.3495], kg: ['g', 1000], kilo: ['g', 1000], g: ['g', 1], gm: ['g', 1], gr: ['g', 1], gram: ['g', 1], grams: ['g', 1],
  gal: ['ml', 3785.41], gallon: ['ml', 3785.41], gallons: ['ml', 3785.41], ga: ['ml', 3785.41],
  qt: ['ml', 946.353], quart: ['ml', 946.353], pt: ['ml', 473.176], pint: ['ml', 473.176],
  floz: ['ml', 29.5735], 'fl oz': ['ml', 29.5735], 'fl. oz': ['ml', 29.5735], fo: ['ml', 29.5735],
  l: ['ml', 1000], lt: ['ml', 1000], ltr: ['ml', 1000], liter: ['ml', 1000], litre: ['ml', 1000], ml: ['ml', 1],
  ct: ['n', 1], count: ['n', 1], ea: ['n', 1], each: ['n', 1], pc: ['n', 1], pcs: ['n', 1], piece: ['n', 1], dz: ['n', 12], doz: ['n', 12], dozen: ['n', 12],
  roll: ['n', 1], rl: ['n', 1], sheet: ['n', 1], sht: ['n', 1], bsh: ['n', 1], bushel: ['n', 1], ctn: ['n', 1], carton: ['n', 1],
  can: ['n', 1], cn: ['n', 1], bag: ['n', 1], bg: ['n', 1], box: ['n', 1], bx: ['n', 1], jar: ['n', 1], btl: ['n', 1], bottle: ['n', 1], pkg: ['n', 1], pk: ['n', 1],
  bunch: ['n', 1], bu: ['n', 1], head: ['n', 1], hd: ['n', 1], loaf: ['n', 1], sleeve: ['n', 1], tray: ['n', 1], tub: ['n', 1], cs: ['n', 1], case: ['n', 1],
};
// the tin sizes kitchens buy (#10 can is about 109 oz, 3 quarts)
const CAN_SIZES = { 10: 3100, 5: 1650, 3: 1300, 2.5: 800, 2: 570, 1: 300, 303: 450, 300: 420 };

const num = (s) => {
  const t = String(s).trim();
  const m = t.match(/^(\d+)\s+(\d+)\/(\d+)$/) || null;
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  const f = t.match(/^(\d+)\/(\d+)$/);
  if (f) return Number(f[1]) / Number(f[2]);
  const r = t.match(/^(\d*\.?\d+)\s*-\s*(\d*\.?\d+)$/);         // 40-45 (a catch-weight range): the middle
  if (r) return (Number(r[1]) + Number(r[2])) / 2;
  return t !== '' && Number.isFinite(Number(t)) ? Number(t) : NaN;
};

/**
 * What a case holds: { kind: 'g' | 'ml' | 'n', amount, packs, text } or null.
 *   "4/1 GAL"   four 1-gallon jugs    -> ml, 15142
 *   "1/50 LB", "50#", "2/5#"          -> g
 *   "6/#10"     six #10 cans          -> g (about 3.1 kg each, by weight)
 *   "36 CT", "15 DZ", "200/1 OZ"      -> n, or g
 *   "4/5 LB AVG", "1/40-45#"          -> catch weight: the average or the middle of the range
 * `pack`, `size` and `unit` can come from separate columns; give whichever the file has.
 */
export function parsePack({ packsize = '', pack = '', size = '', unit = '' } = {}, { liquid = false } = {}) {
  // separate columns: pack "4", size "1", unit "GAL" -> "4/1 GAL"; pack "36", unit "CT" -> "36 CT"
  // a size with no number ("DZ", "#10", "CT") is the unit of the pack: pack "15", size "DZ" -> "15 DZ"
  const joined = pack && size && /\d/.test(String(size).replace(/^#\s*\d+/, '')) ? `${pack}/${size} ${unit}` : [pack, size, unit].filter(Boolean).join(' ');
  const text = String(packsize || joined).trim();
  if (!text) return null;
  let t = text.toUpperCase()
    .replace(/(\d|\s)0Z\b/g, '$1OZ')                                   // "2.4 0Z": a zero typed for the letter O
    .replace(/(^|[\s\/X])\.(\d)/g, '$10.$2')                            // "9/.5 GAL"
    .replace(/^(\d+)\s*\/\s*(\d+)\s*\/\s*(?=\d)/, (_, a, b) => `${Number(a) * Number(b)}/`)   // "1/4/1 LT": 1 case of 4/1 LT
    .replace(/^(\d+(?:\.\d+)?)\s*\/\s*([A-Z]+)\b/, '$1 $2');           // "15/DZ": fifteen dozen
  const caught = /\bAVE?R?A?G?E?\b|\bAVG\b|\bCATCH\s*WT\b|\bRANDOM\s*WT\b|\bR\/W\b|\d\s*-\s*\d/.test(t);
  t = t.replace(/\bAVE?R?A?G?E?\b|\bAVG\b|\bAPPROX\.?\b|\bUP\b|\bCATCH\s*WT\b|\bRANDOM\s*WT\b|\bR\/W\b/g, ' ')
    .replace(/\bFL\.?\s*OZ\b/g, 'FLOZ').replace(/(\d)\s*-\s*(\d)/g, '$1-$2').replace(/\s+/g, ' ').trim();
  // "6/#10" or "6 #10 CAN": number-ten cans
  let m = t.match(/^(?:(\d+)\s*[\/X ]\s*)?#\s*(10|5|3|2\.5|2|1|303|300)\b/);
  if (m) {
    const packs = m[1] ? Number(m[1]) : 1;
    return { kind: 'g', amount: packs * CAN_SIZES[m[2]], packs, one: CAN_SIZES[m[2]], text };
  }
  // "4/1 GAL", "2/5#", "200/1 OZ", "1/40-45#", "12/32 OZ", "3/5 LB", "24/12 FLOZ"
  m = t.match(/^(\d+(?:\.\d+)?)\s*[\/X]\s*(\d+(?:\s\d+\/\d+)?(?:\.\d+)?(?:-\d+(?:\.\d+)?)?)\s*([A-Z#]+(?: OZ)?)?/);
  let packs = 1;
  let each;
  let u;
  if (m) {
    packs = Number(m[1]);
    each = num(m[2]);
    u = (m[3] || '').toLowerCase();
  } else {
    // "50 LB", "50#", "36 CT", "15 DZ", "1 GAL", "6 CT 2 LB"(first wins), "#2.5"
    m = t.match(/^(\d+(?:\s\d+\/\d+)?(?:\.\d+)?(?:-\d+(?:\.\d+)?)?)\s*([A-Z#]+)?/);
    if (!m) return null;
    each = num(m[1]);
    u = (m[2] || '').toLowerCase();
  }
  if (!Number.isFinite(each) || !(each > 0) || !(packs > 0)) return null;
  if (!u) return { kind: 'n', amount: packs * each, packs, one: each, text };
  // ounces of a liquid (milk, juice, syrup...) are fluid ounces
  const def = (liquid && (u === 'oz' || u === 'ounce' || u === 'ounces')) ? ['ml', 29.5735] : UNIT[u] || UNIT[u.replace(/s$/, '')];
  if (!def) return null;
  return { kind: def[0], amount: packs * each * def[1], packs, one: each * def[1], text, ...(caught && def[0] === 'g' ? { catch: true } : {}) };
}

// ------------------------------------------------------------------ prices

const money = (s) => {
  const v = Number(String(s ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(v) && v > 0 && v < 1e6 ? v : null;
};

const YES = /^(y|yes|true|x|1)$/i;
const FLAG = /^(y|yes|true|x|n|no|false|0|1)?$/i;
/** A price over an amount: { p, per } in the price book's units. */
function per(cs, kind, amount, from) {
  if (!(amount > 0)) return null;
  if (kind === 'g') return { p: round(cs / (amount / 453.592)), per: 'lb', from };
  if (kind === 'ml') return { p: round(cs / (amount / 3785.41)), per: 'gallon', from };
  return { p: round(cs / amount), per: 'each', from };
}

/**
 * The price-book price for one product: { p, per } (per = 'lb', 'gallon' or 'each'), or null.
 *   - a price-per-pound column wins; a Y in a "Per Lb" column (Sysco) means the price itself is per pound
 *   - a Y in an "Each" column (Ben E. Keith, SGC) means the price is for one unit of the pack, not the case
 *   - catch-weight meat is often listed at its price per pound ("4/10# AVG" at $3.39): when the line total
 *     is not the price times the cases, or the price would make the meat a few cents a pound, it is per pound
 *   - otherwise the case price over what the case holds, or a split (per piece) price
 */
export function unitPrice({ price, perlb, each, total, qty }, pk) {
  const lb = money(perlb);
  if (lb != null) return { p: round(lb), per: 'lb', from: 'per lb' };
  const cs = money(price);
  if (cs != null && YES.test(String(perlb ?? '').trim())) return { p: round(cs), per: 'lb', from: 'per lb' };
  if (cs != null && pk) {
    if (YES.test(String(each ?? '').trim()) && pk.one > 0) return per(cs, pk.kind, pk.one, 'each unit');
    if (pk.kind === 'g') {
      const t = money(total);
      const q = money(qty);
      const lbs = pk.amount / 453.592;
      const byTotal = t != null && q != null && Math.abs(t - cs * q) > Math.max(0.05, t * 0.03) && t > cs * q;
      if (byTotal || cs / lbs < 0.1 || (pk.catch && cs / lbs < 0.5)) return { p: round(cs), per: 'lb', from: 'catch weight' };
    }
    return per(cs, pk.kind, pk.amount, 'case');
  }
  const ea = FLAG.test(String(each ?? '').trim()) ? null : money(each);
  if (ea != null) return { p: round(ea), per: 'each', from: 'split' };
  return null;
}
const round = (v) => Math.round(v * 10000) / 10000;

// ------------------------------------------------------------------ what food it is

// Distributor shorthand, written out so the description reads like an ingredient.
const ABBR = {
  chkn: 'chicken', chix: 'chicken', ckn: 'chicken', brst: 'breast', bnls: 'boneless', sknls: 'skinless', skls: 'skinless', thgh: 'thigh', thi: 'thigh',
  mont: 'monterey', fcy: 'fancy', bnls: 'boneless', grits: 'grits', ff: 'french fries', hashbrown: 'hash brown', hashbrowns: 'hash brown',
  bf: 'beef', grnd: 'ground', grd: 'ground', gr: 'ground', prk: 'pork', bcn: 'bacon', saus: 'sausage', tky: 'turkey', trky: 'turkey',
  chs: 'cheese', chse: 'cheese', ched: 'cheddar', chdr: 'cheddar', mozz: 'mozzarella', parm: 'parmesan', amer: 'american',
  shrd: 'shredded', shred: 'shredded', sliced: 'sliced', slcd: 'sliced', slc: 'sliced', dcd: 'diced', dic: 'diced', chpd: 'chopped', chop: 'chopped', crshd: 'crushed', crsh: 'crushed',
  frz: 'frozen', frzn: 'frozen', iqf: 'frozen', fz: 'frozen', frsh: 'fresh', ref: 'refrigerated', refrig: 'refrigerated',
  tom: 'tomato', toms: 'tomato', tmto: 'tomato', pot: 'potato', pota: 'potato', onn: 'onion', yel: 'yellow', ylw: 'yellow', wht: 'white', grn: 'green', rd: 'red',
  pep: 'pepper', pepr: 'pepper', ppr: 'pepper', jal: 'jalapeno', jalap: 'jalapeno', mush: 'mushroom', mshrm: 'mushroom', lett: 'lettuce', rom: 'romaine', brcl: 'broccoli', broc: 'broccoli', cauli: 'cauliflower',
  bbq: 'barbecue', ketchp: 'ketchup', catsup: 'ketchup', mayo: 'mayonnaise', mayon: 'mayonnaise', dress: 'dressing', drsg: 'dressing', vin: 'vinegar', vngr: 'vinegar',
  cnla: 'canola', cano: 'canola', veg: 'vegetable', vegtbl: 'vegetable', olv: 'olive', xvoo: 'extra virgin olive oil', evoo: 'extra virgin olive oil',
  sug: 'sugar', sgr: 'sugar', gran: 'granulated', pwdr: 'powdered', pwd: 'powdered', brn: 'brown', flr: 'flour', ap: 'all purpose', bkng: 'baking',
  bttr: 'butter', btr: 'butter', unsltd: 'unsalted', unslt: 'unsalted', marg: 'margarine', crm: 'cream', hvy: 'heavy', whpg: 'whipping', whip: 'whipping', sr: 'sour', hlf: 'half',
  mlk: 'milk', whl: 'whole', bttrmlk: 'buttermilk', eg: 'egg', eggs: 'egg', lg: 'large', xl: 'large', med: 'medium', sm: 'small',
  rce: 'rice', lnggrn: 'long grain', pst: 'pasta', spag: 'spaghetti', elb: 'elbow', mac: 'macaroni', ndl: 'noodle', nood: 'noodle', brd: 'bread', crmb: 'breadcrumb', tort: 'tortilla', torts: 'tortilla',
  bns: 'bean', bn: 'bean', blk: 'black', pnto: 'pinto', kdny: 'kidney', grbnzo: 'chickpea', garbanzo: 'chickpea',
  stk: 'stock', brth: 'broth', bse: 'base', sce: 'sauce', sauc: 'sauce', pste: 'paste', pur: 'puree',
  lmn: 'lemon', lme: 'lime', jce: 'juice', jc: 'juice', org: 'orange', appl: 'apple', strwb: 'strawberry', strwbry: 'strawberry', blubry: 'blueberry',
  cilan: 'cilantro', parsly: 'parsley', grlc: 'garlic', garl: 'garlic', gngr: 'ginger', cel: 'celery', crt: 'carrot', crrt: 'carrot', cuke: 'cucumber', zuc: 'zucchini', zucc: 'zucchini',
  slmn: 'salmon', shrmp: 'shrimp', tna: 'tuna', ctfsh: 'catfish',
};

// words that describe rather than name a product, and house brands that start some descriptions
const QUALIFIERS = new Set(['fresh', 'frozen', 'refrigerated', 'iqf', 'sys', 'syscls', 'cls', 'classic', 'imperial', 'reliance', 'supreme', 'packer',
  'chef', 'chefs', 'house', 'brand', 'premium', 'select', 'choice', 'usda', 'grade', 'organic', 'natural', 'bulk', 'case', 'cs', 'bek', 'sgc', 'us', 'usf', 'monarch', 'rykoff', 'pfg', 'west', 'creek', 'roseli', 'cross', 'valley',
  'spice', 'seasoning', 'markon', 'jit', 'fancy', 'fcy']);

/** A distributor description written out: "CHEESE CHDR SHRD MILD" -> "cheese cheddar shredded mild". */
export function expand(desc) {
  return String(desc || '').toLowerCase()
    .replace(/&/g, ' and ').replace(/\bbread\s*crumbs?\b/g, 'breadcrumb')
    .replace(/[^a-z0-9# ]+/g, ' ')
    .split(/\s+/).filter(Boolean)
    .map((w) => ABBR[w] || w).join(' ');
}

const single = (w) => (w.length > 3 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('oes') ? w.slice(0, -2)
  : w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);

/** The best of `names` for a description's words, or null. Distributors write the main item first and its kind
 *  after ("CHEESE CHEDDAR", "OIL CANOLA", "PEPPER JALAPENO"), so a name's words may come in any order, but the
 *  name must contain that first word: "PICKLE DILL" is not dill, "VINEGAR RED WINE" is not red wine, "SYRUP
 *  RASPBERRY" is not raspberries. The name with the most words wins, then the one whose words sit closest
 *  to the start. */
function bestName(words, names, keyOf) {
  const leads = words.filter((w) => !QUALIFIERS.has(w) && !QUALIFIERS.has(`${w}s`) && !/\d/.test(w));
  if (!leads.length) return null;
  let head = leads[0];
  // "MILK BUTTERMILK", "CHEESE CREAMCHEESE": the second word is the item
  if (leads[1] && leads[1] !== head && leads[1].endsWith(head)) head = leads[1];
  const pos = new Map();
  words.forEach((w, i) => { if (!pos.has(w)) pos.set(w, i); });
  let best = null;                                              // [words in the name, sum of their places, name]
  for (const name of names) {
    const parts = keyOf(name).split(' ').filter(Boolean);
    if (!parts.length || !parts.includes(head) || !parts.every((x) => pos.has(x))) continue;
    const spread = parts.reduce((a, x) => a + pos.get(x), 0);
    if (!best || parts.length > best[0] || (parts.length === best[0] && spread < best[1])) best = [parts.length, spread, name];
  }
  return best && best[2];
}

/** The price-book food for a description ("OIL CANOLA FRY" -> "canola oil"), or '' when there is no good match.
 *  `extra` is the kitchen's own ingredient names (its costing sheet and price book): one of those that fits
 *  is used before any name from the food table, so "BUTTER SOLID UNSALTED" goes to your "butter". */
export function matchFood(desc, extra = []) {
  const words = expand(desc).split(' ').map(single);
  const own = extra.length ? bestName(words, extra, itemKey) : null;
  if (own) return itemKey(own);
  const food = bestName(words, candidateNames(), itemKey);
  return food ? identify(food).key : '';
}

/** How a product is remembered between imports: its description, tidied. */
export const matchKey = (desc) => String(desc || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);

// ounces of these are fluid ounces
const LIQUID = /\b(milk|buttermilk|cream|half and half|juice|syrup|vinegar|soda|lemonade|concentrate|oil|wine|broth|stock|water|beer|sauce|dressing|creamer|nectar|puree|tea|coffee)\b/;
const NOT_LIQUID = /\b(sour cream|cream cheese|ice cream|spray|powder|dry|mix|cheese|chip|chocolate)\b/;
export const isLiquid = (desc) => { const e = expand(desc); return LIQUID.test(e) && !NOT_LIQUID.test(e); };

/** A name for a product the food table doesn't know ("CATFISH FILLET 5-7 OZ" -> "catfish fillet"): the words
 *  before the first size, number or grade. A recipe line "catfish fillets" is priced under the same name. */
export function plainName(desc) {
  const out = [];
  for (const w of expand(desc).split(' ')) {
    if (/\d|^#/.test(w) || /^(fresh|frozen|refrigerated|grade|aa|a|bulk|case|cs|pack|fancy|choice|select|premium|usda|ns|spice|seasoning|markon|jit)$/.test(w)) { if (out.length) break; continue; }
    out.push(w);
    if (out.length === 3) break;
  }
  // "BUN HAMBURGER", "PICKLE DILL", "SYRUP RASPBERRY": the kind of thing first, as distributors write it;
  // said the way a recipe would, "hamburger bun", "dill pickle", "raspberry syrup"
  if (out.length > 1 && HEAD_LAST.has(single(out[0]))) return itemKey(`${out[1]} ${out[0]}`);
  return itemKey(out.join(' '));
}
const HEAD_LAST = new Set(['bun', 'roll', 'pickle', 'syrup', 'juice', 'chip', 'soda', 'base', 'dough', 'paste', 'sauce', 'dressing', 'mix',
  'cheese', 'oil', 'vinegar', 'pepper', 'bean', 'tortilla', 'bread', 'pasta', 'flour', 'sugar', 'rice', 'sausage', 'bacon', 'ham', 'salt']);

// every food the price book knows by name (the nutrition table), for matching in any word order
let names = null;
const candidateNames = () => (names ||= [...new Set(FOODS.map((f) => f[0]))]);

// ------------------------------------------------------------------ the whole file

/**
 * Reads a supplier file into rows ready to review:
 *   [{ line, item, description, brand, pack (parsed or null), packText, price: { p, per } or null, food, why }]
 * `map` overrides the columns found by name ({ role: column index }).
 */
export function readSupplierFile(text, { map: override = null, extraNames = [], matches = null } = {}) {
  const rows = Array.isArray(text) ? text.map((r) => (Array.isArray(r) ? r : []).map((c) => String(c ?? '').trim())) : parseCsv(text);
  const own = [...new Set(extraNames.map((n) => itemKey(String(n || ''))).filter(Boolean))];
  const ownSet = new Set(own);
  const seen = new Set();
  const table = findTable(rows);
  const map = { ...table.map, ...(override || {}) };
  const cell = (r, role) => (map[role] == null ? '' : (r[map[role]] ?? ''));
  const out = [];
  table.rows.forEach((r, i) => {
    const description = cell(r, 'description');
    if (!description && !cell(r, 'price')) return;
    const packText = cell(r, 'packsize') || [cell(r, 'pack'), cell(r, 'size'), cell(r, 'unit')].filter(Boolean).join(' ');
    // the same product listed twice (order histories repeat lines): once is enough
    const dup = [cell(r, 'item'), description, packText, cell(r, 'price')].join('|').toLowerCase();
    if (seen.has(dup)) return;
    seen.add(dup);
    const pk = parsePack({ packsize: cell(r, 'packsize'), pack: cell(r, 'pack'), size: cell(r, 'size'), unit: cell(r, 'unit') }, { liquid: isLiquid(description) });
    const price = unitPrice({ price: cell(r, 'price'), perlb: cell(r, 'perlb'), each: cell(r, 'each'), total: cell(r, 'total'),
      qty: cell(r, 'shipped') || cell(r, 'qty') }, pk);
    const remembered = description && matches ? matches[matchKey(description)] : '';
    const food = remembered || (description ? matchFood(description, own) : '');
    const why = !description ? 'no description' : !price ? (money(cell(r, 'price')) == null ? 'no price' : 'pack size not understood') : !food ? 'no matching food' : '';
    out.push({ line: table.headIndex + i + 2, item: cell(r, 'item'), description, brand: cell(r, 'brand'), pack: pk, packText, casePrice: money(cell(r, 'price')),
      price, food, suggest: food || (description ? plainName(description) : ''), why,
      remembered: !!remembered, ours: !!food && ownSet.has(food) });
  });
  return { rows: out, headings: table.headings, map, found: table.map, typed: table.typed,
    // a file with products but not one price (Sysco's purchase history leaves "Case $" empty)
    noPrices: out.length > 0 && out.every((x) => x.casePrice == null && !x.price) };
}

/**
 * Which rows to add: for each food, the cheapest per unit among the rows that matched it (others are
 * still listed, unticked). Returns the row indexes to tick.
 */
export function defaultPicks(rows) {
  const bestFor = new Map();
  rows.forEach((r, i) => {
    if (!r.price || !r.food) return;
    const cur = bestFor.get(r.food);
    if (cur == null || (rows[cur].price.per === r.price.per && r.price.p < rows[cur].price.p)) bestFor.set(r.food, i);
  });
  return new Set(bestFor.values());
}

/** What goes into the price book for the picked rows: { food: { p, per, src, at } }. */
export function toPrices(rows, picks, supplier, today) {
  const items = {};
  for (const i of picks) {
    const r = rows[i];
    if (!r || !r.price || !r.food) continue;
    items[r.food] = { p: r.price.p, per: r.price.per, src: [supplier, r.item && `#${r.item}`].filter(Boolean).join(' ').slice(0, 60), at: today };
  }
  return items;
}

/** A guess at the supplier from the file name or its first lines ("sysco_order_guide.csv" -> "Sysco"). */
export function guessSupplier(fileName, text) {
  const head = Array.isArray(text) ? text.slice(0, 12).map((r) => r.join(' ')).join('\n') : String(text || '');
  const hay = `${fileName || ''} ${head.slice(0, 2000)}`.toLowerCase();
  for (const [re, name] of [[/sysco/, 'Sysco'], [/ben\s*e\.?\s*keith|\bbek\b|benekeith/, 'Ben E. Keith'], [/\bsgc\b|springfield grocer/, 'SGC'],
    [/us\s*foods|usfoods|\busf\b/, 'US Foods'], [/gordon|\bgfs\b/, 'Gordon Food Service'], [/performance food|\bpfg\b/, 'Performance Foodservice'],
    [/shamrock/, 'Shamrock Foods'], [/restaurant depot|jetro/, 'Restaurant Depot'], [/chef'?s warehouse/, "Chef's Warehouse"]]) {
    if (re.test(hay)) return name;
  }
  return '';
}
