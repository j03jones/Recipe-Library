// Conversions between the three shapes a recipe takes:
//   row     compact array in data/recipes.json (the built-in library)
//   recipe  working object used by the UI
//   record  JSON-safe object stored in IndexedDB / backup files (the user's own changes)
import { Frac } from './units.js';

const q = (s) => (s === '' || s == null ? null : Frac.parse(s));

export function fromRow(row) {
  const [id, title, categories, yq, yu, yr, ings, dir] = row;
  return {
    id, title, categories, yq: q(yq), yu, yr, dir, source: 'base',
    ings: ings.map(([iq, raw, unit, item, group]) => ({ q: q(iq), raw, unit, item, group })),
  };
}

export function toRecord(r) {
  return {
    id: r.id, title: r.title, categories: r.categories,
    yq: r.yq == null ? '' : String(r.yq), yu: r.yu, yr: r.yr, dir: r.dir,
    ings: r.ings.map((i) => [i.q == null ? '' : String(i.q), i.raw, i.unit, i.item, i.group]),
    updated: Date.now(),
  };
}

export function fromRecord(rec, source) {
  const r = fromRow([rec.id, rec.title, rec.categories, rec.yq, rec.yu, rec.yr, rec.ings, rec.dir]);
  r.source = source;
  return r;
}
