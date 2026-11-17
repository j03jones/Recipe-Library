"""Nutrition, unit-to-gram conversion, food cost and the price book (the web app's JS, run in Node)."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SCRIPT = r"""
import { Frac } from './web/js/units.js';
import { identify, measure, amountOf, nutrition, costing, lineCost, suggestedPrice, foodCostPct, defaultPriceUnit } from './web/js/nutrition.js';
import * as prices from './web/js/prices.js';
import { FOODS } from './web/js/nutridata.js';

const ing = (q, unit, item, raw = '') => ({ q: q == null ? null : Frac.parse(q), raw, unit, item, group: '' });
const rec = (ings, yq) => ({ ings, yq: yq ? Frac.parse(yq) : null });
const out = {};

out.ident = ['Peanut Butter', 'chopped onion', 'Onions; finely chopped', 'all-purpose flour', 'egg whites', 'unsalted butter',
  'chicken broth', 'sea salt', 'jalapeno peppers', 'xanthan gum'].map((t) => [t, identify(t).key, !!identify(t).entry]);
const g = (i, e) => { const m = measure(i, identify(e || i.item).entry); return m && m.g; };
out.grams = {
  flourCup: g(ing('1', 'cup', 'flour')), eggs2: g(ing('2', '', 'eggs')), eggLarge: g(ing('2', 'large', 'eggs')),
  butterLb: g(ing('1', 'lb', 'butter')), butterStick: g(ing('1', 'stick', 'butter')), garlicClove: g(ing('3', 'clove', 'garlic')),
  onionMedium: g(ing('1', 'medium', 'onion')), pinch: g(ing('1', 'pinch', 'salt')), kg: g(ing('1', 'kg', 'sugar')),
  unknownCan: g(ing('1', 'can', 'tomatoes')), noAmount: g(ing(null, '', 'salt')), range: amountOf(ing(null, 'cup', 'flour', '2-3')),
  mlWater: measure(ing('1', 'cup', 'water'), identify('water').entry).ml,
};
const flourEggs = nutrition(rec([ing('1', 'cup', 'flour'), ing('2', '', 'eggs')], '4'));
out.nutri = { kcal: flourEggs.total.kcal, per: flourEggs.per.kcal, counted: flourEggs.counted, lines: flourEggs.lines, protein: flourEggs.total.protein };
const partial = nutrition(rec([ing('1', 'cup', 'flour'), ing(null, '', 'salt'), ing('1', 'cup', 'xanthan gum'), ing('1', 'jar', 'beans'), ing('2', 'cup', 'water')], ''));
// whole fruit and vegetables, kitchen units and cans (the Pozole Rojo a chef added: 40% counted before)
const poz = nutrition(rec([ing('3', 'lb', 'pork shoulder'), ing('3', 'can (15 oz)', 'white hominy'), ing('2', 'Tbsp', 'vegetable oil'),
  ing('2', 'cup', 'Dark Beer'), ing('12', 'Each', 'garlic cloves'), ing('5', 'Each', 'guajillo peppers'), ing('5', 'Each', 'ancho peppers'),
  ing('2', 'Each', 'white onion'), ing('1/2', 'tsp', 'dry Mexican oregano'), ing('4', 'quart', 'Water'), ing('4', 'Each', 'Pasilla peppers')], '8'));
out.pozole = { coverage: poz.coverage, kcal: poz.per.kcal, skipped: poz.skipped.map((s) => s.ing.item) };
const wg = (u, item, q = '1') => measure(ing(q, u, item), identify(item).entry)?.g ?? null;
out.weighs = {
  hominyCan: wg('can (15 oz)', 'white hominy'), plainCan: wg('can', 'black beans'), sizedFirst: wg('28-oz can', 'crushed tomatoes'),
  litreCarton: measure(ing('1', 'carton (1 l)', 'chicken broth'), identify('chicken broth').entry)?.ml ?? null,
  jar: wg('jar', 'salsa'), each: wg('Each', 'onion', '2'), ea: wg('Ea', 'onion', '2'), whole: wg('whole', 'tomato'),
  heads: wg('heads', 'garlic', '2'), cabbage: wg('head', 'cabbage'), cilantro: wg('bunch', 'cilantro'), corn: wg('ears', 'corn', '2'),
  celery: wg('stalks', 'celery', '3'), lettuce: wg('', 'lettuce'), tbsp: wg('Tbsp', 'vegetable oil'),
};
out.freshTomato = [identify('tomatoes').entry.kcal, identify('tomatoes').entry.each];
out.names = Object.fromEntries(['garlic cloves', 'cloves garlic', 'guajillo peppers', 'ancho chiles', 'dried pasilla peppers', 'jalapeno peppers',
  'black pepper', 'ground cloves', 'white hominy', 'chiles de arbol', 'poblano peppers', 'tomatillos'].map((n) => [n, identify(n).key]));
out.partial = { counted: partial.counted, lines: partial.lines, why: partial.skipped.map((s) => s.why), perIsNull: partial.per === null };
const cost = (i, price) => { const l = lineCost(i, identify(i.item).entry, price); return l; };
out.cost = {
  lb: cost(ing('1', 'lb', 'butter'), { p: 4, per: 'lb' }),
  cupFromLb: cost(ing('1', 'cup', 'butter'), { p: 4, per: 'lb' }),
  eggs: cost(ing('2', '', 'eggs'), { p: 3.6, per: 'dozen' }),
  eggsByWeightPrice: cost(ing('2', '', 'eggs'), { p: 2, per: 'lb' }),
  quartMilk: cost(ing('1', 'cup', 'milk'), { p: 4, per: 'gallon' }),
  ozFromKg: cost(ing('8', 'oz', 'sugar'), { p: 2, per: 'kg' }),
  cantConvert: cost(ing('1', 'cup', 'xanthan gum'), { p: 5, per: 'each' }),
  badPrice: cost(ing('1', 'lb', 'butter'), { p: -1, per: 'lb' }),
  badUnit: cost(ing('1', 'lb', 'butter'), { p: 1, per: 'bushel' }),
};
const r = rec([ing('1', 'lb', 'butter'), ing('2', '', 'eggs'), ing('1', 'cup', 'flour'), ing(null, '', 'salt'), ing('1', 'cup', 'water')], '4');
const c = costing(r, { butter: { p: 4, per: 'lb' }, egg: { p: 3.6, per: 'dozen' } });
out.costing = { total: c.total, per: c.perServing, missing: c.missing, states: c.lines.map((l) => l.state) };
out.pricing = { sugg: suggestedPrice(3, 30), pct: foodCostPct(3, 12), zero: suggestedPrice(3, 0), none: foodCostPct(3, 0) };
out.defaults = [defaultPriceUnit(ing('1', 'lb', 'butter'), identify('butter').entry), defaultPriceUnit(ing('1', 'cup', 'milk'), identify('milk').entry),
  defaultPriceUnit(ing('1', 'cup', 'flour'), identify('flour').entry), defaultPriceUnit(ing('2', '', 'eggs'), identify('eggs').entry)];

// the price book
out.clean = prices.clean({ items: { butter: { p: 4.5, per: 'lb' }, bad1: { p: -3, per: 'lb' }, bad2: { p: 1, per: 'bushel' }, bad3: 'x' }, menu: { a: 12, b: 0, c: 'x' }, target: 500 });
out.clean2 = prices.clean('garbage');
out.merge = prices.merge({ items: { a: { p: 1, per: 'lb' }, b: { p: 2, per: 'lb' } }, target: 28 }, { items: { b: { p: 3, per: 'oz' } }, menu: { r1: 10 } });
const csv = prices.toCsv({ items: { 'butter': { p: 4.5, per: 'lb' }, 'half and half': { p: 3, per: 'quart' }, 'a, "b"': { p: 1, per: 'each' } } });
out.csv = csv;
out.fromCsv = prices.fromCsv('food,price,per\nButter,$4.50,lbs\n"Eggs",3.60,doz\nflour,abc,lb\nsugar,1,\nolive oil,12,per gallon\n', (n) => identify(n).key);
out.roundtrip = prices.fromCsv(csv, (n) => n);

// the table itself
const names = FOODS.map((f) => f[0]);
out.dupes = names.filter((n, i) => names.indexOf(n) !== i);
out.badRows = FOODS.filter((f) => f.length !== 9 || f.slice(1, 8).some((v) => typeof v !== 'number' || v < 0) || f[1] > 905 || f[2] + f[3] + f[4] > 101).map((f) => f[0]);
// energy should roughly match the macros (4 / 4 / 9 per gram; alcohol and fibre explain the rest)
out.energyOff = FOODS.filter((f) => f[1] > 20 && Math.abs(f[1] - (4 * f[2] + 4 * f[3] + 9 * f[4])) / f[1] > 0.3).map((f) => f[0]);
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
class NutritionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        run = subprocess.run(["node", "--input-type=module", "-e", SCRIPT], cwd=ROOT, capture_output=True, text=True, timeout=60)
        if run.returncode:
            raise AssertionError(run.stderr)
        cls.js = json.loads(run.stdout)

    def test_ingredients_are_recognised(self):
        got = {t: [k, e] for t, k, e in self.js["ident"]}
        self.assertEqual(got["Peanut Butter"], ["peanut butter", True])        # not plain butter
        self.assertEqual(got["chopped onion"][0], "onion")
        self.assertEqual(got["Onions; finely chopped"][0], "onion")
        self.assertEqual(got["all-purpose flour"][0], "flour")
        self.assertEqual(got["egg whites"][0], "egg white")
        self.assertEqual(got["unsalted butter"][0], "unsalted butter")
        self.assertEqual(got["chicken broth"][0], "chicken broth")
        self.assertEqual(got["sea salt"][0], "salt")
        self.assertEqual(got["xanthan gum"], ["xanthan gum", False])           # unknown food keeps its own name

    def test_amounts_become_grams(self):
        g = self.js["grams"]
        self.assertAlmostEqual(g["flourCup"], 125)
        self.assertAlmostEqual(g["eggs2"], 100)
        self.assertAlmostEqual(g["eggLarge"], 100)
        self.assertAlmostEqual(g["butterLb"], 453.592, places=2)
        self.assertEqual(g["butterStick"], 113)
        self.assertEqual(g["garlicClove"], 9)
        self.assertEqual(g["onionMedium"], 110)
        self.assertAlmostEqual(g["pinch"], 0.4)
        self.assertEqual(g["kg"], 1000)
        self.assertEqual(g["unknownCan"], 425)      # a can with no size: a standard 15 oz can (estimated)
        self.assertIsNone(g["noAmount"])
        self.assertEqual(g["range"], 2.5)           # middle of "2-3"
        self.assertAlmostEqual(g["mlWater"], 236.588, places=2)

    def test_whole_vegetables_kitchen_units_and_cans_are_weighed(self):
        p = self.js["pozole"]
        self.assertEqual((p["coverage"], p["skipped"]), (1, []))                 # was 40%: hominy, "Each" and the chiles
        self.assertTrue(440 < p["kcal"] < 510, p["kcal"])
        w = self.js["weighs"]
        self.assertAlmostEqual(w["hominyCan"], 15 * 28.3495, places=2)          # the size written in the unit
        self.assertEqual(w["plainCan"], 425)                                     # a standard 15 oz can
        self.assertAlmostEqual(w["sizedFirst"], 28 * 28.3495, places=2)
        self.assertEqual(w["litreCarton"], 1000)
        self.assertIsNone(w["jar"])                                              # a jar of unknown size is not guessed
        self.assertEqual((w["each"], w["ea"], w["whole"]), (220, 220, 123))      # "Each", "Ea", "whole" are pieces
        self.assertEqual((w["heads"], w["cabbage"], w["cilantro"], w["corn"], w["celery"], w["lettuce"]), (100, 900, 60, 180, 120, 550))
        self.assertAlmostEqual(w["tbsp"], 14.787 * 218 / 236.588, places=3)     # known units keep working

    def test_chiles_and_cloves_are_not_taken_for_spices(self):
        n = self.js["names"]
        self.assertEqual(n["garlic cloves"], "garlic clove")
        self.assertEqual(n["cloves garlic"], "garlic")
        self.assertEqual(n["ground cloves"], "clove")                # the spice, still
        self.assertEqual(n["black pepper"], "black pepper")
        self.assertEqual((n["guajillo peppers"], n["ancho chiles"], n["jalapeno peppers"], n["poblano peppers"]),
                         ("guajillo pepper", "ancho chile", "jalapeno pepper", "poblano pepper"))
        self.assertEqual((n["dried pasilla peppers"], n["chiles de arbol"], n["white hominy"], n["tomatillos"]), ("pasilla pepper", "arbol", "white hominy", "tomatillo"))
        self.assertEqual(self.js["freshTomato"], [18, 123])                   # fresh, not the canned "diced tomato"

    def test_nutrition_totals(self):
        n = self.js["nutri"]
        self.assertAlmostEqual(n["kcal"], 125 * 3.64 + 100 * 1.43, places=1)
        self.assertAlmostEqual(n["per"], n["kcal"] / 4, places=6)
        self.assertEqual((n["counted"], n["lines"]), (2, 2))
        self.assertAlmostEqual(n["protein"], 125 * 0.103 + 100 * 0.126, places=1)

    def test_what_cannot_be_counted_is_said(self):
        p = self.js["partial"]
        self.assertEqual((p["counted"], p["lines"]), (1, 4))          # water is free and left out
        self.assertEqual(sorted(p["why"]), ["cannot be weighed", "no amount", "unknown food"])
        self.assertTrue(p["perIsNull"])                                # no yield, so only totals

    def test_costs_in_any_unit(self):
        c = self.js["cost"]
        self.assertAlmostEqual(c["lb"], 4.0)
        self.assertAlmostEqual(c["cupFromLb"], 227 / 453.592 * 4, places=4)   # cup of butter, priced by the pound
        self.assertAlmostEqual(c["eggs"], 0.6)                                # priced by the dozen
        self.assertAlmostEqual(c["eggsByWeightPrice"], 100 / 453.592 * 2, places=4)
        self.assertAlmostEqual(c["quartMilk"], 236.588 / 3785.41 * 4, places=4)
        self.assertAlmostEqual(c["ozFromKg"], 8 * 28.3495 / 1000 * 2, places=4)
        self.assertIsNone(c["cantConvert"])
        self.assertIsNone(c["badPrice"])
        self.assertIsNone(c["badUnit"])

    def test_recipe_cost_and_pricing(self):
        c = self.js["costing"]
        self.assertAlmostEqual(c["total"], 4.0 + 0.6)
        self.assertAlmostEqual(c["per"], 4.6 / 4)
        self.assertEqual(c["missing"], 1)                                      # flour has no price; salt has no amount, water is free
        self.assertEqual(c["states"], ["ok", "ok", "noprice", "noamount", "free"])
        p = self.js["pricing"]
        self.assertAlmostEqual(p["sugg"], 10)
        self.assertAlmostEqual(p["pct"], 25)
        self.assertIsNone(p["zero"])
        self.assertIsNone(p["none"])
        self.assertEqual(self.js["defaults"], ["lb", "quart", "lb", "each"])

    def test_price_book_storage(self):
        c = self.js["clean"]
        self.assertEqual(c["items"], {"butter": {"p": 4.5, "per": "lb"}})
        self.assertEqual(c["menu"], {"a": 12})
        self.assertEqual(c["target"], 30)                                      # 500% is nonsense: back to the default
        self.assertEqual(self.js["clean2"], {"items": {}, "menu": {}, "target": 30})
        m = self.js["merge"]
        self.assertEqual(m["items"], {"a": {"p": 1, "per": "lb"}, "b": {"p": 3, "per": "oz"}})   # the second book wins ties
        self.assertEqual((m["menu"], m["target"]), ({"r1": 10}, 28))

    def test_csv(self):
        self.assertEqual(self.js["csv"], 'food,price,per\n"a, ""b""",1,each\nbutter,4.5,lb\nhalf and half,3,quart\n')
        r = self.js["fromCsv"]
        self.assertEqual(r["items"], {"butter": {"p": 4.5, "per": "lb"}, "egg": {"p": 3.6, "per": "dozen"}, "olive oil": {"p": 12, "per": "gallon"}})
        self.assertEqual(len(r["bad"]), 2)                                     # the unreadable price and the missing unit
        self.assertEqual(self.js["roundtrip"]["items"]["a, \"b\""], {"p": 1, "per": "each"})
        self.assertEqual(len(self.js["roundtrip"]["bad"]), 0)

    def test_food_table_is_sane(self):
        self.assertEqual(self.js["dupes"], [])
        self.assertEqual(self.js["badRows"], [])
        # Calories should roughly match protein, carbs and fat. These differ for a known reason (alcohol and
        # vanilla carry calories the macros do not show; spices, herbs, cocoa and citrus are mostly fibre, which
        # the official figure leaves out). A new entry here is probably a typo in the table.
        explained = ("alcohol", "vanilla", "wine", "beer", "sherry", "vermouth", "brandy", "rum", "vodka", "gin", "tequila", "whiskey", "bourbon",
                     "spice", "herb", "cocoa", "lemon", "lime", "baking powder", "caper", "cinnamon", "paprika", "chili", "cayenne", "oregano",
                     "basil", "clove", "allspice", "marjoram", "dill", "coriander", "italian seasoning", "poultry seasoning")
        unexplained = [n for n in self.js["energyOff"] if not any(w in n for w in explained)]
        self.assertEqual(unexplained, [], "calories do not match protein, carbs and fat")


if __name__ == "__main__":
    unittest.main()
