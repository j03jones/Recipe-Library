"""Shopping-list names without brand names, "freshly", footnote stars or SHOUTING: recipelib/shopping.py and its
twin web/js/shopping.js must agree."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

from recipelib.shopping import item_key, item_name

ROOT = Path(__file__).resolve().parent.parent

CASES = {
    "freshly ground black pepper": "Ground black pepper",
    "EDEN Brown Rice Vinegar OR- Eden Red Wine Vinegar": "Brown Rice Vinegar",
    "Can EDEN Pinto Beans drained": "Pinto Beans",
    "Medium QUAKER Barley*": "Barley",
    "CRISCO Shortening": "Shortening",
    "PACE Picante Sauce": "Picante Sauce",
    "Black Jack BBQ Sauce": "Black Jack BBQ Sauce",          # BBQ is not a brand
    "Eagle Brand sweetened condensed milk": "Sweetened condensed milk",
    "Instant Coffee or SANKA Brand 97% Caffeine Free Instant Coffee": "Instant Coffee",
    "All-purpose flour -AND": "All-purpose flour",
    "Dijon mustard - PLUS 1 teaspoon": "Dijon mustard",
    "Yeast *DISSOLVED IN:": "Yeast",
    "RICH chicken stock": "Chicken stock",
    "BUTTER": "Butter",
    "COLD WATER": "Water",
    "Cashews **": "Cashews",
    "Halves dried apricots**": "Dried apricots",
    "large eggs": "Eggs",
    "cloves garlic": "Garlic",
    "Cloves": "Cloves",                                        # the spice, on its own
    "butter or margarine": "Butter",
    "stalks celery, chopped": "Celery",
    "Onions; finely chopped": "Onions",
    "extra virgin olive oil": "Extra virgin olive oil",
    "Fresh cilantro": "Fresh cilantro",                        # fresh vs dried changes what you buy
    "Crushed tomatoes": "Crushed tomatoes",
    "ground beef": "Ground beef",
    "eggs at room temperature": "Eggs",
    "(10 oz) raspberries": "Raspberries",
    "****": "",                                                 # not an ingredient: not on the list
}


class TidyNames(unittest.TestCase):
    def test_python(self):
        for raw, want in CASES.items():
            self.assertEqual(item_name(raw).lower(), want.lower(), raw)   # the list capitalises when it shows them

    def test_keys_merge(self):
        self.assertEqual(item_key("freshly ground black pepper"), item_key("Ground black pepper"))
        self.assertEqual(item_key("Large Eggs"), item_key("eggs"))
        self.assertEqual(item_key("Brown sugar*"), item_key("brown sugar"))

    @unittest.skipUnless(shutil.which("node"), "needs Node")
    def test_javascript_twin_agrees(self):
        script = ("import { itemName } from './web/js/shopping.js';"
                  f"console.log(JSON.stringify({json.dumps(list(CASES))}.map(itemName)));")
        res = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(json.loads(res.stdout), [item_name(k) for k in CASES])


if __name__ == "__main__":
    unittest.main()
