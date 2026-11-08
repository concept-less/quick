# UI redesign: minimal brutalism

Scope: `ui/app.html` (Web UI), `ui/server.ts` (login page only), `browser/popup.html`, and the in-page picker styles in `browser/content.js` / `browser/background.js`. No API or behavior changes.

## Design tokens (`:root` in `ui/app.html`; mirrored in popup/login/content)

| token | light | dark | use |
|---|---|---|---|
| `--bg` / `--bg-2` / `--bg-3` / `--surface` | `#f4f4f0` paper … | `#0e0e0e` ink … | page / hover / selected / inputs & code |
| `--fg` / `--fg-2` / `--fg-3` | `#0d0d0d` … | `#ececE6` … | text / secondary / meta |
| `--line` / `--line-2` | hairline / ink | hairline / phosphor | grid borders / structural borders |
| `--acc` | `#e61919` | `#ff3b30` | **the only accent**: needs-you, failure, unread, brand mark, focus ring |
| `--inv-bg` / `--inv-fg` | ink on paper | paper on ink | primary buttons, active tab, `done` tag |
| `--hard` | `4px 4px 0` ink | `4px 4px 0 #4a4a46` | the only shadow (focus/overlays), no blur |
| `--sans` / `--mono` | Inter → system → PingFang | JetBrains/SF Mono → Menlo | body / IDs, labels, statuses, tool args |
| `--s1..s6` | 4 8 12 16 24 32 | | spacing |
| `--r` | `0` | | square corners everywhere |

Theme follows the system. The ◐ button cycles follow system → light → dark (stored in `localStorage.qaTheme`).

## Status tags (fill, not hue)

- running/starting/claimed: ink outline with a blinking square
- done/dispatched: solid inverted
- needs_input/idle/blocked/pending: accent outline
- failed/exited: solid accent
- cancelled/dismissed: dashed and struck through

Unread tasks get a red bar on the left edge. The selected task gets an ink bar on the right edge.

## UX changes

- Chat: user messages are square grey blocks. Consecutive tool calls merge into one compact log with mono args and ✓/ERR/blinking state, so the empty gaps from tool-result rows are gone. Code blocks have a language label and a copy button. Thinking blocks are collapsed behind `+ 思考`. Report and comment cards use mono micro-labels.
- Composer: Enter sends and Shift+Enter adds a newline. IME composition is safe. While a message is sending, the button shows a busy state and is disabled; if sending fails, the text and images are restored. While the agent is streaming, Esc stops it.
- Keyboard: `/` focuses the composer. Esc closes the task detail or the image zoom. Task rows are focusable: ↑/↓ move between them and Enter opens one.
- Task panel: shows a loading skeleton until the first hub snapshot, an explicit offline state, and real empty states. The detail view has a definition-list meta grid, a LIVE terminal and a cleaner event log.
- Responsive: at ≤1100px the side panel narrows. At ≤900px it becomes a single column with a 任务/对话 toggle. At ≤600px the brand text and hints are hidden.
- Motion: only 120–160ms fades. `prefers-reduced-motion` turns them off.

## Screenshots

`before-*.png` vs `after-*.png` (light, dark + task detail, mobile 390px, extension popup light/dark).

---

# v2 (task t2d42): one token source, task-left layout, shortcuts, extension in shadow DOM, page-bound pins & drafts

## Design tokens: one source

`shared/tokens.css` is the only place colors, fonts, spacing, borders and motion are defined (`:root,:host`, dark via `prefers-color-scheme`, Web UI override via `data-theme`).

- Web UI and login page: `ui/server.ts` inlines it at the `/*@tokens*/` marker.
- Extension: `scripts/sync-tokens.sh` copies it to `browser/tokens.css` (`<link>`ed by the popup) and `browser/tokens.js` (injected before `content.js`, used inside the closed shadow root). `scripts/pack-extension.sh` runs the sync first, because the extension may only ship files from `browser/`.

## Web UI

- The task view (list, detail, and later the attention queue / schedules) sits on the **left**. The front-agent chat sits on the **right**. On narrow screens a `[任务 | 对话]` switch shows the tasks first. The Electron client reuses the same page.
- Task search box (title, ID, directory, report). Loading, empty, no-match and offline states.
- Shortcuts (`⌘` on Mac, `Ctrl` elsewhere; press `?` or click the header `?` button to see them all):
  - `⌘K` focuses the composer; pressing it again while in the composer jumps to task search.
  - `⌘1` / `⌘2` switch to tasks / browser comments.
  - `Esc` closes the zoomed image or task detail, or clears the search.
  - `/` focuses the composer; `↑` `↓` `Enter` move through and open tasks.
- Send key: two modes. Either `Enter` sends and `Shift+Enter` adds a newline, or `⌘/Ctrl+Enter` sends and `Enter` adds a newline. Switch with the `↵` button in the composer or from the shortcut panel. The choice is saved in `localStorage.qaSendKey`. The composer placeholder, the hint line and the task "追加指令" box all follow the mode.
- No emoji anywhere. Marks are monochrome glyphs only: `■ □ ● ○ ◐ ✓ ✕ →`, plus text labels such as `[ERR]`.

## Extension

- All in-page UI (toolbar, hover highlight, selection, region, comment box, toast, pins, popover) lives in a **closed shadow root** styled with the shared tokens, so it follows the system light or dark theme. Page CSS cannot reach it, and none of it leaks into the page.
- **Picking chooses by gesture, with no mode switch.** Press and release (moving < 5 px) picks the element under the pointer; `Shift`+click adds to the selection. Press and drag (≥ 5 px) draws a region; on release, the region (viewport px) is sent together with the elements inside it. While dragging, text selection and native drag are blocked. `Esc` works in layers: cancel the drag, then clear the selection or close the box, then exit the picker. The toolbar sits at the bottom center so it does not cover sticky headers. While picking, pins ignore the pointer.
- Shortcuts: `⌘⇧E` / `Ctrl+Shift+E` starts or stops picking. `⌘⇧Y` / `Ctrl+Shift+Y` opens the popup (`_execute_action`). Popup keys: `E` pick, `D` dashboard, `,` settings, `M` switch the send key.
- The send key setting (`chrome.storage.local.sendKey`) is shared by the popup switch and the comment box (which also has its own "切换" link).
- **Pins are bound to the page.** The hub matches comments by `pageKey` (`hub/page-url.ts`, mirrored in `content.js`, tested in `test/page-url.test.ts`):
  - A plain `#anchor` is the same page; a `#/route` or `#!/route` hash route is a different page.
  - A trailing slash and tracking parameters (`utm_*`, `fbclid`, …) are ignored; the remaining query parameters are sorted and compared.

  The extension clears and re-fetches pins as soon as the URL changes. It detects changes through pushState/replaceState (via the main-world hook), the Navigation API, popstate, hashchange, bfcache `pageshow`, and a 500 ms href check. A poll result that arrives after the URL has changed is dropped.
- **Pins stay on their component.** Each new comment saves an anchor `{selector, fx, fy, doc}`: the element plus the pin's position inside it as a fraction of its box, with document coordinates as a fallback. Older comments fall back to the region plus `viewport.scroll*`, which converts it to document coordinates. Pins are `position:fixed` and re-measured with `getBoundingClientRect`, rAF-throttled, on:
  - capture-phase `scroll` (inner scroll containers included)
  - `resize`, `ResizeObserver` and `MutationObserver`
  - a 1 s safety tick

  A pin hides when its point is outside the viewport, clipped by an overflow ancestor, covered by another element (for example, scrolled under a sticky header), or gone. Several pins on one element fan out to the left. The popover follows its pin.
- **Drafts are bound to the page.** A selection or a half-written comment is captured on every change (selectors, region in document coordinates, text, screenshot checkbox). When the URL changes, the marks fade out over 150 ms and the draft is parked in `chrome.storage.local.qaDrafts`, keyed by page (at most 30 pages, 24 h TTL). Returning to that page restores the selection and the text, with a note if some elements are gone. Drafts on different pages are independent. Sending or cancelling drops the page's draft. Starting the picker after a URL change always starts clean.

## Verification

- `test/browser/ext_e2e.py`: headless Chromium with the unpacked extension, an isolated test hub and test pages (`test/browser/spa.html`, `test/browser/layers.html`), all checks passing:
  - drafts across SPA routes, hash routes, full navigation and back
  - pins not leaking across pages (SPA, back, plain `#fragment`)
  - pins following window scroll, inner container scroll, sticky header and resize, and hiding when scrolled out
  - click and drag gestures and their submitted payloads in the hub; Esc during a drag
  - top layer: picking, region selection, typing and sending (selector + screenshots) on top of a native modal `<dialog>` (nested too, opened/closed/removed while picking), a popover, a z-index max portal overlay with outside-dismiss / Esc / focus trap, and a fullscreen element; none of them is closed by the picker
  - popup `M` key; send key in `mod` mode
- `test/page-url.test.ts` (hub and extension copies of `pageKey` agree); `scripts/pack-extension.sh` passes (also checks the token copies and the ≤ 4 `suggested_key` limit).

## Screenshots (v2)

| | |
|---|---|
| Web UI before / after (light) | `v2-before-light.png` / `v2-after-light.png` |
| dark | `v2-before-dark.png` / `v2-after-dark.png` |
| task detail | `v2-before-task-light.png` / `v2-after-task-light.png` |
| browser comments tab | `v2-before-comments-light.png` / `v2-after-comments-light.png` |
| mobile 390px | `v2-before-mobile.png` / `v2-after-mobile.png` |
| extension popup | `v2-ext-popup-light.png`, `v2-ext-popup-dark.png` |
| in-page comment box | `v2-ext-comment-box.png`, `v2-ext-comment-box-dark.png` (⌘/Ctrl+Enter mode) |
| drag-to-region | `v2-ext-region.png` |
| draft restored after coming back | `v2-ext-draft-restored.png` |
| pins on card / inner-scroll row / sticky header | `v2-ext-pins.png` |
