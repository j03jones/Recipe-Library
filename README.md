# Recipe Library

A cross-platform recipe manager (Linux first, then Windows and macOS) that imports
MealMaster recipe files, lets you add and edit recipes, and scales them.

## Status

- [x] Core: MealMaster parser, SQLite library with search, scaling engine
- [x] Parser hardened against ~5,500 real recipes (11 archive files, all start/end markers matched)
- [x] Command-line front end for trying the core
- [x] GUI (PySide6): searchable library, recipe view with scaling, import dialog, add/edit form
- [ ] Linux packaging, then Windows and macOS builds

## Run the GUI

    python3 -m venv .venv && source .venv/bin/activate && pip install PySide6   # once
    python3 -m recipelib.gui                      # opens ~/.local/share/recipe-library/recipes.db
    python3 -m recipelib.gui --db /tmp/test.db    # or any library file you choose

## Build a standalone app (Linux)

    source .venv/bin/activate
    ./build_linux.sh
    dist/RecipeLibrary/RecipeLibrary

The whole `dist/RecipeLibrary` folder is the app; copy or zip it as a unit. PyInstaller cannot
cross-compile, so Windows and macOS builds must be made on those systems.

## Tidy categories

Imported MealMaster files come with hundreds of inconsistent labels (this library had 297). The
app can file every recipe under about 36 tidy groups instead (Desserts, Soups & Stews, Beef,
Italian, Light & Special Diets, ...), shown in sections in the category list. Your original labels
are never lost: they are kept as searchable tags and shown on each recipe.

    python3 -m recipelib --db <library.db> regroup --preview   # show the groups and counts, change nothing
    python3 -m recipelib --db <library.db> regroup             # apply (a backup copy is made first)
    python3 -m recipelib --db <library.db> regroup --restore   # put the original categories back

In the desktop app use Tools > Tidy categories / Restore original categories. New imports are
filed under the groups automatically once a library has been tidied.

The groups and the label-to-group mapping live in `recipelib/category_data.py`; edit that file to
rename groups or move a label, then run `regroup` again (it re-derives groups from the saved
original labels) and `python3 tools/gen_unitdata.py` plus `python3 tools/export_web.py` for the
phone app. Regrouping replaces categories you assigned by hand.

## Meal prep clients (v0.22)

A section for Jones Ridge Kitchen meal prep clients, built around the plans on jonesridgekitchen.com/meal-prep
(Family Table, Couple, Lean & Fresh) and the allergy list on its quote form. Needs `supabase/add_clients.sql`.

**For the chef** (Settings > Meal prep clients):
- A page per client: plan, dishes and servings per week, fee, allergies, foods to avoid, daily targets,
  private notes, and an emailed invitation.
- Plan a week from the library. Each dish is copied for the client as its name, a description, ingredient
  names, nutrition per serving, allergens and reheating notes: never the amounts or the method.
- Allergens are suggested from the ingredient names and must be checked by the chef (bought sauces and stocks
  are not checked). A dish with something the client is allergic to, or a food on their avoid list, is flagged,
  and sending it asks first.
- Send the menu with an answer-by time (Sunday 6 pm by default), see approvals and swap requests, swap a dish,
  finish the week. Save a week to reuse it for another client.
- Prep sheet: every approved dish across all clients for a week, added up, with what is still waiting, the fees
  and estimated groceries; one tap puts it all on the shopping list at the right scale.
- Container labels to print: dish, client, date made, use-by, reheating, allergens, and macros on Lean & Fresh.

**For the client** (the **My meals** tab, once they sign in with the email address the chef has):
- This week's menu with ingredients, nutrition and allergens; approve or ask to swap each dish (or approve all).
- What they have had, with ratings, favourites, and **Have this again**; ask for any dish.
- Their own allergies and foods to avoid, which the chef sees.

## Import and export formats (v0.20)

Settings → *Import and export recipes* (also linked from the Add page). Everything runs in the browser; nothing is uploaded.

- **In:** Paprika (`.paprikarecipes`), Mealie (JSON or its zip export), Tandoor (JSON or its nested zip export),
  Cooklang (`.cook`), any saved web page or JSON that carries schema.org recipe data, and plain pasted text.
  You see what was found and untick anything before it is added. Imports go to your account when you are signed in,
  otherwise to this device. Credit (author and link) is kept when the file has it.
- **Out:** a Paprika file, schema.org JSON (opens in Mealie, Tandoor and most tools), Markdown, and a printable book
  (contents page plus one recipe per page; choose *Save as PDF* in the print dialog). Choose your own recipes or your stars.
- The code is `web/js/transfer.js` (no screens, tested in Node by `tests/test_transfer.py`) and `web/js/transferui.js`.

## Nutrition and food cost (v0.19)

Every recipe page has two cards under the method.

**Nutrition.** Calories, fat, carbs, protein and sodium per serving (or for the whole recipe when no yield is
listed). Each ingredient line is matched to a table of about 280 common foods in `web/js/nutridata.js`
(per 100 g, with how much a cup or one piece weighs), turned into grams, and added up. The card says how
many ingredients it could count, and lists the ones it could not ("1 can", "to taste", a food not in the table)
instead of guessing. These are typical values, not label values. About 89% of the ingredient lines in the
built-in library are recognised and about 79% can be weighed.

**Food cost.** Type what you pay for an ingredient (by the pound, ounce, kilo, gram, gallon, quart, liter,
cup, each or dozen) right on the recipe. The price is remembered for that food in every recipe: set "butter"
once. You get the recipe total and the cost per serving at the scale on screen, then:

- **Target food cost %** (30 by default) gives the menu price that would hit it, rounded up to a quarter.
- **My menu price** (kept per recipe) shows the food cost % at that price and what is left per serving.

**Price book.** Settings > Food cost > Open the price book lists every saved price to edit or remove, with
**Export CSV** and **Import CSV** (`food, price, per`) for a supplier price list or a spreadsheet.

Prices, menu prices and the target are private to you, kept on the device and, signed in, saved with the account
alongside the meal plan (no database change needed). Shared recipe links do not carry any of it.

## Share by link and printable cards (v0.18)

On a recipe page, **Share link** makes a link that carries the recipe itself (compressed, after the `#`,
so it never goes to a server). Anyone can open it, signed in or not: they see the recipe, can scale it,
print it and **Save to my recipes**. It is a copy, so later edits do not reach links already sent, and
there is nothing to revoke or pay for. Short links also get a QR code for showing a client in person.

- A recipe imported from another website shares the **link to the original** instead, so the author keeps
  the visit and the credit (the same rule as the Community).
- Links are checked when opened: oversized or hand-made payloads are refused.
- **Print card** uses a clean layout (title, two-column ingredients, method, footer) and "Save as PDF" in
  the print dialog makes the PDF.

## Cook log, ratings and private notes (v0.17)

Every recipe page has a **Your notes** section: a 1 to 5 star rating, an **I made this** button that
keeps count and remembers the last date, and a box for private notes ("use less salt"). Only you see
them. Recipes you have made are listed, most recent first, under **Cooked** on the Starred page. Signed
in, all of it is saved with the account.

Titles typed in capitals in old collections ("PEPPERY RICE") are shown in title case on the site
(`recipelib/tidy.py`); the library file itself is not changed.

## The full library, on demand (v0.16)

The phone app ships with a built-in set of recipes (`web/data/recipes.json`) that works offline from the
first visit. The rest of the library is published next to it in small files the app fetches only when
needed, so the site can offer every recipe without a large first download:

- `web/data/more.json` names the current set.
- `web/data/more/<version>/index.json` has each extra recipe's title, categories and ingredient names.
  The app loads it in the background, so search and What can I make? cover every recipe.
- `web/data/more/<version>/<xx>.json` (256 files) hold the full recipes. One is fetched the first time a
  recipe in it is opened, planned or shopped for, and kept for offline use after that.

To publish a library:

    python3 tools/export_more.py --db ~/.local/share/recipe-library/recipes.db --refresh-core --duplicates likely

Recipes already in the built-in set are left out (`--duplicates likely` also leaves out the ones that are
probably the same as a built-in recipe). `--refresh-core` also gives built-in recipes the
library's corrected text where it has a same-titled copy, keeping their ids so stars and edits made on
phones stay attached. A browser set to save data skips the extra library.

## What can I make? and collections (v0.15)

- **What can I make?** (on the Recipes page) Type what is in your kitchen. You get the recipes you can
  make now, then the ones that need one or two more things, each with **Plan it** and **Shop for it**.
  An ingredient counts as on hand when every word you typed is in its name ("soy sauce" covers "Dark
  soy sauce", not "Soy milk"); basics like water, salt and flour can be assumed.
  From the command line: `python -m recipelib pantry chicken rice "soy sauce"`.
- **The shopping list knows your kitchen.** Things you listed under What can I make? are set aside under
  "things you already have" instead of being put on the list to buy (switch: "Leave out what I already have").
- **Add my meal plan** on the shopping list page brings in everything planned for the next 7 days in one tap.
- **Collections.** Your own named sets of recipes ("Weeknight dinners"). Use **Add to a collection** on a
  recipe; they are listed on the Starred page.
- Signed in, your kitchen list and collections are saved with the account alongside the plan and the list.

## Meal plan (v0.14)

The **Plan** tab in the phone app has two pages: **Meal plan** and **Shopping list**.

- **Meal plan.** A week at a time. Add recipes (search, or pick from your starred ones) or a note such
  as "Leftovers" to any day, or use **Add to meal plan** on a recipe page, which keeps the scale on screen.
- **Add this week to the shopping list** puts every planned recipe on the list. A recipe planned twice
  is bought for twice.
- **Shopping list** is grouped by aisle (Produce, Meat & Seafood, Dairy & Eggs, ...), and you can type in
  anything else you need ("paper towels"). The aisle table is in `recipelib/shopping.py`; after changing
  it run `python3 tools/gen_unitdata.py`.
- Signed in, the plan and the list are saved with the account and follow you between phone and computer
  (the latest change wins). This needs `supabase/add_planner.sql`. Signed out, they stay on the device.

## Shopping list, units and export (v0.13)

**Shopping list.** In the phone app, open a recipe and choose **Add to shopping list** (it is added at
the scale on screen). The **List** tab combines every recipe you added into one list to tick off, copy,
share or print. The same ingredient from different recipes becomes one line, and amounts are added up
when they are the same kind of measure (cups with tablespoons, pounds with ounces, grams with
kilograms). The list is kept on the device. From the command line:

    python -m recipelib shopping 3 17 42:2         # recipes 3 and 17, and recipe 42 doubled

**Units.** The recipe page has a **Units** choice: as written, US, or metric. Only like-for-like
conversions are made (cups to millilitres, ounces to grams), rounded to amounts you can measure; a cup
of flour is never turned into grams, because that depends on the ingredient.

    python -m recipelib show 12 --units metric     # also works with scale

**Ranges scale.** "2-3 cups" doubled is "4-6 cups". MealMaster's way of writing a range
(`1/2 c  To 1 c Dry sherry`) is read as one.

**Whole folders, and export.**

    python -m recipelib import ~/Recipes            # every .mmf / .mm / .txt file in the folder
    python -m recipelib export -o mine.mmf          # the whole library as a MealMaster file
    python -m recipelib export -o two.mmf 12 40     # or just some recipes

## Find duplicate recipes

Exact copies are skipped when you import. For near-duplicates (retitled or translated copies,
"&" vs "and", the same ingredients with reworded directions) use **Tools > Find duplicate recipes...**.
Groups are ranked *Same recipe*, *Probably the same recipe*, *Possibly the same recipe*; pick the copy
to keep and the others are merged into it (their categories and tags are added to the keeper).
A backup of your library is saved first, nothing is removed until you confirm, and "These are
different recipes" stops a group being flagged again.

From the command line:

    python -m recipelib duplicates                 # report only
    python -m recipelib duplicates --remove high   # merge the high-confidence groups (asks first, backs up)

For the phone app, `python tools/export_web.py --db <file> --drop-near-duplicates high` leaves them out.

## Recipes from other websites (with credit)

**Vegan recipes from Nora Cooks.** Tools > *Vegan recipes from Nora Cooks* (desktop) and the
*Vegetarian & Vegan* category or `#/links/noracooks` (phone) list recipe titles by Nora Taylor. Each
one opens on her website, so she keeps the visit and the credit. Only titles and links are built in, no
recipe content. The list lives in `recipelib/link_data.py`. Run `python3 tools/gen_unitdata.py` after
editing it.

**Import one recipe from a web page.** File > *Import recipe from a web page* (desktop),
`python -m recipelib import-url <link>`, or Add > *Import a recipe from a web page* (phone, signed in).
It reads the page's standard schema.org recipe block and takes only the title, ingredients, method and
yield. It also records **Recipe by**, **From** and the **link to the original**, which show on the
recipe, in copied or printed text, and in the editor. Imported recipes stay private: the phone app
won't share them to Community (`supabase/add_source_credit.sql` enforces this on the server too). The
phone reads pages through the `import-recipe` edge function (`supabase/functions/import-recipe`)
because browsers can't read other sites directly.

**Sharing recipes from other websites with the Community** (phone, signed in). An imported recipe's
full text never goes to Community, but it can be shared in two ways:
- *Share a link to the Community* sends a **link card**: just the name, "Recipe by …" and a button
  that opens the original page. No ingredients or method are copied (`share_link_to_community`).
- *Make my own version* starts a new recipe with the ingredients, an empty method and the original
  method folded away for reference. The student writes the steps in their own words. The app refuses
  methods that repeat too much of the original wording. The result carries an "Adapted from …" credit
  with the original link and can be shared normally.
Both go through admin approval, and the review card links to the original so you can compare.

## Invites (phone app)
- **Links and QR codes.** Admin tools > Invite someone > *Make a link & QR code*. The link opens
  `#/join/CODE`, a sign-up page with the code already filled in. *Show big QR* lets a whole class scan
  it from one screen. Restaurant owners get the same for their staff in Settings.
- **Email invites.** Type a name and email, then *Send invite email*. Supabase emails a button, and
  tapping it signs them in and asks them to choose a password.
- **Requests.** People without a code use Settings > *Request*. Requests appear in Admin tools with
  *Send student invite* / *Dismiss*.
  You get an email for each new request, with a button to Admin tools.
- **Open sign-up.** Admin tools > Sign-up has a switch that lets anyone create a free student
  account without a code. Turn it on when you're ready to open up.
- Signing in, signing up and arriving from an email link show a confirmation dialog. Password boxes
  have *Show*, and an unconfirmed email can have its confirmation sent again.

## Phone web app (offline)

`web/` is an installable web app (PWA) that runs on Android and iPhone, with the whole recipe
library built in and no connection needed after the first visit. It can search, scale, add, edit
and back up recipes. Your changes are stored on the phone, separately from the built-in library.

Made for use in a kitchen: category chips, a bottom tab bar, starred recipes (kept on the phone and
included in backups), tap-to-tick ingredients and numbered steps, and a scale bar pinned to the
bottom of each recipe with a servings stepper. On a computer it switches to a side menu, a card grid, and a two-column recipe page (scale bar and ingredients stay on screen while you read the method). Esc goes back and / jumps to search. Colours and tile emoji live in `web/style.css` and
`web/js/ui.js`.

    python3 tools/export_web.py --db ~/.local/share/recipe-library/recipes.db   # refresh the built-in recipes
    python3 -m http.server 8000 -d web                                         # try it at http://localhost:8000
    python3 tools/parity_check.py                                              # JS output == Python output
    python3 tools/e2e_web.py                                                   # click-through test in headless Chromium (needs Playwright)
    python3 tools/e2e_cloud.py                                                 # the signed-in screens, against a fake server

Both click-through tests run on every pull request (the `e2e` job). To run them yourself:
`pip install playwright && python -m playwright install chromium`.

`tools/export_web.py` also accepts `--mmf file1.mmf file2.mmf ...`. To publish: in the GitHub
repo, Settings > Pages > Source: "GitHub Actions". Every push to `main` that touches `web/` is
then deployed to `https://<user>.github.io/<repo>/`. Open that address on each phone while online,
then use Share > Add to Home Screen (iPhone) or the browser menu > Install app (Android).

Note: GitHub Pages on a free account requires a public repository, which also makes the bundled
recipes public. Private-repo Pages needs a paid plan. Check that you are comfortable sharing the
recipe collections before publishing.

## Automatic builds (GitHub Actions)

Every push to `main` runs the tests and builds Linux, Windows and macOS versions
(Actions tab > the run > Artifacts). To publish a release with downloadable files:

    git tag v0.5.0
    git push origin v0.5.0

The apps are unsigned, so Windows SmartScreen and macOS Gatekeeper will warn on first launch.

## Try the core (no dependencies beyond Python 3.9+)

    python3 -m unittest discover -s tests -t .
    python3 -m recipelib --db /tmp/test.db import samples/sample.mmf
    python3 -m recipelib --db /tmp/test.db list
    python3 -m recipelib --db /tmp/test.db scale 3 --servings 16

The real database defaults to `~/.local/share/recipe-library/recipes.db` on Linux.

## Layout

    recipelib/mealmaster.py   MealMaster parser
    recipelib/scaling.py      scaling by factor or target servings
    recipelib/db.py           SQLite storage, search, duplicate-aware import
    recipelib/units.py        unit names, fraction parsing/formatting
    recipelib/formatting.py   text rendering of ingredients and recipes
    recipelib/convert.py      US / metric conversion
    recipelib/shopping.py     combined shopping list
    tests/                    unit tests (unittest)
    samples/sample.mmf        small hand-made MealMaster sample

## What the parser handles (seen in real archives)

- Start markers `MMMMM----- Recipe via Meal-Master`, `---------- Recipe via Meal-Master`,
  and `----- Now You're Cooking! ... [Meal-Master Export Format]`; end markers `MMMMM` and `-----`
- Group headings (`-----FILLING-----`, `MMMMM-----GLAZE-----`)
- Two ingredients per line (right-hand field starts at column 41)
- Wrapped items: `- more words`, `-- more words`, and mid-word `-xyz` continuations
- Unit codes, including the nonstandard `x`/`ea` (no unit), `ga` (gallon), `pg` (package)
- Mixed text encodings and CRLF line endings: UTF-8, DOS (code page 437, what MealMaster itself wrote)
  and Windows-1252 are told apart from context, line by line, so "350°F", "½" and "sauté" survive
- Amount ranges written MealMaster style (`1/2 c  To 1 c Dry sherry`)
- Rules and dash-framed headings inside the directions (`~--------`, `---For the sauce:---`)

## Known limits

- MealMaster itself dropped a character where it wrapped an item that filled the line (e.g. "temp"
  became "t" + "-mp"), so those words come out misspelled ("tmp"). The lost letter can't be recovered,
  and when the cut fell between two words they can come out joined. Lines the person wrapped
  themselves (shorter than the field) are joined with a space.
- Older exports wrap long items onto plain lines with no dash. `recipelib/tidy.py` rejoins them when the
  wording shows a line cannot stand alone ("cut" + "Into cubes"), turns labels such as "Filling:" into
  sections, and moves stray steps and notes out of the ingredient list. It is cautious: a fragment that
  could be an ingredient in its own right ("Salt") is left where it is, so some wrapped lines remain.
  It runs on import and when the web library is exported; `python -m recipelib tidy --preview` shows
  what it would change in an existing library, and `python -m recipelib tidy` applies it (with a backup).
- Ranges like "2-3" scale, but are not converted between US and metric units.
- Recipes imported before v0.13 keep the text they were imported with. To pick up the importer fixes
  (degree signs, wrapped items, tidier directions), import the original files into a fresh library.

## Accounts and the hosted database (v0.10)

The phone app can sign in to a Supabase project (see `supabase/README.md`): private account recipes, a
Community list that the administrator approves, and restaurant collections that are visible only while the
restaurant's plan is active. Connection details are in `web/js/config.js` (publishable key only). Test the
screens with `python tools/e2e_cloud.py` (uses a fake in-memory server) and the database rules with
`bash supabase/test/run.sh`.


## Look and feel (v0.12)

The phone/desktop app now matches the Jones Ridge Kitchen website: ridge green headers with the animated
contour lines, rust and clay accents, Zilla Slab headings and Work Sans text (loaded from Google Fonts and
kept for offline use by the service worker). New in the app:

- **Cook mode**: one big step at a time, swipe or arrow keys, ingredients one tap away, screen stays on.
- **Timers**: steps that mention a time ("simmer 15 minutes", "two hours") get a start button; timers keep
  running while you browse, survive a reload, and ring with sound and vibration.
- Animations and feedback: the header lines draw themselves, lists glide in, stars pop, ticked ingredients
  strike through, a little confetti when a recipe is finished. All of it switches off for people who ask their
  device to reduce motion.

## License

Free for noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). Using this software
to make money needs a separate commercial license from the author: see [NOTICE.md](NOTICE.md), which also
explains what the license does not cover (the recipes, third-party code and fonts) and that versions up to
v0.17.0 were published under the GPL v3.
