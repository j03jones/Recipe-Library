"""Polishing the published library (tools/polish_library.py): titles, misspellings, glued words, wrapped
ingredient lines, filing uncategorized recipes and hiding copies."""
import unittest

from tools import polish_library as P

# a tiny library where "pepper" and "sauce" are common words, so "peppersauce" is two words glued together
WORDS = [["x", "T", [], "", "", "", [["1", "", "tsp", "pepper", ""]], "pepper sauce " * 400, []]]


class Polish(unittest.TestCase):
    def setUp(self):
        self.p = P.Polisher(WORDS)

    def test_titles(self):
        self.assertEqual(self.p.title("Amish Sugar Cookies  **"), "Amish Sugar Cookies")
        self.assertEqual(self.p.title("Arroz con Pollo #2"), "Arroz con Pollo")
        self.assertEqual(self.p.title("Chicken Noodle Soup 2"), "Chicken Noodle Soup")
        self.assertEqual(self.p.title("Dhal Recipe <T>"), "Dhal Recipe")
        self.assertEqual(self.p.title("Asparagus W/ Cashews"), "Asparagus with Cashews")
        self.assertEqual(self.p.title("7-Up Cake"), "7-Up Cake")                       # a number that belongs

    def test_words(self):
        self.assertEqual(self.p.fix_words("Coarsley chop the parsely untill fine", "t"), "Coarsely chop the parsley until fine")
        self.assertEqual(self.p.fix_words("Add hot peppersauce.", "t"), "Add hot pepper sauce.")
        self.assertEqual(self.p.fix_words("Add the pepper.", "t"), "Add the pepper.")          # nothing to fix

    def test_wrapped_ingredient_lines(self):
        out = self.p.ingredients([
            ["1", "", "cup", "unsalted butter, at room", ""], ["", "", "", "Temperature", ""],
            ["1", "", "", "rack of lamb, cut", ""], ["", "", "", "Into 8 chops", ""],
            ["1", "", "tsp", "baking soda", ""], ["", "", "", "Sliced almonds", ""],          # a real ingredient: kept
        ])
        self.assertEqual([i[3] for i in out], ["unsalted butter, at room temperature", "rack of lamb, cut into 8 chops",
                                                "baking soda", "Sliced almonds"])

    def test_filing(self):
        row = lambda title, items: ["x", title, ["Uncategorized"], "", "", "", [["1", "", "", i, ""] for i in items], "", []]
        self.assertEqual(self.p.file_uncategorized(row("Gravlax", ["salmon fillet", "salt", "dill"])),
                         P.categories.in_display_order(["Seafood", "Main Dishes"]))   # its main fish
        self.assertEqual(self.p.file_uncategorized(row("Grandma's Babka", ["butter", "flour", "sugar"])), ["Desserts"])
        self.assertEqual(self.p.file_uncategorized(row("Tea Smoke Mix", ["tea leaves", "rice"])), ["Uncategorized"])   # no good guess
        self.assertEqual(self.p.file_uncategorized(["x", "T", ["Soups & Stews"], "", "", "", [], "", []]), ["Soups & Stews"])

    def test_copies(self):
        method = "Simmer the beets with the stock and cabbage for an hour, then stir in the dill and sour cream. " * 3
        ings = [["1", "", "lb", n, ""] for n in ("beets", "cabbage", "beef stock", "dill", "sour cream", "carrots")]
        rows = [["a1", "Borsch", ["Soups & Stews"], "", "", "", [list(i) for i in ings], method, ["Soups"]],
                ["b2", "Hearty Russian Beet Soup", ["Soups & Stews"], "", "", "", [list(i) for i in ings], method, []],
                ["c3", "Lemon Bars", ["Desserts"], "", "", "", [["1", "", "cup", "flour", ""]], "Bake.", []]]
        groups = P.mark_duplicates(rows, {"a1", "b2"}, self.p)
        self.assertEqual(groups, 1)
        self.assertEqual(rows[0][8], ["Soups", "duplicate"])        # the copy with the less telling title is hidden
        self.assertEqual(rows[1][8], ["Soups"])                     # the keeper gets its labels
        self.assertEqual(rows[2][8], [])


if __name__ == "__main__":
    unittest.main()
