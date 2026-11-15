"""Breaking a method into steps and finding each step's ingredients (web/js/steps.js, in Node)."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SCRIPT = r"""
import * as S from './web/js/steps.js';
const long = 'Preheat the oven to 350 deg. F. Cream the butter and brown sugar until fluffy. Beat in the eggs one at a time. '
  + 'Sift the flour with 1 tsp. baking soda (or use self-rising flour. It works too.) and fold it in gently. '
  + 'Spoon into the pan and bake 30 minutes. Cool on a rack for ten minutes before turning out . Serve warm with cream.';
const ings = [['Butter, softened'], ['Brown sugar, packed'], ['Eggs'], ['All-purpose flour'], ['Baking soda'], ['Heavy cream'], ['Salt']]
  .map(([item]) => ({ item }));
const steps = S.splitSteps(long);
console.log(JSON.stringify({
  short: S.splitSteps('Mix.\n\nBake.'),
  steps,
  caps: S.splitSteps('PREHEAT OVEN TO 350 DEG F. MIX THE FLOUR AND SUGAR. BAKE FOR 20 MINUTES UNTIL GOLDEN AND SERVE.'),
  numbered: S.splitSteps('1. Mix.\n2) Bake.'),
  uses: steps.map((s) => S.ingredientsIn(s, ings).map((i) => ings[i].item)),
  voice: ['Next', 'okay next step', 'go back', 'say that again', 'start the timer', 'what do I need', 'the bowl is warm'].map(S.voiceCommand),
  keys: [S.keywords('Onion, finely chopped'), S.keywords('2 cups all-purpose flour (sifted)'), S.keywords('Salt & pepper to taste')],
}));
"""


@unittest.skipUnless(shutil.which("node"), "needs Node")
class Steps(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        res = subprocess.run(["node", "--input-type=module", "-e", SCRIPT], cwd=ROOT, capture_output=True, text=True, timeout=60)
        if res.returncode:
            raise AssertionError(res.stderr)
        cls.o = json.loads(res.stdout)

    def test_short_lines_stay_as_written(self):
        self.assertEqual(self.o["short"], ["Mix.", "Bake."])
        self.assertEqual(self.o["numbered"], ["Mix.", "Bake."])

    def test_long_paragraph_is_split_at_sentence_ends(self):
        steps = self.o["steps"]
        self.assertGreater(len(steps), 1)
        self.assertEqual(" ".join(steps).replace("  ", " "), " ".join(steps))
        self.assertTrue(all(len(s) < 300 for s in steps))
        self.assertTrue(any("350 deg. F. Cream" in s for s in steps))           # "deg. F." is not a sentence end
        self.assertTrue(any("(or use self-rising flour. It works too.)" in s for s in steps))   # never inside brackets
        self.assertEqual(steps[-1], "Serve warm with cream.")                    # MealMaster's lone " . " is a break

    def test_capitals_become_sentences(self):
        self.assertTrue(self.o["caps"][0].startswith("Preheat oven to 350 deg F. Mix the flour and sugar."))

    def test_ingredients_found_in_steps(self):
        found = {i for step in self.o["uses"] for i in step}
        self.assertTrue({"Butter, softened", "Brown sugar, packed", "Eggs", "All-purpose flour", "Baking soda", "Heavy cream"} <= found)
        self.assertNotIn("Salt", found)

    def test_voice_commands(self):
        self.assertEqual(self.o["voice"], ["next", "next", "back", "repeat", "timer", "ingredients", None])

    def test_keywords(self):
        self.assertEqual(self.o["keys"], [["onion"], ["flour"], ["salt", "pepper"]])


if __name__ == "__main__":
    unittest.main()
