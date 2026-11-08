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
