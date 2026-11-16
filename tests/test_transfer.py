"""Import and export formats: Paprika, Mealie, Tandoor, Cooklang, schema.org, pasted text (the web app's JS, run in Node)."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SCRIPT = r"""
import { importFile, toPaprika, toSchemaJson, toMarkdown, fromCooklang, fromPlainText, splitRecipes, docxToText, writeZip, readZip, crc32 } from './web/js/transfer.js';
import { linesFromItems } from './web/js/pdfread.js';
import { formatIngredient, formatYield } from './web/js/units.js';
const bytes = (o) => new TextEncoder().encode(typeof o === 'string' ? o : JSON.stringify(o));
const shape = (r) => ({ title: r.title, yield: formatYield(r), ings: r.ings.map((i) => (i.group ? `${i.group}: ` : '') + formatIngredient(i)),
  steps: r.dir ? r.dir.split('\n').length : 0, cats: r.categories, tags: r.tags, src: r.src });
const out = {};

const ck = fromCooklang(`>> servings: 4\n>> tags: dinner, quick\n-- a comment\nCrack @eggs{3} into a #bowl{} and add @milk{1%cup}. Cook ~{5%minutes}.\n\nAdd @salt and @flour{2%cups}.\n[- block comment -]`, 'my-eggs.cook');
out.cook = shape(ck); out.cookDir = ck.dir;
const txt = fromPlainText(`Banana Bread\nServes 8\nIngredients\n2 cups flour\n3 ripe bananas\nTopping:\n1/4 cup sugar\nDirections\n1. Mix.\n2. Bake 50 minutes.`);
out.text = shape(txt);
const loose = fromPlainText(`Toast\n2 slices bread\n1 tbsp butter\nToast the bread and butter it.`);
out.loose = shape(loose);

const pk = await toPaprika([ck, txt]);
const back = await importFile('x.paprikarecipes', pk);
out.paprika = { kind: back.kind, titles: back.recipes.map((r) => r.title), ings: back.recipes.map((r) => shape(r).ings) };
const names = readZip(pk).map((e) => e.name);
out.paprikaNames = names;
out.zipCrc = readZip(writeZip([{ name: 'a.txt', data: bytes('hello') }])).length;
out.crc = crc32(bytes('123456789'));

const sj = await importFile('a.json', bytes(toSchemaJson([ck, txt])));
out.schema = { kind: sj.kind, n: sj.recipes.length, ings: sj.recipes.map((r) => shape(r).ings) };
out.md = toMarkdown([txt]);

const mealie = { name: 'Soup', recipeYield: '4 servings', recipeIngredient: [{ quantity: 2, unit: { name: 'cup' }, food: { name: 'broth' }, note: '' }, { originalText: '1 onion, diced' }],
  recipeInstructions: [{ text: 'Boil.' }, { text: 'Serve.' }], tags: [{ name: 'easy' }], recipeCategory: [{ name: 'Soup' }], orgURL: 'https://x.com/soup' };
out.mealie = shape((await importFile('m.json', bytes(mealie))).recipes[0]);
const tandoor = { name: 'Pie', servings: 6, steps: [{ name: 'Crust', instruction: 'Roll.', ingredients: [{ amount: 2, unit: { name: 'cup' }, food: { name: 'flour' } }] },
  { name: 'Filling', instruction: 'Fill.\nBake.', ingredients: [{ amount: 3, unit: null, food: { name: 'apples' }, note: 'sliced' }] }], keywords: [{ name: 'dessert' }] };
out.tandoor = shape((await importFile('recipe.json', bytes(tandoor))).recipes[0]);
const nested = writeZip([{ name: 'Pie.zip', data: writeZip([{ name: 'recipe.json', data: bytes(tandoor) }]) }]);
const nz = await importFile('export.zip', nested);
out.nested = { kind: nz.kind, titles: nz.recipes.map((r) => r.title) };
const html = '<html><script type="application/ld+json">{"@graph":[{"@type":"Recipe","name":"Toast","recipeIngredient":["2 slices bread"],"recipeInstructions":"Toast it."}]}</script></html>';
out.html = shape((await importFile('p.html', bytes(html))).recipes[0]);
const errs = {};
for (const [k, n, b] of [['empty', 'e.txt', bytes('')], ['backup', 'b.json', bytes({ app: 'recipelib', records: [] })], ['badzip', 'z.zip', new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3])]]) {
  try { await importFile(n, b); errs[k] = 'no error'; } catch (e) { errs[k] = e.message; }
}
out.errs = errs;
// ingredient tables, as pasted from a web page or Word (cells separated by tabs) or written in Markdown
out.table = shape(fromPlainText(`Chicken Stock\nYield: 2 gallons\nIngredient\tMeasurement\nChicken bones\t5 lb\nWater\t2 gal\nBay leaves\t3\nInstructions\nRoast the bones until browned.\nCover with water and simmer 4 hours.`));
out.tableCols = shape(fromPlainText(`Biscuits\nIngredients\tAmount\tUnit\tNotes\nAll-purpose flour\t2\tcups\tsifted\nButter\t6\tTbsp\tcold\nButtermilk\t3/4\tcup\t\nCut the butter into the flour until it looks like coarse meal.\nBake at 450°F for 12 minutes.`));
out.tableNoHead = shape(fromPlainText(`Rub\n2 Tbsp\tpaprika\nkosher salt\t1 tsp\nMix and store.`));
out.markdown = shape(fromPlainText(`Salsa\n| Amount | Ingredient |\n|---|---|\n| 4 | tomatoes, diced |\n| 1/2 cup | onion |\nMix and chill.`));
out.numbered = shape(fromPlainText(`Pancakes\nIngredients\n1 cup flour\n2 eggs\n1. Whisk everything together until smooth.\n2. Cook on a hot griddle.`));
// several recipes in one text
const book = `My Cookbook\n\nTomato Soup\nServes 4\nA warm soup for winter days, simple and quick.\nIngredients\n4 tomatoes\n1 onion\nDirections\nSimmer everything.\nBlend until smooth\n\nGarlic Bread\nIngredients\n1 baguette\n2 cloves garlic\nDirections\nToast it.\n\nBrisket Rub\nIngredient\tAmount\nPaprika\t2 Tbsp\nSalt\t1 Tbsp\nMix.`;
out.split = splitRecipes(book).map((t) => t.split('\n')[0]);
out.splitOne = splitRecipes(`Toast\nIngredients\n2 slices bread\nDirections\nToast it.`).length;
out.splitPages = splitRecipes(`Soup\n1 onion\nSimmer.\n\fBread\n1 cup flour\nBake.`).map((t) => t.split('\n')[0]);
const many = await importFile('pasted.txt', bytes(book));
out.many = many.recipes.map(shape);
// a Word document: paragraphs, an ingredient table, a page break, a second recipe
const p = (t, extra = '') => `<w:p>${extra}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const row = (...cells) => `<w:tr>${cells.map((c) => `<w:tc><w:p><w:r><w:t>${c}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`;
const xml = `<?xml version="1.0"?><w:document><w:body>${p('Cajun Shrimp &amp; Grits')}${p('Serves 4')}
<w:tbl>${row('Ingredient', 'Quantity')}${row('Shrimp, peeled', '1 lb')}${row('Stone-ground grits', '1 cup')}</w:tbl>
${p('Method')}${p('Cook the grits slowly, stirring often.')}${p('Sear the shrimp and spoon over the grits.')}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>${p('Hush Puppies')}${p('Ingredients')}${p('1 cup cornmeal')}${p('1 egg')}${p('Directions')}${p('Fry by the spoonful at 350°F.')}</w:body></w:document>`;
out.docxText = docxToText(xml);
const docx = writeZip([{ name: '[Content_Types].xml', data: bytes('<Types/>') }, { name: 'word/document.xml', data: bytes(xml) }]);
const w = await importFile('Family recipes.docx', docx);
out.docx = { kind: w.kind, recipes: w.recipes.map(shape) };
try { await importFile('old.doc', bytes('x')); out.doc = 'no error'; } catch (e) { out.doc = e.message; }
// a PDF page's text items (what pdf.js gives) back into lines, with table columns as tabs
const item = (str, x, y, size = 12) => ({ str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5 });
out.pdfLines = linesFromItems([item('Corn Bread', 72, 700, 18), item('Ingredient', 72, 660), item('Amount', 300, 660),
  item('Cornmeal', 72, 645), item('1 cup', 300, 645), item('Buttermilk', 72, 630), item('1', 300, 630), item('cup', 309, 630),
  item('Bake at 425°F for', 72, 590), item('20 minutes.', 179, 590)]);
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
class TransferTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        run = subprocess.run(["node", "--input-type=module", "-e", SCRIPT], cwd=ROOT, capture_output=True, text=True, timeout=60)
        if run.returncode:
            raise RuntimeError(run.stderr)
        cls.o = json.loads(run.stdout)

    def test_cooklang(self):
        c = self.o["cook"]
        self.assertEqual(c["title"], "my eggs")
        self.assertEqual(c["yield"], "4 servings")
        self.assertEqual(c["ings"], ["3 eggs", "1 cup milk", "salt", "2 cups flour"])
        self.assertEqual(c["steps"], 2)
        self.assertEqual(c["tags"], ["dinner", "quick"])
        self.assertNotIn("@", self.o["cookDir"])
        self.assertIn("bowl", self.o["cookDir"])
        self.assertIn("5 minutes", self.o["cookDir"])

    def test_plain_text(self):
        t = self.o["text"]
        self.assertEqual((t["title"], t["yield"]), ("Banana Bread", "8 servings"))
        self.assertEqual(t["ings"], ["2 cups flour", "3 ripe bananas", "Topping: 1/4 cup sugar"])
        self.assertEqual(t["steps"], 2)
        self.assertEqual(self.o["loose"]["ings"], ["2 slices bread", "1 Tbsp butter"])
        self.assertEqual(self.o["loose"]["steps"], 1)

    def test_paprika_round_trip(self):
        p = self.o["paprika"]
        self.assertEqual(p["kind"], "Paprika")
        self.assertEqual(p["titles"], ["my eggs", "Banana Bread"])
        self.assertEqual(p["ings"][1], ["2 cups flour", "3 ripe bananas", "Topping: 1/4 cup sugar"])
        self.assertTrue(all(n.endswith(".paprikarecipe") for n in self.o["paprikaNames"]))

    def test_zip_and_crc(self):
        self.assertEqual(self.o["zipCrc"], 1)
        self.assertEqual(self.o["crc"], 0xCBF43926)

    def test_schema_org_round_trip_and_markdown(self):
        self.assertEqual(self.o["schema"]["n"], 2)
        self.assertEqual(self.o["schema"]["ings"][1], ["2 cups flour", "3 ripe bananas", "1/4 cup sugar"])
        self.assertIn("## Ingredients", self.o["md"])
        self.assertIn("1. Mix.", self.o["md"])
        self.assertEqual(self.o["html"]["ings"], ["2 slices bread"])

    def test_mealie_and_tandoor(self):
        m = self.o["mealie"]
        self.assertEqual(m["ings"], ["2 cups broth", "1 onion, diced"])
        self.assertEqual((m["yield"], m["cats"], m["tags"]), ("4 servings", ["Soup"], ["easy"]))
        self.assertEqual(m["src"]["url"], "https://x.com/soup")
        t = self.o["tandoor"]
        self.assertEqual(t["ings"], ["Crust: 2 cups flour", "Filling: 3 apples, sliced"])
        self.assertEqual((t["steps"], t["yield"], t["tags"]), (3, "6 servings", ["dessert"]))
        self.assertEqual(self.o["nested"], {"kind": "Tandoor", "titles": ["Pie"]})

    def test_problems_are_explained(self):
        e = self.o["errs"]
        self.assertIn("No recipe", e["empty"])
        self.assertIn("backup", e["backup"])
        self.assertNotEqual(e["badzip"], "no error")


    def test_ingredient_tables(self):
        t = self.o["table"]
        self.assertEqual((t["title"], t["yield"]), ("Chicken Stock", "2 gallons"))
        self.assertEqual(t["ings"], ["5 lb Chicken bones", "2 gallons Water", "3 Bay leaves"])   # no "Measurement" ingredient
        self.assertEqual(t["steps"], 2)
        c = self.o["tableCols"]
        self.assertEqual(c["ings"], ["2 cups All-purpose flour, sifted", "6 Tbsp Butter, cold", "3/4 cup Buttermilk"])
        self.assertEqual(c["steps"], 2)                       # the method after the table, with no heading
        self.assertEqual(self.o["tableNoHead"]["ings"], ["2 Tbsp paprika", "1 tsp kosher salt"])
        self.assertEqual(self.o["tableNoHead"]["steps"], 1)
        self.assertEqual(self.o["markdown"]["ings"], ["4 tomatoes, diced", "1/2 cup onion"])
        self.assertEqual(self.o["markdown"]["steps"], 1)
        self.assertEqual(self.o["numbered"]["ings"], ["1 cup flour", "2 eggs"])
        self.assertEqual(self.o["numbered"]["steps"], 2)

    def test_several_recipes_in_one_text(self):
        self.assertEqual(self.o["split"], ["Tomato Soup", "Garlic Bread", "Brisket Rub"])
        self.assertEqual(self.o["splitOne"], 1)
        self.assertEqual(self.o["splitPages"], ["Soup", "Bread"])
        soup, bread, rub = self.o["many"]
        self.assertEqual((soup["title"], soup["yield"], soup["ings"], soup["steps"]), ("Tomato Soup", "4 servings", ["4 tomatoes", "1 onion"], 3))   # its description leads the method
        self.assertEqual((bread["title"], bread["ings"]), ("Garlic Bread", ["1 baguette", "2 cloves garlic"]))
        self.assertEqual((rub["title"], rub["ings"], rub["steps"]), ("Brisket Rub", ["2 Tbsp Paprika", "1 Tbsp Salt"], 1))

    def test_word_documents(self):
        self.assertIn("Ingredient\tQuantity\nShrimp, peeled\t1 lb", self.o["docxText"])
        self.assertIn("\f", self.o["docxText"])
        w = self.o["docx"]
        self.assertEqual(w["kind"], "Word")
        shrimp, pups = w["recipes"]
        self.assertEqual((shrimp["title"], shrimp["yield"]), ("Cajun Shrimp & Grits", "4 servings"))
        self.assertEqual(shrimp["ings"], ["1 lb Shrimp, peeled", "1 cup Stone-ground grits"])
        self.assertEqual(shrimp["steps"], 2)
        self.assertEqual((pups["title"], pups["ings"], pups["steps"]), ("Hush Puppies", ["1 cup cornmeal", "1 egg"], 1))
        self.assertIn(".docx", self.o["doc"])

    def test_pdf_text_items_become_lines_and_columns(self):
        self.assertEqual(self.o["pdfLines"].split("\n"),
                         ["Corn Bread", "", "Ingredient\tAmount", "Cornmeal\t1 cup", "Buttermilk\t1 cup", "", "Bake at 425°F for 20 minutes."])


if __name__ == "__main__":
    unittest.main()
