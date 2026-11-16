"""Links and text shared to the app, and tidying a scanned page (web/js/getin.js, in Node)."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SCRIPT = r"""
import { firstLink, fromShared, fromText, tidyScan } from './web/js/getin.js';
const shared = fromShared({ title: 'Best Banana Bread', text: 'Try this! https://example.com/banana-bread/).' });
const text = fromShared({ text: 'Banana Bread\nIngredients\n2 cups flour\n3 bananas\nDirections\nMix. Bake 50 minutes.' });
console.log(JSON.stringify({
  link: firstLink('see (https://a.example/x?y=1), thanks'),
  shared, textTitle: text.recipe.title, textIngs: text.recipe.ings.length, imported: text.recipe.imported,
  nothing: fromShared({ text: 'hello' }), tooShort: fromText('Just a title'),
  tidy: tidyScan('Cream the butter and the sugar until it is light and\nfluffy, then add eggs.\n|\n\n2 cups flour ~'),
}));
"""


@unittest.skipUnless(shutil.which("node"), "needs Node")
class GettingRecipesIn(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        res = subprocess.run(["node", "--input-type=module", "-e", SCRIPT], cwd=ROOT, capture_output=True, text=True, timeout=60)
        if res.returncode:
            raise AssertionError(res.stderr)
        cls.o = json.loads(res.stdout)

    def test_links(self):
        self.assertEqual(self.o["link"], "https://a.example/x?y=1")
        self.assertEqual(self.o["shared"], {"link": "https://example.com/banana-bread/"})

    def test_shared_text_becomes_a_recipe(self):
        self.assertEqual((self.o["textTitle"], self.o["textIngs"], self.o["imported"]), ("Banana Bread", 2, True))
        self.assertIsNone(self.o["nothing"])
        self.assertIsNone(self.o["tooShort"])

    def test_scan_tidying(self):
        self.assertEqual(self.o["tidy"], "Cream the butter and the sugar until it is light and fluffy, then add eggs.\n\n2 cups flour")


if __name__ == "__main__":
    unittest.main()
