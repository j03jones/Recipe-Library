// Moving recipes in and out: read files from Paprika, Mealie, Tandoor, Cooklang, any web page that carries
// schema.org recipe data, or plain pasted text; write Paprika, schema.org JSON and Markdown files.
// No screens here: every function takes bytes or text and returns recipes (the working shape the editor uses:
// { id:null, title, categories, tags, yq, yu, yr, dir, ings:[{q,raw,unit,item,group}], src, source:'mine' }).
import { canonicalUnit, formatIngredient, formatYield, parseQuantity, parseYield, splitCategories } from './units.js';
import { cleanText, parseIngredientLine, recipeFromSchema } from './webimport.js';

const MAX_RECIPES = 2000;
const MAX_ENTRY = 8 * 1024 * 1024;           // one file inside an archive, after unpacking
const MAX_TOTAL = 64 * 1024 * 1024;          // everything unpacked from one archive
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

// ----------------------------------------------------------------------------------------- zip and gzip
async function pump(bytes, stream, cap = MAX_ENTRY) {
  const reader = new Response(new Blob([bytes]).stream().pipeThrough(stream)).body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) { reader.cancel().catch(() => {}); throw new Error('A file inside the archive is too large.'); }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return all;
}
export const gunzip = (bytes) => pump(bytes, new DecompressionStream('gzip'));
export const gzip = (bytes) => pump(bytes, new CompressionStream('gzip'), Infinity);

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export const isZip = (b) => b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5);

/** Lists the files in a zip: [{ name, data() }]. Reads the central directory, so it copes with any zip. */
export function readZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('That is not a zip file.');
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const out = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new Error('That zip file is damaged.');
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue;
    total += usize;
    if (usize > MAX_ENTRY || total > MAX_TOTAL) throw new Error('That archive is too large to open here.');
    out.push({
      name,
      async data() {
        if (local + 30 > bytes.length) throw new Error('That zip file is damaged.');
        const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
        const raw = bytes.subarray(start, start + csize);
        if (method === 0) return raw.slice();
        if (method === 8) return pump(raw, new DecompressionStream('deflate-raw'), MAX_ENTRY);
        throw new Error('That zip uses a compression this app cannot read.');
      },
    });
  }
  return out;
}

/** Writes a zip (files stored, not compressed: the contents are already gzip for Paprika). files: [{ name, data }] */
export function writeZip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true);
    head.setUint32(14, crc, true); head.setUint32(18, size, true); head.setUint32(22, size, true); head.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(head.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const tail = new DataView(new ArrayBuffer(22));
  tail.setUint32(0, 0x06054b50, true); tail.setUint16(8, files.length, true); tail.setUint16(10, files.length, true);
  tail.setUint32(12, cdSize, true); tail.setUint32(16, offset, true);
  const all = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const p of [...chunks, ...central, new Uint8Array(tail.buffer)]) { all.set(p, at); at += p.length; }
  return all;
}

// ----------------------------------------------------------------------------------------- shared helpers
const text = (v) => (v == null ? '' : cleanText(String(v)));
const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const nameOf = (x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? x.name || x.title || x.label || '' : '');

function blank() {
  return { id: null, title: '', categories: [], tags: [], yq: null, yu: '', yr: '', dir: '', ings: [], src: null, source: 'mine' };
}
function setYield(r, v) {
  const t = text(Array.isArray(v) ? v[0] : v);
  if (!t) return;
  const [q, unit] = parseYield(t);
  if (q != null) { r.yq = q; r.yu = unit || 'servings'; } else r.yr = t;
}
const uniq = (a) => { const seen = new Set(); return a.map((s) => text(s)).filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase())); };
function setSource(r, author, url, site) {
  const u = /^https?:\/\//i.test(text(url)) ? text(url) : '';
  const a = text(author), n = text(site);
  if (a || u || n) r.src = { author: a, name: n, url: u };
}
/** "Sauce:" or "FOR THE SAUCE" style lines that head a group of ingredients. */
const isGroupHeading = (line) => /^[^:]{1,60}:$/.test(line) || (/^[A-Z][A-Z '&,-]{2,50}$/.test(line) && /[A-Z]{3}/.test(line));
function ingredientsFromText(block, startGroup = '') {
  const out = [];
  let group = startGroup;
  for (const raw of String(block || '').split(/\r?\n/)) {
    const line = text(raw).replace(/^[-*•▢☐□]\s*/, '');
    if (!line) continue;
    if (isGroupHeading(line)) { group = line.replace(/:$/, '').replace(/^for the /i, ''); group = group.charAt(0).toUpperCase() + group.slice(1).toLowerCase(); continue; }
    const ing = parseIngredientLine(line);
    if (ing) out.push({ ...ing, group });
  }
  return out;
}
const stepsText = (steps) => steps.map((s) => text(s)).filter(Boolean).join('\n');

// ----------------------------------------------------------------------------------------- Paprika
export function fromPaprika(o) {
  const r = blank();
  r.title = text(o.name);
  r.ings = ingredientsFromText(o.ingredients);
  const parts = [String(o.directions || '').split(/\r?\n/).map(text).filter(Boolean).join('\n')];
  if (text(o.notes)) parts.push(`Notes: ${text(o.notes)}`);
  r.dir = parts.filter(Boolean).join('\n');
  setYield(r, o.servings);
  r.categories = uniq(list(o.categories));
  setSource(r, o.source && !/^https?:/i.test(o.source) ? o.source : '', o.source_url, /^https?:/i.test(o.source || '') ? '' : '');
  return r;
}

// ----------------------------------------------------------------------------------------- Mealie
function mealieIngredient(x) {
  if (typeof x === 'string') return parseIngredientLine(x);
  if (!x || typeof x !== 'object') return null;
  const free = text(x.originalText || x.display || x.note || x.text || '');
  const food = nameOf(x.food), unit = nameOf(x.unit);
  const amount = x.quantity ?? x.amount;                       // Mealie says quantity, Tandoor says amount
  if (food && amount != null && amount !== '' && Number(amount) !== 0) {
    const q = parseQuantity(String(Math.round(Number(amount) * 1000) / 1000));
    const u = canonicalUnit(unit) || '';
    if (q != null) return { q, raw: '', unit: u, item: text([u ? '' : unit, food, x.note ? `, ${x.note}` : ''].filter(Boolean).join(' ')).replace(/ ,/g, ','), group: '' };
  }
  return free ? parseIngredientLine(free) : food ? parseIngredientLine(food) : null;
}
function fromRichRecipe(o) {      // Mealie and Tandoor (and anything shaped like them)
  const r = blank();
  r.title = text(o.name || o.title);
  const stepList = list(o.recipeInstructions ?? o.steps ?? o.instructions);
  const dirs = [];
  const ings = [];
  const named = stepList.filter((s) => s && typeof s === 'object' && text(s.name || s.title)).length > 1;
  for (const s of stepList) {
    if (typeof s === 'string') { dirs.push(s); continue; }
    if (!s || typeof s !== 'object') continue;
    const body = text(s.text || s.instruction || s.description || '');
    if (body) dirs.push(...String(s.text || s.instruction || s.description).split(/\r?\n+/).map(text).filter(Boolean));
    if (Array.isArray(s.ingredients)) {                         // Tandoor keeps ingredients inside each step
      const g = named ? text(s.name || s.title) : '';
      for (const x of s.ingredients) { const i = mealieIngredient(x); if (i) ings.push({ ...i, group: g }); }
    }
  }
  for (const x of list(o.recipeIngredient ?? o.ingredients)) { const i = mealieIngredient(x); if (i) ings.push(i); }
  r.ings = ings;
  r.dir = stepsText(dirs);
  const notes = list(o.notes).map((n) => text(typeof n === 'string' ? n : [n.title, n.text].filter(Boolean).join(': '))).filter(Boolean);
  if (notes.length) r.dir += `${r.dir ? '\n' : ''}Notes: ${notes.join(' ')}`;
  const desc = text(o.description);
  if (desc && !r.dir.includes(desc) && desc.length < 400) r.dir = `${desc}\n${r.dir}`.trim();
  if (o.recipeYield != null && o.recipeYield !== '') setYield(r, o.recipeYield);
  else if (o.servings != null && o.servings !== '') setYield(r, `${o.servings} ${text(o.servings_text) || 'servings'}`);
  else if (o.recipeServings) setYield(r, `${o.recipeServings} servings`);
  r.categories = uniq([...list(o.recipeCategory).map(nameOf), ...list(o.categories).map(nameOf)]);
  r.tags = uniq([...list(o.tags).map(nameOf), ...list(o.keywords).map(nameOf)]);
  setSource(r, o.author, o.orgURL || o.source_url || o.url, '');
  return r;
}

// ----------------------------------------------------------------------------------------- Cooklang
export function fromCooklang(source, fileName = '') {
  const r = blank();
  const meta = {};
  const body = [];
  let src = String(source || '').replace(/\[-[\s\S]*?-\]/g, '');
  for (const raw of src.split(/\r?\n/)) {
    const m = /^>>\s*([^:]+?)\s*:\s*(.*)$/.exec(raw);
    if (m) { meta[m[1].toLowerCase()] = m[2].trim(); continue; }
    if (/^---\s*$/.test(raw) && !body.length) continue;          // front matter fences
    const fm = !body.length && /^([A-Za-z][\w ]*):\s*(.*)$/.exec(raw);
    if (fm && !/[@#~]/.test(raw)) { meta[fm[1].toLowerCase()] = fm[2].trim(); continue; }
    body.push(raw.replace(/\s--.*$/, '').replace(/^--.*$/, ''));
  }
  const found = new Map();
  const clean = (s) => s.replace(/@([^@#~{}]+?)\{([^}]*)\}(?:\([^)]*\))?|@(\S+)|#([^@#~{}]+?)\{[^}]*\}|#(\S+)|~([^@#~{}]*)\{([^}]*)\}/g,
    (all, ing, amt, ing1, cw, cw1, tn, tv) => {
      if (ing != null || ing1 != null) {
        const name = text(ing ?? ing1).replace(/[.,;:!?]+$/, '');
        const [qty = '', unit = ''] = String(amt ?? '').split('%').map((x) => x.trim());
        const q = qty ? parseQuantity(qty) : null;
        const u = canonicalUnit(unit) || '';
        const key = `${name.toLowerCase()}|${u}`;
        const item = u || !unit ? name : `${unit} ${name}`;
        if (found.has(key) && q != null && found.get(key).q != null && !found.get(key).raw) found.get(key).q = found.get(key).q.add(q);
        else found.set(found.has(key) ? `${key}#${found.size}` : key, { q, raw: q == null && qty ? qty : '', unit: u, item, group: '' });
        return name;
      }
      if (cw != null || cw1 != null) return text(cw ?? cw1);
      const [tq = '', tu = ''] = String(tv).split('%');
      return text(tn) || `${tq.trim()} ${tu.trim()}`.trim();
    });
  const steps = body.join('\n').split(/\n\s*\n/).map((p) => text(clean(p.replace(/\n/g, ' ')))).filter(Boolean);
  r.title = text(meta.title) || text(fileName).replace(/\.cook$/i, '').replace(/[-_]+/g, ' ');
  r.dir = steps.join('\n');
  r.ings = [...found.values()];
  const servings = meta.servings || meta.serves || meta.yield || meta.makes;
  if (servings) setYield(r, /^\d+(\.\d+)?$/.test(servings) ? `${servings} servings` : servings);
  r.categories = uniq(splitCategories(meta.course || meta.category || meta.categories || ''));
  r.tags = uniq(splitCategories(meta.tags || ''));
  setSource(r, meta.author, meta.source || meta['source.url'] || meta.url, meta['source.name'] || '');
  return r;
}

// ----------------------------------------------------------------------------------------- schema.org (JSON-LD, or a saved web page)
function findRecipeNodes(node, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6 || out.length > MAX_RECIPES) return out;
  if (Array.isArray(node)) { node.forEach((n) => findRecipeNodes(n, out, depth + 1)); return out; }
  const type = list(node['@type']).map(String);
  if (type.some((t) => /(^|\/)Recipe$/i.test(t))) out.push(node);
  else for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item', 'recipes']) if (node[k]) findRecipeNodes(node[k], out, depth + 1);
  return out;
}
export function fromHtml(html) {
  const found = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) { try { findRecipeNodes(JSON.parse(m[1].trim()), found); } catch { /* skip that block */ } }
  return found;
}
const looksSchema = (o) => !!findRecipeNodes(o).length;

// ----------------------------------------------------------------------------------------- pasted or plain text
const DIR_HEAD = /^(?:#+\s*)?(directions?|instructions?|method(?: of preparation)?|steps?|preparation|procedures?|how to make(?: it)?|assembly|notes?)\b[^a-z]*$/i;
const ING_HEAD = /^(?:#+\s*)?(ingredients?)\b(?:\s*\([^)]*\))?\s*:?$/i;
// the cells of a table header row ("Ingredient | Amount | Unit"), as pasted from a web page, Word or a PDF
const NAME_COL = /^(ingredients?|items?|products?|foods?|names?|descriptions?)$/i;
const AMOUNT_COL = /^(amounts?|quantity|quantities|qty\.?|measures?|measurements?|measuring|weights?|volumes?|units?|uom|us|metric|imperial|portions?|sizes?)$/i;
const NOTE_COL = /^(notes?|prep(aration)?|comments?|remarks?|how prepared|preparation notes?)$/i;
const SKIP_COL = /^(costs?|prices?|unit costs?|extensions?|totals?|bakers?\W*%|%|yield %|\$)$/i;
// recipe books often give one amount per batch size: "Full Recipe | Unit | Half Recipe | Unit | Double Recipe | Unit"
const UNIT_COL = /^(units?|uom|unit of measure)$/i;
const BATCH = String.raw`(?:\s+(?:recipe|batch|amount|amt\.?|qty\.?|quantity|yield))?`;
const MAIN_BATCH_COL = new RegExp(`^(?:full|base|single|original|standard|regular|whole|1\\s*[x×]|[x×]\\s*1|one)${BATCH}$`, 'i');
const OTHER_BATCH_COL = new RegExp(`^(?:half|double|triple|quadruple|quarter|[2-9]\\s*[x×]|[x×]\\s*[2-9]|½|1/2|two|three)${BATCH}$`, 'i');
const isHeaderCell = (c) => NAME_COL.test(c) || AMOUNT_COL.test(c) || NOTE_COL.test(c) || SKIP_COL.test(c) || MAIN_BATCH_COL.test(c) || OTHER_BATCH_COL.test(c);
const isTabbed = (line) => line.includes('\t') || (line.match(/\|/g) || []).length >= 2;
const cellsOf = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/\t+|\s*\|\s*/).map((c) => text(c));
const isRule = (cells) => cells.every((c) => !c || /^:?-{2,}:?$/.test(c));           // Markdown's |---|---|
const QTY = /^([\d½⅓⅔¼¾⅛⅜⅝⅞]|(a|an|one|two|three|four|five|six|half|pinch|dash|handful|to taste|as needed)\b)/i;
const isAmountCell = (c) => QTY.test(c) || canonicalUnit(c.replace(/\.$/, '')) != null;

/** A table header row's columns, or null: { name, amount: [..], note: [..] } (indexes into the row's cells). */
function headerColumns(cells) {
  const filled = cells.map((c, n) => [c, n]).filter(([c]) => c);
  if (filled.length < 2 || !filled.every(([c]) => isHeaderCell(c))) return null;
  // columns of amounts in groups: an amount column and the Unit column after it. With several batch sizes
  // (Full / Half / Double) only the main one is read; the app scales recipes itself.
  const groups = [];
  const cols = { name: -1, amount: [], note: [] };
  for (const [c, n] of filled) {
    if (NAME_COL.test(c) && cols.name < 0) cols.name = n;
    else if (UNIT_COL.test(c) && groups.length && groups[groups.length - 1].cols.length === 1) groups[groups.length - 1].cols.push(n);
    else if (MAIN_BATCH_COL.test(c)) groups.push({ main: true, cols: [n] });
    else if (OTHER_BATCH_COL.test(c)) groups.push({ other: true, cols: [n] });
    else if (AMOUNT_COL.test(c)) groups.push({ cols: [n] });
    else if (NOTE_COL.test(c)) cols.note.push(n);
  }
  const batches = groups.some((g) => g.main || g.other);
  const chosen = batches ? [groups.find((g) => g.main) || groups.find((g) => !g.other) || groups[0]].filter(Boolean) : groups;
  cols.amount = chosen.flatMap((g) => g.cols);
  return cols.name >= 0 || cols.amount.length ? cols : null;
}

/** One table row as an ingredient line ("2 cups | flour | sifted" -> "2 cups flour, sifted"). */
function rowToLine(cells, cols) {
  let amount = [], name = '', notes = [];
  if (cols && cols.name >= 0) {
    amount = cols.amount.map((n) => cells[n]).filter(Boolean);
    name = cells[cols.name] || '';
    notes = cols.note.map((n) => cells[n]).filter(Boolean);
    if (!name) name = cells.find((c, n) => c && !cols.amount.includes(n) && !cols.note.includes(n)) || '';
  } else {
    // no header: the cells that read as amounts or units are the amount, the first other cell is the name
    for (const c of cells.filter(Boolean)) {
      if (!name && !isAmountCell(c)) name = c;
      else if (isAmountCell(c) && amount.length < 3) amount.push(c);
      else notes.push(c);
    }
  }
  amount = amount.filter((c, n) => c.toLowerCase() !== (amount[n - 1] || '').toLowerCase());   // "As needed | As needed"
  return [amount.join(' '), name].filter(Boolean).join(' ') + (notes.length ? `, ${notes.join(', ')}` : '');
}

const startsLikeAmount = (line) => /^[\d½⅓⅔¼¾⅛⅜⅝⅞]/.test(line);
const wordCount = (line) => line.split(/\s+/).filter(Boolean).length;
/** A numbered step ("1. Heat the oven", "Step 2: Mix") rather than an ingredient ("1 cup flour"). */
const isNumberedStep = (line) => {
  const m = /^(?:step\s*\d+\s*[:.)-]?\s*|\d+\s*[.)]\s+)(\S.*)$/i.exec(line);
  return !!m && wordCount(m[1]) >= 3 && !startsLikeAmount(m[1]) && canonicalUnit(m[1].split(/\s/)[0].replace(/\.$/, '')) == null;
};

export function fromPlainText(source) {
  const lines = String(source || '').replace(/\r/g, '').replace(/\f/g, '\n').split('\n').map((l) => l.replace(/^[  ]+|[  ]+$/g, ''));
  const r = blank();
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  r.title = text((lines[i++] || '').replace(/\t+/g, ' ')).replace(/^#+\s*/, '');
  const ingRows = [], dirRows = [];
  let mode = '', cols = null, sawTable = false;
  for (; i < lines.length; i++) {
    let line = lines[i];
    if (!line.trim()) continue;
    if (isTabbed(line)) {
      const cells = cellsOf(line);
      if (isRule(cells)) continue;
      const filled = cells.filter(Boolean);
      const header = headerColumns(cells);
      if (header) { cols = header; mode = 'i'; sawTable = true; continue; }
      if (filled.length === 1) line = filled[0];                    // a row with one cell: a heading or a sentence
      else if (DIR_HEAD.test(filled[0]) && mode !== 'd' && filled.length <= 2 && !isAmountCell(filled[1] || '')) { mode = 'd'; if (filled[1]) dirRows.push(filled[1]); continue; }
      else if (mode === 'd' && !cols) { dirRows.push(filled.join(' ')); continue; }
      else { ingRows.push(rowToLine(cells, cols)); mode = 'i'; sawTable = true; continue; }
    }
    line = text(line);
    if (!line) continue;
    if (ING_HEAD.test(line)) { mode = 'i'; continue; }
    if (DIR_HEAD.test(line)) { mode = 'd'; cols = null; continue; }
    const meta = /^(serves|servings|yield|makes|serving size|portions?)\s*:?\s*(.+)$/i.exec(line);
    if (meta && !ingRows.length && !dirRows.length) { setYield(r, /^\d+$/.test(meta[2]) ? `${meta[2]} servings` : meta[2]); continue; }
    const cat = /^(categories|category|tags|course)\s*:\s*(.+)$/i.exec(line);
    if (cat) { r.categories.push(...splitCategories(cat[2])); continue; }
    const from = /^(source|from|by|author)\s*:\s*(.+)$/i.exec(line);
    if (from && !ingRows.length && !dirRows.length) { setSource(r, /^https?:/i.test(from[2]) ? '' : from[2], /^https?:/i.test(from[2]) ? from[2] : '', ''); continue; }
    // the method starts after an ingredient table even without a heading, and at the first numbered step
    if (mode === 'i' && ingRows.length && (isNumberedStep(line) || (sawTable && !startsLikeAmount(line) && !isGroupHeading(line) && (wordCount(line) >= 4 || /[.!]$/.test(line))))) { mode = 'd'; cols = null; }
    if (mode === 'i') ingRows.push(line);
    else if (mode === 'd') dirRows.push(line.replace(/^(?:step\s*\d+\s*[:.)-]?|\d+[.)])\s*/i, ''));
    else if (startsLikeAmount(line) && !isNumberedStep(line)) ingRows.push(line);
    else if (isGroupHeading(line) && !dirRows.length) ingRows.push(line);
    else dirRows.push(line.replace(/^(?:step\s*\d+\s*[:.)-]?|\d+[.)])\s+/i, ''));
  }
  r.ings = ingredientsFromText(ingRows.join('\n'));
  r.dir = dirRows.join('\n');
  r.categories = uniq(r.categories);
  return r;
}

// ----------------------------------------------------------------------------------------- several recipes in one
/** A contents-page line: a name, dot leaders, a page number ("Comeback Sauce…...8", "Crema………. 9"). */
const TOC_LINE = /^\s*\S.{0,90}?(?:[.…·_]\s*){3,}\s*\d{1,4}\s*$/;
const SECTION_LINE = /^\f?\s*section:\s*(\S.*)$/i;
const META_LINE = /^(serves|servings|yield|yields|makes|serving size|portions?|prep(aration)? time|cook(ing)? time|total time|time|category|categories|course|cuisine|source|from|by|author|difficulty|level)\b/i;
/** An "Ingredients" heading, or an ingredient table's header row: where a recipe's list begins. */
const startsIngredients = (line) => {
  if (isTabbed(line)) { const h = headerColumns(cellsOf(line)); return !!h && h.name >= 0; }
  return ING_HEAD.test(text(line));
};

/**
 * Splits text that holds several recipes (a cookbook in Word, a PDF, a long paste) into one text per recipe.
 * Each recipe is anchored on its "Ingredients" heading (or ingredient table); its title is the nearest short
 * line above that, skipping yield, time and description lines. Without anchors, page breaks (\f) split it.
 * Text with one recipe comes back unchanged.
 */
export function splitRecipes(source) {
  // a book's contents pages ("Avocado Cream……… 1") are left out, and "Section: Sauces" lines (from a Word
  // file's big headings) become the category of each recipe after them
  const lines = [], sectionOf = [];
  let section = '';
  for (const raw of String(source || '').replace(/\r/g, '').split('\n')) {
    const sm = SECTION_LINE.exec(raw);
    if (sm) { section = text(sm[1]); if (raw.startsWith('\f')) { lines.push('\f'); sectionOf.push(section); } continue; }
    if (TOC_LINE.test(raw.replace(/\t+/g, ' '))) continue;
    lines.push(raw); sectionOf.push(section);
  }
  const all = lines.join('\n');
  const withSection = (piece, at) => {
    if (!sectionOf[at]) return piece;
    const [first, ...rest] = piece.split('\n');
    return [first, `Category: ${sectionOf[at]}`, ...rest].join('\n');
  };
  const anchors = lines.map((l, n) => (startsIngredients(l) ? n : -1)).filter((n) => n >= 0);
  if (anchors.length >= 2) {
    const starts = [];
    let floor = 0;
    for (const a of anchors) {
      let t = -1;
      for (let k = a - 1; k >= floor && k >= a - 12; k--) {
        const l = text(lines[k].replace(/[\t|]+/g, ' ').replace(/\f/g, ''));
        if (!l || META_LINE.test(l)) continue;
        if (l.length > 90 || (/[.!]$/.test(l) && wordCount(l) > 5)) continue;          // a description
        t = k; break;
      }
      starts.push(t < 0 ? a : t);
      floor = a + 1;
    }
    const pieces = starts.map((st, n) => withSection(lines.slice(st, starts[n + 1] ?? lines.length).join('\n').replace(/\f/g, '\n').trim(), st));
    if (pieces.every((p) => p)) return pieces;
  }
  const pages = [];
  let at = 0;
  for (const page of all.split('\f')) {
    const first = at + page.split('\n').findIndex((l) => l.trim());
    if (page.split('\n').filter((l) => l.trim()).length >= 3) pages.push(withSection(page.trim(), Math.max(at, first)));
    at += page.split('\n').length - 1;
  }
  return pages.length >= 2 ? pages : [all.replace(/\f/g, '\n').trim()];
}

// ----------------------------------------------------------------------------------------- Word (.docx)
const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

/** One Word paragraph's text: runs, tabs, line and page breaks. */
function paraText(xml) {
  let out = /<w:pageBreakBefore(?:\s[^>]*)?\/>/.test(xml) && !/<w:pageBreakBefore[^>]*w:val="(?:0|false)"/.test(xml) ? '\f' : '';
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br(\s[^>]*)?\/>|<w:cr\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] != null) out += xmlText(m[1]);
    else if (m[0].startsWith('<w:tab')) out += '\t';
    else if (/w:type="page"/.test(m[2] || '')) out += '\n\f';
    else out += '\n';
  }
  return out;
}

/** A paragraph's type size in half-points (the first sized run, or its paragraph mark), 0 when it doesn't say. */
const sizeOf = (xml) => +((xml.match(/<w:r[\s>][\s\S]*?<w:sz w:val="(\d+)"/) || xml.match(/<w:sz w:val="(\d+)"/) || [])[1] || 0);

/**
 * The text of a Word document: paragraphs as lines, table rows as tab-separated cells, page and section breaks
 * as \f. When the document uses two sizes of heading (a book's "Sauces" over each recipe's "Avocado Cream"), the
 * bigger, rarer one comes out as "Section: Sauces" so each recipe under it can be filed there.
 */
export function docxToText(xml) {
  const body = (xml.match(/<w:body>([\s\S]*)<\/w:body>/) || [, xml])[1];
  const blocks = [];
  const re = /<w:tbl>([\s\S]*?)<\/w:tbl>|<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:p(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[1] != null) {
      for (const row of m[1].match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) || []) {
        const cells = (row.match(/<w:tc[\s>][\s\S]*?<\/w:tc>/g) || [])
          .map((c) => (c.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || []).map((p) => paraText(p).replace(/[\t\n\f]+/g, ' ').trim()).filter(Boolean).join(' '));
        blocks.push({ text: cells.join('\t') });
      }
      blocks.push({ text: '' });
    } else {
      const p = m[2] || '';
      const t = paraText(p);
      blocks.push({ text: t, size: sizeOf(p), short: !!t.trim() && t.trim().length <= 60 && !/\t/.test(t) });
      if (/<w:sectPr[\s>]/.test(p)) blocks.push({ text: '\f' });          // the end of a section starts a new page
    }
  }
  // heading sizes: bigger than most of the text; the biggest is a section heading when a smaller heading size
  // is used more often (the recipe titles)
  // (text with no size of its own is the document's normal size, counted as 0)
  const all = new Map(), short = new Map();
  for (const b of blocks) {
    if (b.size == null || !b.text.trim()) continue;
    all.set(b.size, (all.get(b.size) || 0) + b.text.length);
    if (b.short) short.set(b.size, (short.get(b.size) || 0) + 1);
  }
  const normal = [...all].sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
  const heads = [...short].filter(([sz]) => sz > normal).sort((a, b) => b[0] - a[0]);
  const section = heads.length >= 2 && heads[0][1] < heads[1][1] ? heads[0][0] : 0;
  const out = blocks.map((b) => (section && b.short && b.size === section ? `\fSection: ${b.text.trim()}` : b.text));
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

async function docxFile(bytes) {
  const doc = readZip(bytes).find((e) => e.name === 'word/document.xml');
  if (!doc) throw new Error('That Word file has no document in it.');
  return docxToText(dec.decode(await doc.data()));
}

// ----------------------------------------------------------------------------------------- the front door
const clean = (r) => ({ ...r, title: text(r.title).slice(0, 300), ings: r.ings.slice(0, 300), dir: r.dir.slice(0, 20000) });
const usable = (r) => r.title && (r.ings.length || r.dir);

async function fromJsonValue(value, label) {
  if (value && typeof value === 'object' && value.app === 'recipelib') throw new Error('That is a Recipe Library backup. Restore it in Settings.');
  if (looksSchema(value)) return findRecipeNodes(value).map((n) => recipeFromSchema(n, text(n.url || ''), ''));
  const items = Array.isArray(value) ? value : value && typeof value === 'object' ? (Array.isArray(value.recipes) ? value.recipes : Array.isArray(value.items) ? value.items : Array.isArray(value.results) ? value.results : [value]) : [];
  const mapped = items.filter((x) => x && typeof x === 'object' && (x.name || x.title)).map(fromRichRecipe);
  return mapped;
}

/**
 * Reads one file. Returns { recipes, skipped, kind } where kind names what it was recognised as.
 * Throws an Error with a message fit to show when nothing can be read.
 */
export async function importFile(name, bytes) {
  const lower = String(name || '').toLowerCase();
  const recipes = [];
  let skipped = 0, kind = '';
  const add = (list_, k) => { for (const r of list_) { const c = clean(r); if (usable(c)) recipes.push(c); else skipped++; } kind = kind || k; };

  async function fromZip(zip, depth) {
    if (depth > 2) return;
    for (const e of zip) {
      const n = e.name.toLowerCase();
      try {
        if (n.endsWith('.paprikarecipe')) { add([fromPaprika(JSON.parse(dec.decode(await gunzip(await e.data()))))], 'Paprika'); }
        else if (n.endsWith('.zip')) await fromZip(readZip(await e.data()), depth + 1);
        else if (n.endsWith('.json')) {
          const value = JSON.parse(dec.decode(await e.data()));
          const rich = looksSchema(value) ? 'schema.org' : /(^|\/)recipe\.json$/.test(n) && value.steps ? 'Tandoor' : 'Mealie';
          add(await fromJsonValue(value, n), rich);
        } else if (n.endsWith('.cook')) add([fromCooklang(dec.decode(await e.data()), e.name.split('/').pop())], 'Cooklang');
      } catch (err) { if (/backup/.test(err.message)) throw err; skipped++; }
      if (recipes.length > MAX_RECIPES) throw new Error(`That has more than ${MAX_RECIPES} recipes. Split it and import in parts.`);
    }
  }

  const fromText = (t, k) => add(splitRecipes(t).map(fromPlainText), k);
  if (lower.endsWith('.docx') && isZip(bytes)) fromText(await docxFile(bytes), 'Word');
  else if (lower.endsWith('.pdf') || dec.decode(bytes.subarray(0, 5)) === '%PDF-') {
    const { pdfToText } = await import('./pdfread.js');
    const t = await pdfToText(bytes);
    if (!t.trim()) throw new Error('No text was found in that PDF. If it is a scan, use Scan a printed recipe on the Add page.');
    fromText(t, 'PDF');
  } else if (lower.endsWith('.doc')) throw new Error('That is an older Word file (.doc). In Word, choose File > Save As > Word Document (.docx), then import that.');
  else if (isZip(bytes)) await fromZip(readZip(bytes), 0);
  else if (lower.endsWith('.cook')) add([fromCooklang(dec.decode(bytes), name)], 'Cooklang');
  else if (lower.endsWith('.json') || lower.endsWith('.jsonld')) add(await fromJsonValue(JSON.parse(dec.decode(bytes)), name), 'JSON');
  else if (/\.html?$/.test(lower)) add(fromHtml(dec.decode(bytes)).map((n) => recipeFromSchema(n, text(n.url || ''), '')), 'web page');
  else {
    const t = dec.decode(bytes);
    if (/^\s*[{[]/.test(t)) { try { add(await fromJsonValue(JSON.parse(t), name), 'JSON'); } catch (err) { if (/backup/.test(err.message)) throw err; } }
    if (!recipes.length && /ld\+json/i.test(t)) add(fromHtml(t).map((n) => recipeFromSchema(n, '', '')), 'web page');
    if (!recipes.length) fromText(t, 'text');
  }
  if (!recipes.length) throw new Error(skipped ? 'No recipe in that file had a title and ingredients or directions.' : 'No recipes were found in that file.');
  return { recipes, skipped, kind };
}

// ----------------------------------------------------------------------------------------- writing
const fraction = (q) => (q == null ? '' : String(q));
const lines = (dir) => String(dir || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

export async function toPaprika(recipes) {
  const files = [];
  const used = new Set();
  for (const [n, r] of recipes.entries()) {
    const ings = [];
    let group = null;
    for (const i of r.ings) {
      if (i.group && i.group !== group) { group = i.group; ings.push('', `${group}:`); } else if (!i.group && group) group = null;
      ings.push(formatIngredient(i));
    }
    const doc = {
      uid: `RL-${n}-${Math.abs(crc32(enc.encode(`${r.title}${r.dir}`))).toString(16)}`.toUpperCase(),
      name: r.title, ingredients: ings.join('\n').replace(/^\n/, ''), directions: lines(r.dir).join('\n\n'),
      servings: formatYield(r) || '', source: r.src?.name || r.src?.author || '', source_url: r.src?.url || '',
      categories: r.categories || [], notes: '', description: '', rating: 0, difficulty: '', prep_time: '', cook_time: '', total_time: '',
      nutritional_info: '', photo: null, photo_hash: null, created: new Date().toISOString().replace('T', ' ').slice(0, 19), hash: '',
    };
    let base = r.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'Recipe';
    for (let k = 2; used.has(base.toLowerCase()); k++) base = `${base.replace(/ \d+$/, '')} ${k}`;
    used.add(base.toLowerCase());
    files.push({ name: `${base}.paprikarecipe`, data: await gzip(enc.encode(JSON.stringify(doc))) });
  }
  return writeZip(files);
}

export function toSchemaJson(recipes) {
  const out = recipes.map((r) => {
    const o = {
      '@context': 'https://schema.org', '@type': 'Recipe', name: r.title,
      recipeIngredient: r.ings.map((i) => formatIngredient(i)),
      recipeInstructions: lines(r.dir).map((t) => ({ '@type': 'HowToStep', text: t })),
    };
    const y = formatYield(r);
    if (y) o.recipeYield = y;
    if (r.categories?.length) o.recipeCategory = r.categories;
    if (r.tags?.length) o.keywords = r.tags.join(', ');
    if (r.src?.author) o.author = { '@type': 'Person', name: r.src.author };
    if (r.src?.url) o.url = r.src.url;
    return o;
  });
  return JSON.stringify(out.length === 1 ? out[0] : out, null, 2);
}

export function toMarkdown(recipes) {
  return recipes.map((r) => {
    const out = [`# ${r.title}`, ''];
    const y = formatYield(r);
    const meta = [y && `**Yield:** ${y}`, r.categories?.length && `**Categories:** ${r.categories.join(', ')}`,
      r.src && (r.src.author || r.src.name) && `**By:** ${[r.src.author, r.src.name].filter(Boolean).join(', ')}`, r.src?.url && `**Original:** ${r.src.url}`].filter(Boolean);
    if (meta.length) out.push(meta.join('  \n'), '');
    out.push('## Ingredients', '');
    let group = null;
    for (const i of r.ings) {
      if (i.group !== group) { group = i.group; if (group) out.push('', `**${group}**`, ''); }
      out.push(`- ${formatIngredient(i)}`);
    }
    out.push('', '## Directions', '');
    lines(r.dir).forEach((s, n) => out.push(`${n + 1}. ${s}`));
    return out.join('\n');
  }).join('\n\n---\n\n') + '\n';
}

/** Names a download: "recipes-2026-11-11.paprikarecipes". */
export const fileNameFor = (stem, ext, date = new Date()) => `${stem}-${date.toISOString().slice(0, 10)}.${ext}`;
