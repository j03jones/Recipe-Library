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
    tests/                    unit tests (unittest)
    samples/sample.mmf        small hand-made MealMaster sample

## What the parser handles (seen in real archives)

- Start markers `MMMMM----- Recipe via Meal-Master`, `---------- Recipe via Meal-Master`,
  and `----- Now You're Cooking! ... [Meal-Master Export Format]`; end markers `MMMMM` and `-----`
- Group headings (`-----FILLING-----`, `MMMMM-----GLAZE-----`)
- Two ingredients per line (right-hand field starts at column 41)
- Wrapped items: `- more words`, `-- more words`, and mid-word `-xyz` continuations
- Unit codes, including the nonstandard `x`/`ea` (no unit), `ga` (gallon), `pg` (package)
- Mixed text encodings (UTF-8, then Windows-1252, then Latin-1) and CRLF line endings

## Known limits

- MealMaster itself dropped a character where it wrapped some long items (e.g. "temp" became
  "t" + "-mp"), so those words come out misspelled ("tmp"). The lost letter can't be recovered.
- Older exports wrap long right-hand items onto a plain line with no dash; those fragments
  (e.g. "Into eighths") become separate ingredient lines instead of being merged.
- Ranges like "2-3" are kept as text and are not scaled.

## Accounts and the hosted database (v0.10)

The phone app can sign in to a Supabase project (see `supabase/README.md`): private account recipes, a
Community list that the administrator approves, and restaurant collections that are visible only while the
restaurant's plan is active. Connection details are in `web/js/config.js` (publishable key only). Test the
screens with `python tools/e2e_cloud.py` (uses a fake in-memory server) and the database rules with
`bash supabase/test/run.sh`.
