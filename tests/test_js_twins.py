"""The web app's unit conversion, range scaling and shopping list must match the Python library."""
import json
import shutil
import subprocess
import unittest
from fractions import Fraction
from pathlib import Path

from recipelib import convert, shopping
from recipelib.formatting import format_ingredient
from recipelib.mealmaster import parse_file
from recipelib.models import Ingredient, Recipe
from recipelib.scaling import scale_recipe

ROOT = Path(__file__).resolve().parent.parent
FACTORS = ["1/2", "2", "3", "5/4", "7/3"]
PICKS = [[0, "2"], [1, "1"], [2, "1/2"], [4, "3"]]
NAMES = ["Onions; chopped", "Chicken broth", "Peanut butter", "Garlic powder", "Green pepper, diced", "Black pepper",
         "Red pepper flakes", "Cream cheese", "Ice cream", "Lemon juice", "Orange juice", "Egg noodles", "Olive oil",
         "All-purpose flour", "Water", "Chicken breasts", "Frozen peas", "(15 oz) tomatoes", "Cloves garlic",
         "Ground cloves", "paper towels", "Dry white wine", "Swiss cheese; grated", "Bread crumbs", "Eggs"]
PLAN = {
    "today": "2026-11-11",   # a Wednesday
    "raw": {"days": {
        "2026-11-09": [{"id": "a", "f": "2"}, {"note": "  Leftovers  "}, {"bad": 1}],
        "2026-11-13": [{"id": "a", "f": "1/2"}, {"id": "b"}, {"id": "c", "f": "nonsense"}],
        "2026-11-20": [{"id": "z", "f": "3"}],
        "2026-02-30": [{"id": "x"}], "2020-01-01": [{"id": "old"}], "junk": "nope"}},
    "other": {"days": {"2026-11-09": [{"id": "a", "f": "2"}, {"id": "d", "f": "1"}], "2026-11-10": [{"note": "Out"}]}},
}


def recipes():
    out = parse_file(ROOT / "samples" / "realworld.mmf").recipes + parse_file(ROOT / "samples" / "sample.mmf").recipes
    out.append(Recipe(title="Odds and ends", yield_quantity=Fraction(4), yield_unit="servings", ingredients=[
        Ingredient(item="Flour", raw_quantity="2-3", unit="cup"),
        Ingredient(item="Dry sherry", raw_quantity="1/2 to 1", unit="cup"),
        Ingredient(item="Garlic", raw_quantity="3-4", unit="clove"),
        Ingredient(item="Milk", quantity=Fraction(250), unit="ml"),
        Ingredient(item="Stock", quantity=Fraction(3, 2), unit="l"),
        Ingredient(item="Butter", quantity=Fraction(125), unit="g"),
        Ingredient(item="Potatoes; peeled", quantity=Fraction(1), unit="kg"),
        Ingredient(item="Vanilla", quantity=Fraction(1, 8), unit="tsp"),
        Ingredient(item="Water", quantity=Fraction(5), unit="quart"),
        Ingredient(item="Cream", quantity=Fraction(2), unit="fl oz"),
        Ingredient(item="Beef", quantity=Fraction(7, 2), unit="lb"),
        Ingredient(item="Cheese", quantity=Fraction(3), unit="oz"),
        Ingredient(item="(15 oz) tomatoes, diced", quantity=Fraction(2), unit="can"),
        Ingredient(item="Berries", quantity=Fraction(7), unit="tsp"),
        Ingredient(item="Salt", raw_quantity="to taste"),
    ]))
    for n, r in enumerate(out):
        r.id = n
    return out


def row(r: Recipe):
    return [str(r.id), r.title, r.categories, "" if r.yield_quantity is None else str(r.yield_quantity),
            r.yield_unit, r.yield_raw,
            [["" if i.quantity is None else str(i.quantity), i.raw_quantity, i.unit, i.item, i.group] for i in r.ingredients],
            r.directions, r.tags]


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class JavaScriptTwins(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.recipes = recipes()
        proc = subprocess.run(["node", str(ROOT / "tools" / "features_js.mjs")], capture_output=True, text=True,
                              input=json.dumps({"rows": [row(r) for r in cls.recipes], "factors": FACTORS, "picks": PICKS,
                                                "names": NAMES, "plan": PLAN}))
        if proc.returncode != 0:
            raise AssertionError(proc.stderr)
        cls.js = json.loads(proc.stdout)

    def test_conversion(self):
        for r in self.recipes:
            for system in convert.SYSTEMS:
                want = [format_ingredient(i) for i in convert.convert_recipe(r, system).ingredients]
                self.assertEqual(self.js["convert"][f"{r.id}|{system}"], want, f"{r.title} to {system}")

    def test_scaling_with_ranges(self):
        for r in self.recipes:
            for f in FACTORS:
                want = [format_ingredient(i) for i in scale_recipe(r, factor=Fraction(f)).recipe.ingredients]
                self.assertEqual(self.js["scale"][f"{r.id}|{f}"], want, f"{r.title} x{f}")

    def test_shopping_list(self):
        self.assertEqual(self.js["shop"][0], shopping.to_text(shopping.combine(self.recipes)))
        picks = [(self.recipes[n], Fraction(f)) for n, f in PICKS]
        self.assertEqual(self.js["shop"][1], shopping.to_text(shopping.shopping_list(picks)))


    def test_aisles(self):
        self.assertEqual(self.js["aisles"], [shopping.aisle_for(n) for n in NAMES])
        self.assertEqual(self.js["shop"][2], shopping.to_text_by_aisle(shopping.combine(self.recipes)))

    def test_web_aisle_table_is_current(self):
        js = (ROOT / "web" / "js" / "aisledata.js").read_text(encoding="utf-8")
        start = js.index("AISLE_TERMS = ") + len("AISLE_TERMS = ")
        self.assertEqual(json.loads(js[start:js.rindex("}") + 1]), shopping.AISLE_TERMS, "run python3 tools/gen_unitdata.py")

    def test_meal_plan_storage(self):
        plan = self.js["plan"]
        self.assertEqual(plan["week"], ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13",
                                        "2026-11-14", "2026-11-15"])
        # bad entries, impossible dates and long-past days are dropped; a bad scale becomes 1
        self.assertEqual(plan["cleaned"], {"days": {
            "2026-11-09": [{"id": "a", "f": "2"}, {"note": "Leftovers"}],
            "2026-11-13": [{"id": "a", "f": "1/2"}, {"id": "b", "f": "1"}, {"id": "c", "f": "1"}],
            "2026-11-20": [{"id": "z", "f": "3"}]}})
        # a recipe planned twice in the week is bought for both days; next week is not counted
        self.assertEqual(plan["recipes"], [["a", "5/2"], ["b", "1"], ["c", "1"]])
        self.assertEqual(plan["merged"]["days"]["2026-11-09"],
                         [{"id": "a", "f": "2"}, {"note": "Leftovers"}, {"id": "d", "f": "1"}])
        self.assertEqual(plan["merged"]["days"]["2026-11-10"], [{"note": "Out"}])


if __name__ == "__main__":
    unittest.main()
