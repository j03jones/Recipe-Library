"""The par list's sums (web/js/par.js): dates, pars by weekday, what to make, progress and cost."""
import json
import shutil
import subprocess
import unittest
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DAY = "2026-11-20"   # a Friday
WEEK = [2, 4, 4, 4, 4, 8, 8]
CASES = {
    "items": [
        {"id": "a", "recipe_id": "g1", "name": "  Pico  de gallo ", "unit": "qt", "per_batch": 4, "station": "Line", "pars": WEEK},
        {"id": "b", "name": "Lemons, cut", "unit": "", "pars": [10, "x", -3, 10, 10, 20, 20]},
        {"id": "c", "name": "Old soup", "active": False, "station": "Line", "pars": [1] * 7},
        {"id": "d", "name": "Aioli", "station": "Pantry", "pars": [3] * 7, "per_batch": 0},
        {"name": "   "},
        {"id": "f", "name": "Croutons", "active": False, "station": "pantry", "pars": [1] * 7},
    ],
    "day": DAY,
    "rows": [
        {"item_id": "a", "for_date": DAY, "par": 8, "on_hand": 3, "counted_at": "2026-11-19T22:40:00Z", "counted_name": "Casey",
         "made": 2, "made_log": [{"qty": 2, "by": "Sam", "at": "2026-11-20T15:00:00Z"}, {"qty": "junk"}]},
        {"item_id": "d", "for_date": DAY, "par": 3, "on_hand": 5, "counted_at": "2026-11-19T22:40:00Z", "made": 0, "made_log": []},
        {"item_id": "f", "for_date": DAY, "par": 1, "on_hand": None, "counted_at": "2026-11-19T22:40:00Z", "made": 1, "made_log": []},
        {"item_id": "b", "for_date": "2026-11-21", "par": 20, "on_hand": 1, "counted_at": "2026-11-20T22:00:00Z", "made": 0},
    ],
    "dates": [DAY, "2026-03-08", "2028-02-28", "2026-12-31"],
    "badDates": ["2026-02-30", "2026-1-5", "", "junk"],
    "clock": [[2026, 11, 20, 22], [2026, 11, 21, 1], [2026, 12, 31, 23], [2026, 11, 21, 5]],
    "makes": [[8, 3], [3, 5], [20, None], [0, None]],
    "recipe": ["g1", "Pico de gallo", [], "4", "cups", "", [["2", "", "lb", "Tomatoes", ""], ["1", "", "", "Onion", ""]], "", []],
    "prices": {"tomato": {"p": 3, "per": "lb"}},
    "typed": {"a": "3", "b": "", "d": "2,5", "f": "-1"},
}


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class ParList(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        proc = subprocess.run(["node", str(ROOT / "tools" / "par_js.mjs")], input=json.dumps(CASES),
                              capture_output=True, text=True, check=True)
        cls.out = json.loads(proc.stdout)

    def test_items_are_tidied(self):
        a, b, c, d, e, f = self.out["cleaned"]
        self.assertEqual((a["name"], a["unit"], a["per_batch"], a["pars"]), ("Pico de gallo", "qt", 4, WEEK))
        self.assertEqual((b["unit"], b["pars"], b["station"], b["active"]), ("batch", [10, 0, 0, 10, 10, 20, 20], "", True))
        self.assertFalse(c["active"])
        self.assertEqual(d["per_batch"], 1, "a batch always makes something")
        self.assertIsNone(e, "an item with no name is dropped")

    def test_dates(self):
        for iso, (dow, nxt, prev, ok) in zip(CASES["dates"], self.out["days"]):
            d = date.fromisoformat(iso)
            self.assertEqual(dow, (d.weekday() + 1) % 7, iso)   # 0 = Sunday
            self.assertEqual(nxt, (d + timedelta(days=1)).isoformat())
            self.assertEqual(prev, (d - timedelta(days=1)).isoformat())
            self.assertTrue(ok)
        self.assertEqual(self.out["bad"], [False] * 4)

    def test_the_count_at_close_is_for_tomorrow_even_after_midnight(self):
        self.assertEqual(self.out["countDate"], ["2026-11-21", "2026-11-21", "2027-01-01", "2026-11-22"])

    def test_what_to_make(self):
        self.assertEqual(self.out["toMake"], [5, 0, 20, 0])

    def test_the_day_list(self):
        self.assertEqual(self.out["list"], [
            ["Pico de gallo", 8, 3, True, 5, 2, 3, False, 1],   # par 8, 3 on hand: make 5, 2 made so far
            ["Aioli", 3, 5, True, 0, 0, 0, True, 0],             # over par: nothing to make
            ["Croutons", 1, None, True, 1, 1, 0, True, 0],       # turned off, but it was on this day's list
            ["Lemons, cut", 20, None, False, 20, 0, 20, False, 0],   # nobody counted: the whole of Friday's par
        ])
        self.assertEqual(self.out["summary"], {"items": 4, "counted": 3, "needed": 3, "done": 1, "started": True})
        self.assertEqual(self.out["stations"], [["Line", ["Pico de gallo"]], ["Pantry", ["Aioli", "Croutons"]], ["", ["Lemons, cut"]]])

    def test_cost(self):
        self.assertEqual(self.out["unit"], {"per": 1.5, "missing": 1})   # $6 of tomatoes a batch, 4 qt a batch
        self.assertEqual(self.out["noRecipe"], {"per": None, "missing": 0})
        self.assertEqual(self.out["cost"], {"made": 3, "planned": 7.5, "missing": 3})

    def test_the_count_to_save(self):
        self.assertEqual(self.out["payload"], {
            "counts": [{"item": "a", "on_hand": 3}, {"item": "b", "on_hand": None}, {"item": "c", "on_hand": None}, {"item": "d", "on_hand": 2.5}],
            "bad": ["Croutons"]})

    def test_amounts(self):
        self.assertEqual(self.out["fmt"], ["1.5", "2", "0.33", "—", "—"])


if __name__ == "__main__":
    unittest.main()
