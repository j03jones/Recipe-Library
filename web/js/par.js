// Par list and daily prep (supabase/add_par_list.sql), the parts with no screen: dates, pars, what to make, cost.
//
// At close, a cook counts what is on hand; that count is for tomorrow, and tomorrow's list is par - on hand, with the
// par for tomorrow's day of the week. The next day the cooks mark what they make. Amounts are in each item's own unit
// ("qt", "each", "batch"); `per_batch` says how many of that unit one batch of the item's recipe makes, for cost.
import { costing } from './nutrition.js';

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MAX_ITEMS = 300;

const pad = (n) => String(n).padStart(2, '0');
/** A day as YYYY-MM-DD in this device's own time (the restaurant's, for the cook at the pass). */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return new Date(y, m - 1, d, 12); };
export const addDays = (iso, n) => { const d = parse(iso); d.setDate(d.getDate() + n); return localDate(d); };
/** The day a count at close is for: tomorrow, or today when closing runs past midnight (before 5 in the morning). */
export const countDate = (now = new Date()) => (now.getHours() < 5 ? localDate(now) : addDays(localDate(now), 1));
/** 0 = Sunday .. 6 = Saturday, as the database's pars are kept. */
export const dayOfWeek = (iso) => parse(iso).getDay();
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && localDate(parse(s)) === s;

const num = (v, lo = 0, hi = 100000) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x < hi ? x : null; };
/** An amount as people write it: up to two decimals, no trailing zeros. */
export const fmtQty = (n) => (n == null || !Number.isFinite(n) ? '—' : String(Math.round(n * 100) / 100));

/** A par item as the app uses it, from a database row (or a form); null if it has no name. */
export function cleanItem(row) {
  if (!row || typeof row !== 'object') return null;
  const name = String(row.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!name) return null;
  const pars = Array.from({ length: 7 }, (_, i) => num(Array.isArray(row.pars) ? row.pars[i] : 0) ?? 0);
  return {
    id: row.id ? String(row.id) : null,
    recipe_id: row.recipe_id ? String(row.recipe_id) : null,
    name,
    unit: String(row.unit ?? '').trim().slice(0, 30) || 'batch',
    per_batch: num(row.per_batch, 0.0001) ?? 1,
    station: String(row.station ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
    pars,
    sort: Number.isInteger(Number(row.sort)) ? Number(row.sort) : 0,
    active: row.active !== false,
  };
}

/** The par for an item on a day. */
export const parFor = (item, iso) => item.pars[dayOfWeek(iso)] ?? 0;
/** What to make: the par less what is on hand, never below zero; not counted means the whole par. */
export const toMake = (par, onHand) => Math.max(0, (par || 0) - (onHand == null ? 0 : onHand));

const byStation = (a, b) => (!a.station !== !b.station ? (a.station ? -1 : 1) : 0)   // items with no station last
  || a.station.localeCompare(b.station, undefined, { sensitivity: 'base' }) || a.sort - b.sort || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/**
 * One day's prep list: every active item (and any inactive one that has a row that day), with the par and count
 * kept for the day (or today's par when nobody counted), what to make, what has been made, and what is left.
 */
export function dayList(items, rows, iso) {
  const byItem = new Map((rows || []).filter((r) => r && r.for_date === iso).map((r) => [String(r.item_id), r]));
  const out = [];
  for (const item of items) {
    const row = byItem.get(item.id);
    if (!item.active && !row) continue;
    const par = row ? num(row.par) ?? 0 : parFor(item, iso);
    const onHand = row && row.on_hand != null ? num(row.on_hand) : null;
    const counted = !!row?.counted_at;
    const make = toMake(par, onHand);
    const made = row ? num(row.made) ?? 0 : 0;
    const log = Array.isArray(row?.made_log) ? row.made_log.filter((x) => x && Number.isFinite(Number(x.qty))) : [];
    out.push({ item, par, onHand, counted, countedBy: row?.counted_name || '', countedAt: row?.counted_at || null,
      toMake: make, made, left: Math.max(0, make - made), done: make > 0 ? made >= make : true, log });
  }
  return out.sort((a, b) => byStation(a.item, b.item));
}

/** How a day stands: items, how many were counted, how many need making, how many of those are done. */
export function summary(list) {
  const needed = list.filter((x) => x.toMake > 0);
  return { items: list.length, counted: list.filter((x) => x.counted).length, needed: needed.length,
    done: needed.filter((x) => x.done).length, started: list.some((x) => x.made > 0) };
}

/** Items grouped by station, in order: [[station, [entries]]]. */
export function byStations(list, key = (x) => x.item.station) {
  const groups = new Map();
  for (const x of list) {   // "Pantry" and "pantry" are one station, named as it is first written
    const s = key(x) || '';
    const k = s.toLowerCase();
    if (!groups.has(k)) groups.set(k, [s, []]);
    groups.get(k)[1].push(x);
  }
  return [...groups.values()];
}

/**
 * What one of an item's unit costs: its recipe's cost from the price book, over how many units a batch makes.
 * { per: cost of one unit or null, missing: ingredient lines without a price }.
 */
export function unitCost(item, recipe, priced) {
  if (!recipe) return { per: null, missing: 0 };
  const c = costing(recipe, priced);
  return { per: c.total > 0 ? c.total / item.per_batch : null, missing: c.missing };
}

/** A day's prep cost so far and in full: { made, planned, missing } (items without a recipe or price are left out). */
export function dayCost(list, recipesById, priced) {
  let made = 0, planned = 0, missing = 0;
  for (const x of list) {
    const { per, missing: m } = unitCost(x.item, recipesById.get(x.item.recipe_id), priced);
    if (per == null) { if (x.toMake > 0 || x.made > 0) missing++; continue; }
    if (m) missing++;
    made += per * x.made;
    planned += per * Math.max(x.toMake, x.made);
  }
  return { made, planned, missing };
}

/**
 * The count to save from what was typed: { counts: [{ item, on_hand }], bad: [item names that aren't a number] }.
 * A blank box is "not counted" (null).
 */
export function countPayload(items, typed) {
  const counts = [], bad = [];
  for (const i of items) {
    if (!i.id) continue;
    const raw = String(typed[i.id] ?? '').trim().replace(',', '.');
    const v = raw === '' ? null : num(raw);
    if (raw !== '' && v == null) bad.push(i.name);
    else counts.push({ item: i.id, on_hand: v });
  }
  return { counts, bad };
}
