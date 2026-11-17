"""The admin's recipe collection: duplicates, what changed between versions, the backup file (web/js/adminrecipes.js)."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SCRIPT = r"""
import { normTitle, findDuplicates, diffRecipe, backupFile } from './web/js/adminrecipes.js';
const ing = (q, u, item) => [q, '', u, item, ''];
const soup = [ing('1', 'lb', 'beef'), ing('2', 'cup', 'onion'), ing('1', '', 'carrot'), ing('4', 'cup', 'beef broth'), ing('1', 'tsp', 'salt')];
const items = [
  { id: 'a', title: 'Beef Stew', ings: soup },
  { id: 'b', title: 'Beef stew (my version)', ings: [...soup.slice(0, 4), ing('1', 'tsp', 'pepper')] },
  { id: 'c', title: 'Hearty beef stew', ings: soup },                         // other name, same ingredients
  { id: 'd', title: 'Beef Stew', ings: [ing('1', 'lb', 'tofu'), ing('1', 'cup', 'rice')] },   // same name, another dish
  { id: 'e', title: 'Beef Stew', ings: soup, source: 'a' },                   // a restaurant copy of a: expected
  { id: 'f', title: 'Pancakes', ings: [ing('1', 'cup', 'flour'), ing('1', '', 'egg')] },
];
const out = {
  titles: ['The Best Beef Stew!', 'Beef Stew (my version)', 'Beef stew #2', 'Chicken & Dumplings', 'Beef Stew copy'].map(normTitle),
  groups: findDuplicates(items).map((g) => g.map((x) => x.id).sort()),
  diff: diffRecipe({ title: 'Soup', categories: ['Soups'], body: { yq: '6', yu: 'servings', ings: soup, dir: 'Brown.\nSimmer.' } },
                   { title: 'Beef Soup', categories: ['Soups', 'Mains'], body: { yq: '8', yu: 'servings', ings: [...soup.slice(1), ing('1', 'cup', 'corn')], dir: 'Brown well.\nSimmer.' } }),
  same: diffRecipe({ title: 'A', body: {} }, { title: 'A', body: {} }),
  backup: backupFile([{ id: 'r1', title: 'Soup', scope: 'restaurant', status: 'approved', owner_id: 'u1', restaurant_id: 'x', source_recipe_id: 'r0', body: { dir: 'Go' } }],
    { u1: { name: 'Joe', email: 'joe@x.test' } }, [{ id: 'x', name: 'Maple' }], new Date('2026-11-17T00:00:00Z')),
};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
class AdminRecipesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        run = subprocess.run(["node", "--input-type=module", "-e", SCRIPT], cwd=ROOT, capture_output=True, text=True, timeout=60)
        if run.returncode:
            raise RuntimeError(run.stderr)
        cls.o = json.loads(run.stdout)

    def test_titles_are_folded_for_comparing(self):
        self.assertEqual(self.o["titles"], ["best beef stew", "beef stew", "beef stew", "chicken and dumplings", "beef stew"])

    def test_duplicates_are_grouped_but_not_copies_or_other_dishes(self):
        self.assertEqual(self.o["groups"], [["a", "b", "c"]])     # d is another dish; e is a's restaurant copy; f is alone

    def test_what_changed_between_versions(self):
        d = self.o["diff"]
        self.assertIn("Renamed from “Soup” to “Beef Soup”", d)
        self.assertIn("Categories: Soups, Mains (was Soups)", d)
        self.assertIn("Makes 8 servings (was 6 servings)", d)
        self.assertIn("Added: 1 cup corn", d)
        self.assertIn("Removed: 1 lb beef", d)
        self.assertIn("Method: 1 step reworded", d)
        self.assertEqual(self.o["same"], ["Small changes"])

    def test_backup_file(self):
        b = self.o["backup"]
        self.assertEqual((b["app"], b["count"], b["exported_at"]), ("jones-ridge-recipes-backup", 1, "2026-11-17T00:00:00.000Z"))
        r = b["recipes"][0]
        self.assertEqual((r["owner"]["name"], r["owner"]["email"], r["restaurant"]["name"], r["copied_from"], r["body"]["dir"]),
                         ("Joe", "joe@x.test", "Maple", "r0", "Go"))


if __name__ == "__main__":
    unittest.main()
