# 13 · The Input Pipeline

> Source: `prosemirror-view/src/input.ts` (830 LOC), `capturekeys.ts` (345 LOC),
> `browser.ts` (24 LOC), `dom.ts`, `selection.ts`, plus cross-references into
> `domobserver.ts` and `domchange.ts` (file 14/15) and `clipboard.ts` (file 16).
>
> Citations are file:line. All paths are relative to `prosemirror-view/src/`.

ProseMirror does not, in general, want the browser to apply its native
contenteditable behavior. Browsers will happily destroy block structure,
collapse non-editable atoms, swallow IME events, and otherwise produce DOM that
is not representable in a ProseMirror document. The input pipeline is the layer
that intercepts every relevant DOM event, classifies it, gives plugin-supplied
handlers a chance to react, and then either:

1. dispatches a transaction (the typical case), or
2. lets the browser write to the DOM and then *reconciles* the change through
   `domobserver`/`readDOMChange` (file 14/15), or
3. calls `event.preventDefault()` and does nothing (the "swallow" case).

The whole apparatus revolves around the `InputState` struct, two dispatch maps
(`handlers` and `editHandlers`), the `captureKeyDown` synthetic-key layer, and
the `MouseDown` micro-state-machine.

---

## 1. Listener registration

### 1.1 The two dispatch maps

`input.ts:15-17`:

```ts
const handlers: {[event: string]: (view: EditorView, event: Event) => void} = {}
const editHandlers: {[event: string]: (view: EditorView, event: Event) => void} = {}
const passiveHandlers: Record<string, boolean> = {touchstart: true, touchmove: true}
```

`handlers` covers every event the editor cares about. `editHandlers` is a
**subset** of handlers that should only run when the view is editable
(`view.editable === true`). At the bottom of the file (`input.ts:830`):

```ts
for (let prop in editHandlers) handlers[prop] = editHandlers[prop]
```

…copies every editHandler entry into `handlers`. So at runtime there is one
unified table — `editHandlers` is just used as a *predicate set* ("is this an
event I should suppress when read-only?").

| Map           | Events                                                                                                                                                              | Suppressed in read-only?                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `editHandlers`| `keydown`, `keyup`, `keypress`, `compositionstart`, `compositionupdate`, `compositionend`, `cut`, `paste`, `dragover`, `dragenter`, `drop`, `beforeinput`             | Yes — guarded by `view.editable` check            |
| `handlers` (only) | `mousedown`, `touchstart`, `touchmove`, `contextmenu`, `focus`, `blur`, `copy`, `dragstart`, `dragend`                                                            | No — always fire                                  |

(Note `copy` is in `handlers` but `cut` is in `editHandlers` — copy is a
read-only operation; cut requires deletion, so it must be guarded.)

### 1.2 `initInput` — wiring (`input.ts:46-61`)

```ts
export function initInput(view: EditorView) {
  for (let event in handlers) {
    let handler = handlers[event]
    view.dom.addEventListener(event, view.input.eventHandlers[event] = (event: Event) => {
      if (eventBelongsToView(view, event) && !runCustomHandler(view, event) &&
          (view.editable || !(event.type in editHandlers)))
        handler(view, event)
    }, passiveHandlers[event] ? {passive: true} : undefined)
  }
  if (browser.safari) view.dom.addEventListener("input", () => null)  // line 58
  ensureListeners(view)
}
```

Important properties of this wiring:

* **All listeners are on `view.dom`** (the editable element). They are *not*
  on `document` or `window`. This means events that don't bubble up to the
  editor (e.g. clicks outside it) are ignored — except for the `mouseup`
  listener which is attached to `view.root` once mousedown fires (see §6.3).
* **Bubble phase, not capture.** No `{capture: true}` flag is passed. This
  matters because plugin DOM nodes (node views, decorations) get a chance to
  call `stopPropagation`/`preventDefault` first.
* **`touchstart`/`touchmove` are passive** (`passiveHandlers` map at
  `input.ts:17`). PM never wants to `preventDefault` scrolling on touch, and
  marking these passive lets the browser do hardware-accelerated scrolling.
* **The Safari "input" no-op (line 58).** The comment is candid:
  > "for reasons beyond my understanding, adding an input event handler makes
  > an issue where the composition vanishes when you press enter go away."
  An empty listener still flips a flag in WebKit's compositor.
* **`view.input.eventHandlers`** caches the bound listener on the InputState
  so `destroyInput` (`input.ts:68-74`) can remove every one symmetrically.

### 1.3 The dispatch wrapper — three gates

For every event the bound listener (`input.ts:49-52`) consults three predicates
*in order*:

1. **`eventBelongsToView(view, event)`** (`input.ts:90-98`): walks from
   `event.target` up to `view.dom`. If any ancestor's `pmViewDesc.stopEvent`
   returns true (a node view opting out), or the bubble crosses a shadow-root
   (`nodeType == 11`), the event is rejected. Non-bubbling events
   (`event.bubbles === false`) skip this check; events whose `defaultPrevented`
   is already true are rejected.
2. **`runCustomHandler(view, event)`** (`input.ts:83-88`): consults the
   `handleDOMEvents` prop. The first plugin/prop whose handler returns truthy
   *or* calls `preventDefault` wins; the built-in handler is skipped.
3. **Read-only guard**: `view.editable || !(event.type in editHandlers)`. In
   read-only mode, anything in `editHandlers` is silently dropped.

### 1.4 Late-registered DOM events — `ensureListeners` (`input.ts:76-81`)

When `handleDOMEvents` is provided, plugins may want to listen for events that
ProseMirror does *not* listen to natively (e.g. `wheel`, `pointerover`).
`ensureListeners` adds a separate listener for any such type so that
`runCustomHandler` is always invoked even for events PM otherwise ignores. This
is called from `initInput` and again from `EditorView.setProps`.

### 1.5 `dispatchEvent` (`input.ts:100-104`) — manual injection

Public-ish entry point allowing programmatic dispatch through the same gates as
real DOM events (used by `pasteHTML`/`pasteText` and tests).

---

## 2. `InputState` — every flag, what it disambiguates

`input.ts:19-44` — every field on the struct exists to disambiguate some piece
of browser behavior. Annotated:

| Field                            | Set where                                                                                                                              | Read where & why                                                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shiftKey`                       | `keydown` (`108`), `mousedown` (`280`), `keyup` clears (`139`)                                                                          | `paste`/`capturePaste` use it as "force plain text" (`620`, `662`); `selectHorizontally` reads `mods` from a fresh keyboard event but `shiftKey` is the persistent mirror.                                                  |
| `mouseDown`                      | new `MouseDown(...)` on single-click (`295`), nulled in `MouseDown.done()` (`371`)                                                      | `dragstart` uses `.mightDrag` (`682`); `selectionToDOM` (`selection.ts:64`) uses `allowDefault`/`delayedSelectionSync` to defer DOM selection sync during a drag-select.                                                  |
| `lastKeyCode` / `lastKeyCodeTime`| `keydown` (`110-111`), cleared in `domchange.ts:120`                                                                                    | `domobserver.ts:195` (Backspace/Delete + a `<br>` insertion is interpreted as enter), `domchange.ts:113` (recent backspace tweaks parse), `capturePaste` (`625`/`662`) ignores shift-paste-as-plain when keyCode==45 (Insert). |
| `lastClick`                      | `mousedown` (`288`)                                                                                                                     | `mousedown` (`283`) reads it 500ms later to detect double/triple click.                                                                                                                                                       |
| `lastSelectionOrigin` / `lastSelectionTime` | `setSelectionOrigin` (`63-66`)                                                                                              | `domchange.ts:86` decides whether to bias an inferred selection toward "key"/"pointer".                                                                                                                                       |
| `lastIOSEnter`                   | `keydown` (`124`), nulled in `domchange.ts:128` and `187`                                                                              | iOS sends Enter as a *composition* sequence; if a regular DOM change arrives within 225ms we synthesize Enter.                                                                                                              |
| `lastIOSEnterFallbackTimeout`    | `keydown` (`125`)                                                                                                                       | If no DOM change happens within 200ms after Enter on iOS, fire `handleKeyDown(Enter)` synthetically (`126-130`).                                                                                                            |
| `lastFocus`                      | `focus` (`781`)                                                                                                                         | `domobserver.ts:228` — a DOM change with no `from` mapping that occurs <200ms after focus and far from any pointer activity is treated as the browser fixing up cursor on focus.                                            |
| `lastTouch`                      | `touchstart`/`touchmove` (`423`/`429`)                                                                                                  | Same `domobserver.ts:229` heuristic — distinguish focus-induced selection from touch.                                                                                                                                        |
| `lastChromeDelete`               | Set in `domchange.ts:202`                                                                                                              | `domchange.ts:234` — Chrome composition deletion: don't reapply if a delete just happened.                                                                                                                                   |
| `composing`                      | `compositionstart/update` (`490`), cleared in `compositionend` (`504`) and `clearComposition` (`522`)                                   | Everywhere — `inOrNearComposition`, `editHandlers.paste` skip path, `endComposition`, `domchange`.                                                                                                                          |
| `compositionNode`                | Set by `findCompositionNode` (`528-545`) called from `index.ts:199`                                                                     | The text node currently hosting an active IME composition; `domobserver` skips mutations on it.                                                                                                                               |
| `composingTimeout`               | `scheduleComposeEnd` (`515-518`)                                                                                                       | Android: 5s inactivity → force end (`455`).                                                                                                                                                                                  |
| `compositionNodes`               | Filled by `viewdesc` during composition; emptied by `clearComposition` (`525`)                                                          | Marks dirty parents so they're re-rendered after composition ends.                                                                                                                                                            |
| `compositionEndedAt`             | `compositionend` (`505`); reset in `inOrNearComposition` (`448`)                                                                       | Safari fires keydown(Enter) *after* compositionend on Japanese IME; if the keydown is within 500ms it is suppressed.                                                                                                          |
| `compositionID`                  | Bumped in `compositionend` (`510`)                                                                                                      | `domchange.ts:82` includes it as a transaction meta key so concurrent dispatches can identify "from composition X".                                                                                                          |
| `badSafariComposition`           | Set in `domobserver.ts:68` when Safari emits weird composition mutations                                                                | `compositionend` forces a flush instead of letting it queue (`508`).                                                                                                                                                          |
| `compositionPendingChanges`      | Set in `compositionend` (`506`); cleared in `domchange.ts:83`                                                                          | Marks "we need a microtask flush after this compositionend."                                                                                                                                                                  |
| `domChangeCount`                 | Incremented in `domchange.ts:123`                                                                                                      | `beforeinput` Android backspace fallback (`815`) snapshots this and checks 50ms later whether anything changed.                                                                                                              |
| `eventHandlers`                  | Filled in `initInput`/`ensureListeners`                                                                                                  | `destroyInput` removes them.                                                                                                                                                                                                  |
| `hideSelectionGuard`             | Set in `selection.ts:138`                                                                                                              | Listener that re-shows selection styling once the user moves the caret away from a hidden selection.                                                                                                                          |

---

## 3. Keyboard pipeline

### 3.1 `keydown` (`input.ts:106-136`)

The handler is small but every line is load-bearing:

```ts
editHandlers.keydown = (view, _event) => {
  let event = _event as KeyboardEvent
  view.input.shiftKey = event.keyCode == 16 || event.shiftKey                 // 108
  if (inOrNearComposition(view, event)) return                                // 109 — Safari IME
  view.input.lastKeyCode = event.keyCode                                       // 110
  view.input.lastKeyCodeTime = Date.now()                                      // 111
  if (browser.android && browser.chrome && event.keyCode == 13) return        // 115 — let composition handle
  if (event.keyCode != 229) view.domObserver.forceFlush()                      // 116 — 229 is "composing"

  if (browser.ios && event.keyCode == 13 && !event.ctrlKey && !event.altKey && !event.metaKey) {
    let now = Date.now()                                                       // 122
    view.input.lastIOSEnter = now                                              // 124
    view.input.lastIOSEnterFallbackTimeout = setTimeout(() => {                // 125
      if (view.input.lastIOSEnter == now) {
        view.someProp("handleKeyDown", f => f(view, keyEvent(13, "Enter")))
        view.input.lastIOSEnter = 0
      }
    }, 200)
  } else if (view.someProp("handleKeyDown", f => f(view, event)) ||
             captureKeyDown(view, event)) {                                     // 131
    event.preventDefault()
  } else {
    setSelectionOrigin(view, "key")
  }
}
```

**Dispatch order:**

```
keydown → inOrNearComposition? ──yes──▶ return (Safari IME confirm)
                              ──no──▶
   record lastKeyCode/time
   forceFlush DOM observer (unless keyCode 229)
   iOS Enter? ──yes──▶ schedule synthetic handler in 200ms; let browser run
              ──no──▶ handleKeyDown prop (plugins, e.g. prosemirror-keymap)
                       │ true → preventDefault
                       └ false → captureKeyDown (synthetic key handling)
                                  │ true → preventDefault
                                  └ false → setSelectionOrigin("key"); browser default
```

The `forceFlush` at line 116 is critical: if the DOM observer has pending
mutations, they need to be applied to state *before* we run a key handler that
might query/modify state. KeyCode 229 means "the IME is processing this", so
flushing would fight composition.

### 3.2 `handleKeyDown` prop semantics

* It is **resolved through `someProp`**: every plugin's `handleKeyDown` is
  tried in order; first one that returns truthy wins.
* Returning `true` is the signal to PM to call `preventDefault`.
* This is where **`prosemirror-keymap`** plugs in — its `handleKeyDown`
  consults a keymap object and calls a command. Modifier-aware keys
  (`Mod-z`, `Shift-Tab`) are resolved *inside* `prosemirror-keymap` using
  `keyName(event)`. The view doesn't know about modifiers as such.

### 3.3 `captureKeyDown` — synthetic key handling (`capturekeys.ts`)

This is the safety net that runs *after* `handleKeyDown` has had its chance.
Its job is **"the browser would do something contenteditable-broken with this
key; we need to either fix the selection first or take over entirely."**

The dispatch is a single switch (`capturekeys.ts:322-345`) keyed on
`event.keyCode` plus modifiers (`getMods` returns a sorted string of
`c`/`m`/`a`/`s`):

| Key                        | Mac alias       | Function called                                             | Returns true when…                                                                          |
| -------------------------- | --------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Backspace** (8)          | Ctrl-H (72)     | `stopNativeHorizontalDelete(view, -1) \|\| skipIgnoredNodes(view, -1)` | …non-text selection or atom-before-cursor → PM dispatches a delete tr; otherwise selection skip. |
| **Delete** (46) + no shift | Ctrl-D (68)     | `stopNativeHorizontalDelete(view, 1) \|\| skipIgnoredNodes(view, 1)`   | Same, forward.                                                                              |
| **Enter** (13)             |                 | unconditionally `return true`                                | Always swallow — *every* Enter goes through `handleKeyDown`; a default Enter would split blocks wrongly. |
| **Escape** (27)            |                 | `return true`                                                | Always swallow.                                                                              |
| **Left arrow** (37)        | Ctrl-B (66)     | `selectHorizontally(view, dir, mods) \|\| skipIgnoredNodes`  | Direction is RTL-aware via `findDirection`.                                                  |
| **Right arrow** (39)       | Ctrl-F (70)     | `selectHorizontally(view, dir, mods)`                        | Same.                                                                                       |
| **Up arrow** (38)          | Ctrl-P (80)     | `selectVertically(view, -1, mods) \|\| skipIgnoredNodes`     | Returns true when motion crosses a node boundary or hits a `NodeSelection`.                  |
| **Down arrow** (40)        | Ctrl-N (78)     | `safariDownArrowBug(view) \|\| selectVertically(view, 1, mods) \|\| skipIgnoredNodes` | First branch is a Safari-specific kludge.                                |
| **Mod-B/I/Y/Z** (66/73/89/90) | (m on Mac, c elsewhere) | `return true` (always swallow)                       | Stop the browser from running its own bold/italic/undo/redo on the contenteditable.          |

#### 3.3.1 `stopNativeHorizontalDelete` (`capturekeys.ts:266-281`)

Returns `true` (= "I handled it; preventDefault") in three cases:

* Selection is not a `TextSelection` (e.g. node selection): always handled.
* `$head` and `$anchor` are in different parents: always handled.
* Cursor at end-of-textblock in deletion direction: handled (let
  `handleKeyDown` commands like `joinBackward` deal with it).
* Adjacent atom node: dispatch `tr.delete($head.pos - nodeSize, $head.pos)`
  immediately and return true.

Otherwise returns `false` — let the browser delete a regular character;
the DOM observer will pick it up.

#### 3.3.2 `skipIgnoredNodes` (`capturekeys.ts:67-157`)

When the cursor is sitting *next to* DOM nodes that ProseMirror inserts but
that have zero document size (cursor wrappers, decoration spacers, trailing
`<br>` placeholders), the browser's native horizontal motion will get stuck on
them. `skipIgnoredNodesBefore`/`After` walk past these via raw DOM mutation of
the selection (`setSelFocus`). Returns nothing useful — but it *moves the
selection*, so the subsequent native cursor motion happens from the right
place. Then it schedules a 50ms timeout to re-sync the selection to the DOM if
state hasn't otherwise updated (`220-220`).

`isIgnorable` (`62-65`): a desc with `size == 0` and either dir<0 or it's not a
trailing `<br>`.

#### 3.3.3 `selectHorizontally` (`capturekeys.ts:19-56`)

Multi-branch decision:

* **TextSelection + shift**: extend across an inline atom by computing
  `nodeSize`-aware new head.
* **TextSelection + non-empty**: don't intervene.
* **TextSelection + at end of textblock**: try to move to a neighboring block
  (calls `moveSelectionBlock` → `Selection.findFrom`); if the result is a
  `NodeSelection` apply it.
* **Mac + Option (m)**: delegate to browser (word motion).
* **TextSelection + empty + interior**: peek at `nodeBefore`/`nodeAfter`. If
  it's a non-text non-leaf, return false. If it's selectable, create a
  `NodeSelection`. If WebKit, jump *past* the node manually because Chrome
  and Safari put extra cursor positions around inline uneditables (#937).
* **NodeSelection + inline**: collapse to TextSelection at the appropriate
  end.
* **Else**: try block selection.

#### 3.3.4 `findDirection` (`capturekeys.ts:223-242`)

Determines RTL/LTR at a position so left/right arrows map to "logical
forward/back" on bidi text. On Chrome and Windows the bidi probe is
unreliable, so it falls back to `getComputedStyle(view.dom).direction`.

#### 3.3.5 `selectVertically` (`capturekeys.ts:247-264`)

Only kicks in when the parent is non-inline-content (block selection) or the
cursor is at the top/bottom of its textblock. Returns false for active text
selections and Mac+Option. Otherwise calls `moveSelectionBlock` and applies if
the result is a `NodeSelection`. Subtle: `AllSelection` uses `Selection.near`
instead of `Selection.findFrom` (line 260) so escape from "select everything"
lands inside the document.

#### 3.3.6 `safariDownArrowBug` (`capturekeys.ts:294-304`)

Issue #867/#1090: Safari mishandles down-arrow when the cursor is at the start
of a textblock followed by a `contenteditable=false` node. Workaround:
temporarily make the uneditable child editable, schedule it to revert in 20ms,
let the native motion happen.

### 3.4 `keyup` (`input.ts:138-140`)

Only purpose: clear `view.input.shiftKey` when keyCode 16 is released.

### 3.5 `keypress` (`input.ts:142-160`) — text input via charCode

`keypress` is deprecated in modern browsers but still fires on plenty of
keystrokes. The handler:

1. Bail if composing or if there's no `charCode` (modifier-only press).
2. Bail on Ctrl-without-Alt (control combos), or Mac-Meta combos.
3. Try `handlePaste`'s sibling: `handleKeyPress` prop.
4. If selection is non-text or crosses parents, build an `insertText(text)`
   transaction with a default `() => view.state.tr.insertText(text).scrollIntoView()`,
   try `handleTextInput(view, $from.pos, $to.pos, text, deflt)`, otherwise
   dispatch `deflt()`. Always `preventDefault`.

Note this path is **only used for cross-parent or non-text selection**. The
common case (cursor inside a paragraph) lets the browser apply the insertion
to the DOM, then `domobserver`/`readDOMChange` reconciles it as `insertText`.
That's why `handleTextInput` is also called from `domchange.ts:84-87`.

### 3.6 `beforeinput` (`input.ts:806-827`) — single-purpose Android Backspace fallback

ProseMirror does *not* generally use `beforeinput` to drive insertion (the
comment at line 808-809 says support is "so spotty"). The only logic here is
a Chrome-Android workaround: when `inputType === "deleteContentBackward"` is
fired but the DOM doesn't actually mutate (a known bug after uneditable
nodes), wait 50ms, and if `domChangeCount` hasn't moved, blur+focus to reopen
the virtual keyboard, dispatch a synthetic Backspace, and as a last resort do
a manual `tr.delete` of the previous character.

`beforeinput` is also listened-to in capture phase by `domobserver.ts:352`
(separately) for tracking things like input-type during composition.

---

## 4. The "user types 'a'" flowchart

```
┌──────────────────────────────────────────────────────────────────────┐
│ 1. User presses 'a'                                                 │
└─────────────────────────────┬────────────────────────────────────────┘
                              ▼
                      keydown event on view.dom
                              │
                  eventBelongsToView? ── no ──▶ ignore
                              │ yes
                  handleDOMEvents.keydown? ── yes-true ──▶ swallow
                              │ no
                  view.editable? ── no ──▶ swallow (editHandler)
                              │ yes
                              ▼
              editHandlers.keydown   (input.ts:106)
                inOrNearComposition? ── yes ──▶ return
                              │
            record lastKeyCode='a'(65); domObserver.forceFlush()
                              │
              handleKeyDown prop chain (plugins / keymap)
                              │ no plugin handles 'a'
                              ▼
              captureKeyDown ('a' isn't in switch) → false
                              │
              setSelectionOrigin("key"); browser default proceeds
                              ▼
                 browser fires keypress (in some browsers)
                              │
        editHandlers.keypress: charCode 97
            isTextSelection sameParent? ── yes ──▶ skip (let browser do it)
            else: build deflt = tr.insertText('a').scrollIntoView()
                  handleTextInput? ── yes ──▶ skip default
                  else dispatch deflt; preventDefault
                              │
              ── (default path) browser writes 'a' into DOM ──
                              ▼
                  Mutation: text node nodeValue changes
                              ▼
                  DOMObserver MutationObserver fires (file 14)
                  flushSoon() → flush() → readDOMChange (file 15)
                              ▼
              parseFromDOM → diff against ProseMirror doc
                              ▼
            handleTextInput($from, $to, 'a', deflt) prop check
                              │ none handles
                              ▼
            view.dispatch(tr.insertText('a').scrollIntoView())
                              ▼
       state update → updateState → docView.update → DOM patched
       (idempotent — DOM already has 'a', but mark application etc. happens)
                              ▼
                       selectionToDOM
```

The **storedMarks/marksAtCursor** semantics live inside
`prosemirror-state`'s `Transaction.insertText` and `state.storedMarks`: when
the user has activated marks (e.g. typed `**bold` then a space), `storedMarks`
is non-null on the state, and `insertText` uses those marks for the inserted
character; otherwise it inherits from `$from.marks()`. The **view layer**'s
contribution is the `compositionstart` branch at `input.ts:461-468` that
detects "stored marks differ from the DOM context" and ends composition early
to wrap the cursor in mark nodes.

---

## 5. Composition

### 5.1 `compositionstart` / `compositionupdate` (`input.ts:457-493`)

Fired exactly when an IME begins composing. The handler:

1. If not already composing:
   * Flush the DOM observer to apply any pending mutations.
   * Decide if we need to **end the in-progress composition synthetically
     before letting the browser start its own** (line 461-470). This happens
     when:
     * `state.storedMarks` is non-null, **or**
     * the cursor is at a position where it should inherit marks from
       `nodeBefore` but those marks have `inclusive === false` (so the
       browser's "extend the existing text node" approach would put the new
       chars in the wrong marks), **or**
     * On Chrome+Windows, the selection is right before an uneditable node
       (`selectionBeforeUneditable`, `495-500`) — issue #1500.
   * Set `view.markCursor` to the marks the new text should have, call
     `endComposition(view, true)`, then null `markCursor`.
   * Otherwise call `endComposition(view, !state.selection.empty)`.
   * Firefox-specific: if cursor is just outside a marked text node, move it
     in (`474-487`).
   * Set `composing = true`.
2. `scheduleComposeEnd(view, timeoutComposition)` — Android only: 5s
   inactivity safeguard (line 455).

### 5.2 `compositionend` (`input.ts:502-513`)

```ts
view.input.composing = false
view.input.compositionEndedAt = event.timeStamp
view.input.compositionPendingChanges = pendingMutations ? compositionID : 0
view.input.compositionNode = null
if (badSafariComposition) forceFlush()
else if (compositionPendingChanges) Promise.resolve().then(() => flush())
view.input.compositionID++
scheduleComposeEnd(view, 20)
```

The 20ms `scheduleComposeEnd` (vs a 5000ms or -1 baseline) is "ok, composition
is over but the browser may emit a few more mutations; flush them via a
proper end after a tick".

### 5.3 `endComposition` (`input.ts:553-566`)

Public-ish entry point used by `mousedown`'s `forceDOMFlush` (line 273) and by
external callers. On Android it bails if a flush is already scheduled
(`555`) to avoid double-applying. Otherwise:

1. `forceFlush` the observer.
2. `clearComposition` — reset `composing`, `compositionEndedAt`, drop
   `compositionNodes`.
3. If restarting *or* docView is dirty:
   * Read selection from DOM. Dispatch a setSelection if it differs.
   * Else if `markCursor` is set (we're cursor-wrapping), delete the empty
     selection.
   * Else `view.updateState(view.state)` — force a redraw.

### 5.4 Composition cross-references to file 14/15

* `domobserver.ts:62-71`: detects "bad" Safari composition mutation patterns
  (mutations on a node we know is the composition node, but in a way Safari
  shouldn't be able to do) and sets `badSafariComposition`.
* `domchange.ts:82-83`: when reading a DOM change, captures `compositionID`
  into the transaction's meta and resets `compositionPendingChanges`.
* `domchange.ts:233-235`: don't let Chrome's mid-composition empty selection
  overwrite a real cursor position from a recent delete.

---

## 6. Mouse handling

### 6.1 `mousedown` dispatch (`input.ts:278-301`)

```ts
handlers.mousedown = (view, _event) => {
  let event = _event as MouseEvent
  view.input.shiftKey = event.shiftKey
  let flushed = forceDOMFlush(view)                               // 281
  let now = Date.now(), type = "singleClick"
  if (now - view.input.lastClick.time < 500 && isNear(event, view.input.lastClick) &&
      !event[selectNodeModifier] && view.input.lastClick.button == event.button) {
    if (view.input.lastClick.type == "singleClick") type = "doubleClick"
    else if (view.input.lastClick.type == "doubleClick") type = "tripleClick"
  }
  view.input.lastClick = {time: now, x, y, type, button}
  let pos = view.posAtCoords(eventCoords(event))
  if (!pos) return

  if (type == "singleClick") {
    if (view.input.mouseDown) view.input.mouseDown.done()
    view.input.mouseDown = new MouseDown(view, pos, event, !!flushed)
  } else if ((type == "doubleClick" ? handleDoubleClick : handleTripleClick)(view, pos.pos, pos.inside, event)) {
    event.preventDefault()
  } else {
    setSelectionOrigin(view, "pointer")
  }
}
```

* **`selectNodeModifier`** (`input.ts:276`): metaKey on Mac, ctrlKey
  elsewhere. This is the modifier that turns a click into "select the node
  under the click" rather than "place the cursor there".
* **Triple-click is synthetic.** The browser doesn't fire a "triple click"
  event; PM tracks `lastClick.time/x/y/button/type` and uses a 500ms /
  100px² (`isNear` at `164`: `dx²+dy² < 100`) window to upgrade single→double→triple.
* **`forceDOMFlush`** (`272`) runs `endComposition` and returns a boolean
  indicating composition was active. Mousedown during composition cannot
  proceed until composition is committed; the `flushed` flag is later passed
  to `MouseDown` to influence its drag/select behavior.
* **`posAtCoords` returning null** — outside the editor — short-circuits and
  lets the browser do whatever.
* For double/triple click, `runHandlerOnContext` is called for each ancestor
  node (inside-out) via `handleClickOn`/`handleDoubleClickOn`/`handleTripleClickOn`.

### 6.2 `runHandlerOnContext` (`input.ts:169-184`)

For each depth `i = $pos.depth+1` down to `1`, call the prop with either
`(pos, $pos.nodeAfter, $pos.before(i), event, true)` (innermost, "direct")
or `(pos, $pos.node(i), $pos.before(i), event, false)`. First truthy wins.

### 6.3 `MouseDown` — the micro-state-machine (`input.ts:303-420`)

Constructed only for single-click. Captures:

* `startDoc` — to detect document changes during the gesture.
* `selectNode` — was the node-select modifier held?
* `allowDefault` — initially true if shift was held; *also* upgrades to true
  if mouse moves >4px (drag-select), see `updateAllowDefault` (`415-419`).
* `mightDrag` — non-null if the click landed on a draggable node *or* on the
  current node selection (`336-344`). Holds `{node, pos, addAttr,
  setUneditable}`. If we're hovering a node that needs `draggable=true` set
  to actually drag, this flag triggers it on; on Gecko, also sets
  `contentEditable=false` after 20ms (line 350-352) so Firefox doesn't
  interfere with the drag.
* `target` — the DOM element corresponding to the clicked node view.
* `delayedSelectionSync` — set by `selection.ts:64-72` to defer
  `setSelection` calls until mouseup, because Chrome misbehaves if we yank
  the selection mid-drag.

Listeners attached to **`view.root`** (`356-357`):

```ts
view.root.addEventListener("mouseup", this.up = this.up.bind(this) as any)
view.root.addEventListener("mousemove", this.move = this.move.bind(this) as any)
```

`view.root` is `document` (or shadow root) — this is intentional, because
mouseup may happen outside `view.dom` after a drag-select.

#### 6.3.1 `up` — what happens on click release (`374-407`)

```
mouseup
  done() — remove listeners, reset draggable/contentEditable, schedule
           selectionSync if delayedSelectionSync, null mouseDown
  if event.target outside view.dom: bail
  pos = this.pos OR (if doc changed) view.posAtCoords(event)
  updateAllowDefault(event)
  if allowDefault || !pos:
      setSelectionOrigin("pointer")
  else if handleSingleClick(view, pos.pos, pos.inside, event, selectNode):
      preventDefault
  else if event.button == 0 && (
        flushed                                             // composition was active at mousedown
        || (safari && mightDrag && !mightDrag.node.isAtom)  // Safari ignores clicks on draggable
        || (chrome && !selection.visible &&
            close to current sel.from/to)                   // Chrome hidden-selection fixup
      ):
      updateSelection(view, Selection.near($pos), "pointer")
      preventDefault
  else:
      setSelectionOrigin("pointer")
```

#### 6.3.2 `handleSingleClick` (`230-234`)

Three-stage fallthrough:

```
runHandlerOnContext("handleClickOn", …)              // per-depth ancestor walk
  ↓ false
view.someProp("handleClick", f => f(view, pos, event))
  ↓ false
selectNode ? selectClickedNode(view, inside) : selectClickedLeaf(view, inside)
```

`selectClickedLeaf` (`194-202`): if the node directly *after* `inside` is an
atom and selectable, make a NodeSelection.
`selectClickedNode` (`204-228`): walk up depths; if there's already a
NodeSelection and the click lands on its child boundary, escalate to the
parent (so repeated cmd-clicks select progressively wider nodes).

#### 6.3.3 `defaultTripleClick` (`247-270`)

If `inside == -1` and the doc is inline-content, select all
(`TextSelection.create(doc, 0, doc.content.size)`). Otherwise walk depths
inside-out: pick the first ancestor that is `inlineContent` (text-select all
of it) or `selectable` (node-select).

### 6.4 Click → selection flowchart

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. User clicks at (x, y) inside view.dom                              │
└─────────────────────────────┬──────────────────────────────────────────┘
                              ▼
                        mousedown event
                              │
            forceDOMFlush(view)  → endComposition, return wasComposing
                              │
              compute click "type" by recency vs lastClick:
                  singleClick / doubleClick / tripleClick
                              │
              update lastClick, posAtCoords(event)
                              │
                ┌─────────────┴───────────────┐
                ▼                             ▼
          singleClick                    double/tripleClick
        new MouseDown(...)              handleDoubleClick or handleTripleClick
        store on view.input.mouseDown   ├─ runHandlerOnContext("handleDoubleClickOn"/...)
        attach mouseup/mousemove        ├─ handleDoubleClick / handleTripleClick prop
        listeners on view.root          └─ defaultTripleClick (inline=text, block=node)
                │                              │ true → preventDefault
                │                              │ false → setSelectionOrigin("pointer")
                ▼
         user releases (mouseup) OR moves >4px (drag-select)
                │
            ┌───┴────────────────────────┐
            ▼                            ▼
     allowDefault (shift, drag)     normal click release
     setSelectionOrigin("pointer")        │
     let browser apply selection          ▼
                                  handleSingleClick:
                                    handleClickOn (per-depth)
                                      ↓ false
                                    handleClick (top-level)
                                      ↓ false
                                    selectNode ?
                                       selectClickedNode :
                                       selectClickedLeaf  (atom NodeSelection)
                                    ┌─ true → preventDefault
                                    └─ false → fallback fixups
                                              (flushed compose / Safari drag
                                               atom / Chrome hidden sel)
                                              → updateSelection(Selection.near)
                                                 OR setSelectionOrigin("pointer")
                                                    + browser default
                                              ▼
                                  updateSelection dispatches
                                  tr.setSelection(...).setMeta("pointer", true)
                                              ▼
                                  state update → selectionToDOM
                                              ▼
                                  selection visually applied
```

### 6.5 `contextmenu` (`input.ts:433`)

Single line: `forceDOMFlush(view)`. The browser does its own thing; we just
make sure the editor's state matches the DOM before the menu opens. This is
why right-click "Inspect Element" on PM never lies about content.

---

## 7. Touch handling

`input.ts:422-431`:

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

Both are passive listeners (see §1.2). PM does not synthesize tap events —
it relies on the browser to convert `touchend` into `click`/`mousedown`,
which then runs through the mouse pipeline. Long-press, pinch, double-tap-
zoom, and drag-from-text-selection are all left to the browser. The only PM
contribution is recording `lastTouch` so the DOM observer can distinguish
"focus-induced selection drift" from "user just touched the screen"
(`domobserver.ts:228-229`).

iOS-specific quirks live in **keydown/Enter** (`input.ts:122-130`) and
**domchange** (file 15) — iOS Enter sends a *composition* and a *keydown*
that don't agree on what happened, so PM uses `lastIOSEnter` as a 225ms
window to recognize "this DOM change must be the result of Enter."

`touchend` is **not** listened to; the browser's emulated mouse events suffice.

---

## 8. Focus & blur

### 8.1 `focus` (`input.ts:780-792`)

```ts
view.input.lastFocus = Date.now()
if (!view.focused) {
  view.domObserver.stop()
  view.dom.classList.add("ProseMirror-focused")
  view.domObserver.start()
  view.focused = true
  setTimeout(() => {
    if (view.docView && view.hasFocus() && !view.domObserver.currentSelection.eq(view.domSelectionRange()))
      selectionToDOM(view)
  }, 20)
}
```

* Add the `ProseMirror-focused` class — purely a CSS hook.
* Bracket the class change with `domObserver.stop/start` so the class change
  is not observed as a content mutation.
* Schedule a 20ms-deferred `selectionToDOM` if the selection has drifted on
  focus (browsers will sometimes place the cursor at position 0 when an
  editable element gains focus — we re-impose the state's selection).

### 8.2 `blur` (`input.ts:794-804`)

```ts
if (view.focused) {
  view.domObserver.stop()
  view.dom.classList.remove("ProseMirror-focused")
  view.domObserver.start()
  if (event.relatedTarget && view.dom.contains(event.relatedTarget))
    view.domObserver.currentSelection.clear()
  view.focused = false
}
```

If `relatedTarget` (the element gaining focus) is *inside* the editor (this
happens with nested form controls in node views), invalidate the cached
selection so subsequent re-focus doesn't try to restore stale coords.

---

## 9. Clipboard — copy / cut / paste

### 9.1 `copy` and `cut` (`input.ts:595-612`)

```ts
handlers.copy = editHandlers.cut = (view, _event) => {
  let event = _event as ClipboardEvent
  let sel = view.state.selection, cut = event.type == "cut"
  if (sel.empty) return
  let data = brokenClipboardAPI ? null : event.clipboardData
  let slice = sel.content(), {dom, text} = serializeForClipboard(view, slice)
  if (data) {
    event.preventDefault()
    data.clearData()
    data.setData("text/html", dom.innerHTML)
    data.setData("text/plain", text)
  } else {
    captureCopy(view, dom)
  }
  if (cut) view.dispatch(tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"))
}
```

* `serializeForClipboard` lives in `clipboard.ts` (file 16) and produces
  HTML+plain text using `clipboardSerializer` / `clipboardTextSerializer`
  props.
* On broken clipboard APIs (IE<15, iOS<604, see `brokenClipboardAPI` at
  `input.ts:592-593`), fall back to `captureCopy` — temporarily insert a
  detached div, select its contents, blur the editor (so IE doesn't hijack
  selectionchange), let the browser put the rendered HTML on the clipboard,
  then refocus 50ms later.
* `cut` always also dispatches a `deleteSelection` transaction, regardless of
  whether the API was broken.

### 9.2 `paste` (`input.ts:654-667`)

```ts
editHandlers.paste = (view, _event) => {
  let event = _event as ClipboardEvent
  if (view.composing && !browser.android) return
  let data = brokenClipboardAPI ? null : event.clipboardData
  let plain = view.input.shiftKey && view.input.lastKeyCode != 45
  if (data && doPaste(view, getText(data), data.getData("text/html"), plain, event))
    event.preventDefault()
  else
    capturePaste(view, event)
}
```

* `view.composing && !browser.android` → let the browser do native paste
  during composition, except Android (where the editor is *always* composing
  and we'd never paste otherwise).
* `plain` is the "paste-as-plain-text" signal: shift held, but not
  Shift-Insert (keyCode 45) which is the legacy paste shortcut and shouldn't
  imply plain-text.
* `getText` (`647-652`) prefers `text/plain`, falls back to `text/uri-list`
  with newlines→spaces.
* `doPaste` (`634-645`):
  1. `parseFromClipboard` (file 16) → optional `Slice`.
  2. `handlePaste` prop chain — first plugin to return truthy wins.
  3. If slice has a single open node, use `replaceSelectionWith(node, plain)`
     (so "paste this image" doesn't expand into the surrounding paragraph
     awkwardly); else `replaceSelection(slice)`.
  4. Dispatch with `setMeta("paste", true).setMeta("uiEvent", "paste")` and
     `scrollIntoView`.
* `capturePaste` (`618-632`) — fallback when `clipboardData` is unusable:
  insert a hidden `<textarea>` (plainText) or contenteditable `<div>`
  off-screen, focus it, let the browser paste into it, read the value out
  50ms later, then call `doPaste`.

---

## 10. Drag & Drop

### 10.1 `dragstart` (`input.ts:680-708`)

```ts
let mouseDown = view.input.mouseDown
if (mouseDown) mouseDown.done()
if (!event.dataTransfer) return

let sel = view.state.selection
let pos = sel.empty ? null : view.posAtCoords(eventCoords(event))
let node: NodeSelection | undefined
if (pos && pos.pos >= sel.from && pos.pos <= (sel instanceof NodeSelection ? sel.to-1 : sel.to)) {
  // dragging the active selection
} else if (mouseDown && mouseDown.mightDrag) {
  node = NodeSelection.create(view.state.doc, mouseDown.mightDrag.pos)
} else if (event.target.nodeType == 1) {
  let desc = view.docView.nearestDesc(event.target, true)
  if (desc?.node.type.spec.draggable && desc != view.docView)
    node = NodeSelection.create(view.state.doc, desc.posBefore)
}
let draggedSlice = (node || view.state.selection).content()
let {dom, text, slice} = serializeForClipboard(view, draggedSlice)
if (!event.dataTransfer.files.length || !browser.chrome || browser.chrome_version > 120)
  event.dataTransfer.clearData()
event.dataTransfer.setData(brokenClipboardAPI ? "Text" : "text/html", dom.innerHTML)
event.dataTransfer.effectAllowed = "copyMove"
if (!brokenClipboardAPI) event.dataTransfer.setData("text/plain", text)
view.dragging = new Dragging(slice, dragMoves(view, event), node)
```

Key decisions:

* The dragged content priority is: **active selection ⊃ mightDrag node ⊃
  nearest draggable ancestor of the target**.
* MIME types written: `text/html` (or `Text` on broken APIs) + `text/plain`.
  PM does **not** set a custom MIME like `application/x-prosemirror`; the
  source-view detection happens via `view.dragging` being non-null when
  `drop` fires (see §10.3).
* `clearData()` is only called when there are no files attached, *or* on
  Chrome > 120. Chrome ≤120 had a bug where `clearData` clears file lists
  too (#1472).
* No custom ghost element is set — the browser's default drag image is used.
  `drop-cursor` decoration is a separate plugin (`prosemirror-dropcursor`)
  that listens to `dragover` itself and renders an inline cursor element.
* `Dragging` (`input.ts:669-671`) carries `slice`, `move` (boolean), and
  optional `node` (the source NodeSelection if it was a node-drag).

### 10.2 `dragover`, `dragenter`, `dragend` (`input.ts:710-717`)

```ts
handlers.dragend = view => {
  let dragging = view.dragging
  window.setTimeout(() => { if (view.dragging == dragging) view.dragging = null }, 50)
}
editHandlers.dragover = editHandlers.dragenter = (_, e) => e.preventDefault()
```

* `dragover`/`dragenter` just `preventDefault` — that is what tells the
  browser the editor accepts the drop. Without this, browsers refuse to fire
  the `drop` event.
* `dragend` waits 50ms before clearing `view.dragging` so a same-tick `drop`
  can still see it.
* `posAtCoords` for hover and drop-cursor decorations is *not* done here —
  `prosemirror-dropcursor` listens to `dragover` itself.

### 10.3 `drop` and `handleDrop` (`input.ts:719-778`)

```ts
editHandlers.drop = (view, event) => {
  try { handleDrop(view, event as DragEvent, view.dragging) }
  finally { view.dragging = null }
}
```

`handleDrop`:

```
1. eventPos = posAtCoords(event); bail if null
2. $mouse = doc.resolve(eventPos.pos)
3. slice = dragging.slice  (intra-PM)
        OR parseFromClipboard(text, html, false, $mouse)  (external)
4. transformPasted prop applied to slice (intra-PM only)
5. move = !!(dragging && dragMoves(view, event))
6. handleDrop prop chain — true → preventDefault and return
7. compute insertPos = dropPoint(doc, $mouse.pos, slice) ?? $mouse.pos
8. tr = view.state.tr
9. if move:
       if dragging.node: node.replace(tr)        // remove source node
       else tr.deleteSelection()                  // remove dragged text
10. pos = tr.mapping.map(insertPos)
11. isNode = single-node slice → replaceRangeWith / else replaceRange
12. if no change: return
13. compute new selection:
        if isNode and the inserted node is a selectable atom whose markup
            matches → NodeSelection
        else → TextSelection between $pos and the mapped end
14. view.focus()
15. dispatch(tr.setMeta("uiEvent", "drop"))
```

* **`dragMoves`** (`675-678`): consults `dragCopies` prop first; if absent,
  uses `dragCopyModifier` — `altKey` on Mac, `ctrlKey` elsewhere. The naming
  is inverted: `dragCopies` returning true means "this is a copy, *not* a
  move".
* **Source view detection**: implicit. `view.dragging` is only non-null on
  the source editor view. Multiple PM views in the same page share the same
  `view.dragging` discipline because each view has its own `Dragging`
  instance on its `InputState`.
* **`dropPoint`** (from `prosemirror-transform`) finds the nearest valid
  insertion point near `$mouse.pos` for the given slice — e.g. dropping a
  block before/after the textblock under the cursor depending on which is
  legal.

### 10.4 The ghost / draggable handling on Gecko

In `MouseDown` (`343`), `setUneditable` is set on Gecko if the element isn't
already `contentEditable=false`. After 20ms (line 350-352) the element is
forced uneditable, *only while mouseDown is pending*. This makes Firefox
treat the element as a single drag-able unit instead of trying to drag a
text fragment. `done()` (line 367) reverses both `draggable` and
`contentEditable`.

---

## 11. Read-only mode behavior

`view.editable` is computed each `setProps` from the `editable` prop (default
true). When false:

* The dispatch wrapper (`input.ts:51`) drops every event in `editHandlers`:
  `keydown`, `keyup`, `keypress`, `compositionstart/update/end`, `cut`,
  `paste`, `dragover`, `dragenter`, `drop`, `beforeinput`.
* That leaves: `mousedown`, `touchstart/move`, `contextmenu`, `focus`, `blur`,
  `copy`, `dragstart`, `dragend`. So a read-only view still:
  * Reacts to clicks (selection, link clicks via `handleClickOn`).
  * Lets users select & copy.
  * Lets users drag content out (but not drop in).
  * Tracks focus.
* `focus()` (`index.ts:339`) avoids `focusPreventScroll` when not editable —
  the comment is at the call site.

---

## 12. "Bad selection" detection & forced correction

There is no single "is this selection illegal" predicate; instead the system
constantly nudges the selection back to legal positions:

* **`skipIgnoredNodes`** (`capturekeys.ts:67-157`): on cursor-motion keys,
  skip past zero-size view descs.
* **`selectionFromDOM`** (`selection.ts:9-47`): when reading from DOM, if the
  focus is at a position whose nearest desc is a zero-size widget, set
  `inWidget = true`. If the focused node is an atom that's selectable, return
  a NodeSelection instead of a TextSelection. For multi-range selections it
  takes the bounding pos.
* **`anchorInRightPlace`** (`selection.ts:212-216`): used by the DOM observer
  to reject DOM-selection changes that don't actually move the anchor.
* **Chrome hidden-selection nudge** (`input.ts:399-401`): if the click lands
  ≤2 chars away from a hidden NodeSelection, force `Selection.near`.
* **`selectionToDOM`** (`selection.ts:55-102`): the inverse — sync state to
  DOM. The `brokenSelectBetweenUneditable` path (`108-131`) temporarily
  flips `contentEditable=true` on neighbors of node selections so WebKit
  doesn't refuse to place the selection.
* **`hideSelectionGuard`** (`selection.ts:138-147`): once a hidden selection
  is shown, install a `selectionchange` listener that re-shows the visible
  styling when the user moves the caret elsewhere.
* **`endOfTextblock`** check inside `selectHorizontally` (`capturekeys.ts:29`)
  — the browser's idea of "I'm at the visual end of this line" is the source
  of truth for whether to escape into a NodeSelection.

---

## 13. The `view.input` queue & `endComposition`

There is no explicit FIFO queue per se; "the queue" is implicit in the
serialization of mutations and timeouts:

* `domObserver` accumulates mutations and dispatches them via `flush()`.
* `flushSoon()` schedules a 20ms-deferred flush.
* `forceFlush()` cancels the deferral and flushes synchronously.

`endComposition` interacts with the queue:

* Called from `keydown` (via `forceFlush` at `input.ts:116` *if not 229*),
  `mousedown` (via `forceDOMFlush`), `contextmenu`, `compositionend`, and
  externally.
* On Android only, if `view.domObserver.flushingSoon >= 0` it bails — there
  is already a flush coming; piggyback on it (`input.ts:555`).
* Otherwise: forceFlush; clearComposition; dispatch a final selection or
  delete-selection transaction; or `updateState` to re-render.

`compositionPendingChanges` is the bridge between compositionend (which sets
it) and the *next* `domchange.readDOMChange` (which clears it and includes
the compositionID in the transaction's meta — `domchange.ts:82-83`).

---

## 14. Catalog: every browser-conditional branch in the input pipeline

### `input.ts`

| Line  | Check                                            | What it guards                                                                          |
| ----- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 58    | `browser.safari`                                  | Add a no-op `input` listener so Safari doesn't drop compositions on Enter.              |
| 115   | `browser.android && browser.chrome && keyCode==13` | Suppress Android-Chrome Enter — let composition handle it.                              |
| 122   | `browser.ios && keyCode==13 && no modifiers`     | iOS Enter fallback timeout (200ms) — synthesize keydown if no DOM change.               |
| 145   | `browser.mac && event.metaKey`                    | In keypress: skip Mac-Cmd combos (system shortcuts).                                    |
| 276   | `browser.mac ? "metaKey" : "ctrlKey"`             | `selectNodeModifier` — Cmd vs Ctrl for "click to select node".                          |
| 343   | `browser.gecko && !target.hasAttribute("contentEditable")` | `mightDrag.setUneditable` — Firefox needs uneditable nodes to drag well.    |
| 391   | `browser.safari && mightDrag && !node.isAtom`    | Safari ignores clicks on draggable elements; manually re-place selection on mouseup.    |
| 399   | `browser.chrome && !selection.visible && near`    | Chrome hidden-cursor fixup — click near an invisible NodeSelection updates it.          |
| 447   | `browser.safari && eventTimeStamp~compositionEndedAt` | `inOrNearComposition` Safari Japanese IME Enter suppression (500ms window).       |
| 455   | `browser.android ? 5000 : -1`                    | Android composition idle timeout (5s).                                                   |
| 464   | `browser.chrome && browser.windows && selectionBeforeUneditable` | Issue #1500 — preempt composition before uneditable node.                |
| 474   | `browser.gecko && empty && parentOffset && !textOffset && nodeBefore.marks.length` | Firefox: move cursor into marked node before composition. |
| 555   | `browser.android && flushingSoon >= 0`           | endComposition piggybacks on existing flush on Android.                                  |
| 592   | `browser.ie && ie_version < 15`                  | brokenClipboardAPI: classic IE pre-Edge.                                                 |
| 593   | `browser.ios && webkit_version < 604`            | brokenClipboardAPI: old iOS Safari.                                                      |
| 660   | `view.composing && !browser.android`             | Skip native paste during composition, except Android.                                    |
| 673   | `browser.mac ? "altKey" : "ctrlKey"`             | `dragCopyModifier` — Option vs Ctrl for copy-on-drag.                                    |
| 701   | `!event.dataTransfer.files.length \|\| !browser.chrome \|\| browser.chrome_version > 120` | Pre-Chrome-121: don't `clearData` when files attached. |
| 813   | `browser.chrome && browser.android && deleteContentBackward` | beforeinput Backspace fallback for Chrome Android.                       |

### `capturekeys.ts`

| Line | Check                              | What it guards                                                       |
| ---- | ---------------------------------- | -------------------------------------------------------------------- |
| 33   | `browser.mac && mods.indexOf("m")` | Mac Option (word motion) — let browser handle.                       |
| 40   | `browser.webkit`                   | Manually skip past inline uneditable nodes in WebKit (#937).         |
| 81   | `browser.gecko && nodeType==1 && offset<len && isIgnorable` | Force-skip ignorable child in Firefox.                |
| 225  | `!(browser.chrome \|\| browser.windows) && inlineContent`    | bidi probe is only reliable off Chrome/Windows.       |
| 250  | `browser.mac && mods.indexOf("m")` | Mac Option — vertical motion → browser default.                       |
| 295  | `!browser.safari \|\| ...`         | `safariDownArrowBug` only applies to Safari.                         |
| 324  | `browser.mac && code==72 && mods=="c"` | Mac Ctrl-H = Backspace (Emacs-style).                              |
| 326  | `browser.mac && code==68 && mods=="c"` | Mac Ctrl-D = Delete (Emacs-style).                                  |
| 330  | `browser.mac && code==66 && mods=="c"` | Mac Ctrl-B = Left arrow.                                            |
| 333  | `browser.mac && code==70 && mods=="c"` | Mac Ctrl-F = Right arrow.                                           |
| 336  | `browser.mac && code==80 && mods=="c"` | Mac Ctrl-P = Up arrow.                                              |
| 338  | `browser.mac && code==78 && mods=="c"` | Mac Ctrl-N = Down arrow.                                            |
| 340  | `browser.mac ? "m" : "c"`          | Mod-B/I/Y/Z swallow — Cmd vs Ctrl.                                   |

### `selection.ts`

| Line | Check                                       | What it guards                                              |
| ---- | ------------------------------------------- | ----------------------------------------------------------- |
| 64   | `browser.chrome` (in `selectionToDOM`)      | Defer drag-select selection sync on Chrome.                 |
| 108  | `browser.safari \|\| browser.chrome && chrome_version<63` | `brokenSelectBetweenUneditable` workaround. |
| 114  | `browser.safari && after.contentEditable=="false"`        | Safari: temporarily make following node editable.|
| 124  | `browser.safari && element.draggable`       | Setting contenteditable on a draggable Safari el clears `draggable` until reset. |
| 160  | `browser.ie && ie_version <= 11`            | IE11 control-selection kludge for invisible cursor wrappers.|

---

## 15. Hooks: the prop API surface

This is the user-facing contract; in source-of-truth order from `index.ts:620-723`:

| Prop                       | Where called                                                                                | Truthy return = …                                              |
| -------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `handleDOMEvents[type]`    | `runCustomHandler` (`input.ts:84-87`) — *every* event, before built-in dispatch              | event handled; PM does not call `preventDefault` for you.       |
| `handleKeyDown`            | keydown (`input.ts:131`)                                                                    | call `preventDefault`; skip captureKeyDown.                     |
| `handleKeyPress`           | keypress (`input.ts:147`)                                                                   | call `preventDefault`; skip default text insertion.             |
| `handleTextInput`          | keypress (`input.ts:156`) and `domchange.readDOMChange` (file 15)                           | suppress default `tr.insertText`.                               |
| `handleClickOn`            | `runHandlerOnContext` per ancestor depth (`input.ts:179-180`)                                | mark click handled; outer ancestors not consulted.              |
| `handleClick`              | `handleSingleClick` (`input.ts:232`)                                                        | mark click handled; skip default leaf/node selection.           |
| `handleDoubleClickOn`      | `runHandlerOnContext` from `handleDoubleClick` (`input.ts:237`)                              | as above.                                                       |
| `handleDoubleClick`        | `handleDoubleClick` (`input.ts:238`)                                                        | mark dblclick handled.                                          |
| `handleTripleClickOn`      | `runHandlerOnContext` from `handleTripleClick` (`input.ts:242`)                              | as above.                                                       |
| `handleTripleClick`        | `handleTripleClick` (`input.ts:243`)                                                        | skip `defaultTripleClick`.                                      |
| `handlePaste`              | `doPaste` (`input.ts:636`)                                                                  | skip default paste replacement.                                 |
| `handleDrop`               | `handleDrop` (`input.ts:741`)                                                               | skip default drop replacement.                                  |
| `handleScrollToSelection`  | `EditorView.scrollToSelection` (`index.ts:243`)                                              | `false` = continue with default scroll-into-view; `true` = done.|
| `dragCopies`               | `dragMoves` (`input.ts:675-677`)                                                            | "this drag should be a copy" — inverts move flag.               |
| `createSelectionBetween`   | `selectionBetween` (`selection.ts:188-191`)                                                 | replace default `TextSelection.between` result.                 |

The key invariant: **every "handle*" prop except `handleDOMEvents` causes
ProseMirror to call `preventDefault` on the originating event when it returns
true.** That's the contract documented at `index.ts:606-609`.

---

## 16. Cross-references & file map

* DOM observer / mutation reading → file 14 (`domobserver.ts`).
* DOM-change reconciliation, `readDOMChange`, IME diffing → file 15
  (`domchange.ts`).
* Clipboard serialization & parsing → file 16 (`clipboard.ts`).
* `selection.ts` — the bridge between PM Selection and DOM Selection;
  `selectionFromDOM`/`selectionToDOM` are the symmetric operations the input
  pipeline relies on after every interesting event.
* `viewdesc.ts` — `pmViewDesc.stopEvent`, `nearestDesc`, `posBefore`,
  `selectNode`/`deselectNode` are the per-node hooks the input pipeline
  consults during click handling and node selection.

---

## 17. Implementation lessons for a next-gen editor

1. **Two dispatch tables, copied at boot.** The `editHandlers` ⊂ `handlers`
   pattern is a clean way to express the read-only filter without a runtime
   `if`-tree at every event.
2. **Bubble phase + `eventBelongsToView` guard** is enough to give node
   views a `stopEvent` opt-out. No need for capture-phase listeners.
3. **`MouseDown` as an explicit object** (not just closures) makes the
   "delayed selection sync", "drag detection", and "uneditable kludge"
   trivially readable. Worth replicating.
4. **Synthetic triple-click** with a 500ms / 100px² window is
   industry-standard and worth keeping.
5. **`captureKeyDown` as a backstop** rather than a primary handler — the
   user's keymap runs first; only when nothing handles the key do we
   second-guess the browser. A modern editor could collapse this with the
   keymap by encoding "browser would do the wrong thing" as a low-priority
   fallback in the keymap itself.
6. **Composition is the hard part.** Of the 18 InputState fields, 8 exist
   solely to disambiguate composition events. A new editor that controls its
   own rendering (e.g. via canvas) can side-step most of this; one that uses
   contenteditable cannot.
7. **Browser quirks are scoped by feature, not by browser.** The pattern of
   `browser.x` checks scattered across one logical block (e.g. composition
   start) is easier to maintain than per-browser code paths.
