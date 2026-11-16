"""The library clean-up (tools/clean_library.mjs): ingredient-list notes sorted out, broken recipes tagged."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SCRIPT = r"""
import { cleanIngredients, cleanRow } from './tools/clean_library.mjs';
const ings = cleanIngredients([
  ['1', '', 'tsp', 'To 2 ts chopped garlic', ''],
  ['6', '', 'slice', 'To 8 sl bacon, chopped', ''],
  ['', '', '', 'For the sauce:', ''],
  ['1', '', 'cup', 'tomato puree', ''],
  ['', '', '', 'Or 2 fresh tomatoes', ''],
  ['', '', '', '', ''],
  ['', '', '', 'Garnish:', ''],
  ['', '', '', 'parsley sprigs', ''],
  ['', '2-3', '', 'to 4 cloves garlic', ''],
]);
const broken = cleanRow(['x', 'Fig Appetizers', [], '', '', '', [], 'Wrap figs in ham.', []]);
const fine = cleanRow(['y', 'Toast', [], '', '', '', [['2', '', '', 'slices bread', '']],
  'Toast the bread until golden on both sides, then butter it.\n\nPosted by Jo Smith; Feb 1993.', ['quick']]);
console.log(JSON.stringify({ ings, broken: broken[8], fine: [fine[7], fine[8]] }));
"""


@unittest.skipUnless(shutil.which("node"), "needs Node")
class CleanLibrary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        res = subprocess.run(["node", "--input-type=module", "-e", SCRIPT], cwd=ROOT, capture_output=True, text=True, timeout=60)
        if res.returncode:
            raise AssertionError(res.stderr)
        cls.o = json.loads(res.stdout)

    def test_ingredient_notes(self):
        self.assertEqual(self.o["ings"], [
            ["", "1-2", "tsp", "chopped garlic", ""],                  # "1 tsp / To 2 ts garlic": one range
            ["", "6-8", "slice", "bacon, chopped", ""],
            ["1", "", "cup", "tomato puree, or 2 fresh tomatoes", "Sauce"],   # heading -> group; "Or ..." joins the line above
            ["", "", "", "parsley sprigs", "Garnish"],                  # empty line gone
            ["", "2-3", "", "to 4 cloves garlic", "Garnish"],           # already a range: left alone
        ])

    def test_broken_recipes_are_tagged(self):
        self.assertEqual(self.o["broken"], ["needs-work"])           # no ingredients

    def test_good_recipes_are_tidied_not_tagged(self):
        method, tags = self.o["fine"]
        self.assertEqual(method, "Toast the bread until golden on both sides, then butter it.")
        self.assertEqual(tags, ["quick"])


if __name__ == "__main__":
    unittest.main()
