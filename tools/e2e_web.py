"""End-to-end check of the phone web app in a real (headless) browser, including offline use.

    python tools/e2e_web.py [screenshot_dir]

Needs Playwright with Chromium. Serves web/ itself on a free port. Expects the real recipe data
(web/data/recipes.json built by tools/export_web.py) because it looks recipes up by name.
"""
import asyncio
import json
import re
import os
import subprocess
import sys
import tempfile
from datetime import datetime
import time
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp())
SHOTS.mkdir(parents=True, exist_ok=True)
PORT = 8791
URL = f"http://127.0.0.1:{PORT}/"
errors, results = [], []
# how many recipes the app should show: the built-in set, plus the on-demand set once its index has loaded
# (built-in recipes tagged needs-work by tools/clean_library.mjs aren't listed)
CORE = sum(1 for r in json.loads((ROOT / "web" / "data" / "recipes.json").read_text(encoding="utf-8"))["recipes"]
           if not {"needs-work", "duplicate"} & set(r[8] if len(r) > 8 else []))
_more = ROOT / "web" / "data" / "more.json"
MORE = json.loads(_more.read_text(encoding="utf-8")) if _more.exists() else {"v": "", "count": 0}
TOTAL = f"{CORE + MORE['count']:,}"


async def whole_library(page):
    """Wait until the list counts every recipe (the on-demand index loads in the background)."""
    await page.wait_for_function(f"document.querySelector('.count')?.innerText.includes('{TOTAL} recipes')", timeout=30000)


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


async def search(page, text):
    await page.fill("input[type=search]", text)
    await page.wait_for_timeout(400)


async def main():
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", str(ROOT / "web")],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        return await run()
    finally:
        server.terminate()


async def run():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # the functional checks run with "reduce motion" on (no page transitions to wait for); one check below
        # turns motion back on to test the transitions themselves
        plain_new_context = b.new_context

        async def calm_context(*args, **kwargs):
            kwargs.setdefault("reduced_motion", "reduce")
            return await plain_new_context(*args, **kwargs)
        b.new_context = calm_context
        if os.environ.get("E2E_NOW"):
            # run as if it were this date (YYYY-MM-DDTHH:MM): the plan and list depend on today's weekday
            real_new_context = b.new_context

            async def new_context(*args, **kwargs):
                c = await real_new_context(*args, **kwargs)
                await c.clock.install(time=datetime.fromisoformat(os.environ["E2E_NOW"]))
                return c
            b.new_context = new_context
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, reduced_motion="no-preference",
                                  is_mobile=True, has_touch=True, accept_downloads=True)
        page = await ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        await page.goto(URL)
        await page.wait_for_selector(".rc")
        await whole_library(page)
        check("library loads with all recipes", f"{TOTAL} recipes" in await page.inner_text(".count"), await page.inner_text(".count"))
        check("rows do not overflow the screen", await page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
        await page.wait_for_function("navigator.serviceWorker.controller !== null", timeout=30000)
        cached = await page.evaluate("caches.keys().then(async ks => { const c = await caches.open(ks.find(k => !['recipelib-fonts', 'recipelib-more'].includes(k))); return (await c.keys()).length })")
        check("service worker cached app, fonts and data", cached >= 17, cached)
        check("heading font loaded", await page.evaluate("document.fonts.check('700 20px Poppins')"))

        # category chips: section, then group
        await page.click(".chips >> text=Course & type")
        names = await page.locator(".chips.groups .chip").count()
        check("section chip reveals its groups", names >= 8, names)
        await page.click(".chips.groups >> text=Soups & Stews")
        await page.wait_for_timeout(300)
        soups = await page.inner_text(".count")
        check("filter by a group", f" of {TOTAL}" in soups and not soups.startswith(TOTAL), soups)
        await page.click(".chips.groups >> text=Soups & Stews")  # tap again to clear
        await page.wait_for_timeout(300)
        check("tapping the group again clears it", f"{TOTAL} recipes" in await page.inner_text(".count"))
        await page.click(".chips >> text=All")
        await search(page, "penndutch")
        check("old label still searchable", f"of {TOTAL}" in await page.inner_text(".count"), await page.inner_text(".count"))
        await search(page, "zzzzqq")
        check("empty state offers a way out", await page.locator(".empty button:has-text('Clear search and filters')").count() == 1)
        await page.click(".empty button")
        await page.wait_for_timeout(300)
        check("clearing restores the library", f"{TOTAL} recipes" in await page.inner_text(".count"))
        await search(page, "garlic mushroom")
        check("search narrows results", f"of {TOTAL}" in await page.inner_text(".count"))

        # open a known recipe, tick things off, scale it
        await search(page, "Hearty Russian Beet Soup")
        await page.click(".rc >> nth=0")
        await page.wait_for_selector(".dock")
        check("recipe shows labels and original tags", "Original labels:" in await page.inner_text("#app") and await page.locator(".label:has-text('Soups')").count() == 1)
        check("tab bar hidden on recipe, dock shown", not await page.locator("#tabs").is_visible() and await page.locator(".dock").is_visible())
        check("directions become numbered steps", await page.locator("ol.steps li").count() >= 2)
        await page.click("ul.ing .tick >> nth=0")
        await page.click("ol.steps .tick >> nth=0")
        check("ingredients and steps can be ticked off", await page.locator(".tick[aria-pressed=true]").count() == 2)
        before = await page.inner_text("ul.ing")
        await page.click(".seg button:has-text('2×')")
        after = await page.inner_text("ul.ing")
        check("2x doubles amounts", "2 1/2 lb Lean beef" in before and "5 lb Lean beef" in after, after[:80])
        check("2x chip is highlighted", await page.locator(".seg button:has-text('2×')").get_attribute("aria-pressed") == "true")
        await page.click(".seg button:has-text('1×')")
        await page.fill("input[aria-label='Servings to make']", "12")
        await page.wait_for_timeout(150)
        s12 = await page.inner_text("ul.ing")
        check("servings box scales to 12", "3 3/4 lb Lean beef" in s12 and await page.input_value("input[aria-label='Multiplier']") == "1.5", s12[:60])
        await page.click("button[aria-label='More servings']")
        check("+ steps servings by one", await page.input_value("input[aria-label='Servings to make']") == "13")
        await page.click("button[aria-label='Fewer servings']")
        await page.click("button[aria-label='Fewer servings']")
        check("- steps servings by one", await page.input_value("input[aria-label='Servings to make']") == "11")

        # stars
        await page.click(".topbar .star")
        check("recipe can be starred", await page.locator(".topbar .star").get_attribute("aria-pressed") == "true")
        await page.goto(URL + "#/starred")
        await page.wait_for_selector(".rc")
        check("starred tab lists it", "1 starred" in await page.inner_text(".count"))
        await page.screenshot(path=str(SHOTS / "starred.png"))

        # offline from here on
        await ctx.set_offline(True)
        await page.goto(URL)
        await page.wait_for_selector(".rc", timeout=15000)
        await whole_library(page)      # the on-demand index was saved by the service worker too
        check("loads while offline", f"{TOTAL} recipes" in await page.inner_text(".count"))
        await search(page, "biscotti")
        check("search works offline", (await page.locator(".rc").count()) > 0)

        # add a new recipe
        await page.click("a[data-tab=new]")
        await page.wait_for_selector("input[aria-label=Title]")
        check("a skip link leads past the menu to the page", await page.locator("a.skip").count() == 1)
        await page.locator(".ing-row button.danger").first.click()
        check("removing the last ingredient row leaves an empty one to type in", await page.locator(".ing-row").count() == 1)
        await page.click(".formactions button:has-text('Save')")
        await page.wait_for_selector("#title-err:not([hidden])")
        check("saving without a title says so under the title",
              await page.get_attribute("input[aria-label=Title]", "aria-invalid") == "true" and "/new" in page.url)
        await page.fill("input[aria-label=Title]", "Test Chili")
        check("and the message goes once a title is typed", await page.locator("#title-err").is_hidden())
        await page.fill("input[aria-label=Categories]", "Soups, Test")
        await page.fill("input[aria-label=Yield]", "6 servings")
        r0 = page.locator(".ing-row").first
        await r0.locator("input.amt").fill("1½")
        await r0.locator("input.unit").fill("cups")
        await r0.locator("input.item").fill("Kidney beans")
        await page.click("button:has-text('+ Add ingredient')")
        r1 = page.locator(".ing-row").nth(1)
        await r1.locator("input.amt").fill("2")
        await r1.locator("input.unit").fill("Tbsp")
        await r1.locator("input.item").fill("Chili powder")
        await page.fill("textarea", "Simmer everything.\n\nServe hot.")
        await page.screenshot(path=str(SHOTS / "edit.png"), full_page=True)
        await page.click("button:has-text('Save')")
        await page.wait_for_selector("h1:has-text('Test Chili')")
        body = await page.inner_text("ul.ing")
        check("new recipe saved and normalised", "1 1/2 cups Kidney beans" in body and "2 Tbsp Chili powder" in body, body)
        await page.click(".seg button:has-text('2×')")
        body2 = await page.inner_text("ul.ing")
        check("new recipe scales (smart units)", "3 cups Kidney beans" in body2 and "1/4 cup Chili powder" in body2, body2)

        await page.goto(URL + "#/")
        await page.reload()
        await page.wait_for_selector(".rc")
        await search(page, "Test Chili")
        check("new recipe persists after reload", await page.locator(".rc:has-text('Test Chili')").count() == 1)
        check("new recipe is badged", await page.locator(".badge:has-text('Mine')").count() == 1)
        await page.click(".rows .star")   # star it too, so a star survives the removal test below

        # edit a built-in recipe, then revert
        await search(page, "Hearty Russian Beet Soup")
        await page.click(".rc >> nth=0")
        await page.click("a[aria-label='Edit recipe']")
        await page.wait_for_selector("input[aria-label=Title]")
        await page.fill("input[aria-label=Title]", "Hearty Russian Beet Soup EDITED")
        await page.click("button:has-text('Save')")
        await page.wait_for_selector("h1:has-text('EDITED')")
        await page.click("a[aria-label='Edit recipe']")
        await page.click("button:has-text('Revert to original')")
        await page.click("dialog button:has-text('Revert')")
        await page.wait_for_selector("h1:has-text('Hearty Russian Beet Soup')")
        check("edit then revert restores original", "EDITED" not in await page.inner_text("h1"))

        # remove a built-in recipe, restore it in settings
        await page.click("a[aria-label='Edit recipe']")
        await page.click("button:has-text('Remove from library')")
        await page.click("dialog button:has-text('Remove')")
        await page.wait_for_selector("input[type=search]")
        await search(page, "Hearty Russian Beet Soup")
        check("removed recipe disappears", await page.locator(".rc").count() == 0)
        await page.click("a[data-tab=settings]")
        await page.wait_for_selector("button:has-text('Restore removed')")
        await page.screenshot(path=str(SHOTS / "settings.png"), full_page=True)
        async with page.expect_download() as dl:
            await page.click("button:has-text('Export backup')")
        path = await (await dl.value).path()
        backup = json.load(open(path))
        check("backup contains my changes and stars", backup["app"] == "recipelib" and len(backup["records"]) >= 2 and len(backup.get("stars", [])) == 2,
              (len(backup.get("records", [])), backup.get("stars")))
        await page.click("button:has-text('Restore removed')")
        await page.click("a[data-tab=list]")
        await search(page, "Hearty Russian Beet Soup")
        check("restore brings it back", await page.locator(".rc").count() == 1)

        # import the backup into a fresh browser profile
        ctx2 = await b.new_context(viewport={"width": 390, "height": 844}, accept_downloads=True)
        pg2 = await ctx2.new_page()
        await pg2.goto(URL + "#/settings")
        await pg2.wait_for_selector("button:has-text('Import backup')")
        await pg2.set_input_files("input[type=file]", path)
        await pg2.wait_for_timeout(500)
        await pg2.goto(URL + "#/")
        await pg2.wait_for_selector(".rc")
        await pg2.fill("input[type=search]", "Test Chili")
        await pg2.wait_for_timeout(400)
        check("backup imports into a fresh device", await pg2.locator(".rc:has-text('Test Chili')").count() == 1)
        await pg2.goto(URL + "#/starred")
        await pg2.wait_for_selector(".rc")
        check("stars come back with the backup (removed recipe stays hidden)", "1 starred" in await pg2.inner_text(".count"))

        # ---- website look and the new kitchen features
        await page.goto(URL + "#/")
        await page.wait_for_selector(".band.hero .eyebrow")
        check("home page has the green header with contour lines", await page.locator(".band.hero svg.ridge .draw").count() == 1)
        check("signed-out visitors do not see the source chips", not await page.locator(".chips.src").is_visible())

        # ---- long methods become numbered steps, each with the amounts it uses
        await page.goto(URL + "#/r/6cd1288901")
        await page.wait_for_selector("ol.steps")
        check("a one-paragraph method is split into steps", await page.locator("ol.steps > li").count() >= 6)
        check("a step shows the amounts it uses", "1 tsp Salt" in await page.inner_text("ol.steps > li:nth-child(2) .uses"))
        check("recipe page shows an estimated time", "About" in await page.inner_text(".rmeta"))

        # ---- a link shared to the installed web app, and the scan button
        await page.goto(URL + "?title=Pie&url=" + "https%3A%2F%2Fexample.com%2Fapple-pie")
        await page.wait_for_selector("input[aria-label='Recipe page address']")
        check("a shared link opens the import page with the link filled in",
              await page.input_value("input[aria-label='Recipe page address']") == "https://example.com/apple-pie" and "?" not in page.url)
        check("the import page offers to scan a printed recipe", await page.locator("button:has-text('Take or choose a photo')").count() == 1)

        # ---- search forgives typos and remembers what you searched
        await page.goto(URL + "#/")
        await page.reload()
        await page.wait_for_selector("input[type=search]")
        await page.fill("input[type=search]", "choclate cake")
        await page.wait_for_timeout(1800)
        check("a typo still finds recipes", "chocolate cake" in (await page.inner_text(".didyoumean")).lower()
              and await page.locator(".rows .rc").count() > 0)
        await page.fill("input[type=search]", "")
        await page.wait_for_timeout(300)
        await page.click("input[type=search]")
        await page.wait_for_timeout(200)
        check("recent searches are offered", "choclate cake" in await page.inner_text(".chips.recent"))
        await page.click(".chips.recent button:has-text('choclate cake')")
        await page.wait_for_timeout(300)
        check("tapping a recent search runs it", await page.input_value("input[type=search]") == "choclate cake")
        await page.fill("input[type=search]", "")
        await page.wait_for_timeout(200)

        # ---- meal plan: drag a meal to another day
        await page.goto(URL + "#/")
        await page.evaluate("""() => { const d = new Date(); const iso = (x) => x.toISOString().slice(0, 10);
          const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
          localStorage.setItem('recipelib.plan', JSON.stringify({ at: Date.now(), days: { [iso(mon)]: [{ note: 'Leftovers' }] } })); }""")
        await page.goto(URL + "#/plan")
        await page.reload()
        await page.wait_for_selector(".planitem")
        first_day = await page.get_attribute(".planday:has(.planitem)", "data-date")
        box = await page.locator(".planitem").bounding_box()
        target = page.locator(".planday").nth(2)
        await target.scroll_into_view_if_needed()
        box = await page.locator(".planitem").bounding_box()
        tbox = await target.bounding_box()
        await page.mouse.move(box["x"] + 20, box["y"] + box["height"] / 2)
        await page.mouse.down()
        await page.mouse.move(box["x"] + 30, box["y"] + 30, steps=4)
        await page.mouse.move(tbox["x"] + 40, tbox["y"] + tbox["height"] / 2, steps=8)
        await page.mouse.up()
        await page.wait_for_timeout(300)
        moved_to = await page.get_attribute(".planday:has(.planitem)", "data-date")
        check("a meal can be dragged to another day", moved_to != first_day and moved_to == await target.get_attribute("data-date"), f"{first_day} -> {moved_to}")

        # ---- library methods without mailing-list sign-offs, CAPITALS or "250 deg F"
        await page.goto(URL + "#/r/c447fab046"); await page.wait_for_selector("ol.steps, .dir")
        method = await page.inner_text("#app")
        check("a library method drops its sign-off and keeps the source as a credit",
              "Posted by" not in method and "Source: A Taste of Quebec by Julian Armstrong" in await page.inner_text(".methodsource")
              and "250°F" in method, method[-300:])
        await page.goto(URL + "#/r/91b2d98d77"); await page.wait_for_selector(".rhead h1:has-text('Pizza Deluxe')")
        check("a recipe written in CAPITALS reads in normal sentences", "Cook ground round and drain" in await page.inner_text("#app"))
        check("and its ingredients aren't shouted either", "3 oz pepperoni" in await page.inner_text("ul.ing"))

        # ---- hands-free cook mode
        await page.goto(URL + "#/r/6cd1288901")
        await page.wait_for_selector(".cookbtn")
        await page.evaluate("window.__said = []; speechSynthesis.speak = (u) => window.__said.push(u.text); true")
        await page.click(".cookbtn")
        await page.click("button[aria-label='Read steps aloud']")
        check("reading aloud says the current step", "Over here" in (await page.evaluate("window.__said"))[-1])
        await page.click(".cook-foot .primary")
        check("reading aloud follows to the next step", "Sift the flour" in (await page.evaluate("window.__said"))[-1])
        await page.keyboard.press("Escape")

        # ---- page transitions (motion on): pages slide, and nothing errors when taps come quickly
        ctxM = await b.new_context(viewport={"width": 390, "height": 844}, reduced_motion="no-preference")
        m = await ctxM.new_page()
        m.on("pageerror", lambda e: errors.append(str(e)))
        m.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        await m.goto(URL + "#/")
        await m.wait_for_selector(".feed .fcard")
        await m.evaluate("window.__vt = 0; const real = document.startViewTransition.bind(document); document.startViewTransition = (cb) => { window.__vt++; return real(cb); }; true")
        await m.click(".feed .fcard")
        await m.wait_for_selector(".rhead h1")
        await m.go_back(); await m.go_forward(); await m.go_back()
        await m.wait_for_selector(".feed .fcard")
        check("page changes use view transitions", await m.evaluate("window.__vt") >= 2)
        await ctxM.close()

        # ---- the home feed, quick filters and estimated times (fresh page: earlier steps left a search typed in)
        await page.goto(URL + "#/")
        await page.reload()
        await page.wait_for_selector(".feed .fcard")
        shelves = await page.eval_on_selector_all(".shelf h2", "els => els.map(e => e.textContent)")
        check("home feed has its shelves", {"Ready in 30 minutes", "Meat-free mains", "Something sweet"} <= set(shelves), str(shelves))
        check("feed cards show a time", "min" in await page.inner_text(".shelf:has(h2:text('Ready in 30 minutes')) .fcard .fm"))
        await page.click(".shelf:has(h2:text('Ready in 30 minutes')) .seeall")
        await page.wait_for_timeout(300)
        check("See all turns on the Under 30 min filter", await page.get_attribute(".chips.quick .chip:has-text('Under 30 min')", "aria-pressed") == "true")
        check("the feed hides while filtering", await page.eval_on_selector(".feed", "e => e.hidden"))
        times = await page.eval_on_selector_all(".rows .rc .c", "els => els.slice(0, 20).map(e => e.textContent)")
        check("filtered rows are all quick", all("min" in t and "hr" not in t for t in times), str(times[:3]))
        await page.click(".chips.quick .chip:has-text('Under 30 min')")
        await page.click(".chips.quick .chip:has-text('Vegetarian')")
        await page.wait_for_timeout(300)
        check("Vegetarian filter labels every row", all("Vegetarian" in t for t in await page.eval_on_selector_all(".rows .rc .c", "els => els.slice(0, 20).map(e => e.textContent)")))
        await page.click(".chips.quick .chip:has-text('Vegetarian')")
        await page.wait_for_timeout(200)
        check("clearing filters brings the feed back", not await page.eval_on_selector(".feed", "e => e.hidden"))
        first = await page.eval_on_selector(".rows .rc .t", "e => e.textContent")
        check("titles with quotes don't jump to the top of the list", not first.startswith('"'), first)
        bg = await page.evaluate("getComputedStyle(document.querySelector('.band.hero')).backgroundColor")
        check("header uses the website's ridge green", bg == "rgb(35, 64, 47)", bg)

        await page.click("a[data-tab=new]")
        await page.wait_for_selector("input[aria-label=Title]")
        await page.fill("input[aria-label=Title]", "Timer Soup")
        r0 = page.locator(".ing-row").first
        await r0.locator("input.amt").fill("2")
        await r0.locator("input.unit").fill("cups")
        await r0.locator("input.item").fill("Stock")
        await page.fill("textarea", "Simmer for 10 minutes.\nChill two hours, then 30 seconds more.\nServe hot.")
        await page.click("button:has-text('Save')")
        await page.wait_for_selector("h1:has-text('Timer Soup')")
        check("steps that mention times get timer buttons", await page.locator(".tchip").count() == 3, str(await page.locator(".tchip").count()))
        await page.click(".tchip >> nth=0")
        await page.wait_for_selector("#timers .timer")
        check("tapping starts a countdown", "10 min" in await page.inner_text("#timers .timer") and ":" in await page.inner_text("#timers .tt"))
        await page.reload()
        await page.wait_for_selector("#timers .timer")
        check("a running timer survives a reload", await page.locator("#timers .timer").count() == 1)
        await page.click("#timers .plus")
        await page.click("#timers .x")
        check("timer can be dismissed", await page.locator("#timers .timer").count() == 0)

        await page.click(".cookbtn")
        await page.wait_for_selector(".cook")
        check("cook mode shows step 1 of 3", "step 1 of 3" in (await page.inner_text(".cook-n")).lower())
        await page.click(".cook-foot .primary")
        check("next step advances", "step 2 of 3" in (await page.inner_text(".cook-n")).lower())
        await page.keyboard.press("ArrowLeft")
        check("arrow keys move back", "step 1 of 3" in (await page.inner_text(".cook-n")).lower())
        await page.click(".cook button[aria-label='Show ingredients']")
        check("ingredients sheet lists the recipe", "Stock" in await page.inner_text(".cook-sheet"))
        await page.keyboard.press("Escape")
        check("Escape closes the sheet first", await page.locator(".cook-sheet").count() == 0 and await page.locator(".cook").count() == 1)
        await page.click(".cook-foot .primary"); await page.click(".cook-foot .primary"); await page.click(".cook-foot .primary")
        await page.wait_for_selector(".confetti", state="attached")
        check("finishing cook mode celebrates and closes", await page.locator(".cook").count() == 0 and "Plated" in await page.inner_text("#toast"))
        await page.click("button.tick >> nth=0")
        await page.click("ol.steps .tick >> nth=0"); await page.click("ol.steps .tick >> nth=1"); await page.click("ol.steps .tick >> nth=2")
        await page.wait_for_selector(".confetti", state="attached")
        check("ticking every step also celebrates", True)

        # a newly published version shows an "Update now" banner
        sw = ROOT / "web" / "sw.js"
        original = sw.read_text()
        try:
            await page.goto(URL + "#/")
            await page.wait_for_selector(".rc")
            sw.write_text(original.replace("const VERSION = 'dev'", "const VERSION = 'e2e-new'"))
            await page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
            await page.wait_for_selector(".updatebar", timeout=15000)
            check("new version shows an update banner", "Update now" in await page.inner_text(".updatebar"))
        finally:
            sw.write_text(original)

        # ---- meal plan, shopping list, What can I make?, collections and the on-demand library (a fresh device)
        ctx4 = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        p4 = await ctx4.new_page()
        p4.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        p4.on("pageerror", lambda e: errors.append(str(e)))
        await p4.goto(URL)
        await p4.wait_for_selector(".rc")
        await whole_library(p4)
        await p4.wait_for_function("navigator.serviceWorker.controller !== null", timeout=30000)

        async def plan_on(day, title):
            await p4.click(f".planday >> nth={day} >> .addday")
            await p4.fill("dialog.pickdialog input[type=search]", title)
            await p4.wait_for_timeout(250)
            await p4.click("dialog.pickdialog .picklist button >> nth=0")
            await p4.wait_for_timeout(200)

        await p4.click("a[data-tab=plan]")
        await p4.wait_for_selector(".planday")
        check("meal plan shows a week", await p4.locator(".planday").count() == 7)
        await plan_on(1, "Hearty Russian Beet Soup")
        await plan_on(3, "Hearty Russian Beet Soup")
        check("a planned recipe is listed on its day", "Beet Soup" in await p4.inner_text(".planday >> nth=1"))
        await p4.click(".planday >> nth=4 >> .addday")
        await p4.fill("dialog.pickdialog input[type=text]", "Leftovers")
        await p4.click("dialog.pickdialog form button")
        check("a note can be planned", "Leftovers" in await p4.inner_text(".planday >> nth=4"))
        check("no dialog is left open", await p4.locator("dialog[open]").count() == 0)
        await p4.screenshot(path=str(SHOTS / "plan.png"))

        await p4.click("button:has-text('Add this week to the shopping list')")
        await p4.wait_for_selector(".shoplist")
        check("the week goes to the shopping list, twice-planned counted twice", "×2" in await p4.inner_text(".shoprecipes"))
        check("the list is grouped by aisle", await p4.locator("h3.aisle").count() >= 3, await p4.locator("h3.aisle").count())
        check("the meal-plan button goes once the list matches", await p4.locator("button:has-text('Add my meal plan')").count() == 0)
        await p4.fill(".addextra input", "Paper towels")
        await p4.press(".addextra input", "Enter")
        check("a typed item is added", await p4.locator(".shoplist li.extra:has-text('Paper towels')").count() == 1)
        before = await p4.inner_text("[role=status]")
        await p4.click(".shoplist .tick >> nth=0")
        after = await p4.inner_text("[role=status]")
        check("ticking counts down", "still to get" in after and before != after, after)
        await p4.reload()
        await p4.wait_for_selector(".shoplist")
        check("the list survives a reload", "×2" in await p4.inner_text(".shoprecipes") and "still to get" in await p4.inner_text("[role=status]"))
        await p4.screenshot(path=str(SHOTS / "shopping.png"))

        await p4.goto(URL + "#/pantry")
        await p4.fill(".addextra input", "beets, cabbage, potatoes, onions, carrots, beef")
        await p4.press(".addextra input", "Enter")
        await p4.wait_for_selector("ul.rows li")
        status = await p4.inner_text("[role=status]")
        check("what can I make finds recipes", "make now" in status or "need one or two" in status, status)
        check("each result says what is missing", await p4.locator("ul.rows li .s:has-text('Needs'), ul.rows li .s:has-text('You have everything')").count() > 0)
        await p4.click(".rowacts button:has-text('Plan it') >> nth=0")
        await p4.click("dialog.pickdialog .picklist button >> nth=5")
        check("a result can be planned", "Planned for" in await p4.inner_text("#toast"))
        await p4.screenshot(path=str(SHOTS / "pantry.png"))
        await p4.goto(URL + "#/shop")
        await p4.wait_for_selector(".shoplist")
        check("the list sets aside what is already in the kitchen", await p4.locator(".havebox").count() == 1)
        check("and offers the newly planned recipe", await p4.locator("button:has-text('Add my meal plan')").count() == 1)

        await p4.goto(URL + "#/")
        await search(p4, "Hearty Russian Beet Soup")
        await p4.click(".rc >> nth=0")
        await p4.wait_for_selector(".dock")
        await p4.click("button:has-text('Add to a collection')")
        await p4.fill("dialog.pickdialog input[type=text]", "Soups I like")
        await p4.press("dialog.pickdialog input[type=text]", "Enter")
        await p4.click("dialog.pickdialog button:has-text('Done')")
        check("a recipe can be put in a new collection", await p4.locator("button:has-text('Collections (1)')").count() == 1)
        await p4.goto(URL + "#/starred")
        await p4.click(".collrow .chip:has-text('Soups I like')")
        await p4.wait_for_selector("ul.rows li")
        check("the collection lists it", "Soups I like" in await p4.inner_text("h1") and await p4.locator("ul.rows li").count() == 1)

        # cook log: rate it, mark it made, keep a private note
        await p4.goto(URL + "#/")
        await search(p4, "Hearty Russian Beet Soup")
        await p4.click(".rc >> nth=0")
        await p4.wait_for_selector(".mylog")
        await p4.click(".ratestar >> nth=3")
        check("a recipe can be rated", "4 of 5" in await p4.inner_text(".ratingrow"))
        await p4.click(".mylog button:has-text('I made this')")
        check("and marked as made", "Made once, last today" in await p4.inner_text(".mylog"))
        await p4.fill(".mylog textarea", "Use less salt next time")
        await p4.reload()
        await p4.wait_for_selector(".mylog")
        check("rating, cook log and note survive a reload",
              "4 of 5" in await p4.inner_text(".ratingrow") and "Made once" in await p4.inner_text(".mylog")
              and await p4.input_value(".mylog textarea") == "Use less salt next time")
        await p4.goto(URL + "#/starred")
        await p4.click(".collrow .chip:has-text('Cooked')")
        await p4.wait_for_selector("ul.rows li")
        check("the Cooked page lists it with its rating", "★★★★" in await p4.inner_text("ul.rows") and "Made once" in await p4.inner_text("ul.rows"))

        if MORE["count"]:
            index = json.loads((ROOT / "web" / "data" / "more" / MORE["v"] / "index.json").read_text(encoding="utf-8"))["recipes"]
            first = next(r for r in index if len(r[3]) >= 6)
            other = next(r for r in index if r[0][:2] != first[0][:2])      # in a file that is never fetched here
            await p4.goto(URL + f"#/r/{first[0]}")
            await p4.wait_for_selector(".dock")
            check("an on-demand recipe opens with its ingredients", await p4.locator("ul.ing li").count() >= len(first[3]),
                  await p4.locator("ul.ing li").count())
            await ctx4.set_offline(True)
            await p4.reload()
            await p4.wait_for_selector(".dock", timeout=15000)
            check("an opened on-demand recipe works offline", first[1] in await p4.inner_text("h1"))
            await p4.goto(URL + f"#/r/{other[0]}")
            await p4.wait_for_selector("button:has-text('Try again')", timeout=15000)
            check("an unopened one explains it needs a connection", "needs a connection" in await p4.inner_text("#app"))
            await ctx4.set_offline(False)

        # share a recipe as a link, open it on a device that has never seen it
        await page.goto(URL + "#/")
        await page.wait_for_selector(".rc")
        await search(page, "Hearty Russian Beet Soup")
        await page.click(".rc >> nth=0")
        await page.wait_for_selector("ul.ing li")
        await page.click("button:has-text('Share link')")
        await page.wait_for_selector("dialog.sharedialog input.link")
        link = await page.input_value("dialog.sharedialog input.link")
        check("share dialog gives a self-contained link", "#/s/" in link and link.startswith(URL), link[:60])
        check("QR code only when the link is short enough to scan", await page.locator("dialog.sharedialog .qr svg").count() == (1 if len(link) <= 700 else 0))
        await page.click("dialog.sharedialog button:has-text('Done')")
        ctxS = await b.new_context(viewport={"width": 390, "height": 844})
        pgS = await ctxS.new_page()
        pgS.on("pageerror", lambda e: errors.append(str(e)))
        await pgS.goto(link)
        await pgS.wait_for_selector("ul.ing li", timeout=15000)
        check("a shared link opens the recipe on a fresh device", "Hearty Russian Beet Soup" in await pgS.inner_text("h1"))
        check("shared recipe keeps its ingredients and method", await pgS.locator("ul.ing li").count() > 3 and await pgS.locator("ol.steps li, .dir p").count() >= 1)
        check("shared recipe says it was shared", "Shared with you" in await pgS.inner_text(".sharednote"))
        check("shared recipe has no star, plan or notes", await pgS.locator("button.star, .mylog").count() == 0
              and await pgS.locator("button:has-text('Add to meal plan')").count() == 0)
        await pgS.click("button:has-text('2×')")
        check("shared recipe can be scaled", await pgS.input_value("input[aria-label=Multiplier]") == "2")
        await pgS.emulate_media(media="print")
        check("printed card shows the footer and hides the tools",
              await pgS.locator(".printfoot").is_visible() and not await pgS.locator(".tools").is_visible() and not await pgS.locator(".sharednote").is_visible())
        await pgS.emulate_media(media="screen")
        await pgS.click("button:has-text('Save to my recipes')")
        await pgS.wait_for_selector("input[aria-label=Title], label.field input")
        check("Save to my recipes opens the editor with the recipe", await pgS.locator("input").first.count() >= 1
              and "Hearty Russian Beet Soup" in (await pgS.locator("label.field input").first.input_value()))
        await pgS.goto(URL + "#/s/1AAAA")
        await pgS.reload()
        await pgS.wait_for_selector(".linkbtn")
        check("a damaged link says so and offers the library", "did not work" in await pgS.inner_text("#app"))
        await ctxS.close()

        # nutrition and food cost on a recipe, and the price book
        await page.goto(URL + "#/")
        await page.wait_for_selector(".rc")
        await search(page, "European Sour Cream Apple Pie")
        await page.click(".rc >> nth=0")
        await page.wait_for_selector("ul.ing li")
        nsum = await page.inner_text("details.nutri > summary")
        check("a recipe estimates calories per serving", "calories per serving" in nsum, nsum)
        await page.click("details.nutri > summary")
        check("nutrition shows five figures", await page.locator(".nstats > div").count() == 5)
        check("nutrition says how much it could count", "ingredients" in await page.inner_text("details.nutri") and "not a label" in await page.inner_text("details.nutri"))
        await page.click("details.macros > summary")
        await page.wait_for_selector("details.macros[open] .macrobar span")
        legend = await page.inner_text(".macrolegend")
        pcts = [int(x) for x in re.findall(r"(\d+)% of calories", legend)]
        check("Macronutrients opens to calories by protein, carbs and fat, adding up to about 100%",
              await page.locator(".macrobar span").count() == 3 and len(pcts) == 3 and 98 <= sum(pcts) <= 102, legend)
        mt = await page.inner_text("details.macros table.macrotable >> nth=0")
        check("with a table of per serving, whole recipe and % daily value",
              all(x in mt.lower() for x in ("% daily value", "per serving", "whole recipe", "carbohydrates", "sodium")), mt[:200])
        kc = [int(x.replace(",", "")) for x in await page.locator("table.sources tbody tr td:nth-child(2)").all_inner_texts()]
        check("and where the calories come from, biggest first", len(kc) >= 3 and kc == sorted(kc, reverse=True), kc)
        await page.screenshot(path="/tmp/web_macros.png", full_page=False)
        check("food cost starts by asking for prices", "Add prices" in await page.inner_text("details.costcard > summary"))
        await page.click("details.costcard > summary")
        await page.fill("input[aria-label='Price of butter']", "4")
        row = page.locator(".costline:has(input[aria-label='Price of butter']) .cl-cost")
        await page.wait_for_function("document.querySelector(\"input[aria-label='Price of butter']\").closest('.costline').querySelector('.cl-cost').textContent.startsWith('$')")
        check("2/3 cup of butter at $4 a pound costs $1.33", await row.inner_text() == "$1.33", await row.inner_text())
        check("the summary shows cost per serving", "per serving" in await page.inner_text("details.costcard > summary"))
        await page.fill("input[aria-label='Menu price per serving']", "5")
        check("food cost percent follows the menu price", "4.4%" in await page.inner_text(".costtotals"), await page.inner_text(".costtotals"))
        per_before = await page.locator(".costtotals .ctline:has-text('Per serving') strong").first.inner_text()
        await page.click("button:has-text('2×')")
        await page.wait_for_function("document.querySelector('.costtotals').textContent.includes('$2.6')")
        check("scaling doubles the total but not the cost per serving",
              await page.locator(".costtotals .ctline:has-text('Per serving') strong").first.inner_text() == per_before)
        await page.reload()
        await page.wait_for_selector("ul.ing li")
        await page.click("details.costcard > summary")
        check("prices are remembered", await page.input_value("input[aria-label='Price of butter']") == "4")
        check("and so is the menu price", await page.input_value("input[aria-label='Menu price per serving']") == "5")
        # a purveyor's price list can be imported right from the Food cost card
        sup_csv = Path(tempfile.mkdtemp()) / "purveyor.csv"
        sup_csv.write_text("Item,Description,Pack,Size,Case Price\n100,BUTTER SOLID GRADE AA,36,1 LB,$108.00\n")
        check("the Food cost card has a supplier import button",
              await page.locator("details.costcard button:has-text('Import a supplier price list')").count() == 1)
        await page.set_input_files("details.costcard input[type=file]", str(sup_csv))
        await page.wait_for_selector("details.costcard .supplier .suprow")
        check("the review opens inside the card", "1 products: 1 matched" in await page.inner_text("details.costcard .supplier [role=status]"),
              await page.inner_text("details.costcard .supplier [role=status]"))
        await page.click("details.costcard .suptools button.primary")
        await page.wait_for_function("document.querySelector(\"input[aria-label='Price of butter']\").value === '3'")
        check("and the imported price fills in the recipe's line", await row.inner_text() == "$1.00"
              and await page.locator("details.costcard .supplier").count() == 0, await row.inner_text())
        # an older invoice never replaces a newer price
        old_csv = Path(tempfile.mkdtemp()) / "old_invoice.csv"
        old_csv.write_text("Item,Description,Pack,Size,Case Price,Invoice Date\n100,BUTTER SOLID GRADE AA,36,1 LB,$36.00,01/05/2026\n")
        await page.set_input_files("details.costcard input[type=file]", str(old_csv))
        await page.wait_for_selector("details.costcard .supplier .suprow")
        sup_text = await page.inner_text("details.costcard .supplier")
        check("an older price shows the newer one is kept, and is not ticked",
              "is newer and is kept" in sup_text and "Add 0 prices" in await page.inner_text("details.costcard .suptools button.primary"), sup_text[:400])
        await page.click("details.costcard .suptools button:has-text('Cancel')")
        await page.fill("input[aria-label='Price of butter']", "4")
        # the printed costing sheet: title, costed lines and totals, nothing else
        check("the card offers a costing sheet to print", await page.locator("details.costcard button:has-text('Print costing sheet')").count() == 1)
        await page.evaluate("document.body.classList.add('printcost')")
        await page.emulate_media(media="print")
        check("the costing sheet prints the costs and the title, not the method",
              await page.locator("details.costcard .costtotals").is_visible() and await page.locator(".rhead h1").is_visible()
              and not await page.locator("details.nutri").is_visible() and not await page.locator("details.costcard .costimport").is_visible())
        await page.screenshot(path="/tmp/web_costsheet.png", full_page=True)
        await page.emulate_media(media="screen")
        await page.evaluate("document.body.classList.remove('printcost')")
        await page.goto(URL + "#/settings")
        await page.wait_for_selector("a:has-text('Open the price book')")
        check("Settings links to the price book with its count", "1" in await page.inner_text("section:has(a:has-text('Open the price book'))"))
        await page.click("a:has-text('Open the price book')")
        await page.wait_for_selector(".pricebook .costline")
        check("the price book lists the price", await page.locator(".pricebook .costline:has-text('butter')").count() == 1)
        async with page.expect_download() as dl:
            await page.click("button:has-text('Export CSV')")
        csv_text = Path(await (await dl.value).path()).read_text()
        check("the price book exports a CSV", "butter,4,lb" in csv_text, csv_text)
        csv_in = Path(tempfile.mkdtemp()) / "prices.csv"
        csv_in.write_text("food,price,per\nolive oil,12,gallon\nflour,0.8,lb\nbad row\n")
        await page.set_input_files(".pricebook input[type=file]", str(csv_in))
        await page.wait_for_selector(".pricebook [role=status]:has-text('Added or updated 2')")
        check("a supplier list can be imported, and unreadable rows are reported",
              "1 row could not be read" in await page.inner_text(".pricebook [role=status]")
              and await page.locator(".pricebook .costline:has-text('olive oil')").count() == 1)
        await page.fill(".pricebook input[type=search]", "flour")
        check("the price book can be searched", await page.locator(".pricebook .costline").count() == 1)
        await page.click(".pricebook .costline .icon-btn")
        check("and a price can be removed", await page.locator(".pricebook .costline:has-text('flour')").count() == 0)
        await page.goto(URL + "#/")

        # import and export formats
        await page.goto(URL + "#/settings")
        await page.click("a:has-text('Import and export recipes')")
        await page.wait_for_selector(".transfer")
        await page.fill(".transfer textarea", "Wild Rice Soup\nServes 6\nIngredients\n1 cup wild rice\n2 Tbsp butter\nDirections\n1. Simmer the rice.\n2. Stir in butter.")
        await page.click("button:has-text('Read pasted text')")
        await page.wait_for_selector(".foundlist")
        check("pasted text is read and listed before anything is added", await page.locator(".foundlist li:has-text('Wild Rice Soup')").count() == 1)
        # a table copied from a web page or Word, pasted: its cells arrive as columns, not as stray ingredients
        await page.evaluate("""() => { const t = document.querySelector('.transfer textarea'); t.value = ''; t.focus();
          const dt = new DataTransfer();
          dt.setData('text/html', '<h2>Brisket Rub</h2><table><tr><th>Ingredient</th><th>Measurement</th></tr><tr><td>Paprika</td><td>2 Tbsp</td></tr><tr><td>Brown sugar</td><td>1/4 cup</td></tr></table><p>Instructions</p><p>Mix and rub on the brisket the night before.</p><h2>Slaw</h2><p>Ingredients</p><p>1 head cabbage</p><p>Directions</p><p>Shred it.</p>');
          dt.setData('text/plain', 'Brisket Rub Ingredient Measurement Paprika 2 Tbsp');
          t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }""")
        check("a pasted table keeps its columns", "Paprika\t2 Tbsp" in await page.input_value(".transfer textarea"))
        await page.click("button:has-text('Read pasted text')")
        await page.wait_for_selector(".foundlist li:has-text('Slaw')")
        check("several pasted recipes become one each, the table's two rows as ingredients",
              await page.locator(".foundlist li").all_inner_texts() == [" Brisket Rub 2 ingredients", " Slaw 1 ingredient"],
              await page.locator(".foundlist li").all_inner_texts())
        cook = Path(tempfile.mkdtemp()) / "pan-toast.cook"
        cook.write_text(">> servings: 2\nToast @bread{2%slices} with @butter{1%Tbsp}.\n")
        await page.set_input_files(".transfer input[type=file]", str(cook))
        await page.wait_for_selector(".foundlist li:has-text('pan toast')")
        check("a Cooklang file is read", "Cooklang" in await page.inner_text(".transfer [role=status]"))
        await page.locator("button:has-text('Add 1 recipe')").evaluate("e => e.click()")   # a real tap lands (checked by hit test); Playwright's own scrolling trips over the fixed tab bar here
        await page.wait_for_selector(".transfer [role=status]:has-text('Added 1 recipe')")
        await page.goto(URL + "#/")
        await page.fill("input[type=search]", "pan toast")
        await page.wait_for_selector(".rc:has-text('pan toast')")
        check("an imported recipe lands in the library", True)
        await page.goto(URL + "#/transfer")
        await page.wait_for_selector(".transfer")
        async with page.expect_download() as dl:
            await page.locator("button:has-text('Paprika file')").evaluate("e => e.click()")
        pk_path = Path(await (await dl.value).path())
        check("the Paprika export is a zip", pk_path.read_bytes()[:2] == b"PK")
        await page.set_input_files(".transfer input[type=file]", str(pk_path))
        await page.wait_for_selector(".foundlist")
        check("the Paprika export reads back in", await page.locator(".foundlist li:has-text('pan toast')").count() == 1
              and "Paprika" in await page.inner_text(".transfer [role=status]"))
        async with page.expect_download() as dl:
            await page.locator("button:has-text('Markdown')").evaluate("e => e.click()")
        check("Markdown export has the ingredients", "## Ingredients" in Path(await (await dl.value).path()).read_text())
        await page.goto(URL + "#/")

        # ---- importing a supplier price list into the price book
        ctx5 = await b.new_context(viewport={"width": 390, "height": 844})
        p5 = await ctx5.new_page()
        p5.on("pageerror", lambda e: errors.append(str(e)))
        await p5.goto(URL + "#/prices")
        await p5.wait_for_selector("button:has-text('Import a supplier price list')")
        files = p5.locator(".pricebook input[type=file]")
        await files.nth(1).set_input_files(str(ROOT / "tests" / "fixtures" / "suppliers" / "sysco_order_guide.csv"))
        await p5.wait_for_selector(".supplier .suprow")
        check("a Sysco order guide is read and named", await p5.input_value(".supname input") == "Sysco"
              and "9 products: 7 matched to a food" in await p5.inner_text(".supplier"), await p5.inner_text(".supplier [role=status]"))
        check("the case price becomes a price per pound", "$2.64 per lb" in await p5.inner_text(".suprow:has-text('CHEDDAR')"))
        await p5.fill(".suprow:has-text('DONUT') .supfood input", "donut")
        await p5.press(".suprow:has-text('DONUT') .supfood input", "Enter")
        await p5.locator(".suprow:has-text('DONUT') .supfood input").blur()
        await p5.wait_for_timeout(200)
        add = p5.locator(".suptools button.primary")
        # 7 matched, but only the cheaper of the two onions is ticked: 6, and the donut makes 7
        check("choosing a food for an unknown product ticks it", "Add 7 prices" in await add.inner_text(), await add.inner_text())
        await add.click()
        await p5.wait_for_selector(".costline:has-text('cheddar cheese')")
        book = await p5.evaluate("JSON.parse(localStorage.getItem('recipelib.prices')).items")
        check("the prices are saved with where they came from",
              book.get("cheddar cheese") == {"p": 2.64, "per": "lb", "src": "Sysco #4782109", "at": book["cheddar cheese"].get("at")}
              and book.get("donut", {}).get("per") == "each" and "onion" in book, book.get("cheddar cheese"))
        check("the price list shows the supplier", "Sysco #4782109" in await p5.inner_text(".costline:has-text('cheddar cheese')"))
        await ctx5.close()

        # dark mode renders
        ctx3 = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, color_scheme="dark")
        pg3 = await ctx3.new_page()
        await pg3.goto(URL + "#/")
        await pg3.wait_for_selector(".rc")
        await pg3.screenshot(path=str(SHOTS / "dark.png"))
        await b.close()
    real = [e for e in errors if "Failed to load resource" not in e and "net::ERR" not in e]
    check("no JavaScript errors", not real, real[:3])
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


sys.exit(asyncio.run(main()))
