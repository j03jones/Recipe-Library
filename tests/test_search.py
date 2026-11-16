"""Typo-forgiving search (web/js/search.js, in Node)."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SCRIPT = r"""
import * as S from './web/js/search.js';
const R = (title, items) => ({ title, ings: items.map((item) => ({ item })) });
const lib = [R('Chocolate Cake', ['flour', 'chocolate', 'sugar']), R('Chocolate Chip Cookies', ['chocolate chips', 'butter']),
  R('Broccoli Casserole', ['broccoli', 'cheese']), R('Chicken Soup', ['chicken', 'carrots']), R('Chicken Pie', ['chicken']),
  ...Array.from({ length: 30 }, (_, i) => R(`Roast Chicken ${i}`, ['chicken'])), R('Chiken Wings', ['chiken'])];
const v = S.vocabulary(lib);
console.log(JSON.stringify({
  d: [S.distance('cokie', 'cookie'), S.distance('ckoie', 'cokie'), S.distance('abc', 'xyz')],
  fixes: ['choclate cake', 'brocoli', 'chiken soup', 'chocolate cake', 'pie', 'xyzzyq'].map((q) => S.correct(q, v)),
}));
"""


@unittest.skipUnless(shutil.which("node"), "needs Node")
class Search(unittest.TestCase):
    def test_typos(self):
        res = subprocess.run(["node", "--input-type=module", "-e", SCRIPT], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        o = json.loads(res.stdout)
        self.assertEqual(o["d"], [1, 1, 3])
        # real words and short words stay; a slip the old recipes also made ("chiken") is still corrected
        self.assertEqual(o["fixes"], ["chocolate cake", "broccoli", "chicken soup", "", "", ""])


if __name__ == "__main__":
    unittest.main()


MERGE = r"""
import { merge3 } from './web/js/shopping.js';
const base = { items: [{ id: 'a', f: '1' }], extras: [{ id: 'x1', text: 'Milk' }, { id: 'x2', text: 'Eggs' }], done: [] };
const mine = { items: [{ id: 'a', f: '1' }, { id: 'b', f: '2' }], extras: [{ id: 'x1', text: 'Milk' }, { id: 'x2', text: 'Eggs' }], done: ['x1'] };
const theirs = { items: [{ id: 'a', f: '1' }], extras: [{ id: 'x1', text: 'Milk' }, { id: 'x3', text: 'Bread' }], done: ['x3'] };
console.log(JSON.stringify(merge3(base, mine, theirs)));
"""


@unittest.skipUnless(shutil.which("node"), "needs Node")
class HouseholdMerge(unittest.TestCase):
    def test_both_peoples_changes_survive(self):
        res = subprocess.run(["node", "--input-type=module", "-e", MERGE], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        m = json.loads(res.stdout)
        self.assertEqual([i["id"] for i in m["items"]], ["a", "b"])                    # I added b
        self.assertEqual([x["text"] for x in m["extras"]], ["Milk", "Bread"])          # they removed eggs, added bread
        self.assertEqual(sorted(m["done"]), ["x1", "x3"])                               # both ticks kept
