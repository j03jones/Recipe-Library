// The home feed: shelves of recipe cards above the full list ("Ready in 30 minutes", "Fall flavors", ...).
// The picks change once a day and stay put while you browse. Searching or choosing a category hides it.
import { daySeed, formatMinutes, inSeason, pick, usesAny } from './insights.js';

const NOT_A_MEAL = new Set(['Beverages & Cocktails', 'Sauces & Condiments']);
const MAINS = new Set(['Main Dishes', 'Soups & Stews', 'Pasta, Rice & Grains', 'Salads & Dressings', 'Eggs & Cheese']);
const SWEET = new Set(['Desserts', 'Cakes', 'Cookies & Bars', 'Pies & Pastries', 'Candy & Chocolate']);
const PER_SHELF = 10;

/** The small line under a card or list row: "25 min · Vegetarian". */
export function metaLine(r) {
  return [r._mins != null && formatMinutes(r._mins), r._veg && 'Vegetarian'].filter(Boolean).join(' · ');
}

/**
 * ctx: { h, lib, thumb, starIds, recentCooked, filter(kind) } where filter('quick' | 'veg') shows the full list
 * with that filter on.
 */
export function homeFeed(ctx) {
  const { h, lib } = ctx;
  const seed = daySeed();
  const library = lib.all.filter((r) => r.source === 'base' && !r.stub);
  const meal = (r) => !r.categories.some((c) => NOT_A_MEAL.has(c));

  const card = (r) => h('a', { class: 'fcard', href: `#/r/${r.id}` },
    ctx.thumb(r, true),
    h('span', { class: 'ft' }, r.title),
    h('span', { class: 'fm' }, metaLine(r) || r.categories[0] || ''));

  const shelf = (title, list, more) => list.length > 0 && h('section', { class: 'shelf', 'aria-label': title },
    h('div', { class: 'shelfhead' }, h('h2', null, title),
      more && h('button', { type: 'button', class: 'seeall', onclick: more }, 'See all')),
    h('div', { class: 'shelfrow' }, list.map(card)));

  const byId = (ids) => ids.map((id) => lib.byId.get(id)).filter((r) => r && !r.hidden);
  const season = inSeason();
  const community = lib.all.filter((r) => r.source === 'community' && r.row?.created_at)
    .sort((a, b) => String(b.row.created_at).localeCompare(String(a.row.created_at)));

  return h('div', { class: 'feed' },
    shelf('Cook again', byId(ctx.recentCooked()).slice(0, PER_SHELF), () => { location.hash = '#/cooked'; }),
    shelf('Your stars', byId(ctx.starIds()).slice(0, PER_SHELF), () => { location.hash = '#/starred'; }),
    shelf('Ready in 30 minutes', pick(library.filter((r) => r._mins != null && r._mins <= 30 && meal(r)), PER_SHELF, seed), () => ctx.filter('quick')),
    shelf(season.title, pick(library.filter((r) => meal(r) && usesAny(r, season.words)), PER_SHELF, seed + 1)),
    shelf('Meat-free mains', pick(library.filter((r) => r._veg && r.categories.some((c) => MAINS.has(c))), PER_SHELF, seed + 2), () => ctx.filter('veg')),
    shelf('Something sweet', pick(library.filter((r) => r.categories.some((c) => SWEET.has(c))), PER_SHELF, seed + 3)),
    shelf('New in Community', community.slice(0, PER_SHELF)));
}
