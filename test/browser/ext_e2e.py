# End-to-end test of the browser extension in headless Chromium (Playwright, Python).
# Needs an isolated test hub on :7811 with token "testtoken" (QA_HOME=<tmp> QA_PORT=7811 node hub/server.ts)
# and the test site served on :7813:  python3 -m http.server 7813 --bind 127.0.0.1 -d test/browser
# Run: python3 test/browser/ext_e2e.py     (closed shadow DOM is inspected via CDP DOM.getDocument pierce)
# Covers: per-page drafts (SPA / hash / full navigation / back), one-shot comments (after sending no
# mark stays on the page, also not after a reload or a later visit; a failed send keeps the text for a
# retry), click-vs-drag gesture payloads, send key.
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
        // anything that marks the page besides the toolbar / toast: pins, badges, popovers, selection, region, box
        marks: [...this.querySelectorAll('*')].filter(n => n.tagName !== 'STYLE' && !n.classList.contains('layer') && !n.closest('.bar,.toast,.fade')
          && !((n.classList.contains('hl') || n.classList.contains('tag')) && n.style.display === 'none')).map(n => n.className || n.tagName.toLowerCase()),
        hover: live('.hl,.tag').filter(n => n.style.display !== 'none').length };
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
            check(f"[{scen}] B: sent, nothing left on the page", not st["box"] and not st["marks"] and not st["bar"], st)
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
            check(f"[{scen}] A: sent, nothing left on the page", not st["marks"] and not st["bar"], st)
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

        # ---------------------------------------------------------------- one-shot: sent comments leave no marks
        await sw.evaluate("() => chrome.storage.local.remove('qaDrafts')")
        check("[once] background has no page-comment polling", await sw.evaluate("() => typeof handlers['qa-page-comments']") == "undefined")
        ONCE = SITE + "spa.html?r=once"
        await page.goto(ONCE); await page.wait_for_timeout(700)
        await toggle(); await page.wait_for_timeout(200)
        await page.click("#item-once", modifiers=["Shift"]); await page.click("#second-once", modifiers=["Shift"]); await page.wait_for_timeout(150)
        await page.keyboard.press("Enter"); await page.wait_for_timeout(200)
        st = await shadow_state(page)
        check("[once] before sending: selection boxes + comment box on the page", st["box"] and st["sel"] == 2, st)
        await page.keyboard.type("one-shot element comment"); await page.keyboard.press("Enter")
        await page.wait_for_timeout(1200)
        st = await shadow_state(page)
        iid = await last_id()
        check("[once] sent: toast with the comment id", bool(iid), st["toast"])
        check("[once] sent: no selection, box, pin, badge or toolbar left", not st["marks"] and not st["bar"] and st["hover"] == 0, st)
        await page.screenshot(path=SHOTS + "ext-after-send.png")
        await page.wait_for_timeout(3500)  # the old extension polled the hub here and drew pins
        st = await shadow_state(page)
        check("[once] still nothing after a while", not st["marks"], st)
        await page.reload(); await page.wait_for_timeout(2500)
        st = await shadow_state(page)
        check("[once] reload: no marks come back", st is not None and not st["marks"] and not st["box"] and not st["bar"], st)
        await page.goto(SITE + "other.html"); await page.wait_for_timeout(500)
        await page.goto(ONCE); await page.wait_for_timeout(2500)
        st = await shadow_state(page)
        check("[once] later visit: no marks", st is not None and not st["marks"] and not st["bar"], st)
        d = await drafts(); check("[once] nothing kept in extension storage for the page", not d, d)
        # region: the dashed region goes away too
        await toggle(); await page.wait_for_timeout(200)
        b1 = await page.evaluate("(() => { const a = document.getElementById('item-once').getBoundingClientRect(); return [a.x - 6, a.y - 6, a.right + 6, a.bottom + 6]; })()")
        await page.mouse.move(b1[0], b1[1]); await page.mouse.down()
        for i in range(1, 11): await page.mouse.move(b1[0] + (b1[2] - b1[0]) * i / 10, b1[1] + (b1[3] - b1[1]) * i / 10)
        await page.mouse.up(); await page.wait_for_timeout(250)
        st = await shadow_state(page); check("[once] region drawn", st["region"] == 1 and st["box"], st)
        await page.keyboard.type("one-shot region comment"); await page.keyboard.press("Enter"); await page.wait_for_timeout(1500)
        st = await shadow_state(page); check("[once] region sent: no marks left", not st["marks"] and not st["bar"], st)
        await page.reload(); await page.wait_for_timeout(2000)
        st = await shadow_state(page); check("[once] region: reload shows nothing", not st["marks"], st)
        # failed send: text and selection stay for a retry; the retry clears everything
        await sw.evaluate("() => chrome.storage.local.set({ token: 'wrong' })")
        await toggle(); await page.wait_for_timeout(200)
        await page.click("#item-once"); await page.wait_for_timeout(200)
        await page.keyboard.type("retry me"); await page.keyboard.press("Enter"); await page.wait_for_timeout(1500)
        st = await shadow_state(page)
        check("[once] send failed: box + text + selection kept, error toast", st["box"] and st["text"] == "retry me" and st["sel"] == 1 and any("发送失败" in t for t in st["toast"]), st)
        await sw.evaluate("() => chrome.storage.local.set({ token: 'testtoken' })")
        await page.keyboard.press("Enter"); await page.wait_for_timeout(1500)
        st = await shadow_state(page)
        check("[once] retry succeeds and clears the page", not st["marks"] and not st["bar"] and any("已发送" in t for t in st["toast"]), st)
        await page.reload(); await page.wait_for_timeout(2000)
        st = await shadow_state(page); check("[once] retry: reload shows nothing", not st["marks"], st)

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
