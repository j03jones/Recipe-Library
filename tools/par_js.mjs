// Companion to tests/test_par.py: runs web/js/par.js on cases given as JSON on stdin and prints what it makes of them.
import { readFileSync } from 'node:fs';
import { fromRow } from '../web/js/model.js';
import * as par from '../web/js/par.js';

const input = JSON.parse(readFileSync(0, 'utf8'));
const items = input.items.map(par.cleanItem);
const out = {};
out.cleaned = items;
out.days = input.dates.map((d) => [par.dayOfWeek(d), par.addDays(d, 1), par.addDays(d, -1), par.isDate(d)]);
out.bad = input.badDates.map(par.isDate);
out.countDate = input.clock.map(([y, mo, d, hr]) => par.countDate(new Date(y, mo - 1, d, hr, 30)));
out.toMake = input.makes.map(([p, o]) => par.toMake(p, o));
const good = items.filter(Boolean);
const list = par.dayList(good, input.rows, input.day);
out.list = list.map((x) => [x.item.name, x.par, x.onHand, x.counted, x.toMake, x.made, x.left, x.done, x.log.length]);
out.summary = par.summary(list);
out.stations = par.byStations(list).map(([s, g]) => [s, g.map((x) => x.item.name)]);
const recipe = fromRow(input.recipe);
const byId = new Map([[recipe.id, recipe]]);
out.unit = par.unitCost(good[0], recipe, input.prices);
out.noRecipe = par.unitCost(good[1], undefined, input.prices);
out.cost = par.dayCost(list, byId, input.prices);
out.payload = par.countPayload(good, input.typed);
out.fmt = [1.5, 2, 0.333333, null, NaN].map(par.fmtQty);
console.log(JSON.stringify(out));
