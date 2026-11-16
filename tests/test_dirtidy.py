"""Library recipe methods shown without mailing-list sign-offs, CAPITALS and "500 DEG F" (web/js/dirtidy.js, in Node)."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

CASES = {
    "signoffs": "Cook the beef until tender.\n\nServes 4.\n\nPER SERVING: 445 calories, 38 g protein.\n\n"
                "From an article by Andrew Schloss in the San Francisco Chronicle, 11/18/92.\n\nPosted by Stephen Ceideberg; February 23 1993.",
    "show": "Boil, stirring often, 2 minutes. Best if used immediately.\n\nYield: about 3/4 cup\n\nESSENCE OF EMERIL SHOW#EE61",
    "mmconv": "DIRECTIONS  ------------------------------------------------------------ Beat egg yolks until thick. "
              "Bake the next morning at 300-F for 12 minutes. Source:  Pennsylvania Dutch Cook Book, 1936.\n\nConverted by MMCONV vers. 1.20",
    "shout": "COOK GROUND ROUND AND DRAIN. SPREAD 6 OZ. CHEESE ON THE MEAT. PLACE IN COLD OVEN AND HEAT TO 500 DEG F. "
             "BAKE UNTIL GOLDEN. PER SERVING: 530 CALORIES, 22g FAT, 839mg SODIUM.",
    "temps": "Bake at 375 degrees F. for 40 minutes. Roast at 400 F (200 C) gas mark 6. Heat to 350 degrees.",
    "keep": "Mix well.\n\nMakes a great gift.\n\nNOTE: Raisins can be added.",
    "emails": "Stir and serve.\n\nCopyright Whole Foods Market, 1995, wfm@wholefoods.com (http://www.wholefoods.com/wf.html)",
    "allbookkeeping": "Contributed to the echo by: Judy Haight Originally from: The New York Times Bread and Soup Cookbook. "
                      "Place the barley and the broth in a soup kettle and cook for a few minutes. Peel and chop the onion; "
                      "saute in butter until it is golden. Simmer the soup until the barley is soft.",
    "credittail": "Mix all ingredients and bake.\n\nSource: Arrowhead Mills tri-fold Reprinted by permission of Arrowhead Mills, Inc. "
                  "Electronic format courtesy of: Karen Mintzias",
}

SCRIPT = ("import { tidyDirections } from './web/js/dirtidy.js';"
          f"const c = {json.dumps(CASES)};"
          "console.log(JSON.stringify(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, tidyDirections(v)]))));")


@unittest.skipUnless(shutil.which("node"), "needs Node")
class TidyDirections(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        res = subprocess.run(["node", "--input-type=module", "-e", SCRIPT], cwd=ROOT, capture_output=True, text=True, timeout=60)
        if res.returncode:
            raise AssertionError(res.stderr)
        cls.o = json.loads(res.stdout)

    def test_signoffs_go_and_the_source_stays(self):
        o = self.o["signoffs"]
        self.assertEqual(o["text"], "Cook the beef until tender.")
        self.assertEqual(o["credits"], ["From an article by Andrew Schloss in the San Francisco Chronicle, 11/18/92"])

    def test_show_tags_and_yield(self):
        self.assertEqual(self.o["show"]["text"], "Boil, stirring often, 2 minutes. Best if used immediately.")

    def test_converter_stamps_and_separators(self):
        o = self.o["mmconv"]
        self.assertTrue(o["text"].startswith("Beat egg yolks until thick."), o["text"])
        self.assertIn("at 300°F for 12 minutes", o["text"])
        self.assertNotIn("MMCONV", o["text"])
        self.assertEqual(o["credits"], ["Pennsylvania Dutch Cook Book, 1936"])

    def test_capitals(self):
        t = self.o["shout"]["text"]
        self.assertTrue(t.startswith("Cook ground round and drain. Spread 6 oz. cheese on the meat."), t)
        self.assertIn("heat to 500°F. Bake until golden.", t)
        self.assertNotIn("CALORIES", t)

    def test_temperatures(self):
        self.assertEqual(self.o["temps"]["text"],
                         "Bake at 375°F for 40 minutes. Roast at 400°F (200°C) gas mark 6. Heat to 350°F.")

    def test_real_text_is_kept(self):
        self.assertEqual(self.o["keep"]["text"], "Mix well.\n\nMakes a great gift.\n\nNOTE: Raisins can be added.")
        self.assertIn("Place the barley", self.o["allbookkeeping"]["text"])    # a long paragraph is the recipe

    def test_no_emails_or_copyright(self):
        self.assertEqual(self.o["emails"]["text"], "Stir and serve.")

    def test_credit_without_its_bookkeeping(self):
        self.assertEqual(self.o["credittail"]["credits"], ["Arrowhead Mills tri-fold"])


if __name__ == "__main__":
    unittest.main()
