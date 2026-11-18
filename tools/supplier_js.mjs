// Companion to tests/test_supplier.py: reads supplier price files with web/js/supplier.js and prints the result.
import { readFileSync } from 'node:fs';
import * as s from '../web/js/supplier.js';
import { readXlsx } from '../web/js/xlsx.js';

const { files, packs, descs, own = [] } = JSON.parse(readFileSync(0, 'utf8'));
const out = { files: {}, packs: {}, descs: {}, own: {} };
for (const [name, path, map, opts] of files) {
  const text = path.endsWith('.xlsx') ? await readXlsx(readFileSync(path)) : readFileSync(path, 'utf8');
  const r = s.readSupplierFile(text, { map: map || null, extraNames: opts?.ingredients || [], matches: opts?.matches || null });
  const picks = s.defaultPicks(r.rows);
  out.files[name] = {
    supplier: s.guessSupplier(path, text), found: r.found, typed: r.typed, noPrices: r.noPrices,
    rows: r.rows.map((x, i) => [x.item, x.description, x.price && x.price.p, x.price && x.price.per, x.food, x.suggest, x.why, picks.has(i),
      x.price && x.price.from, x.ours, x.remembered]),
    prices: s.toPrices(r.rows, picks, 'Test', '2026-11-16'),
  };
}
for (const p of packs) { const x = s.parsePack(p); out.packs[JSON.stringify(p)] = x && [x.kind, Math.round(x.amount)]; }
for (const d of descs) out.descs[d] = s.matchFood(d);
for (const [d, names] of own) out.own[d] = s.matchFood(d, names);
process.stdout.write(JSON.stringify(out));
