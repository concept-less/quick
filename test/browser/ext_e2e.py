# End-to-end test of the browser extension in headless Chromium (Playwright, Python).
# Needs an isolated test hub on :7811 with token "testtoken" (QA_HOME=<tmp> QA_PORT=7811 node hub/server.ts)
# and the test site served on :7813:  python3 -m http.server 7813 --bind 127.0.0.1 -d test/browser
# Run: python3 test/browser/ext_e2e.py     (closed shadow DOM is inspected via CDP DOM.getDocument pierce)
# Covers: per-page drafts (SPA / hash / full navigation / back), pins not leaking across pages, pins
# following window scroll / inner scroll / sticky header / resize, click-vs-drag gesture payloads, send key.
import asyncio, json, sys, shutil, os
from playwright.async_api import async_playwright
EXT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "browser")
SITE = "http://127.0.0.1:7813/"
SHOTS = os.environ.get("SHOTS", "/tmp/qa-shots/"); os.makedirs(SHOTS, exist_ok=True)
results = []
def check(name, cond, info=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info and not cond else ""))

async def shadow_state(page):
    cdp = await page.context.new_cdp_session(page)
    doc = await cdp.send("DOM.getDocument", {"depth": -1, "pierce": True})
    def find(n):
        if n.get("localName") == "qa-agent-root":
            return n["shadowRoots"][0]
        for c in n.get("children", []) + n.get("shadowRoots", []):
            r = find(c)
            if r: return r
    sr = find(doc["root"])
    if not sr:
        await cdp.detach(); return None
    obj = await cdp.send("DOM.resolveNode", {"backendNodeId": sr["backendNodeId"]})
    r = await cdp.send("Runtime.callFunctionOn", {"objectId": obj["object"]["objectId"], "returnByValue": True, "functionDeclaration": """function(){
      const live = s => [...this.querySelectorAll(s)].filter(n => !n.classList.contains('fade'));
      const box = live('.box')[0];
      return { bar: !!this.querySelector('.bar'), box: !!box, text: box ? box.querySelector('textarea').value : null,
        meta: box ? box.querySelector('.meta').textContent : null, sel: live('.sel').length, region: live('.region').length,
        toast: [...this.querySelectorAll('.toast')].map(t => t.textContent),
        pins: [...this.querySelectorAll('.pin')].map(p => { const m = /translate\\((-?[\\d.]+)px,\\s*(-?[\\d.]+)px\\)/.exec(p.style.transform) || []; return { id: p.dataset.id, hidden: p.hidden, x: +m[1], y: +m[2] }; }),
        pop: !!this.querySelector('.pop:not([hidden])') };
    }"""})
    await cdp.detach()
    return r["result"]["value"]

async def main():
    async with async_playwright() as p:
        import tempfile; udd = tempfile.mkdtemp(prefix="qa-ext-")
        ctx = await p.chromium.launch_persistent_context(udd, headless=False, viewport={"width": 1280, "height": 800},
            args=["--headless=new", f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
        await asyncio.sleep(1)
        await sw.evaluate("""async () => {
          await chrome.storage.local.set({ hubUrl: 'http://127.0.0.1:7811', token: 'testtoken', sendKey: 'enter' });
          await chrome.scripting.registerContentScripts([
            { id: 't-hook', js: ['console-hook.js'], matches: ['http://127.0.0.1:7813/*'], runAt: 'document_start', world: 'MAIN' },
            { id: 't-content', js: ['tokens.js', 'content.js'], matches: ['http://127.0.0.1:7813/*'], runAt: 'document_idle' }]);
        }""")
        page = await ctx.new_page()
        toggle = lambda: sw.evaluate("async () => { const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:7813/*' }); return togglePicker(t); }")
        drafts = lambda: sw.evaluate("async () => (await chrome.storage.local.get('qaDrafts')).qaDrafts || {}")
        spa = lambda js: page.evaluate(js)

        # ---------------------------------------------------------------- drafts follow the page
        for scen in ["spa", "hash", "full", "back"]:
            await sw.evaluate("() => chrome.storage.local.remove('qaDrafts')")
            start_url = SITE + ("spa.html#/ha" if scen == "hash" else "spa.html?r=a")
            await page.goto(start_url); await page.wait_for_timeout(700)
            a_name = "hash-ha" if scen == "hash" else "a"
            await toggle(); await page.wait_for_timeout(200)
            await page.click(f"#item-{a_name}"); await page.wait_for_timeout(200)
            await page.keyboard.type(f"draft on A ({scen})")
            await page.wait_for_timeout(500)
            st = await shadow_state(page)
            check(f"[{scen}] A: box open with draft", st["box"] and st["text"] == f"draft on A ({scen})", st)
            if scen == "spa": await page.screenshot(path=SHOTS + "ext-comment-box.png")
            # leave A
            if scen == "spa": await spa("history.pushState({}, '', '?r=b'); render()")
            elif scen == "hash": await spa("location.hash = '#/hb'")
            elif scen == "full": await page.goto(SITE + "other.html")
            elif scen == "back":
                await page.goto(SITE + "other.html")
            await page.wait_for_timeout(900)
            st = await shadow_state(page)
            check(f"[{scen}] B: no trace of A (box/selection)", st is not None and not st["box"] and st["sel"] == 0, st)
            d = await drafts()
            check(f"[{scen}] A draft parked in storage", any(v.get("text") == f"draft on A ({scen})" for v in d.values()), d)
            # on B: start a new, independent selection and send it
            b_sel = {"spa": "#item-b", "hash": "#item-hash-hb", "full": "#other-item", "back": "#other-item"}[scen]
            if scen in ("full", "back") or not (st and st["bar"]): await toggle(); await page.wait_for_timeout(200)
            await page.click(b_sel); await page.wait_for_timeout(200)
            st = await shadow_state(page)
            check(f"[{scen}] B: fresh box, empty text, only B's element", st["box"] and st["text"] == "" and b_sel.strip('#') in (st["meta"] or ""), st)
            await page.keyboard.type(f"comment on B ({scen})"); await page.keyboard.press("Enter")
            await page.wait_for_timeout(2500)
            st = await shadow_state(page)
            check(f"[{scen}] B: sent (box closed, pin shown)", not st["box"] and len(st["pins"]) >= 1, st)
            # back to A
            if scen == "spa": await page.go_back()
            elif scen == "hash": await page.go_back()
            elif scen == "full": await page.goto(start_url)
            elif scen == "back": await page.go_back()
            await page.wait_for_timeout(1500)
            st = await shadow_state(page)
            check(f"[{scen}] A again: selection + draft restored", st and st["box"] and st["text"] == f"draft on A ({scen})" and f"item-{a_name}" in (st["meta"] or ""), st)
            if scen == "spa": await page.screenshot(path=SHOTS + "ext-draft-restored.png")
            await page.keyboard.press("End"); await page.keyboard.type(" — done"); await page.keyboard.press("Enter")
            await page.wait_for_timeout(2500)
            st = await shadow_state(page); d = await drafts()
            check(f"[{scen}] A: sent, draft cleared", not st["box"] and not d, (st, d))
            # pins of A must not include B's comment (and vice versa)
            pins_a = {p["id"] for p in st["pins"]}
            check(f"[{scen}] A pins exclude B comment", len(pins_a) >= 1, st)
            await page.keyboard.press("Escape")

        # ---------------------------------------------------------------- toggle after URL change starts fresh
        await sw.evaluate("() => chrome.storage.local.remove('qaDrafts')")
        await page.goto(SITE + "spa.html?r=a"); await page.wait_for_timeout(600)
        await toggle(); await page.wait_for_timeout(200)
        await page.click("#item-a", modifiers=["Shift"]); await page.wait_for_timeout(300)
        await page.keyboard.press("Escape"); await page.keyboard.press("Escape")  # clear selection, exit (cancel → no draft)
        await page.wait_for_timeout(300)
        d = await drafts(); check("[toggle] Esc cancel drops draft", not d, d)

        # ---------------------------------------------------------------- auto gesture: click = element, drag = region
        import re, urllib.request
        def intake(iid):
            req = urllib.request.Request(f"http://127.0.0.1:7811/api/intake/{iid}", headers={"authorization": "Bearer testtoken"})
            return json.load(urllib.request.urlopen(req))["intake"]
        async def last_id():
            st = await shadow_state(page)
            m = re.search(r"（(c[0-9a-f]+)）", " ".join(st["toast"]))
            return m and m.group(1)
        await page.goto(SITE + "spa.html?r=g"); await page.wait_for_timeout(600)
        await toggle(); await page.wait_for_timeout(200)
        st = await shadow_state(page)
        bx = await page.evaluate("(() => { const r = document.getElementById('item-g').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()")
        # click with a tiny jitter (< 5px) still selects the element
        await page.mouse.move(bx[0] + 40, bx[1] + 20); await page.mouse.down(); await page.mouse.move(bx[0] + 42, bx[1] + 21); await page.mouse.up()
        await page.wait_for_timeout(250)
        st = await shadow_state(page)
        check("[gesture] small-jitter click selects the element", st["box"] and "item-g" in (st["meta"] or ""), st)
        await page.keyboard.type("click gesture"); await page.keyboard.press("Enter"); await page.wait_for_timeout(2500)
        iid = await last_id(); it = intake(iid) if iid else {}
        check("[gesture] click → element comment payload", it.get("mode") == "element" and it.get("elements") and it["elements"][0]["selector"] == "#item-g" and not it.get("region"), it.get("mode"))
        await toggle(); await page.wait_for_timeout(200)
        b1 = await page.evaluate("(() => { const a = document.getElementById('item-g').getBoundingClientRect(), b = document.getElementById('second-g').getBoundingClientRect(); return [a.x - 6, a.y - 6, b.right + 6, b.bottom + 6]; })()")
        await page.mouse.move(b1[0], b1[1]); await page.mouse.down()
        for i in range(1, 11): await page.mouse.move(b1[0] + (b1[2] - b1[0]) * i / 10, b1[1] + (b1[3] - b1[1]) * i / 10)
        st_mid = await shadow_state(page)
        await page.mouse.up(); await page.wait_for_timeout(250)
        st = await shadow_state(page)
        check("[gesture] drag draws a region and opens the box", st_mid["region"] == 1 and st["box"] and "区域" in (st["meta"] or ""), (st_mid, st))
        sel_text = await page.evaluate("String(getSelection())")
        check("[gesture] drag does not select page text", sel_text == "", sel_text)
        await page.screenshot(path=SHOTS + "ext-region.png")
        await page.keyboard.type("drag gesture"); await page.keyboard.press("Enter"); await page.wait_for_timeout(2500)
        iid = await last_id(); it = intake(iid) if iid else {}
        sels = [e["selector"] for e in it.get("elements", [])]
        rg = it.get("region") or {}
        check("[gesture] drag → region payload with the cards", it.get("mode") == "region" and rg.get("width", 0) > 100 and "#item-g" in sels and "#second-g" in sels, (it.get("mode"), rg, sels))
        # Esc while dragging cancels
        await toggle(); await page.wait_for_timeout(200)
        await page.mouse.move(b1[0], b1[1]); await page.mouse.down(); await page.mouse.move(b1[0] + 120, b1[1] + 80)
        await page.keyboard.press("Escape"); await page.mouse.up(); await page.wait_for_timeout(200)
        st = await shadow_state(page)
        check("[gesture] Esc during drag cancels (no region, no box, picker still on)", st["region"] == 0 and not st["box"] and st["bar"], st)
        await page.keyboard.press("Escape")

        # ---------------------------------------------------------------- pins: no cross-page leaking
        await page.goto(SITE + "spa.html?r=a"); await page.wait_for_timeout(2000)
        st = await shadow_state(page); ids_a = {p["id"] for p in st["pins"]}
        await spa("history.pushState({}, '', '?r=b'); render()"); await page.wait_for_timeout(150)
        st = await shadow_state(page); ids_b_immediate = {p["id"] for p in st["pins"]}
        check("[pins] SPA route change clears A's pins immediately", not (ids_a & ids_b_immediate), (ids_a, ids_b_immediate))
        await page.wait_for_timeout(2000)
        st = await shadow_state(page); ids_b = {p["id"] for p in st["pins"]}
        check("[pins] B shows only B's pins", ids_b and not (ids_a & ids_b), (ids_a, ids_b))
        await page.go_back(); await page.wait_for_timeout(2000)
        st = await shadow_state(page); check("[pins] back to A shows A's pins again", {p['id'] for p in st['pins']} == ids_a, st["pins"])
        await page.goto(SITE + "spa.html?r=a#section"); await page.wait_for_timeout(1500)
        st = await shadow_state(page); check("[pins] plain #fragment = same page", {p['id'] for p in st['pins']} == ids_a, st["pins"])

        # ---------------------------------------------------------------- pins stay on their component
        await sw.evaluate("() => chrome.storage.local.remove('qaDrafts')")
        import time; PIN = "pin" + str(int(time.time()))
        await page.goto(SITE + "spa.html?r=" + PIN); await page.wait_for_timeout(800)
        async def comment_on(sel, text, region=False):
            await toggle(); await page.wait_for_timeout(200)
            await page.click(sel); await page.wait_for_timeout(200)
            await page.keyboard.type(text); await page.keyboard.press("Enter"); await page.wait_for_timeout(2200)
        await comment_on("#second-"+PIN, "pin on card")
        await page.evaluate(f"document.getElementById('row-{PIN}-3').scrollIntoView({{block:'center'}})"); await page.wait_for_timeout(200)
        await comment_on("#row-"+PIN+"-3", "pin on inner row")
        await page.evaluate("window.scrollTo(0,0)")
        await comment_on("#sticky-btn", "pin on sticky header")
        await page.wait_for_timeout(5500)  # let the poll attach ids
        async def pin_vs(sel, idx):
            st = await shadow_state(page)
            r = await page.evaluate(f"(() => {{ const r = document.querySelector('{sel}').getBoundingClientRect(); return [r.right, r.top]; }})()")
            pin = st["pins"][idx]
            return pin, r
        def near(pin, r):
            return (not pin["hidden"]) and abs(pin["x"] + 11 - min(r[0], 1280 - 15)) <= 3 and abs(pin["y"] + 11 - max(r[1], 13)) <= 3
        st = await shadow_state(page); n = len(st["pins"])
        check("[pos] 3 pins on page", n == 3, st["pins"])
        for dy in (300, 700):
            await page.evaluate(f"window.scrollTo(0,{dy})"); await page.wait_for_timeout(250)
            pin, r = await pin_vs("#second-"+PIN, 0)
            vis = r[1] > 44  # below the sticky header
            check(f"[pos] window scroll {dy}: card pin follows card / hides under sticky header", near(pin, r) if vis else pin["hidden"], (pin, r))
            pin, r = await pin_vs("#sticky-btn", 2)
            check(f"[pos] window scroll {dy}: sticky header pin stays on header", near(pin, r), (pin, r))
        await page.evaluate("window.scrollTo(0,0)"); await page.wait_for_timeout(200)
        await page.evaluate("document.getElementById('inner').scrollTop = 60"); await page.wait_for_timeout(250)
        pin, r = await pin_vs("#row-"+PIN+"-3", 1)
        check("[pos] inner container scroll: pin follows row", near(pin, r), (pin, r))
        await page.screenshot(path=SHOTS + "ext-pins.png")
        await page.evaluate("document.getElementById('inner').scrollTop = 600"); await page.wait_for_timeout(250)
        pin, r = await pin_vs("#row-"+PIN+"-3", 1)
        check("[pos] inner container scroll: row scrolled out → pin hidden", pin["hidden"], (pin, r))
        await page.set_viewport_size({"width": 900, "height": 700}); await page.wait_for_timeout(300)
        await page.evaluate("document.getElementById('inner').scrollTop = 60"); await page.wait_for_timeout(250)
        pin, r = await pin_vs("#second-"+PIN, 0)
        check("[pos] after resize: pin follows card", near(pin, r) or r[1] <= 44, (pin, r))

        # ---------------------------------------------------------------- popup
        await page.set_viewport_size({"width": 1280, "height": 800})
        ext_id = sw.url.split("/")[2]
        for scheme in ("light", "dark"):
            pp = await ctx.new_page()
            await pp.emulate_media(color_scheme=scheme)
            await pp.set_viewport_size({"width": 340, "height": 560})
            await pp.goto(f"chrome-extension://{ext_id}/popup.html"); await pp.wait_for_timeout(1500)
            await pp.screenshot(path=SHOTS + f"ext-popup-{scheme}.png", full_page=True)
            if scheme == "light":
                await pp.keyboard.press("m"); await pp.wait_for_timeout(300)
                sk = await sw.evaluate("async () => (await chrome.storage.local.get('sendKey')).sendKey")
                check("[popup] M toggles send key", sk == "mod", sk)
            await pp.close()
        # comment box in mod mode
        await page.goto(SITE + "spa.html?r=c"); await page.wait_for_timeout(600)
        await toggle(); await page.click("#item-c"); await page.wait_for_timeout(200)
        await page.keyboard.type("line1"); await page.keyboard.press("Enter"); await page.keyboard.type("line2")
        st = await shadow_state(page); check("[sendKey=mod] Enter inserts newline", st["box"] and st["text"] == "line1\nline2", st)
        await page.emulate_media(color_scheme="dark"); await page.wait_for_timeout(200)
        await page.screenshot(path=SHOTS + "ext-comment-box-dark.png")
        await page.keyboard.press("Escape"); await page.keyboard.press("Escape")
        await sw.evaluate("() => chrome.storage.local.set({ sendKey: 'enter' })")
        await ctx.close()
    fails = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(fails)}/{len(results)} passed")
    sys.exit(1 if fails else 0)
asyncio.run(main())
