// Companion to tests/test_js_twins.py: runs web/js conversion, range scaling and shopping-list code
// on recipes given as JSON on stdin (the compact row shape of data/recipes.json) and prints the results.
import { readFileSync } from 'node:fs';
import { Frac, convertRecipe, formatIngredient, scaleRecipe } from '../web/js/units.js';
import { fromRow } from '../web/js/model.js';
import { combine, shoppingList, toText } from '../web/js/shopping.js';

const { rows, factors, picks } = JSON.parse(readFileSync(0, 'utf8'));
const recipes = rows.map(fromRow);
const out = { convert: {}, scale: {}, shop: [] };
for (const r of recipes) {
  for (const system of ['metric', 'us']) out.convert[`${r.id}|${system}`] = convertRecipe(r, system).ings.map(formatIngredient);
  for (const f of factors) out.scale[`${r.id}|${f}`] = scaleRecipe(r, Frac.parse(f)).recipe.ings.map(formatIngredient);
}
out.shop.push(toText(combine(recipes)));
out.shop.push(toText(shoppingList(picks.map(([n, f]) => [recipes[n], Frac.parse(f)]))));
process.stdout.write(JSON.stringify(out));
