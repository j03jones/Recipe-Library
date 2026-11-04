"""End-to-end check of the phone web app in a real (headless) browser, including offline use.

    python tools/e2e_web.py [screenshot_dir]

Needs Playwright with Chromium. Serves web/ itself on a free port. Expects the real recipe data
(web/data/recipes.json built by tools/export_web.py) because it looks recipes up by name.
"""
import asyncio
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp())
SHOTS.mkdir(parents=True, exist_ok=True)
PORT = 8791
URL = f"http://127.0.0.1:{PORT}/"
errors, results = [], []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


async def search(page, text):
    await page.fill("input[type=search]", text)
    await page.wait_for_timeout(400)


async def main():
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--directory", str(ROOT / "web")],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        return await run()
    finally:
        server.terminate()


async def run():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                                  is_mobile=True, has_touch=True, accept_downloads=True)
        page = await ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        await page.goto(URL)
        await page.wait_for_selector(".rc")
        check("library loads with all recipes", "5,512 recipes" in await page.inner_text(".count"), await page.inner_text(".count"))
        check("rows do not overflow the screen", await page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
        await page.wait_for_function("navigator.serviceWorker.controller !== null", timeout=30000)
        cached = await page.evaluate("caches.keys().then(async ks => { const c = await caches.open(ks[0]); return (await c.keys()).length })")
        check("service worker cached app, fonts and data", cached >= 17, cached)
        check("heading font loaded", await page.evaluate("document.fonts.check('700 20px Poppins')"))

        # category chips: section, then group
        await page.click(".chips >> text=Course & type")
        names = await page.locator(".chips.groups .chip").count()
        check("section chip reveals its groups", names >= 8, names)
        await page.click(".chips.groups >> text=Soups & Stews")
        await page.wait_for_timeout(300)
        soups = await page.inner_text(".count")
        check("filter by a group", "291 of 5,512" in soups, soups)
        await page.click(".chips.groups >> text=Soups & Stews")  # tap again to clear
        await page.wait_for_timeout(300)
        check("tapping the group again clears it", "5,512 recipes" in await page.inner_text(".count"))
        await page.click(".chips >> text=All")
        await search(page, "penndutch")
        check("old label still searchable", "of 5,512" in await page.inner_text(".count"), await page.inner_text(".count"))
        await search(page, "zzzzqq")
        check("empty state offers a way out", await page.locator(".empty button:has-text('Clear search and filters')").count() == 1)
        await page.click(".empty button")
        await page.wait_for_timeout(300)
        check("clearing restores the library", "5,512 recipes" in await page.inner_text(".count"))
        await search(page, "garlic mushroom")
        check("search narrows results", "of 5,512" in await page.inner_text(".count"))

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
        check("loads while offline", "5,512 recipes" in await page.inner_text(".count"))
        await search(page, "biscotti")
        check("search works offline", (await page.locator(".rc").count()) > 0)

        # add a new recipe
        await page.click("a[data-tab=new]")
        await page.wait_for_selector("input[aria-label=Title]")
        await page.fill("input[aria-label=Title]", "Test Chili")
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
