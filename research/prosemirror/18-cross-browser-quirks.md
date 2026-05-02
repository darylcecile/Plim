# 18 — Cross-Browser Quirks

This is the bug-and-workaround index for `prosemirror-view`. Every flag
in [`browser.ts`](https://github.com/ProseMirror/prosemirror-view/blob/master/src/browser.ts)
is enumerated, every site that branches on it across `src/` is listed
with the bug it works around, and all the structural workarounds —
zero-width-space tricks, `contenteditable=false` placeholders, hack
`<br>`/`<img>` nodes, pre-emptive blur, focus reset — are catalogued.

This file is meant to be the master reference for "why does PM check
that flag here?" questions when porting the editor model.

---

## 1. The `browser.ts` inventory

Source: [`browser.ts`](https://github.com/ProseMirror/prosemirror-view/blob/master/src/browser.ts) (24 lines).

```ts
const nav = typeof navigator != "undefined" ? navigator : null
const doc = typeof document != "undefined" ? document : null
const agent = (nav && nav.userAgent) || ""

const ie_edge   = /Edge\/(\d+)/.exec(agent)                         // legacy Edge (EdgeHTML)
const ie_upto10 = /MSIE \d/.exec(agent)
const ie_11up   = /Trident\/(?:[7-9]|\d{2,})\..*rv:(\d+)/.exec(agent)

export const ie         = !!(ie_upto10 || ie_11up || ie_edge)
export const ie_version = ie_upto10 ? document.documentMode
                          : ie_11up ? +ie_11up[1]
                          : ie_edge ? +ie_edge[1]
                          : 0
export const gecko         = !ie && /gecko\/(\d+)/i.test(agent)
export const gecko_version = gecko && +(/Firefox\/(\d+)/.exec(agent) || [0,0])[1]

const _chrome              = !ie && /Chrome\/(\d+)/.exec(agent)
export const chrome        = !!_chrome
export const chrome_version = _chrome ? +_chrome[1] : 0

export const safari = !ie && !!nav && /Apple Computer/.test(nav.vendor)
// Is true for both iOS and iPadOS for convenience
export const ios    = safari && (/Mobile\/\w+/.test(agent) ||
                                 !!nav && nav.maxTouchPoints > 2)
export const mac     = ios || (nav ? /Mac/.test(nav.platform)  : false)
export const windows = nav ? /Win/.test(nav.platform) : false
export const android = /Android \d/.test(agent)
export const webkit  = !!doc && "webkitFontSmoothing" in doc.documentElement.style
export const webkit_version = webkit ? +(/\bAppleWebKit\/(\d+)/.exec(navigator.userAgent) || [0,0])[1] : 0
```

| Flag           | Detection method                                                              | Notes |
| -------------- | ----------------------------------------------------------------------------- | ----- |
| `ie`           | UA matches `MSIE`, `Trident/`, or `Edge/`                                     | Includes legacy (EdgeHTML) Edge — Chromium-Edge identifies as Chrome and is **not** flagged `ie`. |
| `ie_version`   | `document.documentMode` (≤10), Trident `rv:`, or Edge version                 | `0` when not IE. |
| `gecko`        | `!ie && /gecko\/(\d+)/i.test(agent)`                                          | Firefox & forks. |
| `gecko_version`| Firefox version captured by `/Firefox\/(\d+)/`                                | Currently unused — declared but never branched on. |
| `chrome`       | `!ie && /Chrome\/(\d+)/.exec(agent)`                                          | Includes Chromium Edge, Brave, Opera. |
| `chrome_version`| Chrome major version, `0` otherwise                                          | Used to gate two specific bug fixes. |
| `safari`       | `!ie && navigator.vendor matches "Apple Computer"`                            | Desktop & iOS Safari. |
| `ios`          | `safari && (/Mobile\/\w+/ || maxTouchPoints > 2)`                             | True for iPadOS desktop-mode (`maxTouchPoints > 2` covers the case where iPad ships a desktop UA). |
| `mac`          | `ios || /Mac/.test(navigator.platform)`                                       | Drives Cmd-vs-Ctrl modifier choice. |
| `windows`      | `/Win/.test(navigator.platform)`                                              | Used to suppress one specific composition workaround. |
| `android`      | `/Android \d/.test(agent)`                                                    | Cuts deep into composition / beforeinput handling. |
| `webkit`       | `"webkitFontSmoothing" in documentElement.style`                              | Capability-style probe — true for Chrome **and** Safari. |
| `webkit_version`| `AppleWebKit/...` UA capture                                                 | Only used to gate broken iOS clipboard (`< 604`). |

### Subtleties

- `webkit` is **true on Chrome** because Blink retains the
  `webkitFontSmoothing` style. So a check like `if (browser.webkit)` is
  a "WebKit-or-Blink" check, while `if (browser.safari)` is
  "Apple Safari only" and `if (browser.chrome)` is "Chrome / Chromium
  family".
- `ie` is computed first and excluded from `gecko`, `chrome`, `safari` so
  the four families are mutually exclusive (safari ∩ chrome could happen
  on weird UAs but Chrome on macOS doesn’t set `Apple Computer` as
  vendor, so they are usually disjoint).
- `mac` includes iOS — keep that in mind: a `browser.mac` branch fires
  on iPhone/iPad too. Modifier keys differ between truly-mac (Cmd) and
  iOS (no real modifier interaction).
- `gecko_version` is exported but never read inside the package — it’s
  there for downstream consumers.

---

## 2. Bugs and workarounds, by browser

References use `file:line` notation against
`prosemirror-view/src/`.

### 2.1 Android (`browser.android`)

Android **lies about composition events** and routes everything through
`beforeinput`/MutationObserver. PM treats Android composition as
near-permanent and avoids preventing default on most key events.

| Site                              | Behaviour |
| --------------------------------- | --------- |
| `input.ts:115` `if (browser.android && browser.chrome && event.keyCode == 13) return` | "Suppress enter key events on Chrome Android, because those tend to be part of a confused sequence of composition events fired, and handling them eagerly tends to corrupt the input." (`input.ts:112-115`) |
| `input.ts:455` `const timeoutComposition = browser.android ? 5000 : -1` | "Drop active composition after 5 seconds of inactivity on Android." On Android `compositionend` is unreliable so PM force-ends the composition after a timeout. |
| `input.ts:555` `if (browser.android && view.domObserver.flushingSoon >= 0) return` (inside `endComposition`) | Avoid ending a composition while the observer has a pending flush. |
| `input.ts:660` `if (view.composing && !browser.android) return` (paste) | "On Android, the editor is almost always composing." Allow paste to run **even during composition** because otherwise the user can’t paste at all. |
| `input.ts:813` `if (browser.chrome && browser.android && event.inputType == "deleteContentBackward")` | "Very specific hack to deal with backspace sometimes failing on Chrome Android when after an uneditable node." Watches for failed deletion via `domChangeCount` (`input.ts:815-825`), then **`view.dom.blur()`** + **`view.focus()`** (because the bug typically closes the virtual keyboard) and runs the registered `Backspace` handler. Falls back to a manual `tr.delete($cursor.pos - 1, $cursor.pos)`. This is the "pre-emptive blur, reset focus" workaround. |
| `domchange.ts:89-91` Enter detection on Chrome Android | When `lastKeyCode === 13` within 100ms and the DOM diff did anything, fire a synthetic `Enter` keydown so plugins react predictably. |
| `domchange.ts:124` `(browser.ios && lastIOSEnter > Date.now() - 225) \|\| browser.android` | Convert "an inserted block" mutation into a synthetic Enter key. Android virtual keyboards often replace the line break with a re-laid-out paragraph. |
| `domchange.ts:194` `if (browser.android && browser.chrome) view.domObserver.suppressSelectionUpdates()` | Workaround for issue #820 — after backspace-as-keydown, suppress selection updates briefly so the keyboard's own correction doesn't replace the dispatched delete. |
| `domchange.ts:212-219` Android virtual-keyboard paragraph-suggestion fix | "This tries to detect Android virtual keyboard enter-and-pick-suggestion action. That sometimes (see issue #1059) first fires a DOM mutation, before moving the selection to the newly created block. And then, because ProseMirror cleans up the DOM selection, it gives up moving the selection entirely, leaving the cursor in the wrong place." Mutates `change.endB -= 2` and dispatches a synthetic Enter. |
| `domobserver.ts` (no direct branch but the entire `flushSoon`/`forceFlush` machinery exists primarily for Android timing) | n/a |

**Mobile-specific concerns** (Android):
- Predictive text rewrites are visible only as `MutationObserver` text
  edits — PM's `findDiff` (`domchange.ts:353-377`) is what makes
  inferred typing work.
- "Smart" autocomplete that selects a suggestion sometimes fires Enter
  *after* the new block has been inserted; the
  `domchange.ts:212-219` heuristic detects this.
- Virtual keyboards spuriously close on focus changes; the
  `dom.blur()`/`view.focus()` dance in `input.ts:818-820` reopens it.
- `keydown` for Enter is suppressed (`input.ts:115`) so the keyboard's
  own "send" behaviour doesn’t double-fire.

### 2.2 iOS (`browser.ios`)

iOS Safari has its own list of pain.

| Site                            | Behaviour |
| ------------------------------- | --------- |
| `input.ts:122-130` `if (browser.ios && event.keyCode == 13 && !ctrlKey && !altKey && !metaKey)` | "On iOS, if we preventDefault enter key presses, the virtual keyboard gets confused. So the hack here is to set a flag (`view.input.lastIOSEnter`) that makes the DOM change code recognize that what just happens should be replaced by whatever the Enter key handlers do." Also schedules a 200ms fallback timer that synthesises an Enter keydown if `lastIOSEnter` hasn't been consumed yet. |
| `input.ts:73` `clearTimeout(view.input.lastIOSEnterFallbackTimeout)` | Cleared on `destroyInput`. |
| `domchange.ts:124-130` consumes `lastIOSEnter > Date.now() - 225` to recognise the inserted block as an Enter | The 225ms window is the iOS virtual keyboard latency. |
| `domchange.ts:181-189` second iOS-Enter detector | If the mutation looks like an inline change but `addedNodes` contains a `DIV` or `P`, treat it as Enter as well. |
| `viewdesc.ts:811` `if (browser.ios) iosHacks(this.dom as HTMLElement)` (inside `BlockNodeViewDesc.update`) | Triggers `iosHacks` (`viewdesc.ts:1531-1540`): "List markers in Mobile Safari will mysteriously disappear sometimes. This works around that." Implementation toggles `list-style: square !important`, calls `getComputedStyle(...).listStyle` to force a recompute, then restores the original style. |
| `input.ts:592-593` `brokenClipboardAPI = (browser.ie && ie_version < 15) \|\| (browser.ios && webkit_version < 604)` | Old iOS WebKit's clipboard objects exist but are non-functional, forcing the `captureCopy`/`capturePaste` invisible-textarea fallback (`input.ts:568-587, 618-632`). |

**Mobile-specific concerns** (iOS):
- **Long-press menu**: PM does not branch on long-press explicitly but
  the touch handlers in `input.ts:422-431` set `lastTouch` so PM can
  later distinguish touch-driven focus from mouse-driven focus.
- **Selection drift**: `domobserver.ts:228-234` detects "browser reset
  the selection to the start of the document right after focus" by
  checking that the current DOM selection equals
  `Selection.near(doc.resolve(0), 1)` and that the focus event was
  recent. If so, restore the model's selection and `scrollToSelection`.
  iOS triggers this case repeatedly when the keyboard closes.
- **Caret in empty paragraph**: covered structurally by the trailing-BR
  hack node (`viewdesc.ts:1373-1394` + `ProseMirror-trailingBreak`
  CSS class). Without a trailing `<br>`, an empty paragraph is
  zero-height on iOS.
- **Autocorrect/predictive text**: again, picked up purely as DOM
  mutations and reconciled via `findDiff` in `domchange.ts`.
- **Swipe input**: same MutationObserver-based reconciliation.

### 2.3 Safari macOS (`browser.safari` and not `browser.ios`)

Safari has the deepest pile of quirks because its WebKit composition
and contentEditable bugs are unique.

| Site                                  | Behaviour |
| ------------------------------------- | --------- |
| `input.ts:58` `if (browser.safari) view.dom.addEventListener("input", () => null)` | "On Safari, for reasons beyond my understanding, adding an input event handler makes an issue where the composition vanishes when you press enter go away." (`input.ts:55-58`) |
| `input.ts:391` `(browser.safari && this.mightDrag && !this.mightDrag.node.isAtom)` | "Safari ignores clicks on draggable elements" — at click-up, force a fresh `Selection.near` if the click didn't dispatch through. |
| `input.ts:447-450` `compositionEndedAt` heuristic | "On Japanese input method editors (IMEs), the Enter key is used to confirm character selection. On Safari, when Enter is pressed, compositionend and keydown events are emitted. The keydown event triggers newline insertion, which we don't want." Window of 500ms after `compositionend.timeStamp`. |
| `selection.ts:108` `brokenSelectBetweenUneditable = browser.safari \|\| (browser.chrome && chrome_version < 63)` | "Webkit not allowing a selection to start/end between non-editable block nodes. We briefly make something editable, set the selection, then set it uneditable again." (`selection.ts:104-126`) |
| `selection.ts:114` `if (browser.safari && after && after.contentEditable == "false") return setEditable(after)` | Inside `temporarilyEditableNear`: Safari is even pickier than old Chrome — needs the `after` element to be made editable specifically. |
| `selection.ts:124` `if (browser.safari && element.draggable) { element.draggable = false; element.wasDraggable = true }` | Safari treats `draggable=true` as eating selection — disable `draggable` for the duration of the temporary edit, restored in `resetEditable` (`:130`). |
| `selection.ts:295` (referenced via `safariDownArrowBug` in `capturekeys.ts:294-304`) | "Issue #867 / #1090 / chromium 903821 — Safari does really wrong things when the down arrow is pressed when the cursor is directly at the start of a textblock and has an uneditable node after it." Workaround: `switchEditable(view, child, "true")`, then `setTimeout(...20ms, switchEditable(view, child, "false"))`. |
| `viewdesc.ts:426` `if ((browser.gecko \|\| browser.safari) && anchor == head)` (`brKludge`) | "On Safari, the cursor sometimes inexplicably visually lags behind its reported position in such situations (#1092)." See `viewdesc.ts:421-446`. |
| `viewdesc.ts:454` `if (!(force \|\| brKludge && browser.safari) && ...)` | Skip the equivalent-position early return when Safari needs the BR kludge. |
| `viewdesc.ts:1378` `if ((browser.safari \|\| browser.chrome) && lastChild && lastChild.contentEditable == "false") this.addHackNode("IMG", parent)` | "Avoid bugs in Safari's cursor drawing (#1165) and Chrome's mouse selection (#1152)." Inserts a hidden `IMG.ProseMirror-separator` after the last uneditable child so the cursor has a place to go. |
| `domchange.ts:66` `if (browser.safari && /^(ul\|ol)$/i.test(dom.parentNode.nodeName))` | "Safari replaces the list item or table cell with a BR directly in the list node (?!) if you delete the last character in a list item or table cell (#708, #862)." Substitutes a fake `<div><li></li></div>` into the parse rule. |
| `domchange.ts:70` `else if (... \|\| browser.safari && /^(tr\|table)$/i.test(...))` | Same bug, table variant — ignore the stray `<br>`. |
| `domobserver.ts:63-72` `else if (browser.safari && view.composing && mutations.some(m => m.type == "childList" && m.target.nodeName == "TR"))` | "Safari does weird stuff when finishing a composition in a table cell, which tends to involve inserting inappropriate nodes in the table row." Sets `view.input.badSafariComposition = true` and schedules a flush. The flag is consumed in `input.ts:508` (`if (badSafariComposition) view.domObserver.forceFlush()`) and `domobserver.ts:241-243` (`fixUpBadSafariComposition`). |
| `domobserver.ts:367-392` `fixUpBadSafariComposition` | Walks added nodes, detects ones that ended up inside a `<tr>`, and moves them into the next cell's deepest non-leaf descendant; if no following cell exists, removes them. |
| `domobserver.ts:332-357` `safariShadowSelectionRange` | "Used to work around a Safari Selection/shadow DOM bug. Based on `https://github.com/codemirror/dev/issues/414` fix." Tries `selection.getComposedRanges(view.root)` first; if missing, "we have to perform a ridiculous hack to get at it—using `execCommand` to trigger a `beforeInput` event so that we can read the target range from the event." Calls `document.execCommand("indent")` with a `beforeinput` listener installed. Consumed by `index.ts:500-501` only when `view.root.nodeType === 11` (shadow root) and `deepActiveElement(...) == view.dom`. |

### 2.4 Chrome (`browser.chrome`)

| Site                                        | Behaviour |
| ------------------------------------------- | --------- |
| `index.ts:191-192` `let forceSelUpdate = updateDoc && (browser.ie \|\| browser.chrome) && !this.composing && ...` | "Work around an issue in Chrome, IE, and Edge where changing the DOM around an active selection puts it into a broken state where the thing the user sees differs from the selection reported by the Selection object (#710, #973, #1011, #1013, #1035)." |
| `index.ts:198` `let chromeKludge = browser.chrome ? (this.trackWrites = this.domSelectionRange().focusNode) : null` | "If the node that the selection points into is written to, Chrome sometimes starts misreporting the selection, so this tracks that and forces a selection reset when our update did write to the node." Triggered at `index.ts:205`. |
| `selection.ts:64` `if (!force && view.input.mouseDown && view.input.mouseDown.allowDefault && browser.chrome)` | "The delayed drag selection causes issues with Cell Selections in Safari. And the drag selection delay is to workaround issues which only present in Chrome." Skip the immediate selection sync if Chrome is mid-drag. |
| `selection.ts:108` (combined with safari) `chrome && chrome_version < 63` | Pre-Chrome-63 needed the `brokenSelectBetweenUneditable` workaround alongside Safari. |
| `viewdesc.ts:1378` (combined with safari) | Hack `<img>` ahead of trailing uneditable node (#1152). |
| `capturekeys.ts:225` `if (!(browser.chrome \|\| browser.windows) && $pos.parent.inlineContent)` (`findDirection`) | Geometric LTR/RTL detection via `coordsAtPos` is **disabled** on Chrome and Windows because the rect comparisons are unreliable; falls back to `getComputedStyle(view.dom).direction`. |
| `domchange.ts:28-34` `if (browser.chrome && view.input.lastKeyCode === 8)` | "Work around issue in Chrome where backspacing sometimes replaces the deleted content with a random BR node (issues #799, #831)." Walks back from `toOffset` skipping bogus `BR` siblings before parsing. |
| `domchange.ts:201` `if (browser.chrome && change.endB == change.start) view.input.lastChromeDelete = Date.now()` | "Chrome will occasionally, during composition, delete the entire composition and then immediately insert it again." Tracked to avoid re-entering the bad state. |
| `domchange.ts:233-235` `if (sel && !(browser.chrome && view.composing && sel.empty && (... \|\| view.input.lastChromeDelete < Date.now() - 100) && (sel.head == chFrom \|\| sel.head == tr.mapping.map(chTo) - 1))` | "Chrome will sometimes, during composition, report the selection in the wrong place. If it looks like that is happening, don't update the selection." |
| `input.ts:399-401` Chrome cursor-vs-node selection mismatch | "Chrome will sometimes treat a node selection as a cursor, but still report that the node is selected when asked through getSelection. You'll then get a situation where clicking at the point where that (hidden) cursor is doesn't change the selection, and thus doesn't get a reaction from ProseMirror." Apply `Selection.near` when the click pos is within 2 of the node selection extent. |
| `input.ts:464` `browser.chrome && browser.windows && selectionBeforeUneditable(view)` | Issue #1500 — Chrome on Windows starts compositions inside `contenteditable=false` siblings. Forces `endComposition(view, true)` ahead of time. |
| `input.ts:701` `!event.dataTransfer.files.length \|\| !browser.chrome \|\| browser.chrome_version > 120` | "Pre-120 Chrome versions clear files when calling `clearData` (#1472)." Skip `clearData()` on those versions. |
| `input.ts:813` `if (browser.chrome && browser.android && event.inputType == "deleteContentBackward")` | See Android section above. |
| `clipboard.ts:242` `dom.querySelectorAll(browser.chrome ? "span:not([class]):not([style])" : "span.Apple-converted-space")` | "Webkit browsers do some hard-to-predict replacement of regular spaces with non-breaking spaces when putting content on the clipboard. This tries to convert such non-breaking spaces (which will be wrapped in a plain span on Chrome, a span with class Apple-converted-space on Safari) back to regular spaces." (`clipboard.ts:236-248`) |

**Chrome-specific paste meta tag**: `clipboard.ts:225` strips leading
`<meta>` tags via `/^(\s*<meta [^>]*>)*/` because Chrome inserts
`<meta charset>` at the start of clipboard HTML. This isn't gated on a
`browser.chrome` check — it's done unconditionally because parsing the
meta tag wouldn't hurt other browsers.

### 2.5 Firefox / Gecko (`browser.gecko`)

Firefox has surprisingly subtle bugs around `contenteditable=false`,
selection-after-blur, and bidi.

| Site                                           | Behaviour |
| ---------------------------------------------- | --------- |
| `viewdesc.ts:426` `(browser.gecko \|\| browser.safari) && anchor == head` | "On Firefox, using `Selection.collapse` to put the cursor after a BR node for some reason doesn't always work (#1073)." Sets `brKludge` and switches to issue-#1128 navigation up to the first BR sibling. |
| `viewdesc.ts:449-452` `if (browser.gecko && selRange.focusNode && ... selRange.focusNode.nodeType == 1)` | "Firefox can act strangely when the selection is in front of an uneditable node. See #1163 and bugzilla 1709536." Forces a re-set if there's a `contentEditable=false` child after the focus. |
| `viewdesc.ts:463` `(domSel.extend \|\| anchor == head) && !(brKludge && browser.gecko)` | Avoid `Selection.extend` when Gecko is in BR-kludge mode. |
| `capturekeys.ts:81` `if (browser.gecko && node.nodeType == 1 && offset < nodeLen(node) && isIgnorable(node.childNodes[offset], -1)) force = true` | "Gecko will do odd things when the selection is directly in front of a non-editable node, so in that case, move it into the next node if possible. Issue prosemirror/prosemirror#832." (Inside `skipIgnoredNodesBefore`.) |
| `domobserver.ts:208-222` `else if (browser.gecko && added.length)` | Strip duplicate stray `<br>` nodes that Gecko's input-handler injects. Two-BR case: remove one of them; otherwise remove BRs that ended up directly inside a `<li>` (unless that's where the focus is). |
| `domobserver.ts:258-259` Firefox spurious empty `style` attribute fix | Inside `registerMutation`: ignore `style` attribute mutations whose old + new value are both falsy ("Firefox sometimes fires spurious events for null/empty styles"). |
| `domobserver.ts:312` `view.requiresGeckoHackNode = browser.gecko` | Set inside `checkCSS` (only when the user's CSS overrides `white-space`). The flag is consumed in `viewdesc.ts:1376` to add a trailing `<br>` whenever the last text node ends in whitespace, so Gecko renders the trailing space. |
| `domcoords.ts:296-308` Firefox `caretPositionFromPoint` fix | Clamp offsets returned for `<input>` (#953) and bump past images that Gecko returned a too-low offset for. |
| `domcoords.ts:357-367` Firefox empty-range whitespace miscount | See `17-coordinates-and-hit-testing.md` §2.2. |
| `domcoords.ts:488` `let oldBidiLevel = sel.caretBidiLevel // Only for Firefox` | Save and restore Firefox's non-standard caret bidi level around `Selection.modify` probe. |
| `dom.ts:147` `try { ... caretPositionFromPoint ... } catch (_) {}` | "Firefox throws for this call in hard-to-predict circumstances (#994)." |
| `selection.ts:202-208` `try ... catch (_) { return false }` (`hasSelection`) | "Firefox will raise 'permission denied' errors when accessing properties of `sel.anchorNode` when it's in a generated CSS element." |
| `input.ts:343` `setUneditable: !!(this.target && browser.gecko && !this.target.hasAttribute("contentEditable"))` | When mouse-down lands on a draggable target on Gecko, PM temporarily sets the target's `contentEditable="false"` (after a 20ms delay, `:351`) so Firefox lets us drag a non-atomic node. Cleared on `done()` (`input.ts:367`) and reset by `wasDraggable`. |
| `input.ts:474-488` `if (browser.gecko && state.selection.empty && $pos.parentOffset && !$pos.textOffset && $pos.nodeBefore.marks.length)` (compositionstart) | "In firefox, if the cursor is after but outside a marked node, the inserted text won't inherit the marks. So this moves it inside if necessary." Manually moves the DOM caret into the previous text node. |

### 2.6 Internet Explorer / Legacy Edge (`browser.ie`, `browser.ie_version`)

These branches still ship even though IE is dead — the code is
defensive and disabled for non-IE.

| Site                                  | Behaviour |
| ------------------------------------- | --------- |
| `index.ts:191` `(browser.ie \|\| browser.chrome) && !this.composing` | Same forceSelUpdate selection sync as Chrome. |
| `index.ts:321-332` `if (browser.ie) { ... resize-handles activeElement walk ... }` (`hasFocus`) | "Work around IE not handling focus correctly if resize handles are shown. If the cursor is inside an element with resize handles, activeElement will be that element instead of this.dom." Walk parents accepting any chain of normal elements. |
| `selection.ts:160-163` `if (!img && !view.state.selection.visible && browser.ie && browser.ie_version <= 11) { node.disabled = true; node.disabled = false }` | "Kludge to kill 'control selection' in IE11 when selecting an invisible cursor wrapper, since that would result in those weird resize handles and a selection that considers the absolutely positioned wrapper, rather than the root editable node, the focused element." |
| `domobserver.ts:16` `const useCharData = browser.ie && browser.ie_version <= 11` | "IE11 has very broken mutation observers, so we also listen to DOMCharacterDataModified" — fallback events are queued into the same MutationObserver pipeline (`:74-79, :101-115`). |
| `domobserver.ts:55-62` `if (browser.ie && browser.ie_version <= 11 && mutations.some(m => m.type == "childList" && m.removedNodes.length \|\| m.type == "characterData" && m.oldValue.length > m.target.nodeValue.length))` | "IE11 will sometimes (on backspacing out a single character text node after a BR node) call the observer callback before actually updating the DOM, which will cause ProseMirror to miss the change (see #930)." Defer flush. |
| `domobserver.ts:138-142` `if (browser.ie && browser.ie_version <= 11 && !this.view.state.selection.empty)` | "Deletions on IE11 fire their events in the wrong order, giving us a selection change event before the DOM changes are reported." Plus "Selection.isCollapsed isn't reliable on IE", so PM uses `isEquivalentPosition` to detect the collapsed-after-delete pattern and `flushSoon`. |
| `domobserver.ts:272-280` `if (browser.ie && browser.ie_version <= 11 && mut.addedNodes.length)` | "IE11 gives us incorrect next/prev siblings for some insertions, so if there are added nodes, recompute those." |
| `domchange.ts:167-173` `if (browser.ie && browser.ie_version <= 11 && change.endB == change.start + 1 && ...)` | "IE11 will insert a non-breaking space _ahead_ of the space after the cursor when adding a space before another space. When that happened, adjust the change to cover the space instead." |
| `domchange.ts:236` `browser.ie && sel.empty && sel.head == chFrom` | "Edge just doesn't move the cursor forward when you start typing in an empty block or between br nodes." Don't apply the parsed-selection. |
| `domchange.ts:248-251` `if (browser.ie && browser.ie_version <= 11 && $from.parentOffset == 0)` | "IE11 sometimes weirdly moves the DOM selection around after backspacing out the first element in a textblock." `suppressSelectionUpdates()` + `selectionToDOM` on a 20ms timeout. |
| `input.ts:567-587` `captureCopy` | "The extra wrapper is somehow necessary on IE/Edge to prevent the content from being mangled when it is put onto the clipboard." Plus `view.dom.blur()` (the **pre-emptive blur**) before `removeAllRanges` because "IE will fire a `selectionchange` moving the selection to its start when `removeAllRanges` is called and the editor still has focus (which will mess up the editor's selection state)." |
| `input.ts:592-593` `brokenClipboardAPI = (browser.ie && ie_version < 15) \|\| ...` | IE/Edge clipboard API is "completely broken — they pretend that they have a clipboard API, all the objects and methods are there, they just don't work." Routes through `captureCopy`/`capturePaste` instead. |
| `domcoords.ts:126` `if (dom.setActive) return dom.setActive() // in IE` | IE-only `setActive()` for scroll-preserving focus before standardised `focus({preventScroll})` was a thing. |
| `domcoords.ts:478` `\|\| !sel.modify` | Selection.modify isn't on legacy Edge — fall back to plain at-start/at-end test. |

### 2.7 macOS / `browser.mac`

`mac` flips modifier keys and selection-modifier conventions.

| Site                                  | Behaviour |
| ------------------------------------- | --------- |
| `capturekeys.ts:33` `if (!(browser.mac && mods.indexOf("m") > -1))` | macOS Cmd-arrow does word/line jumps natively — don't override with node-selection logic. |
| `capturekeys.ts:250` `if (browser.mac && mods.indexOf("m") > -1) return false` | Same, vertical motion. |
| `capturekeys.ts:324, 326, 330, 333, 336, 338, 340` | Emacs-style Ctrl bindings (Ctrl-h, Ctrl-d, Ctrl-b, Ctrl-f, Ctrl-p, Ctrl-n, Mod-b/i/y/z) only on Mac. |
| `input.ts:145` `event.ctrlKey && !event.altKey \|\| browser.mac && event.metaKey` | Skip keypress dispatch when modifier-only; on Mac, `metaKey` (Cmd) shouldn't trigger text input. |
| `input.ts:276` `const selectNodeModifier = browser.mac ? "metaKey" : "ctrlKey"` | Cmd-click selects nodes on Mac, Ctrl-click elsewhere. |
| `input.ts:673` `const dragCopyModifier = browser.mac ? "altKey" : "ctrlKey"` | Mac uses Option for drag-copy; others use Ctrl. |

### 2.8 `browser.windows`

| Site                                  | Behaviour |
| ------------------------------------- | --------- |
| `capturekeys.ts:225` (combined with chrome) | Disable geometric direction probe. |
| `input.ts:464` (combined with chrome) | Issue #1500 composition kludge. |

### 2.9 `browser.webkit`

WebKit-or-Blink; covers Chrome and Safari simultaneously.

| Site                                  | Behaviour |
| ------------------------------------- | --------- |
| `clipboard.ts:70` `if (browser.webkit) restoreReplacedSpaces(dom)` | Both Chrome and Safari mangle whitespace on copy; restore. |
| `capturekeys.ts:40` `else if (browser.webkit) { ... apply(view, new TextSelection(...)) }` | "Chrome and Safari will introduce extra pointless cursor positions around inline uneditable nodes, so we have to take over and move the cursor past them (#937)." |
| `domcoords.ts:311` `if (browser.webkit && offset && node.nodeType == 1 && (prev = node.childNodes[offset - 1]).nodeType == 1 && prev.contentEditable == "false" && prev.getBoundingClientRect().top >= coords.top) offset--` | Click above an uneditable node returns position after it; correct it. |
| `domcoords.ts:351` `let supportEmptyRange = browser.webkit \|\| browser.gecko` | Chrome and Firefox both support empty ranges in `getClientRects` — see coords doc §2.2. |

### 2.10 `webkit_version`

Only one consumer: `input.ts:593` `(browser.ios && browser.webkit_version < 604)` to gate the broken iOS clipboard.

### 2.11 `chrome_version`

Two consumers:

- `selection.ts:108` `chrome && chrome_version < 63` for
  `brokenSelectBetweenUneditable`.
- `input.ts:701` `chrome_version > 120` to gate the dataTransfer.files
  bug fix.

---

## 3. Structural workarounds (cross-cutting)

### 3.1 Hack `<br>` and `<img>` separators

`viewdesc.ts:1373-1395` (`fixSpacing` in the rendering loop):

```ts
if (!lastChild ||
    !(lastChild instanceof TextViewDesc) ||
    /\n$/.test(lastChild.node.text!) ||
    (this.view.requiresGeckoHackNode && /\s$/.test(lastChild.node.text!))) {
  if ((browser.safari || browser.chrome) && lastChild &&
      lastChild.dom.contentEditable == "false")
    this.addHackNode("IMG", parent)
  this.addHackNode("BR", this.top)
}
```

Plus `addHackNode` (`viewdesc.ts:1384-1395`):
```ts
if (nodeName == "IMG") {
  dom.className = "ProseMirror-separator"
  dom.alt = ""
}
if (nodeName == "BR") dom.className = "ProseMirror-trailingBreak"
```

These elements:

- **`ProseMirror-trailingBreak` `<br>`** — gives every textblock a place
  for the cursor to render. Without it, an empty paragraph collapses
  to zero height in every browser.
- **`ProseMirror-separator` `<img>`** — placed after a trailing
  uneditable child to give Safari/Chrome cursor a slot (#1152, #1165).
- **Marker `<img>` cursor wrapper** — when `view.markCursor` is set
  (`index.ts:537-548`), an inert image with `mark-placeholder="true"`
  is rendered; the parser ignores it
  (`domchange.ts:73-75` — `if (dom.nodeName == "IMG" && dom.getAttribute("mark-placeholder")) return {ignore: true}`).

### 3.2 `contenteditable=false` placeholders / draggable kludges

- **Drag preparation**: `input.ts:336-369` — on mousedown on a
  draggable node, PM may set `target.draggable = true` and
  (on Gecko, after 20ms) `target.contentEditable = "false"`. Both are
  reverted on `done()`.
- **Selection between uneditable blocks**: `selection.ts:104-131`
  (`brokenSelectBetweenUneditable`) — temporarily flip
  `contentEditable="true"` on a sibling to allow `setBaseAndExtent`-style
  selections, then revert.
- **Safari draggable + uneditable interaction**:
  `selection.ts:124` saves `wasDraggable` flag so we know to
  restore `draggable=true` on the same element after the temporary
  edit — Safari otherwise loses the drag handle.
- **safariDownArrowBug** (`capturekeys.ts:294-304`): toggles a
  `contenteditable="false"` child to `"true"` for 20ms to escape the
  trapped cursor.

### 3.3 Zero-width / placeholder content

- `mark-placeholder` `<img>` with `alt=""` is the only zero-width
  placeholder PM injects. PM does **not** rely on `\u200b` zero-width
  spaces internally; that's an editor-stack convention found in some
  forks but not in upstream prosemirror-view.

### 3.4 Pre-emptive blur and focus reset

- **Pre-emptive blur**: `input.ts:580` (`view.dom.blur()` before
  `removeAllRanges`/`addRange` in `captureCopy`) — keeps IE from firing a
  spurious `selectionchange`.
- **Reset focus on Android backspace**: `input.ts:818-820` —
  `view.dom.blur(); view.focus()` to reopen the virtual keyboard after
  an Android Chrome backspace bug.
- **Focus restoration via `focusPreventScroll`**: `domcoords.ts:122-140`
  — feature-detects `focus({preventScroll: true})`, falls back to IE's
  `setActive()`, then to manually saving and restoring scroll positions
  via `scrollStack`.
- **Late focus selection sync**: `input.ts:780-792` schedules a 20ms
  `selectionToDOM` after focus to fix selections that the browser
  rewrote on focus.
- **`hideselection` class toggle**: `selection.ts:92-97` adds
  `ProseMirror-hideselection` when the model selection is `visible:false`
  (e.g. node selections), and arranges via `removeClassOnSelectionChange`
  (`selection.ts:133-147`) to re-show the selection 20ms after the user
  next moves the DOM selection.
- **Compositionend forced flush**: `input.ts:506-512` — after
  `compositionend`, schedules a microtask flush via
  `Promise.resolve().then(() => view.domObserver.flush())` to deal with
  events that arrive after the actual DOM mutations.

### 3.5 Suppression / debouncing windows

- `domobserver.ts:127-130` `suppressSelectionUpdates(50ms)` — used
  during Android Chrome backspace (`domchange.ts:194`) and IE11
  empty-block backspace (`domchange.ts:249`).
- `domobserver.ts:83-94` `flushSoon(20ms)` and `forceFlush()`.
- `input.ts:447` Safari composition-end window: 500ms.
- `input.ts:130` iOS Enter fallback timeout: 200ms.
- `input.ts:455` Android composition timeout: 5000ms.
- `domchange.ts:124` iOS Enter detection window: 225ms.
- `domchange.ts:113` backspace prefer-end window: 100ms.
- `domchange.ts:202` `lastChromeDelete` window: ~100ms.
- `domobserver.ts:228` focus-bug detection windows: 200ms (focus),
  300ms (touch/click).

### 3.6 `requiresGeckoHackNode`

`domobserver.ts:308-317`. Set the first time
`checkCSS(view)` runs and detects that the user has overridden
`white-space` to a non-`pre`-flavoured value:

```ts
if (['normal', 'nowrap', 'pre-line'].indexOf(getComputedStyle(view.dom).whiteSpace) !== -1) {
  view.requiresGeckoHackNode = browser.gecko
  ...
  console.warn("ProseMirror expects the CSS white-space property to be set, preferably to 'pre-wrap'. ...")
}
```

When the flag is on, the rendering loop appends a trailing `<br>` even
to non-empty textblocks whose last char is whitespace
(`viewdesc.ts:1373-1380`) so Firefox doesn't collapse the trailing
space.

### 3.7 Trusted Types compatibility

`clipboard.ts:213-222` `maybeWrapTrusted` — wraps clipboard HTML in a
TrustedTypes policy when CSP requires it, primarily targeting Chrome's
`require-trusted-types-for` directive.

### 3.8 `<meta>` / paste sentinel handling

- `clipboard.ts:225` strips leading `<meta>` tags from pasted HTML
  (Chrome injects `<meta charset>` ahead of clipboard payloads).
- `clipboard.ts:73-79` reads `data-pm-slice` to round-trip slice context
  through copy-paste.
- `clipboard.ts:241` distinguishes Chrome's `<span>` and Safari's
  `span.Apple-converted-space` representations of clipboard NBSPs.

---

## 4. Mobile-specific concerns summary

| Concern                  | Where handled |
| ------------------------ | ------------- |
| Virtual keyboard flicker | `input.ts:115` (no Enter `keydown`), `input.ts:122-130` (iOS Enter flag), `input.ts:818-820` (Android backspace blur/focus) |
| Predictive text          | `domchange.ts:81-277` MutationObserver-driven diff |
| Autocorrect              | Same |
| Swipe input              | Same |
| Long-press selection     | `input.ts:422-431` touch handlers, `selection.ts:64-72` Chrome drag delay |
| Selection drift on focus | `domobserver.ts:228-235` |
| `visualViewport`         | `domcoords.ts:8-16` `windowRect` |
| List markers vanishing   | `viewdesc.ts:811`, `viewdesc.ts:1531-1540` `iosHacks` |
| Composition Enter        | `input.ts:447-450` Safari, `domchange.ts:181-189` iOS, `input.ts:115` Android Chrome, `input.ts:506-512` post-end flush |

---

## 5. TODO / FIXME / "kludge" / "hack" comments

A grep of the source for `kludge`, `hack`, `TODO`, `FIXME`, `weird`,
`bug` produced the following set of explicit self-deprecating comments
(file:line — short summary):

- `domcoords.ts:207` `function targetKludge(...)` — list bullet click target adjustment.
- `domcoords.ts:314` `// Suspiciously specific kludge to work around caret*FromPoint never returning a position at the end of the document`.
- `domcoords.ts:359` `// Detect this situation and and kludge around it` (Firefox whitespace).
- `domcoords.ts:482` `// This is a huge hack, but appears to be the best we can currently do` (Selection.modify probe).
- `index.ts:198` `let chromeKludge = ...`.
- `selection.ts:104` `// Kludge to work around Webkit not allowing a selection to start/end between non-editable block nodes.`.
- `selection.ts:155` `// Kludge to kill 'control selection' in IE11`.
- `viewdesc.ts:421` `// brKludge` Firefox/Safari BR cursor placement.
- `viewdesc.ts:1377` `// Avoid bugs in Safari's cursor drawing (#1165) and Chrome's mouse selection (#1152)` ahead of `addHackNode("IMG", ...)` and `addHackNode("BR", ...)`.
- `viewdesc.ts:1531` `// List markers in Mobile Safari will mysteriously disappear sometimes.`.
- `domobserver.ts:367` `// Kludge for a Safari bug where, on ending a composition in an otherwise empty table cell, it randomly moves the composed text into the table row around that cell, greatly confusing everything (#188).`.
- `domobserver.ts:332` `// Used to work around a Safari Selection/shadow DOM bug` + `// ridiculous hack` (`:347`).
- `domchange.ts:26` `// Work around issue in Chrome where backspacing sometimes replaces the deleted content with a random BR node`.
- `domchange.ts:198` `// Chrome will occasionally, during composition, delete the entire composition and then immediately insert it again. This is used to detect that situation.`.
- `domchange.ts:204` `// This tries to detect Android virtual keyboard enter-and-pick-suggestion action.`.
- `dom.ts:124` `// Work around Chrome issue https://bugs.chromium.org/p/chromium/issues/detail?id=447523 (isCollapsed inappropriately returns true in shadow dom)`.
- `input.ts:55` `// On Safari, for reasons beyond my understanding, adding an input event handler makes an issue where the composition vanishes when you press enter go away.`.
- `input.ts:118` `// On iOS, if we preventDefault enter key presses, the virtual keyboard gets confused. So the hack here is to set a flag ...`.
- `input.ts:289` (inside `safariDownArrowBug`) `// Issue #867 / #1090 / chromium 903821 — Safari does really wrong things ...`.
- `input.ts:454` `// Drop active composition after 5 seconds of inactivity on Android`.
- `input.ts:589` `// This is very crude, but unfortunately both these browsers _pretend_ that they have a clipboard API`.
- `input.ts:656` `// Handling paste from JavaScript during composition is very poorly handled by browsers, so as a dodgy but preferable kludge ...`.
- `input.ts:809` `// We should probably do more with beforeinput events, but support is so spotty that I'm still waiting to see where they are going.` *(this is the closest thing to a TODO).*
- `input.ts:811` `// Very specific hack to deal with backspace sometimes failing on Chrome Android when after an uneditable node.`.

There are no explicit `TODO:` or `FIXME:` strings in the source —
ProseMirror tracks open issues in GitHub rather than inline. The
"#NNNN" references throughout the code (`#710, #973, #1011, #1013,
#1035, #832, #708, #862, #930, #710, #1500, #1472, #937, #1163, #1073,
#1092, #1128, #1152, #1165, #188, #820, #859, #993, #994, #1059, #1552`)
are the pointers to the original bug reports.

---

## 6. Cross-reference

| Browser flag           | First defined         | Number of branch sites in `src/` |
| ---------------------- | --------------------- | -------------------------------- |
| `ie`                   | `browser.ts:9`        | 12                               |
| `ie_version`           | `browser.ts:10`       | 8 (always paired with `ie`)      |
| `gecko`                | `browser.ts:11`       | 13                               |
| `gecko_version`        | `browser.ts:12`       | 0 (exported, unused)             |
| `chrome`               | `browser.ts:15`       | 23                               |
| `chrome_version`       | `browser.ts:16`       | 2                                |
| `safari`               | `browser.ts:17`       | 17                               |
| `ios`                  | `browser.ts:19`       | 6                                |
| `mac`                  | `browser.ts:20`       | 11                               |
| `windows`              | `browser.ts:21`       | 2                                |
| `android`              | `browser.ts:22`       | 9                                |
| `webkit`               | `browser.ts:23`       | 4                                |
| `webkit_version`       | `browser.ts:24`       | 1                                |

(Counts are approximate — based on `grep "browser\.<flag>" src/`.)

The ratio of `safari` + `chrome` + `gecko` branches (≈53 sites) to the
total module size shows that the lion's share of PM's complexity is
WebKit/Blink/Gecko-bug compensation. iOS and Android together account
for a further 15 sites, almost all of which involve the composition or
virtual-keyboard pipeline.
