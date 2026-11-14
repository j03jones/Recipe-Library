// Companion to tests/test_clients.py: runs web/js/allergens.js and web/js/clients.js on cases given
// as JSON on stdin and prints what they make of them.
import { readFileSync } from 'node:fs';
import { fromRow } from '../web/js/model.js';
import { ALLERGENS, clean, conflicts, detect, inIngredient } from '../web/js/allergens.js';
import * as clients from '../web/js/clients.js';

const input = JSON.parse(readFileSync(0, 'utf8'));
const out = { ALLERGENS, plans: clients.PLANS };
out.ingredients = Object.fromEntries(input.names.map((n) => [n, inIngredient(n).map((x) => x.allergen)]));
out.detect = detect(input.dish);
out.clean = clean(input.messy);
out.conflicts = conflicts(input.dishAllergens, input.personAllergens);

const recipes = input.rows.map(fromRow);
out.snapshots = recipes.map((r, n) => clients.snapshot(r, input.servings[n]));
out.factors = recipes.map((r, n) => String(clients.factorFor(r, input.servings[n])));
out.warnings = input.meals.map((m) => clients.warnings(m, input.client));
out.tally = clients.tally(input.meals);
out.status = input.menus.map((m) => clients.menuStatus(m));
out.approveBy = clients.defaultApproveBy('2026-11-16').toString().slice(0, 21);
out.targets = clients.cleanTargets(input.targets);
out.summary = clients.nutritionSummary(input.meals, input.targets);
out.history = clients.history(input.menus).map((d) => [d.title, d.times, d.last, d.rating]);
const sheet = clients.prepSheet(input.menus);
out.prep = { dishes: sheet.dishes.map((d) => [d.title, d.recipeId, String(d.factor), d.portions, d.clients]), waiting: sheet.waiting };
out.labels = [clients.labelFor(input.meals[0], input.client, 'Nov 15'), clients.labelFor(input.meals[1], { ...input.client, plan: 'lean' }, '')];
out.cost = clients.groceryCost(recipes[0], clients.factorFor(recipes[0], 4), input.prices);
// dishes made of several recipes
out.titles = [[], ['Gumbo'], ['Gumbo', 'Rice'], ['Gumbo', 'Rice', 'Greens'], ['Gumbo', 'Rice', 'Greens', 'Cornbread']].map(clients.dishTitle);
out.combined = clients.combine(out.snapshots.map((s) => ({ ...s, servings: 2 })));
out.single = clients.combine([out.snapshots[0]]) === out.snapshots[0];
const parts = [{ recipe_id: 'g1', title: 'Gumbo', factor: '1/2', grocery_cost: 6.5 }, { recipe_id: 'r1', title: 'Rice', factor: '1', grocery_cost: null },
  { recipe_id: 'p1', title: 'Pecan Pie', factor: '1/4', grocery_cost: 2.25 }];
out.priv = [clients.privateFor(parts), clients.privateFor(parts.slice(0, 1)), clients.privateFor([parts[1]])];
out.partsOf = [clients.partsOf({ title: 'Gumbo plate', private: out.priv[0] }), clients.partsOf({ title: 'Old dish', private: { recipe_id: 'g1', factor: '1/2', grocery_cost: 3 } }),
  clients.partsOf({ title: 'Typed in', private: { recipe_id: '' } })];
const sheet2 = clients.prepSheet(input.partsMenus);
out.prepParts = sheet2.dishes.map((d) => [d.title, d.recipeId, String(d.factor), d.portions]);
process.stdout.write(JSON.stringify(out));
