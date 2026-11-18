"""Supplier price lists (Sysco, SGC, Ben E. Keith, ...) into the price book (web/js/supplier.js, in Node)."""
import json
import shutil
import subprocess
import tempfile
import zipfile
from xml.sax.saxutils import escape
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
PACKS += [{"packsize": t} for t in ("15/DZ", "9/.5 GAL", "1/4/1 LT", "12/2.4 0Z", "8 / 2 LB", "1 / 1 ROLL", "4/10# AVG")]
DESCS = ["CHEESE CHEDDAR SHRD MILD YELLOW", "OIL CANOLA FRY CLEAR", "CHICKEN BREAST BNLS SKLS 6 OZ", "BUTTER SOLID UNSALTED AA",
         "SAUCE BBQ HICKORY", "CHEESE CREAM LOAF", "BEEF GROUND 80/20 FINE", "TORTILLA FLOUR 12IN", "BREAD CRUMB PANKO",
         "PEANUT BUTTER CREAMY", "PEPPER BLACK GROUND TABLE", "POTATO SWEET FRESH", "ONION GREEN", "JUICE LEMON",
         "SYS CLS CHEESE AMERICAN SLICED", "IQF CORN KERNEL", "DONUT GLAZED YEAST", "CORN ON COB FRZN", "WIDGET MYSTERY",
         "PICKLE DILL HAMBURGER SMOOTH", "VINEGAR RED WINE", "SYRUP RASPBERRY FLAVOR", "PEPPER JALAPENO GREEN BUSHEL",
         "MILK BUTTERMILK CULTURED", "BASE BEEF FLAVORED PASTE", "Oil Canola Olive Blend 90/10", "Seasoning Dill Weed"]


DATES = ["11/17/2026", "11/17/26", "2026-11-17", "Nov 17, 2026", "November 7, 2026", "17-Nov-26", "46343", "13/45/2026", "soon"]
MERGE = [{"butter": {"p": 3, "per": "lb", "at": "2026-11-10"}, "milk": {"p": 6, "per": "gallon", "at": "2026-10-01"}, "egg": {"p": 0.2, "per": "each"}},
         {"butter": {"p": 2, "per": "lb", "at": "2026-11-01"}, "milk": {"p": 7, "per": "gallon", "at": "2026-11-01"}, "egg": {"p": 0.3, "per": "each", "at": "2026-11-01"}}]

# what a restaurant's costing sheet calls things, for matching an order to it
OWN = [["Butter Solid Unsalted", ["butter", "sour cream"]], ["Bun Hamburger 4.25in W/shine", ["hamburger bun", "bread"]],
       ["Pork Belly Skinless Cryovac", ["pork belly", "pork"]], ["Cheese Mont Jack Sliced", ["monterey jack cheese", "cheese"]],
       ["French Fries Tin Roof", ["french fries"]], ["Pickle Dill Slice Smooth", ["dill"]]]


def write_xlsx(path, rows):
    """A small Excel workbook like a distributor's order export: shared strings, numbers, one sheet."""
    strings, index = [], {}
    def ref(c, r):
        name = ""
        c += 1
        while c:
            c, rem = divmod(c - 1, 26)
            name = chr(65 + rem) + name
        return f"{name}{r}"
    body = []
    for r, row in enumerate(rows, 1):
        cells = []
        for c, v in enumerate(row):
            if v == "":
                continue
            if isinstance(v, (int, float)):
                cells.append(f'<c r="{ref(c, r)}"><v>{v}</v></c>')
            else:
                if v not in index:
                    index[v] = len(strings)
                    strings.append(v)
                cells.append(f'<c r="{ref(c, r)}" t="s"><v>{index[v]}</v></c>')
        body.append(f'<row r="{r}">{"".join(cells)}</row>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        z.writestr("xl/workbook.xml", f'<?xml version="1.0"?><workbook {ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Order" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr("xl/sharedStrings.xml", f'<?xml version="1.0"?><sst {ns}>' + "".join(f"<si><t>{escape(x)}</t></si>" for x in strings) + "</sst>")
        z.writestr("xl/worksheets/sheet1.xml", f'<?xml version="1.0"?><worksheet {ns}><sheetData>{"".join(body)}</sheetData></worksheet>')


# a Ben E. Keith order export (.xlsx): Each = Y is a price for one unit; catch-weight meat at its price per pound,
# which the line total gives away ($2.00 a pound, 33 lb shipped)
BEK_ORDER = [["Item#", "Pack / Size", "Brand", "Item Name", "Manufacturer Id", "", "Ordered", "Each", "Price", "Deviated Price", "Confirmed", "Total Price", "Status"],
             ["400001", "1 / 30 LB", "Test Pork", "Pork Belly Skinless Cryovac", "1", "Refrigeration.", 1, "N", "$2.00", "N", 1, "$66.00", "Filled"],
             ["400002", "4 / 5 LB", "Test Dairy", "Sour Cream Cultured", "2", "Refrigeration.", 1, "Y", "$7.50", "N", 1, "$7.50", "Filled"],
             ["400003", "2 / 5 LB", "Test Farms", "Cheese Cheddar Jack Shred Fcy", "3", "Refrigeration.", 2, "N", 25.0, "N", 2, 50.0, "Filled"],
             ["400004", "6 / 1 GAL", "Test Oil", "Oil Canola Olive Blend 90/10", "4", "Dry.", 1, "N", "$108.00", "N", 1, "$108.00", "Filled"]]


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class SupplierPriceLists(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        files = [["sysco", str(FIX / "sysco_order_guide.csv")], ["bek", str(FIX / "bek_order_guide.csv")],
                 ["sgc", str(FIX / "sgc_invoice.txt")],
                 # a file read with its description column chosen by hand (SGC file, "Item Number" taken as the name)
                 ["remapped", str(FIX / "sgc_invoice.txt"), {"description": 0}],
                 ["bek_history", str(FIX / "bek_history_list.csv")], ["sgc_history", str(FIX / "sgc_history.csv")],
                 ["sysco_history", str(FIX / "sysco_purchase_history.csv")], ["sysco_perlb", str(FIX / "sysco_per_lb_flag.csv")]]
        cls.tmp = tempfile.TemporaryDirectory()
        order = Path(cls.tmp.name) / "Order 0001.xlsx"
        write_xlsx(order, BEK_ORDER)
        files.append(["bek_order", str(order)])
        files.append(["invoice", str(FIX / "sysco_invoice_text.txt"), None, {"invoice": True}])
        files.append(["dated", str(FIX / "dated_history.csv")])
        # a price typed by hand on 11/10 is newer than the history's 11/01 onion: it is not ticked
        files.append(["dated_book", str(FIX / "dated_history.csv"), None, {"book": {"onion": {"p": 1, "per": "lb", "at": "2026-11-10"}}}])
        # matched to a restaurant's costing sheet, with a choice remembered from an earlier import
        files.append(["bek_sheet", str(FIX / "bek_history_list.csv"), None,
                      {"ingredients": ["butter", "hamburger bun", "dill pickle", "pork belly"], "matches": {"film 18x2000 clear wrap": "plastic wrap"}}])
        proc = subprocess.run(["node", str(ROOT / "tools" / "supplier_js.mjs")], capture_output=True, text=True,
                              input=json.dumps({"files": files, "packs": PACKS, "descs": DESCS, "own": OWN, "dates": DATES, "merge": MERGE}))
        if proc.returncode != 0:
            raise AssertionError(proc.stderr)
        cls.out = json.loads(proc.stdout)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

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
        # shapes seen in real exports
        for text, value in {"15/DZ": ["n", 180], "9/.5 GAL": ["ml", 17034], "1/4/1 LT": ["ml", 4000], "12/2.4 0Z": ["g", 816],
                            "8 / 2 LB": ["g", 7257], "1 / 1 ROLL": ["n", 1], "4/10# AVG": ["g", 18144]}.items():
            self.assertEqual(got[json.dumps({"packsize": text}, separators=(",", ":"))], value, text)
        self.assertIsNone(got['{"packsize":""}'])

    def test_descriptions_match_foods(self):
        want = {"CHEESE CHEDDAR SHRD MILD YELLOW": "cheddar cheese", "OIL CANOLA FRY CLEAR": "canola oil",
                "CHICKEN BREAST BNLS SKLS 6 OZ": "chicken breast", "BUTTER SOLID UNSALTED AA": "unsalted butter",
                "SAUCE BBQ HICKORY": "barbecue sauce", "CHEESE CREAM LOAF": "cream cheese", "BEEF GROUND 80/20 FINE": "ground beef",
                "TORTILLA FLOUR 12IN": "tortilla", "BREAD CRUMB PANKO": "breadcrumb", "PEANUT BUTTER CREAMY": "peanut butter",
                "PEPPER BLACK GROUND TABLE": "black pepper", "POTATO SWEET FRESH": "sweet potato", "ONION GREEN": "green onion",
                "JUICE LEMON": "lemon juice", "SYS CLS CHEESE AMERICAN SLICED": "cheese", "IQF CORN KERNEL": "corn",
                "DONUT GLAZED YEAST": "", "CORN ON COB FRZN": "corn", "WIDGET MYSTERY": "",
                # the first word is the item: a pickle is not dill, red wine vinegar is not red wine
                "PICKLE DILL HAMBURGER SMOOTH": "", "VINEGAR RED WINE": "vinegar", "SYRUP RASPBERRY FLAVOR": "",
                "PEPPER JALAPENO GREEN BUSHEL": "jalapeno pepper", "MILK BUTTERMILK CULTURED": "buttermilk",
                "BASE BEEF FLAVORED PASTE": "", "Oil Canola Olive Blend 90/10": "canola oil", "Seasoning Dill Weed": "dill weed"}
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


    def test_ben_e_keith_history_list(self):
        rows = self.rows("bek_history")
        self.assertEqual(rows["Butter Solid Unsalted"][2:4], [2.0, "lb"])                       # 36 x 1 lb, $72
        # Each = Y: the price is for one unit of the pack, not the case
        self.assertEqual(rows["Sour Cream Cultured"][2:4], [1.5, "lb"])                         # one 5 lb tub, $7.50
        self.assertEqual(rows["Milk Whole 3.25%"][2:4], [6.0, "gallon"])                       # one gallon, $6
        self.assertEqual(rows["Milk Buttermilk 3.25%"][2:5], [8.0, "gallon", "buttermilk"])     # 64 fluid oz, $4
        self.assertEqual(rows["Milk Buttermilk 3.25%"][8], "each unit")
        self.assertEqual(rows["Pickle Dill Slice Smooth 3/16"][4:6], ["", "dill pickle"])      # not "dill"
        self.assertEqual(rows["Bun Hamburger 4.25in W/shine"][5], "hamburger bun")
        self.assertEqual(rows["Pork Belly Skinless Cryovac"][6], "no price")
        self.assertEqual(rows["Film 18x2000 Clear Wrap"][2:4], [30.0, "each"])

    def test_sgc_history(self):
        f = self.out["files"]["sgc_history"]
        rows = self.rows("sgc_history")
        self.assertEqual(len(f["rows"]), 8, "a line listed twice is shown once")
        # catch weight: $4.00 for 40 lb of beef would be 10 cents a pound, so it is the price per pound
        self.assertEqual(rows["BEEF GROUND BULK FRESH 80/20 FINE"][2:5] + [rows["BEEF GROUND BULK FRESH 80/20 FINE"][8]],
                         [4.0, "lb", "ground beef", "catch weight"])
        self.assertEqual(rows["EGG LARGE GRADE A USDA"][2:4], [0.1, "each"])                   # 15 dozen, $18
        self.assertEqual(rows["MILK BUTTERMILK CULTURED"][2:4], [8.0, "gallon"])               # 9 half gallons, $36
        self.assertEqual(rows["SYRUP RUBY RED GRAPEFRUIT"][2:4], [37.8541, "gallon"])          # 4 liters, $40
        self.assertEqual(rows["SPICE CHIVES DRIED LRG BTL"][2:5], [66.6667, "lb", "chive"])    # 12 x 2.4 oz, $120
        self.assertEqual(rows["PEPPER JALAPENO GREEN BUSHEL"][4], "jalapeno pepper")
        self.assertEqual(rows["VINEGAR RED WINE"][4], "vinegar")
        self.assertEqual(rows["SYRUP RASPBERRY FLAVOR"][4:6], ["", "raspberry syrup"])

    def test_sysco_purchase_history_has_no_prices(self):
        f = self.out["files"]["sysco_history"]
        self.assertTrue(f["typed"])
        self.assertTrue(f["noPrices"], "the file is flagged so the review can say to export prices")
        self.assertEqual(self.rows("sysco_history")["Bean Black Turtle Dried"][4], "black bean")

    def test_sysco_per_lb_flag(self):
        rows = self.rows("sysco_perlb")
        self.assertEqual(rows["Beef Ground Fine 73% Lean Bulk Chubs"][2:4], [3.5, "lb"])       # Per Lb = Y: the price is per pound
        self.assertEqual(rows["Bean Black Turtle Dried"][2:4], [1.2, "lb"])                    # Per Lb = N: a case of 20 lb

    def test_excel_order_with_line_totals(self):
        rows = self.rows("bek_order")
        self.assertEqual(len(rows), 4)
        # $2.00 but $66.00 for one case: the price is per pound (33 lb)
        self.assertEqual(rows["Pork Belly Skinless Cryovac"][2:4] + [rows["Pork Belly Skinless Cryovac"][8]], [2.0, "lb", "catch weight"])
        self.assertEqual(rows["Sour Cream Cultured"][2:4], [1.5, "lb"])
        self.assertEqual(rows["Cheese Cheddar Jack Shred Fcy"][2:5], [2.5, "lb", "cheddar cheese"])   # numbers, not text, in the sheet
        self.assertEqual(rows["Oil Canola Olive Blend 90/10"][2:5], [18.0, "gallon", "canola oil"])

    def test_matching_the_costing_sheet(self):
        # a restaurant's own ingredient names are used first
        self.assertEqual(self.out["own"], {"Butter Solid Unsalted": "butter", "Bun Hamburger 4.25in W/shine": "hamburger bun",
                                           "Pork Belly Skinless Cryovac": "pork belly", "Cheese Mont Jack Sliced": "monterey jack cheese",
                                           "French Fries Tin Roof": "french fry", "Pickle Dill Slice Smooth": ""})
        rows = self.rows("bek_sheet")
        self.assertEqual(rows["Butter Solid Unsalted"][4], "butter")
        self.assertTrue(rows["Butter Solid Unsalted"][9], "marked as on the costing sheet")
        self.assertEqual(rows["Bun Hamburger 4.25in W/shine"][4], "hamburger bun")
        self.assertEqual(rows["Pickle Dill Slice Smooth 3/16"][4], "dill pickle")
        # a choice made in an earlier import is used again
        self.assertEqual(rows["Film 18x2000 Clear Wrap"][4], "plastic wrap")
        self.assertTrue(rows["Film 18x2000 Clear Wrap"][10])


    def test_dates(self):
        self.assertEqual(self.out["dates"], {"11/17/2026": "2026-11-17", "11/17/26": "2026-11-17", "2026-11-17": "2026-11-17",
                                             "Nov 17, 2026": "2026-11-17", "November 7, 2026": "2026-11-07", "17-Nov-26": "2026-11-17",
                                             "46343": "2026-11-17", "13/45/2026": "", "soon": ""})

    def test_newest_price_wins(self):
        f = self.out["files"]["dated"]
        self.assertEqual(f["date"], "2026-11-01", "the file's date is its latest order date")
        # the same butter on two dates: the later one is ticked, whatever it costs
        rows = f["rows"]
        self.assertEqual([r[2] for r in rows if r[1] == "Butter Solid Unsalted" and r[7]], [2.2222])
        self.assertEqual(f["prices"]["butter"]["at"] if "butter" in f["prices"] else f["prices"]["unsalted butter"]["at"], "2026-11-01")
        # two onions: the more recent (11/01, $0.60/lb) over the cheaper but older (10/15, $0.56/lb)
        self.assertEqual(f["prices"]["onion"], {"p": 0.6, "per": "lb", "src": "Test #100009", "at": "2026-11-01"})
        # a saved price newer than the file's is kept: that food is not ticked
        self.assertNotIn("onion", self.out["files"]["dated_book"]["prices"])
        # saving: an older price never replaces a newer one; one with no date replaces one with a date only when it has none
        merged = self.out["merge"]
        self.assertEqual(merged["items"]["butter"]["p"], 3)
        self.assertEqual(merged["items"]["milk"]["p"], 7)
        self.assertEqual(merged["items"]["egg"]["p"], 0.3)
        self.assertEqual((merged["added"], merged["kept"]), (2, ["butter"]))

    def test_pdf_invoice_lines(self):
        f = self.out["files"]["invoice"]
        self.assertEqual((f["supplier"], f["date"]), ("Sysco", "2026-11-12"))
        rows = self.rows("invoice")
        self.assertEqual(len(rows), 5, "only the product lines: not the subtotal, surcharge, tax, total or remit-to")
        self.assertEqual(rows["SYS CLS CHEESE AMERICAN YEL LOAF"][0], "1234567")
        self.assertEqual(rows["SYS CLS CHEESE AMERICAN YEL LOAF"][2:4], [2.909, "lb"])            # 6 x 5 lb, $87.27
        beef = rows["FIRE RIVER BEEF GROUND 80/20 FINE"]
        self.assertEqual(beef[2:5] + [beef[8]], [3.39, "lb", "ground beef", "catch weight"])   # 41.2 lb at $3.39, $139.67 for 2 cases
        self.assertEqual(rows["WHLFCLS BUTTER SOLID UNSALTED"][2:5], [2.1972, "lb", "unsalted butter"])   # brand first, then the item
        self.assertEqual(rows["WHLFARM EGG SHELL LARGE GRADE AA"][2:5], [0.2292, "each", "egg"])          # 15 dozen, $41.25
        self.assertEqual(rows["SYS CLS MILK WHOLE"][2:5], [7.6, "gallon", "milk"])
        self.assertEqual(f["prices"]["milk"]["at"], "2026-11-12", "dated by the invoice")


if __name__ == "__main__":
    unittest.main()
