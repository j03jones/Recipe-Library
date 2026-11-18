// Your ingredient prices, for costing recipes.
// { items: { [food]: { p: dollars, per: 'lb', src?: 'Sysco #1234567', at?: '2026-11-16' } }, menu: { [recipeId]: menu price }, target: food cost % }
// src and at say where a price came from (a supplier price list) and when.
// Kept on this device and, signed in, with the account (see app.js). Nobody else sees them.
import { PRICE_UNITS } from './nutrition.js';

const KEY = 'recipelib.prices';
const MAX_ITEMS = 3000;
export const DEFAULT_TARGET = 30;
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); };

const money = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e6 ? Math.round(v * 10000) / 10000 : null);

export function clean(v) {
  const out = { items: {}, menu: {}, target: DEFAULT_TARGET };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  if (v.items && typeof v.items === 'object' && !Array.isArray(v.items)) {
    for (const [key, e] of Object.entries(v.items).slice(0, MAX_ITEMS)) {
      const p = money(e?.p);
      if (p == null || !key || key.length > 80 || !Object.hasOwn(PRICE_UNITS, e.per)) continue;
      out.items[key] = { p, per: e.per };
      if (typeof e.src === 'string' && e.src.trim()) out.items[key].src = e.src.trim().slice(0, 60);
      if (typeof e.at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.at)) out.items[key].at = e.at;
    }
  }
  if (v.menu && typeof v.menu === 'object' && !Array.isArray(v.menu)) {
    for (const [id, p] of Object.entries(v.menu).slice(0, 5000)) { const m = money(p); if (m != null && m > 0) out.menu[id] = m; }
  }
  const t = Number(v.target);
  if (Number.isFinite(t) && t >= 1 && t <= 100) out.target = Math.round(t * 10) / 10;
  return out;
}
export function load() {
  try { return clean(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { return clean(null); }
}
export function replace(data) {
  try { localStorage.setItem(KEY, JSON.stringify(clean(data))); return true; } catch { return false; }
}
export function save(data) {
  const ok = replace(data);
  if (ok) for (const fn of listeners) fn();
  return ok;
}
/** True when nothing has been saved (used to decide whether there is anything to offer an account). */
export const isEmpty = (d) => Object.keys(d.items).length === 0 && Object.keys(d.menu).length === 0;

function change(fn) {
  const d = load();
  fn(d);
  return save(d);
}
/** Set a price; an empty or invalid one removes it. */
export const setPrice = (key, p, per) => change((d) => {
  const v = money(typeof p === 'string' ? parseFloat(p) : p);
  if (v == null || p === '' || p == null) delete d.items[key];
  else d.items[key] = { p: v, per, at: today() };   // typed by hand: no longer the supplier's price, and the newest
});
export const removePrice = (key) => change((d) => { delete d.items[key]; });
export const setMenuPrice = (id, p) => change((d) => {
  const v = money(typeof p === 'string' ? parseFloat(p) : p);
  if (v == null || !(v > 0)) delete d.menu[id]; else d.menu[id] = v;
});
export const setTarget = (pct) => change((d) => { d.target = clean({ target: pct }).target; });

export const today = () => new Date().toISOString().slice(0, 10);

/**
 * `incoming` prices laid over `current` ones, the newest winning: a price is not replaced by one dated earlier
 * (an old invoice imported after a newer one). Returns { items, added, kept: [foods whose newer price stayed] }.
 */
export function mergeNewest(current, incoming) {
  const items = { ...current };
  let added = 0;
  const kept = [];
  for (const [food, e] of Object.entries(incoming)) {
    const have = items[food];
    if (have?.at && e.at && have.at > e.at) { kept.push(food); continue; }
    items[food] = e;
    added++;
  }
  return { items, added, kept };
}

/** Add many prices at once (a supplier price list): { food: { p, per, src, at } }. Returns how many were added
 *  (prices newer than these are kept). */
export function addMany(items) {
  const d = load();
  const r = mergeNewest(d.items, items);
  if (r.added) save({ ...d, items: r.items });
  return r.added;
}

/** Two price books combined (first sign-in on a device that already has one): this device's prices win ties. */
export function merge(a, b) {
  const x = clean(a);
  const y = clean(b);
  return clean({ items: { ...x.items, ...y.items }, menu: { ...x.menu, ...y.menu }, target: y.target !== DEFAULT_TARGET ? y.target : x.target });
}

// ---- CSV, for a supplier price list or a spreadsheet: food,price,per
const cell = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export function toCsv(d) {
  return `food,price,per\n${Object.entries(d.items).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, e]) => `${cell(k)},${e.p},${e.per}`).join('\n')}\n`;
}
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}
const PER_WORDS = { lbs: 'lb', pound: 'lb', pounds: 'lb', '/lb': 'lb', ounce: 'oz', ounces: 'oz', kilo: 'kg', kilogram: 'kg', gram: 'g', gal: 'gallon', gallons: 'gallon', qt: 'quart', quarts: 'quart', liter: 'l', litre: 'l', ea: 'each', doz: 'dozen' };
/** Parses `food,price,per` rows. Returns { items, bad } (bad = the rows that could not be read). */
export function fromCsv(text, identifyKey) {
  const items = {};
  const bad = [];
  const rows = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  for (const [i, line] of rows.entries()) {
    const [food, price, perRaw = ''] = splitCsvLine(line);
    if (i === 0 && /^food$|^item$|^ingredient$/i.test(food)) continue;
    const p = parseFloat(String(price).replace(/^\$/, ''));
    const per0 = perRaw.toLowerCase().replace(/^per\s+|^\//, '');
    const per = Object.hasOwn(PRICE_UNITS, per0) ? per0 : PER_WORDS[per0] || '';
    if (!food || !Number.isFinite(p) || p < 0 || !per) { bad.push(line); continue; }
    items[identifyKey(food)] = { p, per };
  }
  return { items, bad };
}
