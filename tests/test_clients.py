"""Meal prep clients: allergen suggestions and the rules behind menus (web/js/allergens.js, clients.js)."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

GUMBO = ["g1", "Chicken and Andouille Gumbo", ["Soups & Stews"], "4", "servings", "4 servings", [
    ["1", "", "lb", "Chicken thighs; boneless", ""], ["1/2", "", "cup", "All-purpose flour", ""],
    ["1/2", "", "cup", "Vegetable oil", ""], ["2", "", "cup", "Onions, chopped", ""],
    ["1", "", "Tbsp", "Worcestershire sauce", ""], ["2", "", "cup", "Cooked rice", ""], ["", "", "", "Salt to taste", ""]],
    "Make a dark roux. Add everything else and simmer.", []]
PIE = ["p1", "Pecan Pie", ["Desserts"], "", "", "", [
    ["1", "", "cup", "Pecans, chopped", ""], ["3", "", "", "Eggs", ""], ["1", "", "", "Pie crust", ""],
    ["1", "", "cup", "Corn syrup", ""], ["4", "", "Tbsp", "Butter, melted", ""]], "Mix and bake.", []]

CASES = {
    "names": ["Peanut butter", "Butter", "Butternut squash", "Coconut milk", "Whole milk", "Eggplant", "Eggs, beaten",
              "All-purpose flour", "Rice flour", "Corn tortillas", "Flour tortillas", "Soy sauce", "Worcestershire sauce",
              "Catfish fillets", "Crawfish tails", "Oyster mushrooms", "Tahini", "Pecans, chopped", "Ground nutmeg",
              "Cream of tartar", "Swiss chard", "Swiss cheese", "Sea bass", "Water chestnuts", "Egg noodles", "Rolled oats",
              "Chicken broth", "Almond milk", "Shrimp, peeled"],
    "dish": ["Chicken", "Soy sauce", "Peanut butter", "Sesame oil", "Rice", "Soy sauce"],
    "messy": ["Sesame", "Gold", "Peanuts", "Peanuts", "fish"],
    "dishAllergens": ["Peanuts", "Soy", "Sesame"], "personAllergens": ["Sesame", "Shellfish", "Peanuts"],
    "rows": [GUMBO, PIE], "servings": [2, 8],
    "client": {"name": "Anna Lee", "plan": "couple", "allergens": ["Fish", "Tree nuts"], "dislikes": "no mushrooms, cilantro; Onions"},
    "meals": [
        {"title": "Chicken gumbo", "ingredients": ["Chicken", "Onions", "Rice"], "allergens": ["Wheat / gluten", "Fish"], "status": "approved",
         "servings": 2, "nutrition": {"kcal": 520, "protein": 34, "carbs": 40, "fat": 22}, "reheat": "350F for 15 min", "storage": "", "use_by": "2026-11-20"},
        {"title": "Turkey chili", "ingredients": ["Turkey", "Black beans"], "allergens": [], "status": "proposed", "servings": 2,
         "nutrition": {"kcal": 380, "protein": 30, "carbs": 30, "fat": 12}, "reheat": "", "storage": "Freezes well", "use_by": None},
        {"title": "Mushroom risotto", "ingredients": ["Arborio rice", "Mushrooms"], "allergens": ["Milk / dairy"], "status": "swap", "servings": 2, "nutrition": {}},
    ],
    "targets": {"kcal": "2000", "protein": 150, "carbs": -5, "fat": "x"},
    "menus": [
        {"week_start": "2026-11-09", "status": "closed", "client": {"name": "Anna"}, "meals": [
            {"title": "Chicken gumbo", "status": "approved", "servings": 2, "rating": 5, "private": {"recipe_id": "g1", "factor": "1/2"}},
            {"title": "Fish tacos", "status": "swap", "servings": 2}]},
        {"week_start": "2026-11-16", "status": "sent", "client": {"name": "Anna"}, "meals": [
            {"title": "chicken gumbo", "status": "approved", "servings": 2, "rating": 4, "private": {"recipe_id": "g1", "factor": "1/2"}},
            {"title": "Pecan pie", "status": "proposed", "servings": 8, "private": {"recipe_id": "p1", "factor": "1"}}]},
        {"week_start": "2026-11-16", "status": "sent", "client": {"name": "Ben"}, "meals": [
            {"title": "Chicken gumbo", "status": "approved", "servings": 4, "private": {"recipe_id": "g1", "factor": "1"}},
            {"title": "House salad", "status": "approved", "servings": 4, "private": {"recipe_id": "", "factor": "1"}}]},
        {"week_start": "2026-11-16", "status": "draft", "client": {"name": "Cy"}, "meals": [
            {"title": "Secret dish", "status": "approved", "servings": 2, "private": {"recipe_id": "x", "factor": "1"}}]},
        {"week_start": "2026-11-23", "status": "sent", "client": {"name": "Dee"}, "meals": []},
    ],
    "prices": {"chicken": {"p": 3, "per": "lb"}, "flour": {"p": 0.5, "per": "lb"}},
    # a dish of gumbo with rice for Anna, and gumbo on its own (an older one-recipe meal) for Ben
    "partsMenus": [
        {"status": "sent", "client": {"name": "Anna"}, "meals": [
            {"title": "Gumbo with Rice", "status": "approved", "servings": 2, "private": {"recipe_id": "g1", "factor": "1/2", "parts": [
                {"recipe_id": "g1", "title": "Chicken and Andouille Gumbo", "factor": "1/2"}, {"recipe_id": "r1", "title": "Rice", "factor": "1/3"}]}}]},
        {"status": "sent", "client": {"name": "Ben"}, "meals": [
            {"title": "Ben's gumbo", "status": "approved", "servings": 4, "private": {"recipe_id": "g1", "factor": "1"}}]},
    ],
}


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class Clients(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        proc = subprocess.run(["node", str(ROOT / "tools" / "clients_js.mjs")], input=json.dumps(CASES),
                              capture_output=True, text=True)
        if proc.returncode != 0:
            raise AssertionError(proc.stderr)
        cls.out = json.loads(proc.stdout)

    def test_the_nine_allergens_match_the_website_intake_form(self):
        self.assertEqual(self.out["ALLERGENS"], ["Peanuts", "Tree nuts", "Milk / dairy", "Eggs", "Wheat / gluten", "Soy",
                                                 "Fish", "Shellfish", "Sesame"])

    def test_plans_match_the_website(self):
        plans = self.out["plans"]
        self.assertEqual([(plans[k]["entrees"], plans[k]["servings"], plans[k]["fee"]) for k in ("family", "couple", "lean")],
                         [(5, 4, 240), (5, 2, 185), (10, 1, 175)])
        self.assertTrue(plans["lean"]["macros"])

    def test_allergens_from_ingredient_names(self):
        want = {
            "Peanut butter": ["Peanuts"], "Butter": ["Milk / dairy"], "Butternut squash": [], "Coconut milk": [],
            "Whole milk": ["Milk / dairy"], "Eggplant": [], "Eggs, beaten": ["Eggs"], "All-purpose flour": ["Wheat / gluten"],
            "Rice flour": [], "Corn tortillas": [], "Flour tortillas": ["Wheat / gluten"], "Soy sauce": ["Wheat / gluten", "Soy"],
            "Worcestershire sauce": ["Fish"], "Catfish fillets": ["Fish"], "Crawfish tails": ["Shellfish"], "Oyster mushrooms": [],
            "Tahini": ["Sesame"], "Pecans, chopped": ["Tree nuts"], "Ground nutmeg": [], "Cream of tartar": [], "Swiss chard": [],
            "Swiss cheese": ["Milk / dairy"], "Sea bass": ["Fish"], "Water chestnuts": [], "Egg noodles": ["Eggs", "Wheat / gluten"],
            "Rolled oats": [], "Chicken broth": [], "Almond milk": ["Tree nuts"], "Shrimp, peeled": ["Shellfish"],
        }
        self.assertEqual(self.out["ingredients"], want)

    def test_a_dish_lists_each_allergen_once_with_where_it_came_from(self):
        self.assertEqual(self.out["detect"], [
            {"allergen": "Peanuts", "from": ["Peanut butter"]}, {"allergen": "Wheat / gluten", "from": ["Soy sauce"]},
            {"allergen": "Soy", "from": ["Soy sauce"]}, {"allergen": "Sesame", "from": ["Sesame oil"]}])
        self.assertEqual(self.out["clean"], ["Peanuts", "Sesame"])
        self.assertEqual(self.out["conflicts"], ["Peanuts", "Sesame"])

    def test_what_a_client_is_shown_has_no_amounts_and_no_method(self):
        gumbo, pie = self.out["snapshots"]
        self.assertEqual(gumbo["title"], "Chicken and Andouille Gumbo")
        self.assertEqual(gumbo["ingredients"], ["Chicken thighs", "All-purpose flour", "Vegetable oil", "Onions",
                                                "Worcestershire sauce", "Cooked rice", "Salt to taste"])
        self.assertEqual(gumbo["allergens"], ["Wheat / gluten", "Fish"])
        self.assertEqual(gumbo["servings"], 2)
        self.assertGreater(gumbo["nutrition"]["kcal"], 100)       # per serving, from the recipe's own yield
        self.assertNotIn("dir", gumbo)
        self.assertNotIn("roux", json.dumps(gumbo).lower())
        self.assertFalse(any(ch.isdigit() for name in gumbo["ingredients"] for ch in name))
        # a recipe with no yield cannot give per-serving numbers: none are shown rather than a guess
        self.assertEqual(pie["nutrition"], {})
        self.assertEqual(pie["allergens"], ["Tree nuts", "Milk / dairy", "Eggs", "Wheat / gluten"])
        # 2 portions of a 4-serving recipe is half of it; no yield means the recipe as written
        self.assertEqual(self.out["factors"], ["1/2", "1"])

    def test_warnings_for_this_client(self):
        gumbo, chili, risotto = self.out["warnings"]
        self.assertEqual([w["kind"] for w in gumbo], ["allergen", "dislike"])
        self.assertEqual(gumbo[0]["allergens"], ["Fish"])
        self.assertEqual(gumbo[1]["foods"], ["onions"])
        self.assertEqual(chili, [])
        self.assertEqual([w["foods"] for w in risotto], [["mushrooms"]])

    def test_where_a_menu_stands(self):
        self.assertEqual(self.out["tally"], {"total": 3, "approved": 1, "swap": 1, "proposed": 1})
        self.assertEqual(self.out["status"], ["Finished: 1 of 2 approved", "1 approved, 1 unanswered", "All approved",
                                              "Draft: not sent yet", "No meals yet"])
        self.assertEqual(self.out["approveBy"], "Sun Nov 15 2026 18:00")      # the Sunday before the week starts

    def test_targets_and_nutrition_summary(self):
        self.assertEqual(self.out["targets"], {"kcal": 2000, "protein": 150})
        self.assertEqual(self.out["summary"], {"avg": {"kcal": 450, "protein": 32, "carbs": 35, "fat": 17},
                                               "share": {"kcal": 23, "protein": 21}, "counted": 2, "of": 3})

    def test_history_counts_dishes_not_swapped_ones(self):
        # most recent week first; the swapped "Fish tacos" never counts as something they had
        self.assertEqual(self.out["history"], [["chicken gumbo", 3, "2026-11-16", 4.5], ["Pecan pie", 1, "2026-11-16", None],
                                               ["House salad", 1, "2026-11-16", None], ["Secret dish", 1, "2026-11-16", None]])

    def test_prep_sheet_adds_up_approved_dishes_across_clients(self):
        prep = self.out["prep"]
        self.assertEqual(prep["dishes"], [
            ["Chicken gumbo", "g1", "2", 8, [{"name": "Anna", "servings": 2}, {"name": "Anna", "servings": 2}, {"name": "Ben", "servings": 4}]],
            ["House salad", "", "1", 4, [{"name": "Ben", "servings": 4}]]])
        # not approved yet, and nothing from a draft
        self.assertEqual(prep["waiting"], [{"client": "Anna", "title": "Fish tacos", "status": "swap"},
                                           {"client": "Anna", "title": "Pecan pie", "status": "proposed"}])

    def test_labels(self):
        gumbo, chili = self.out["labels"]
        self.assertEqual(gumbo, {"title": "Chicken gumbo", "client": "Anna Lee", "made": "Nov 15", "useBy": "2026-11-20",
                                 "lines": ["Reheat: 350F for 15 min"], "allergens": "Contains: Wheat / gluten, Fish", "macros": ""})
        self.assertEqual(chili["allergens"], "No major allergens listed")
        self.assertEqual(chili["lines"], ["Keep: Freezes well"])
        self.assertEqual(chili["macros"], "380 cal · 30g protein · 30g carbs · 12g fat")      # Lean & Fresh labels macros

    def test_grocery_estimate_uses_the_price_book(self):
        cost = self.out["cost"]
        self.assertGreater(cost["total"], 0)
        self.assertFalse(cost["complete"])       # oil, onions and the rest have no price yet

    def test_a_dish_name_from_several_recipes(self):
        self.assertEqual(self.out["titles"], ["", "Gumbo", "Gumbo with Rice", "Gumbo with Rice and Greens",
                                              "Gumbo with Rice, Greens and Cornbread"])

    def test_a_dish_of_several_recipes_is_shown_to_the_client_as_one(self):
        gumbo, pie = self.out["snapshots"]
        dish = self.out["combined"]
        self.assertEqual(dish["title"], "Chicken and Andouille Gumbo with Pecan Pie")
        self.assertEqual(dish["ingredients"][:len(gumbo["ingredients"])], gumbo["ingredients"])
        self.assertIn("Pecans", dish["ingredients"])
        self.assertEqual(len(dish["ingredients"]), len({n.lower() for n in dish["ingredients"]}))
        # every allergen of every part, in the usual order
        self.assertEqual(dish["allergens"], ["Tree nuts", "Milk / dairy", "Eggs", "Wheat / gluten", "Fish"])
        # the pie has no yield, so only the gumbo is counted, and coverage says the numbers are rough
        self.assertEqual(dish["nutrition"]["kcal"], gumbo["nutrition"]["kcal"])
        self.assertEqual(dish["nutrition"]["coverage"], 0)
        self.assertEqual(dish["servings"], 2)
        self.assertNotIn("dir", dish)
        self.assertTrue(self.out["single"])

    def test_the_chef_only_row_keeps_the_main_recipe_and_the_total(self):
        both, one, unpriced = self.out["priv"]
        self.assertEqual((both["recipe_id"], both["factor"], both["grocery_cost"], len(both["parts"])), ("g1", "1/2", 8.75, 3))
        self.assertEqual((one["recipe_id"], one["grocery_cost"], one["parts"]), ("g1", 6.5, []))
        self.assertIsNone(unpriced["grocery_cost"])
        several, old, typed = self.out["partsOf"]
        self.assertEqual([p["recipe_id"] for p in several], ["g1", "r1", "p1"])
        self.assertEqual(old, [{"recipe_id": "g1", "title": "Old dish", "factor": "1/2", "grocery_cost": 3}])
        self.assertEqual(typed, [])

    def test_prep_sheet_counts_each_recipe_of_a_dish(self):
        self.assertEqual(self.out["prepParts"], [["Chicken and Andouille Gumbo", "g1", "3/2", 6], ["Rice", "r1", "1/3", 2]])


if __name__ == "__main__":
    unittest.main()
