"""Supplier price lists (Sysco, SGC, Ben E. Keith, ...) into the price book (web/js/supplier.js, in Node)."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures" / "suppliers"

PACKS = [
    {"packsize": "4/1 GAL"}, {"packsize": "1/50 LB"}, {"packsize": "50#"}, {"packsize": "2/5#"}, {"packsize": "6/#10"},
    {"packsize": "36 CT"}, {"packsize": "15 DZ"}, {"packsize": "200/1 OZ"}, {"packsize": "4/5 LB AVG"}, {"packsize": "1/40-45#"},
    {"packsize": "24/12 FL OZ"}, {"packsize": "1/4.5 KG"}, {"packsize": "3/1 QT"}, {"packsize": "6 #10 CAN"},
    {"pack": "4", "size": "1", "unit": "GAL"}, {"pack": "15", "size": "DZ"}, {"pack": "6", "size": "#10"}, {"pack": "4", "size": "5 LB"},
    {"packsize": "ASSORTED"}, {"packsize": ""},
]
DESCS = ["CHEESE CHEDDAR SHRD MILD YELLOW", "OIL CANOLA FRY CLEAR", "CHICKEN BREAST BNLS SKLS 6 OZ", "BUTTER SOLID UNSALTED AA",
         "SAUCE BBQ HICKORY", "CHEESE CREAM LOAF", "BEEF GROUND 80/20 FINE", "TORTILLA FLOUR 12IN", "BREAD CRUMB PANKO",
         "PEANUT BUTTER CREAMY", "PEPPER BLACK GROUND TABLE", "POTATO SWEET FRESH", "ONION GREEN", "JUICE LEMON",
         "SYS CLS CHEESE AMERICAN SLICED", "IQF CORN KERNEL", "DONUT GLAZED YEAST", "CORN ON COB FRZN", "WIDGET MYSTERY"]


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class SupplierPriceLists(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        files = [["sysco", str(FIX / "sysco_order_guide.csv")], ["bek", str(FIX / "bek_order_guide.csv")],
                 ["sgc", str(FIX / "sgc_invoice.txt")],
                 # a file read with its description column chosen by hand (SGC file, "Item Number" taken as the name)
                 ["remapped", str(FIX / "sgc_invoice.txt"), {"description": 0}]]
        proc = subprocess.run(["node", str(ROOT / "tools" / "supplier_js.mjs")], capture_output=True, text=True,
                              input=json.dumps({"files": files, "packs": PACKS, "descs": DESCS}))
        if proc.returncode != 0:
            raise AssertionError(proc.stderr)
        cls.out = json.loads(proc.stdout)

    def rows(self, name):
        return {r[1]: r for r in self.out["files"][name]["rows"]}

    def test_pack_sizes(self):
        got = self.out["packs"]
        want = {"4/1 GAL": ["ml", 15142], "1/50 LB": ["g", 22680], "50#": ["g", 22680], "2/5#": ["g", 4536], "6/#10": ["g", 18600],
                "36 CT": ["n", 36], "15 DZ": ["n", 180], "200/1 OZ": ["g", 5670], "4/5 LB AVG": ["g", 9072], "1/40-45#": ["g", 19278],
                "24/12 FL OZ": ["ml", 8517], "1/4.5 KG": ["g", 4500], "3/1 QT": ["ml", 2839], "6 #10 CAN": ["g", 18600]}
        for text, value in want.items():
            self.assertEqual(got[json.dumps({"packsize": text}, separators=(",", ":"))], value, text)
        self.assertEqual(got['{"pack":"4","size":"1","unit":"GAL"}'], ["ml", 15142])
        self.assertEqual(got['{"pack":"15","size":"DZ"}'], ["n", 180])
        self.assertEqual(got['{"pack":"6","size":"#10"}'], ["g", 18600])
        self.assertEqual(got['{"pack":"4","size":"5 LB"}'], ["g", 9072])
        self.assertIsNone(got['{"packsize":"ASSORTED"}'])
        self.assertIsNone(got['{"packsize":""}'])

    def test_descriptions_match_foods(self):
        want = {"CHEESE CHEDDAR SHRD MILD YELLOW": "cheddar cheese", "OIL CANOLA FRY CLEAR": "canola oil",
                "CHICKEN BREAST BNLS SKLS 6 OZ": "chicken breast", "BUTTER SOLID UNSALTED AA": "unsalted butter",
                "SAUCE BBQ HICKORY": "barbecue sauce", "CHEESE CREAM LOAF": "cream cheese", "BEEF GROUND 80/20 FINE": "ground beef",
                "TORTILLA FLOUR 12IN": "tortilla", "BREAD CRUMB PANKO": "breadcrumb", "PEANUT BUTTER CREAMY": "peanut butter",
                "PEPPER BLACK GROUND TABLE": "black pepper", "POTATO SWEET FRESH": "sweet potato", "ONION GREEN": "green onion",
                "JUICE LEMON": "lemon juice", "SYS CLS CHEESE AMERICAN SLICED": "cheese", "IQF CORN KERNEL": "corn",
                "DONUT GLAZED YEAST": "", "CORN ON COB FRZN": "corn", "WIDGET MYSTERY": ""}
        self.assertEqual(self.out["descs"], want)

    def test_sysco_order_guide(self):
        f = self.out["files"]["sysco"]
        self.assertEqual(f["supplier"], "Sysco")
        self.assertTrue(f["typed"], "the H/F/P record-type column is recognised and skipped")
        rows = self.rows("sysco")
        self.assertEqual(len(rows), 9, "only product rows")
        # 4 x 5 lb of cheddar at $52.80 a case is $2.64 a pound
        self.assertEqual(rows["CHEESE, CHEDDAR SHRD MILD YELLOW"][2:5], [2.64, "lb", "cheddar cheese"])
        # a price per pound column wins (catch-weight brisket)
        self.assertEqual(rows["BEEF BRISKET FLAT CHOICE"][2:4], [4.65, "lb"])
        # 15 dozen eggs: priced per egg
        self.assertEqual(rows["EGG SHELL LARGE GRADE A"][2:4], [0.2292, "each"])
        # two onions: the cheaper per pound is ticked, the other listed but not
        self.assertTrue(rows["ONION YELLOW JUMBO FRESH"][7])
        self.assertFalse(rows["ONION YELLOW MEDIUM"][7])
        # an unknown product is offered under its own name, unticked; a pack that can't be read is not priced
        self.assertEqual(rows["DONUT GLAZED YEAST"][4:8], ["", "donut glazed yeast", "no matching food", False])
        self.assertEqual(rows["WIDGET MYSTERY"][6], "pack size not understood")
        self.assertEqual(f["prices"]["cheddar cheese"], {"p": 2.64, "per": "lb", "src": "Test #4782109", "at": "2026-11-16"})
        self.assertEqual(f["prices"]["onion"]["src"], "Test #9100022")

    def test_ben_e_keith_order_guide(self):
        f = self.out["files"]["bek"]
        self.assertEqual(f["supplier"], "Ben E. Keith")
        rows = self.rows("bek")
        self.assertEqual(len(rows), 5, "title lines above the headings are skipped")
        self.assertEqual(rows["BUTTER SOLID UNSALTED AA"][2:5], [3.58, "lb", "unsalted butter"])     # 36 x 1 lb, $128.88
        self.assertEqual(rows["HALF & HALF ULTRA PAST"][2:4], [11.4, "gallon"])                      # 12 quarts, $34.20
        self.assertEqual(rows["TORTILLA FLOUR 12IN"][2:5], [0.315, "each", "tortilla"])               # 12 x 12 ct, $45.36
        self.assertEqual(rows["CATFISH FILLET 5-7 OZ"][4:6], ["", "catfish fillet"])

    def test_sgc_invoice_tab_separated(self):
        rows = self.rows("sgc")
        self.assertEqual(rows["CHICKEN BREAST BNLS SKLS 6 OZ"][2:5], [2.45, "lb", "chicken breast"])  # 4 x 10 lb, $98
        self.assertEqual(rows["CHEESE MOZZARELLA SHRD LMPS"][2:4], [3.15, "lb"])                    # no case price: the per lb one
        self.assertEqual(rows["LEMON JUICE"][2:4], [12.8, "gallon"])                                # 12 x 32 fl oz, $38.40

    def test_columns_can_be_chosen_by_hand(self):
        f = self.out["files"]["remapped"]
        self.assertEqual([r[1] for r in f["rows"]], ["SG7781", "SG7782", "SG7783", "SG7784"])


if __name__ == "__main__":
    unittest.main()
