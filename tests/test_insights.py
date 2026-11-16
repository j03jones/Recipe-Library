"""Times, the vegetarian label, sorting and daily picks worked out from recipe text (web/js/insights.js, in Node)."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SCRIPT = r"""
import * as I from './web/js/insights.js';
const R = (dir, items = ['flour', 'sugar'], extra = {}) => ({ title: extra.title || 'Test', categories: extra.categories || [], dir,
  ings: items.map((item) => ({ item, raw: '' })) });
const out = {
  durations: I.durations('Simmer 10-12 minutes, then bake 1 1/2 hours. Rest five minutes. Cut 2 inch pieces.'),
  quick: I.estimateMinutes(R('Mix and chill. Serve.', ['yogurt', 'cucumber', 'dill', 'salt'])),
  baked: I.estimateMinutes(R('Bake at 350 for 45 minutes.', ['flour', 'sugar', 'eggs', 'butter'])),
  overnight: I.estimateMinutes(R('Soak the beans overnight. Simmer 2 hours.')),
  unknown: I.estimateMinutes(R('Bake until golden.')),
  stub: I.estimateMinutes({ stub: true, dir: '', ings: [] }),
  fmt: [25, 60, 75, 600, 2000].map(I.formatMinutes),
  veg: I.dietOf(R('', ['eggplant', 'butter beans', 'cheddar cheese'])),
  meat: I.dietOf(R('', ['onion', 'ground beef'])),
  fish: I.dietOf(R('', ['redfish fillets', 'butter'])),
  worcester: I.dietOf(R('', ['ketchup', 'Lea & Perrins'])),
  byTitle: I.dietOf(R('', ['onion', 'rice'], { title: 'Chicken Biriani' })),
  byGroup: I.dietOf(R('', ['kidney beans'], { categories: ['Beef'] })),
  sort: ['"21" Apple Pie', 'Apple Pie'].map(I.sortKey),
  pickSame: JSON.stringify(I.pick([1,2,3,4,5,6,7,8], 3, 20261115)) === JSON.stringify(I.pick([1,2,3,4,5,6,7,8], 3, 20261115)),
  pickDiffers: JSON.stringify(I.pick([1,2,3,4,5,6,7,8], 3, 20261115)) !== JSON.stringify(I.pick([1,2,3,4,5,6,7,8], 3, 20261116)),
  seed: I.daySeed(new Date(2026, 10, 15)),
  season: I.inSeason(new Date(2026, 10, 15)).title,
  uses: I.usesAny({ title: 'Spiced Pumpkin Bread', ings: [] }, I.inSeason(new Date(2026, 10, 15)).words),
};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(shutil.which("node"), "needs Node")
class Insights(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        res = subprocess.run(["node", "--input-type=module", "-e", SCRIPT], cwd=ROOT, capture_output=True, text=True, timeout=60)
        if res.returncode:
            raise AssertionError(res.stderr)
        cls.o = json.loads(res.stdout)

    def test_durations(self):
        self.assertEqual(self.o["durations"], [11, 90, 5])

    def test_estimates(self):
        o = self.o
        self.assertEqual(o["quick"], 10)          # no cooking: prep only
        self.assertEqual(o["baked"], 55)          # 10 prep + 45 baking
        self.assertEqual(o["overnight"], 610)     # an overnight soak counts
        self.assertIsNone(o["unknown"])           # bakes, but never says how long
        self.assertIsNone(o["stub"])

    def test_format(self):
        self.assertEqual(self.o["fmt"], ["25 min", "1 hr", "1 hr 15 min", "Overnight", "A day or more"])

    def test_vegetarian(self):
        o = self.o
        self.assertEqual(o["veg"], {"vegetarian": True})        # eggplant and butter beans aren't meat
        for k in ("meat", "fish", "worcester", "byTitle", "byGroup"):
            self.assertEqual(o[k], {"vegetarian": False}, k)

    def test_sorting_and_picks(self):
        self.assertEqual(self.o["sort"], ["21  Apple Pie", "Apple Pie"])
        self.assertTrue(self.o["pickSame"] and self.o["pickDiffers"])
        self.assertEqual(self.o["seed"], 20261115)

    def test_season(self):
        self.assertEqual(self.o["season"], "Fall flavors")
        self.assertTrue(self.o["uses"])


if __name__ == "__main__":
    unittest.main()
