# 25 — Mobile

ProseMirror's hardest battles are fought on phones. Mobile browsers
fire **different events**, fire them in **different orders**, and
sometimes **lie** about what happened. This file is the mobile-only
master reference, consolidating the mobile bits that live scattered
across [13 — Input Pipeline](./13-input-pipeline.md), [14 — IME &
Composition](./14-ime-composition.md), and
[18 — Cross-Browser Quirks](./18-cross-browser-quirks.md).

References use `file:line` against `/tmp/pm-source/prosemirror-view/src/`
unless otherwise noted.

---

## 1. The mobile reality stack

A web editor on phone has *six* layers between the user's finger and
your transaction:

```
   finger
     │
     ▼
 ┌─────────────────────────┐
 │ Touch hardware          │   400ms tap delay (legacy), force/3D-touch,
 │                         │   palm rejection
 └──────────┬──────────────┘
            ▼
 ┌─────────────────────────┐
 │ OS gesture recognizer   │   double-tap word-select (iOS/Android),
 │                         │   long-press magnifier (iOS), swipe-to-go-back
 └──────────┬──────────────┘
            ▼
 ┌─────────────────────────┐
 │ Browser chrome          │   visualViewport resize, address-bar
 │                         │   show/hide, momentum scroll
 └──────────┬──────────────┘
            ▼
 ┌─────────────────────────┐
 │ Virtual keyboard        │   predictive text (Android), autocorrect
 │                         │   (iOS), GIF/voice/swipe input
 └──────────┬──────────────┘
            ▼
 ┌─────────────────────────┐
 │ contenteditable engine  │   WebKit (iOS) / Blink (Android) edit
 │                         │   command translation
 └──────────┬──────────────┘
            ▼
 ┌─────────────────────────┐
 │ ProseMirror             │   beforeinput → DOMObserver → state.tr
 └─────────────────────────┘
```

Every layer can rewrite the event stream. Mobile bugs almost always
trace to a discrepancy between what one layer fired and what the next
layer expected.

PM's mobile strategy is **defensive observation, not control**: it
lets the OS/browser/keyboard write the DOM and reverse-engineers what
happened via `MutationObserver` ([15](./15-domobserver-and-domchange.md)).
Trying to use `keydown` + `preventDefault` for editing on mobile is
a known failure mode and the entire `domchange.ts` exists to avoid it.

---

## 2. Virtual keyboards and viewport shifts

### 2.1 The visualViewport API

The keyboard either **resizes the layout viewport** (older Android,
desktop-mode iPad) or **overlays without resizing** (modern iOS,
Chrome on Android with `interactive-widget=resizes-content` set).

For a robust UX, the editor must subscribe to `visualViewport`:

```ts
const vv = window.visualViewport
if (vv) {
  vv.addEventListener("resize", onViewportChange)
  vv.addEventListener("scroll", onViewportChange)
}

function onViewportChange() {
  const keyboardHeight = window.innerHeight - vv.height
  // pad the editor so caret stays above the keyboard
  document.documentElement.style.setProperty(
    "--keyboard-inset",
    `${Math.max(0, keyboardHeight)}px`
  )
  // re-run scrollIntoView so caret is visible
  if (view.hasFocus()) view.dispatch(view.state.tr.scrollIntoView())
}
```

PM itself does **not** subscribe to `visualViewport`. The
`scrollIntoView` flag on transactions ([21 §5](./21-rendering-pipeline-end-to-end.md))
relies on the standard DOM `scrollIntoView`, which sees the *layout*
viewport. On modern iOS, the layout viewport doesn't shrink when the
keyboard appears, so the caret can be stuck under the keyboard until
the user manually scrolls.

The userland fix is the snippet above: pad the editor (or its
scrolling ancestor) by `innerHeight - vv.height` so the layout viewport
*effectively* shrinks.

### 2.2 The `interactive-widget` viewport meta

Chrome (Android) and increasingly other browsers honor:

```html
<meta name="viewport" content="width=device-width, interactive-widget=resizes-content">
```

This makes the keyboard resize the layout viewport (so
`scrollIntoView` "just works"). On iOS Safari it's still ignored as of
this writing — `visualViewport` is the only correct path.

### 2.3 Address-bar collapse / expand

Mobile Safari's URL bar shrinks on scroll-down and grows on
scroll-up; this fires **resize events** that change `innerHeight`
without any user gesture relevant to the editor. Three pitfalls:

- Don't anchor the editor to `100vh` — use `100dvh` (dynamic viewport)
  to track the address-bar state, or `min-height: 100svh` to lock to
  the small-viewport size.
- Don't recompute coordinates ([17](./17-coordinates-and-hit-testing.md))
  on every resize — debounce to ~150ms.
- The address bar reappearing **while the keyboard is open** is rare
  but possible (iOS landscape) — both insets matter.

### 2.4 The keyboard-occlusion bug

Symptom: user taps the bottom of the doc, keyboard opens, caret is
visible for a frame, then keyboard finishes animating *over* the
caret. Standard `scrollIntoView` runs once and is "done" before the
keyboard fully appears.

Mitigation:

```ts
function ensureCaretAbove() {
  view.dispatch(view.state.tr.scrollIntoView())
  // re-run after the keyboard finishes animating
  setTimeout(() => view.dispatch(view.state.tr.scrollIntoView()), 250)
  // and once visualViewport stabilizes
  if (window.visualViewport) {
    let cleanup: number | null = null
    const onResize = () => {
      view.dispatch(view.state.tr.scrollIntoView())
      if (cleanup != null) clearTimeout(cleanup)
      cleanup = window.setTimeout(() => {
        window.visualViewport!.removeEventListener("resize", onResize)
      }, 600)
    }
    window.visualViewport.addEventListener("resize", onResize)
  }
}

view.dom.addEventListener("focus", ensureCaretAbove)
```

This is **userland**. PM provides the `tr.scrollIntoView()` flag and
nothing more.

---

## 3. iOS quirks

### 3.1 The Enter key (`lastIOSEnter`)

Documented in [14 §7a](./14-ime-composition.md). Source:
`input.ts:118-130`:

```ts
// On iOS, if we preventDefault enter key presses, the virtual
// keyboard gets confused. So the hack here is to set a flag that
// makes the DOM change code recognize that what just happens should
// be replaced by whatever the Enter key handlers do.
if (browser.ios && event.keyCode == 13 && !event.ctrlKey && !event.altKey && !event.metaKey) {
  let now = Date.now()
  view.input.lastIOSEnter = now
  view.input.lastIOSEnterFallbackTimeout = setTimeout(() => {
    if (view.input.lastIOSEnter == now) {
      view.someProp("handleKeyDown", f => f(view, keyEvent(13, "Enter")))
      view.input.lastIOSEnter = 0
    }
  }, 200)
}
```

Why: iOS Safari uses Enter to confirm autocorrect / IME candidates.
If PM `preventDefault`s on the Enter `keydown`, the autocorrect chain
breaks (the suggestion isn't committed and the keyboard freezes for a
beat).

The strategy:

1. On iOS Enter: do **not** preventDefault. Stash a timestamp.
2. Watch the next DOM mutation (`domchange.ts:124`):
   `(browser.ios && lastIOSEnter > Date.now() - 225)` — if the
   mutation looks like an inserted block break, treat it as a
   synthetic Enter and dispatch through `handleKeyDown` so plugins
   that bind Enter (markdown lists, etc.) run.
3. If no mutation arrives within 200ms, fall back: dispatch the
   synthetic Enter anyway (the `setTimeout` callback above).

This means **Enter on iOS is racy by design**. Plugins that bind
Enter must be idempotent — the handler may run from the keydown
fallback or from the DOM-change synthesis, not both.

### 3.2 The magnifier and hit testing

Long-press on text in iOS Safari pops a circular magnifier and a
draggable caret. The magnifier:

- Captures touch events (PM never sees the move).
- Uses **its own** hit-testing — completely independent of
  `posAtCoords` ([17](./17-coordinates-and-hit-testing.md)).
- Drops the caret based on iOS's text-layout heuristics, then fires
  `selectionchange`; PM picks up the new selection from the
  DOMObserver ([15 §6](./15-domobserver-and-domchange.md)).

Implications:

- You **cannot** intercept the magnifier or change where it lands.
- The magnifier respects DOM order, not PM model order — gap-cursor
  positions and atom-boundary positions are unreachable via magnifier.
- After magnifier release, PM's selection mapping resolves the DOM
  selection back to a PM Selection. If the DOM caret landed inside an
  atom NodeView, PM creates a NodeSelection or snaps to the nearest
  textblock boundary.
- Custom NodeViews with `contentEditable="false"` on their root reject
  the caret (the magnifier "skips over" them). Without that flag, the
  user can drop the caret *inside* an atom — then character-level
  arrow-keys move within the atom DOM, which is almost never what you
  want. PM forces this attribute at `viewdesc.ts:708-709`.

### 3.3 Double-tap word selection

iOS double-tap selects the word and shows the bubble menu (Cut/Copy/
Paste/…). The selection comes through as a normal `selectionchange`
event; PM picks it up.

Pitfalls:

- The selection may extend across ZWJ-bonded grapheme clusters in
  ways PM doesn't expect — see [28 §3](./28-i18n-bidi.md) for ZWJ
  handling.
- The bubble menu's "Replace" / "Look Up" / "Translate" can mutate
  the DOM directly (especially "Replace" with autocorrect
  suggestions). The DOMObserver catches it as a generic text edit;
  the diff shows up as `findDiff` (`domchange.ts:353`) and PM
  reconstructs the transaction.

### 3.4 Long-press context menu

Distinct from the magnifier — long-press *outside* a text run (e.g.
on an image) brings up the iOS **context menu** with copy-image / save
options. PM's `contextmenu` handler runs `forceDOMFlush`
(`input.ts:432-434` — actually `input.ts: handlers.contextmenu = view => forceDOMFlush(view)`)
to make sure pending mutations are processed before the system menu
displays.

### 3.5 iOS clipboard quirks (`webkit_version < 604`)

Source: `input.ts:593` —
`browser.ios && browser.webkit_version < 604`. Pre-iOS 11 had a
broken clipboard API; PM detects it and uses fallback paths (see
[16 §5](./16-clipboard.md)). Modern iOS works correctly.

### 3.6 iOS selectionchange firing pattern

iOS fires `selectionchange` aggressively during gestures — sometimes
40-60 events per second during a magnifier drag. PM's DOMObserver
batches via `flushSoon` and `setTimeout(0)` to coalesce. Don't add
custom `selectionchange` listeners that do real work; they will
flood the main thread.

### 3.7 "Click to dismiss keyboard"

A user tap on non-editor chrome (e.g., the toolbar) on iOS *does not*
dismiss the keyboard, because the tap doesn't blur the
contenteditable. Bug pattern: user taps a toolbar button, expects
keyboard to stay open, gets a brief blur/refocus dance instead because
the button receives focus.

Fix: make toolbar buttons `mousedown.preventDefault()` to keep focus
in the editor. Pattern:

```ts
button.addEventListener("mousedown", e => e.preventDefault())
button.addEventListener("touchstart", e => e.preventDefault())
button.addEventListener("click", () => execCommand())
```

PM's input handlers (`input.ts:51-53`) already use passive listeners
where appropriate; the toolbar dance is purely on the consumer side.

---

## 4. Android predictive text

### 4.1 The fundamental problem

Android keyboards (Gboard, SwiftKey, Samsung) do **predictive**
input: as the user taps keys, the keyboard shows candidates above and
*invisibly rewrites the underlying word* as it predicts a better
match. The browser sees this as a stream of:

```
input event (composition update) — "h"
input event (composition update) — "he"
input event (composition update) — "hel"
input event (composition update) — "help"
input event (composition update) — "hello"   ← keyboard guessed it
compositionend
```

…but it can also see **mid-word rewrites**: typing `teh` → keyboard
auto-fixes to `the`, fired as a single mutation that *deletes* `teh`
and *inserts* `the`. There's no synchronous keydown for these, no
`keyCode`, no `key`.

### 4.2 PM's response: long-running composition + diff-based reconciliation

Source citations:

- `input.ts:115` — drop Enter `keydown` on Chrome Android (it's part
  of the autocorrect dance, never a user-initiated newline).
- `input.ts:455` — `const timeoutComposition = browser.android ? 5000 : -1`.
  Android `compositionend` is unreliable, so PM force-ends the
  composition after 5s of inactivity.
- `input.ts:555` — `if (browser.android && view.domObserver.flushingSoon >= 0) return`
  inside `endComposition`. Don't end composition while a flush is
  pending.
- `input.ts:660` — paste is allowed *during* composition on Android
  (`if (view.composing && !browser.android) return`), because Android
  is essentially always composing.
- `input.ts:813` — backspace-after-uneditable-node hack:
  `if (browser.chrome && browser.android && event.inputType == "deleteContentBackward")`.
  PM watches for failed deletion via `domChangeCount`, then **blurs
  and refocuses** the editor (`view.dom.blur(); view.focus()`) to
  reset the keyboard, then runs the registered Backspace handler.
- `domchange.ts:89-91` — synthesize an Enter `keydown` event when
  Chrome Android sends a block-break mutation within 100ms of the
  last key.
- `domchange.ts:194` — `if (browser.android && browser.chrome) view.domObserver.suppressSelectionUpdates()`
  for issue #820 — keyboard's correction stomping on PM's dispatched
  delete.
- `domchange.ts:212-219` — virtual-keyboard "enter-and-pick-suggestion"
  detection (issue #1059): keyboard fires the new-block mutation
  *before* moving selection; PM mutates `change.endB -= 2` and
  dispatches a synthetic Enter.

The pattern: **PM treats Android as a permanently-composing surface**
and reconstructs intent from DOM mutations alone.

### 4.3 Why typing rules behave oddly on Android

Input rules ([19 §6](./19-commands-keymap-inputrules.md)) match on
the inserted text. On Android, the "inserted text" is the
composition's final form, not each character. So:

- `> ` → blockquote: works only after the user types space, because
  composition includes the space.
- `# ` → heading: same.
- `**bold**` → bold mark: works because the closing `**` triggers
  composition end on most keyboards.
- `1. ` → ordered list: works.
- `:smile:` → emoji: depends on whether the keyboard treats `:` as a
  word boundary. Often broken.

Mitigation: write input rules that tolerate composition. The
`prosemirror-inputrules` package's regex matches the *final* text;
that already aligns with composition's semantics.

### 4.4 Backspace on Android Chrome

The hack at `input.ts:812-825` deserves expansion. The pattern:

```
user presses backspace at start of paragraph after an embed node
  ↓
keyboard fires beforeinput { inputType: "deleteContentBackward" }
  ↓
Chrome Android FAILS to delete (the embed is contenteditable=false)
  ↓
PM sees no DOM mutation → composer thinks nothing happened
  ↓
PM detects the failure via domChangeCount, intervenes:
   1. view.dom.blur()    ← closes the keyboard
   2. view.focus()       ← reopens it
   3. dispatch the registered Backspace handler
   4. fall back to tr.delete($cursor.pos - 1, $cursor.pos)
```

The blur/focus is **necessary** because some Android keyboards
silently lock the input field after a "failed" deletion until the
field is re-attached.

Userland implication: don't add custom Backspace handlers that assume
they always run from `keydown`. They can be invoked from
`domchange.ts` synthesis instead. Make them transaction-pure.

### 4.5 Voice / swipe / GIF input

- **Voice (Gboard mic)**: arrives as a single composition with the
  full transcribed sentence. No `keydown` per word. Input rules
  trigger only on the final text.
- **Swipe (gesture typing)**: same — one composition per word.
- **GIF / sticker insertion**: arrives as a `paste`-like event with
  `image/gif` MIME type. PM's clipboard handlers in
  [16 §3](./16-clipboard.md) handle this if the schema accepts
  image nodes; otherwise the insert is dropped.

---

## 5. Touch event handling

### 5.1 Passive listeners

Source: `input.ts:17` —

```ts
const passiveHandlers: Record<string, boolean> = {touchstart: true, touchmove: true}
```

…and `input.ts:51-53`:

```ts
this.view.dom.addEventListener(event, (this as any)[event] = (event: Event) => {
  if (eventBelongsToView(this.view, event) &&
      !runCustomHandler(this.view, event) &&
      (this.view.editable || !(event.type in editHandlers)))
    handler(this.view, event)
}, passiveHandlers[event] ? {passive: true} : undefined)
```

Why passive:

- `touchstart` and `touchmove` are scroll-blocking by default. Browsers
  emit a console warning if you don't declare passivity and your
  handler doesn't `preventDefault`.
- PM's touch handlers don't preventDefault — they only update
  `view.input.lastTouch` and `setSelectionOrigin` (`input.ts:422-430`):

```ts
handlers.touchstart = view => {
  view.input.lastTouch = Date.now()
  forceDOMFlush(view)
  setSelectionOrigin(view, "pointer")
}

handlers.touchmove = view => {
  view.input.lastTouch = Date.now()
  setSelectionOrigin(view, "pointer")
}
```

So `passive: true` is safe and unblocks scrolling.

### 5.2 What PM does *not* handle natively

- **Tap-to-place-caret**: handled by the browser. PM observes via
  `selectionchange`.
- **Swipe-to-scroll**: handled by the browser. PM stays out.
- **Pinch-to-zoom**: handled by the browser; PM coordinates
  ([17 §5](./17-coordinates-and-hit-testing.md)) account for
  `visualViewport.scale` indirectly via `getBoundingClientRect`.
- **Drag-to-select**: handled by the browser's text-selection logic.
  PM's mousedown listener handles desktop drag-to-select; touch goes
  through the browser's own gesture recognizer.

### 5.3 Custom touch UX (drag handles, slash menus)

Userland adds:

- **Block drag handles**: a button rendered to the left of each
  paragraph, draggable to reorder blocks. Anti-pattern: putting
  handles inside the contenteditable as widgets — they interfere with
  caret placement. Better: render outside the editor, position
  absolutely against `coordsAtPos` of each block start.
- **Slash menu**: triggered by typing `/` — pure transaction-driven
  state, no special touch handling needed.
- **Selection toolbar (bubble menu)**: anchor to selection rect from
  `view.coordsAtPos(view.state.selection.from)` and `to`. Shift up by
  a fixed amount; flip below if too close to the top of the visual
  viewport.

```ts
function positionBubbleMenu(view: EditorView, menu: HTMLElement) {
  const sel = view.state.selection
  if (sel.empty) { menu.hidden = true; return }
  const start = view.coordsAtPos(sel.from)
  const end = view.coordsAtPos(sel.to)
  const left = (start.left + end.left) / 2 - menu.offsetWidth / 2
  let top = start.top - menu.offsetHeight - 8
  // flip below if would be hidden by visual viewport top
  const vv = window.visualViewport
  const vvTop = vv ? vv.offsetTop : 0
  if (top < vvTop + 8) top = end.bottom + 8
  menu.style.transform = `translate(${left}px, ${top}px)`
  menu.hidden = false
}
```

---

## 6. selectionchange behavior

### 6.1 iOS — coalesced

iOS Safari coalesces `selectionchange` events at a frame boundary. A
drag gesture that touches 50 distinct positions fires roughly 50
events but at most one per `requestAnimationFrame`. PM's DOMObserver
uses `setTimeout(0)` to defer reading, so it naturally subsamples.

### 6.2 Android — eager + interleaved with input

Android Chrome fires `selectionchange` *during* composition events, in
arbitrary interleavings. PM's DOMObserver suppresses selection
synchronization while a composition is active
([14 §5](./14-ime-composition.md), `domobserver.ts: suppressSelectionUpdates`).

### 6.3 Pitfall: selectionchange on focus loss

When the keyboard closes (user dismisses), DOM focus may briefly leave
the editor and return. Some Android keyboards emit a `selectionchange`
in the gap; PM's `view.focused` check in `input.ts:323` covers this:

```ts
// setting `contenteditable` to false in between, treat it as focused.
```

If you write a custom `selectionchange` listener, gate it on
`view.focused`.

### 6.4 The "ghost selection" problem

Sometimes after a backspace at a paragraph boundary, the DOM selection
points at a nonexistent text node (the parent paragraph was joined
into the previous one). PM's `domSelection` getters return null in
that case; the DOMObserver's next read pulls a fresh selection from
the new structure.

Don't try to read DOM selection in a microtask after a transaction —
use `view.state.selection` instead.

---

## 7. Momentum scrolling and scrollIntoView

### 7.1 iOS overflow-scroll inertia

`overflow: auto` containers on iOS use *momentum* scrolling: a flick
keeps scrolling for ~1 second after touch-end. During that time:

- The user's scroll position is in flux.
- `scrollIntoView` on PM transactions executes immediately, fighting
  the inertia.

Symptom: user types at the bottom, keyboard opens, momentum scroll
from a previous flick is still active, caret bounces.

Mitigation: pause `scrollIntoView` while momentum is active. Detect
via `scroll` event with timestamp gap > 50ms since touch-end:

```ts
let lastTouchEnd = 0
view.dom.addEventListener("touchend", () => { lastTouchEnd = Date.now() })

const origScrollIntoView = view.dom.scrollIntoView
// userland: only suppress your own scroll calls — don't override PM's.
function safeScrollCaretIntoView() {
  if (Date.now() - lastTouchEnd < 600) {
    setTimeout(safeScrollCaretIntoView, 100)
    return
  }
  view.dispatch(view.state.tr.scrollIntoView())
}
```

### 7.2 `-webkit-overflow-scrolling: touch`

Legacy iOS required `-webkit-overflow-scrolling: touch` for momentum.
Modern iOS no longer needs it. Setting it explicitly can confuse
`getBoundingClientRect` on some iOS versions — drop it unless you
support iOS < 13.

### 7.3 The whole-document case

If the editor takes the entire page (no scroll container around it),
the *body* scrolls. `scrollIntoView` then operates on the document and
all the address-bar / visualViewport pitfalls above apply. Wrap the
editor in a sized scroll container if you can — it makes coordinate
math more predictable.

---

## 8. Common mobile pitfalls

### 8.1 Keyboard occluding selection

Already covered in §2.4. The fundamental issue: PM's
`tr.scrollIntoView()` schedules `dom.scrollIntoView({block: "nearest"})`
which uses the *layout* viewport.

### 8.2 Paste-via-share-sheet

iOS share sheet → "Paste from Other App" inserts content via the
`paste` event with limited MIME types. Patterns:

- Plain-text paste from a system share works normally
  ([16 §4](./16-clipboard.md)).
- Image paste from the camera app: `clipboardData.files` populated;
  PM's clipboard parser handles it if the schema accepts an image
  node.
- "Paste from iCloud" can fire async after a delay — PM's paste
  handler runs synchronously and may miss the data on slow networks.
  No good fix; document the limitation.

### 8.3 Drag-handle UX patterns

On mobile, traditional desktop drag-handles (4-dot icon outside the
block) are awkward. Patterns that work:

- **Long-press to enter "block mode"**: long-press blurs the editor,
  selects the touched block as a NodeSelection, shows a floating
  drag-handle plus delete/duplicate buttons.
- **Reorder via "move up / move down"** in a block menu: avoids the
  drag entirely.
- **Native drag-and-drop (HTML5 DnD)**: works on Android Chrome,
  intermittent on iOS Safari (15+). Not portable.

PM's HTML5 drag handlers (`input.ts: dragstart/dragover/drop`,
[13 §6](./13-input-pipeline.md)) are designed for desktop. Mobile
drag-to-reorder is a userland feature.

### 8.4 Autocorrect "stuck word" bug

Symptom: user types a word, autocorrect changes it, user backspaces,
the word reverts to its original form *and the keyboard candidate bar
stays open*. Press Backspace again — no change. User is stuck.

Cause: Android autocorrect maintains its own buffer; PM's transaction
diverges from it after a custom transformation (e.g., input rule
fired during composition).

Mitigation: when an input rule fires inside an active composition,
end the composition first:

```ts
// inside a custom input rule wrapper
if (view.composing) view.input.composing = false
view.dispatch(tr)
```

This is a userland workaround; PM has no built-in for it because the
problem is keyboard-implementation-specific.

### 8.5 Caret invisible after focus

iOS: focusing the editor programmatically doesn't always show the
caret. The `selectionToDOM` call in `view.focus()` (`index.ts:339`)
does the work, but iOS sometimes ignores the selection write if it
came too soon after the focus.

Mitigation:

```ts
view.focus()
requestAnimationFrame(() => {
  // re-apply the selection on the next frame
  (view as any).selectionToDOM?.() ??
    view.dispatch(view.state.tr.setSelection(view.state.selection))
})
```

### 8.6 Tap on padding doesn't focus

If the editor's outer DOM has padding and the user taps in the
padding, the click target is the editor host, but iOS sometimes fails
to place the caret. Workaround: bind a `click` handler on the host
that calls `view.focus()` if no caret moved.

### 8.7 The "invisible" newline

Pressing Enter at the end of an empty paragraph on iOS: the new
paragraph is created, but Mobile Safari sometimes shows the caret
*above* it (in the just-emptied previous paragraph). The visualViewport
hasn't updated, the layout is mid-animation. Wait one frame, then
re-scroll.

### 8.8 Long-press selection on contenteditable=false atoms

iOS long-press on an atom (image, embed) selects it but doesn't show
the bubble menu unless the atom has explicit `user-select: text` /
`-webkit-user-select: text`. Most atoms should have
`user-select: none` so long-press selects the *node*, not interior
text.

---

## 9. WebView quirks

In-app browsers (Twitter, Facebook, Slack, Instagram, …) are *not*
Mobile Safari / Chrome. They run with subtly different feature flags.

### 9.1 iOS in-app (`SFSafariViewController` vs `WKWebView`)

- **SFSafariViewController**: identical to Mobile Safari.
- **WKWebView with custom config**: missing features depending on the
  host app's setup. Common gotchas:
  - `clipboardData.files` may be empty (image paste broken).
  - `visualViewport` may not fire `resize` reliably.
  - Custom user-agent makes `browser.ios` detection brittle —
    `browser.ts` matches `/Apple Computer/` vendor + iOS UA, which
    *should* still hold but check.

### 9.2 Android in-app (Custom Tabs vs WebView)

- **Custom Tabs**: identical to Chrome.
- **android.webkit.WebView**: legacy engine, lags Chrome by 6-12
  months. JavaScript engine differences, fewer modern CSS features.
  Don't assume `visualViewport` or `interactive-widget` work.

### 9.3 Detection

Best-effort:

```ts
function isInAppBrowser() {
  const ua = navigator.userAgent
  return (
    /FBAN|FBAV|Instagram|Twitter|Line|MicroMessenger|Snapchat/.test(ua) ||
    // Generic WebView markers
    /; wv\)/.test(ua)
  )
}
```

Strategy when detected: degrade gracefully. Disable features that
require IME parity (slash menu autocomplete, predictive emoji), warn
the user, link to "open in browser".

### 9.4 The "Open in Safari" button

Many apps offer this. Recommendation: link the user out for any
serious editing. Document in your app that in-app browsers are
unsupported for the editor.

---

## 10. Testing matrix

Real devices are the only honest test. Recommended floor:

| Device                | OS      | Browser / WebView         | Why |
| --------------------- | ------- | ------------------------- | --- |
| iPhone SE 3rd gen     | iOS 17+ | Mobile Safari             | Smallest viewport, most agressive autocorrect |
| iPhone 14 Pro         | iOS 17+ | Mobile Safari, Chrome iOS | Dynamic island viewport edge |
| iPad Air              | iPadOS  | Safari (desktop UA)       | iPadOS desktop-mode ↔ mobile-mode toggling |
| Pixel 6a              | Android 14 | Chrome, Firefox        | Stock Gboard predictive text |
| Samsung Galaxy S23    | Android 14 | Samsung Internet, Chrome | Samsung Keyboard's distinct composition behavior |
| iPhone in Twitter app | iOS 17+ | WKWebView                 | Most common in-app webview |

Testing scenarios per device:

1. Type a paragraph; verify each character appears.
2. Trigger autocorrect; verify the corrected word commits.
3. Type `> ` at start; verify blockquote input rule fires.
4. Type `# ` at start; verify heading.
5. Press Enter mid-paragraph; verify split.
6. Press Backspace at paragraph start (should join with previous).
7. Press Backspace right after an image; verify image deletion (not
   caret stuck).
8. Long-press text; verify bubble menu and selection.
9. Tap inside a long-press selection; verify caret placement.
10. Open keyboard; verify caret remains visible (not occluded).
11. Type and immediately scroll while keyboard is open.
12. Paste plain text from system clipboard.
13. Paste an image (Android: from Gboard image picker; iOS: from
    Photos via share sheet).
14. Voice-input a sentence; verify final transcription is one
    transaction.
15. Swipe-type a sentence (Gboard); verify result.
16. Switch browsers (Chrome ↔ Firefox on Android, Safari ↔ Chrome on
    iOS) and repeat 1–10.

For automation: Playwright with the iPhone / Pixel emulation profile
*does not* exercise IME, predictive text, or magnifier. Treat
emulator passes as smoke tests, not coverage.

---

## 11. Cross-references

This file pulls together pieces from:

- [13 §7 — Touch handlers and passive listeners](./13-input-pipeline.md)
- [14 §7a — `lastIOSEnter`](./14-ime-composition.md)
- [14 §7b — Android composition timeout](./14-ime-composition.md)
- [15 §6 — `selectionchange` coalescing](./15-domobserver-and-domchange.md)
- [16 §5 — iOS clipboard ≤ 11](./16-clipboard.md)
- [17 §5 — `visualViewport` and coordinate math](./17-coordinates-and-hit-testing.md)
- [18 §2.1 — Android quirks table](./18-cross-browser-quirks.md)
- [18 §2.2 — Gecko / WebKit drag handling](./18-cross-browser-quirks.md)
- [19 §6 — Input rules under composition](./19-commands-keymap-inputrules.md)
- [21 §5 — `tr.scrollIntoView` mechanics](./21-rendering-pipeline-end-to-end.md)
- [22 §10 — Mobile-specific gotchas in the war-story manual](./22-edge-cases-and-pitfalls.md)
- [23 §4–§5 — A11y on mobile (NodeViews, live regions)](./23-accessibility.md)
- [28 §3 — Bidi/IME interactions](./28-i18n-bidi.md)

---

## 12. Honest summary: what mobile costs you

PM's mobile support is a *triumph of defensive engineering*:

- Treats Android as permanently composing.
- Synthesizes Enter from DOM mutations on iOS and Android.
- Blurs/refocuses to recover from keyboard lockups.
- Force-ends compositions after 5s of inactivity.
- Allows paste during composition (otherwise users could never
  paste on Android).

But it stops at "stable text editing". Everything modern users
expect on mobile — visualViewport-aware scrolling, drag handles,
bubble menus, presence-aware live regions, keyboard-occlusion
recovery — is **userland**. Plan for at least 30% of the editor
implementation budget to be mobile-specific UX glue, separate from
schema/transactions/state.

The most common production bug class: a feature works on desktop
Chrome, the developer skips manual testing on a Pixel, ships, and
discovers that Gboard's autocorrect breaks the input rule that
triggered the feature in the first place. Real-device testing is
not optional.
