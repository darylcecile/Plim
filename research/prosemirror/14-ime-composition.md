# 14 — IME & Composition

> Source basis: `prosemirror-view/src/input.ts`, `viewdesc.ts`, `index.ts`,
> `domobserver.ts`, `domchange.ts`, `selection.ts`, `browser.ts`.
> All citations are `file:line` against the upstream `prosemirror-view`
> snapshot in `/tmp/prosemirror-research/`.

---

## 1. The IME problem

A `contenteditable` editor that controls its own DOM has a fundamental
conflict with *Input Method Editors* (CJK, Hangul, hangul-jamo, voice
input, autocorrect, gboard suggestions, dead-key Latin combos):

* During composition the **browser owns a transient text node** (or several)
  that represents the in-flight, not-yet-committed character sequence.
  Underlining, candidate popups, and selection are all anchored on those
  exact DOM nodes.
* If we *re-render* the contenteditable region while the user is composing,
  the browser loses its anchor:
  - the candidate window detaches,
  - the composition is silently committed at the wrong position,
  - or worse, the next `compositionupdate` fires with a stale `data` and
    duplicates characters.
* On Android Chrome the situation is even more hostile: the IME is *always*
  on (gboard treats every keystroke as composition), and the
  `compositionstart`/`compositionend` events lie about content. The browser
  also fires `keydown` with `keyCode 229` — the legendary "input pending"
  sentinel.

ProseMirror's strategy is therefore: **freeze reconciliation over the
composition area for as long as the browser is composing, then read the
DOM back into state on `compositionend`** (or a timeout, on Android).

---

## 2. State carried on `view.input`

Defined on `InputState` in `input.ts:19-44`:

| field | purpose |
|---|---|
| `composing: boolean` (L32) | Public-ish flag exposed via `view.composing` (`index.ts:110`). True between `compositionstart` and `compositionend` (or its timeout). |
| `view.composing` getter (`index.ts:108-110`) | Just forwards `this.input.composing`. There is no separate "tail-window" — code that wants to see "composition just ended" reads `compositionEndedAt` directly via `inOrNearComposition` (see §11). |
| `compositionNode: Text \| null` (L33) vs `compositionNodes: ViewDesc[]` (L35) | **Different things, despite the name overlap.** `compositionNode` is the *one* live `Text` node currently being mutated by the IME (a snapshot stored by `findCompositionNode` on each `updateState`). `compositionNodes` is an array of *past* `CompositionViewDesc` instances queued up so `clearComposition` can call `markParentsDirty` on each when composition ends — i.e. one is "current", the other is "history of everything we shielded so far this composition". |
| `view.markCursor: readonly Mark[] \| null` (`index.ts:41`) | The marks the *next* inserted character should carry. Set by `compositionstart`'s mark-context branch before calling `endComposition(view, true)` (`input.ts:466-468`). When non-null, `updateCursorWrapper` (`index.ts:537-547`) renders an invisible `<img mark-placeholder>` widget wrapped in the marks so the IME types into the correctly-marked DOM context. Cleared on the next state change. |
| `composingTimeout: number` (L34) | Setinterval handle that ends composition after 5 s of inactivity on Android (`timeoutComposition = 5000`, `input.ts:455`). |
| `compositionNodes: ViewDesc[]` (L35) | Stack of `CompositionViewDesc` instances that need to be marked dirty when composition is cleared. |
| `compositionEndedAt: number` (L36) | Timestamp of last `compositionend`. Used to ignore the spurious `keydown Enter` Safari fires immediately after a Japanese candidate confirm (`input.ts:447`). |
| `compositionID: number` (L37) | Monotonic ID, bumped on every `compositionend` (`input.ts:510`). Stamped into the resulting transaction's metadata as `tr.setMeta("composition", id)` so plugins / history can correlate steps that came from a single IME run. |
| `compositionPendingChanges: number` (L40) | If mutations were *queued but not flushed* at `compositionend`, this stores the composition ID so the next flush attaches it to the dispatched transaction. |
| `badSafariComposition: boolean` (L38) | Toggled by `domobserver.ts:68` when Safari mangles a table cell composition; triggers `fixUpBadSafariComposition` post-flush. |

`view.composing` is a getter pointing at `view.input.composing`
(`index.ts:108-110`), which is what the rest of the codebase tests.

---

## 3. Lifecycle: start → update → end

The handlers live in `input.ts:457-513`:

### 3a. `compositionstart` / `compositionupdate` (L457-493)

Both events go through the same handler. Logic:

1. If we weren't already composing (`!view.composing`):
   - **Force-flush the observer** first (`view.domObserver.flush()`, L459)
     so any pending mutations from before the IME started are turned
     into transactions before we freeze.
   - If the cursor has *stored marks* — or sits at the right edge of an
     inline mark with `inclusive: false` — we can't let the browser type
     into the existing mark span, because the new text wouldn't carry the
     stored marks. We end composition immediately (`endComposition(view, true)`,
     L467) but keep `view.markCursor` set so the next text input rebuilds
     the cursor wrapper with the right marks.
   - On Chrome+Windows there's a special case where the cursor sits in front
     of a `contentEditable=false` widget — `selectionBeforeUneditable`
     (L495) — same workaround applies (issue #1500).
   - Otherwise we call `endComposition(view, !state.selection.empty)` to
     flush any leftover state, then enter composition.
   - **Firefox-only mark inheritance fix** (L474-487): if the cursor is at
     the edge of a marked node, Firefox refuses to inherit the marks for
     the inserted text, so we manually walk the DOM and `collapse` the
     selection *into* the preceding text node so the IME inserts inside
     the mark span.
2. Set `view.input.composing = true` (L490).
3. Schedule an Android-only watchdog timer (`scheduleComposeEnd(view, 5000)`,
   L492 → L515): if no `compositionend` arrives within 5 s, force-end.

### 3b. `compositionend` (L502-513)

```ts
editHandlers.compositionend = (view, event) => {
  if (view.composing) {
    view.input.composing = false
    view.input.compositionEndedAt = event.timeStamp
    view.input.compositionPendingChanges =
      view.domObserver.pendingRecords().length ? view.input.compositionID : 0
    view.input.compositionNode = null
    if (view.input.badSafariComposition) view.domObserver.forceFlush()
    else if (view.input.compositionPendingChanges)
      Promise.resolve().then(() => view.domObserver.flush())
    view.input.compositionID++
    scheduleComposeEnd(view, 20)
  }
}
```

Notes:
* `composing` is cleared *immediately*, but `compositionNode` stays
  reachable through the `compositionPendingChanges` pathway so the
  follow-up flush still knows it's part of the composition.
* `pendingRecords()` (`domobserver.ts:169-172`) drains the
  `MutationObserver`'s buffer plus the queue we've accumulated. If it's
  empty, no transaction is needed; if it's non-empty, the *next*
  microtask flushes it.
* `compositionID` is bumped *after* it's been stamped, so the *next*
  composition gets a fresh ID.
* `scheduleComposeEnd(view, 20)` (L511) sets a 20 ms safety net to call
  `endComposition` if a redraw didn't already happen.

**Why `Promise.resolve().then(() => view.domObserver.flush())` and not
`setTimeout(..., 0)`?** Microtask ordering. A `Promise.resolve().then`
callback runs *before* the browser yields to the event loop's macrotask
queue — i.e. *before* the next animation frame, before any I/O callback,
and crucially *before* the browser repaints. Using `setTimeout` would
schedule the flush as a macrotask, giving the browser an opportunity to
paint the post-composition DOM (with whatever the IME left behind) before
PM has a chance to reconcile. The result would be a single-frame visual
flicker every time a composition ends. The microtask path guarantees the
reconcile happens "between" the JS turn that fired `compositionend` and
the browser's first paint after that turn.

The 5s vs 20ms `scheduleComposeEnd` distinction:
* **5000ms** (`timeoutComposition`, `input.ts:455`) — used inside
  `compositionstart`/`compositionupdate` on Android only. Some Android
  IMEs never fire `compositionend` if the user just walks away; the 5-s
  watchdog force-ends the composition so PM doesn't stay frozen forever.
* **20ms** (`input.ts:512`) — used immediately after `compositionend`.
  Schedules a deferred `endComposition` to run if a redraw hasn't already
  forced one. The 20ms picks up any residual mutations the browser may
  emit *after* compositionend (Safari is the worst offender), then tears
  down the composition shield.

### 3c. `endComposition` — the "force end" path (L554-566)

```ts
export function endComposition(view: EditorView, restarting = false) {
  if (browser.android && view.domObserver.flushingSoon >= 0) return
  view.domObserver.forceFlush()
  clearComposition(view)
  if (restarting || view.docView && view.docView.dirty) {
    let sel = selectionFromDOM(view), cur = view.state.selection
    if (sel && !sel.eq(cur)) view.dispatch(view.state.tr.setSelection(sel))
    else if ((view.markCursor || restarting) && !cur.$from.node(...).inlineContent)
      view.dispatch(view.state.tr.deleteSelection())
    else view.updateState(view.state)
    return true
  }
  return false
}
```

* The Android guard at L555 prevents fighting an already-scheduled flush.
* `forceFlush()` (`domobserver.ts:88-94`) cancels the pending timer and
  drains the queue *now*.
* `clearComposition` (L520-526) flips `composing = false`, sets
  `compositionEndedAt` to a synthesised timestamp (`timestampFromCustomEvent`,
  L547-551, used so the "ignore Enter near compositionend" check in
  `inOrNearComposition` still works for programmatic ends), and pops every
  `CompositionViewDesc` off `compositionNodes` calling `markParentsDirty()`
  on each so the next reconcile redraws them.
* If the doc is now dirty (or we were explicitly *restarting* a composition
  with new marks), we dispatch / `updateState` to rebuild the DOM.

#### Why the second argument `restarting`?

The `restarting` parameter is *only* `true` from one caller: the
mark-context branch of `compositionstart` (`input.ts:466-468`), where the
user has begun composing and there are stored marks (set via
`tr.setStoredMarks` or implicitly because the cursor is between two
identically-marked text runs) that need to wrap the in-progress IME text.

Without `restarting`, the three-way branch inside `endComposition` would
choose the "selection unchanged, doc not dirty, no markCursor" path and
return `false` — meaning **the stored marks would silently disappear**,
because nothing would force the DOM to be re-rendered with the
mark-placeholder wrapper around the cursor. With `restarting = true`, the
function falls through to either `tr.deleteSelection` (if at a non-inline
parent) or — the common case — `view.updateState(view.state)`, which
re-runs `viewUpdate` and *renders* the mark-placeholder widget. The IME
then resumes typing into the correctly-wrapped DOM, and on subsequent
characters the typed text inherits those marks via `markCursor`.

The single use site is essentially: "I'm about to start a composition,
but I need PM's DOM redrawn to reflect the marks-context first; pretend
I'm 'ending' a composition just to force that redraw, then immediately
let the new compositionstart proceed." A subtle but load-bearing trick.

### 3d. `forceDOMFlush` (L272-274)

A trivial alias: `endComposition(view)`. Called from `mousedown` (L281),
`touchstart` (L424), `contextmenu` (L433), and on every non-229
`keydown` (L116) — i.e. anything that proves the user has stopped IME
input.

---

## 4. `CompositionViewDesc` — the shield

Defined `viewdesc.ts:586-605`:

```ts
class CompositionViewDesc extends ViewDesc {
  constructor(parent, dom, readonly textDOM: Text, readonly text: string) {
    super(parent, [], dom, null)
  }
  get size() { return this.text.length }
  localPosFromDOM(dom, offset) {
    if (dom != this.textDOM) return this.posAtStart + (offset ? this.size : 0)
    return this.posAtStart + offset
  }
  domFromPos(pos) { return {node: this.textDOM, offset: pos} }
  ignoreMutation(mut) {
    return mut.type === 'characterData' && mut.target.nodeValue == mut.oldValue
  }
}
```

Properties of this special view desc:

* **No children** (`super(parent, [], ...)`) — it's a leaf shielded box.
* **It owns a real DOM node** the browser is mid-edit on (`textDOM`), so
  reconciliation must not touch it. This is the critical inversion vs.
  `TextViewDesc`: a normal `TextViewDesc.dom` is a Text node *PM created*
  and feels free to replace; a `CompositionViewDesc.dom` is a Text node
  *the browser created* (or PM created earlier and the browser is now
  mutating) — the reconciler must keep its hands off.
* `ignoreMutation` returns true for the no-op characterData notifications
  some browsers fire spuriously, but lets real edits through (since
  `oldValue !== nodeValue` then).
* It reports `posAtStart..posAtStart+text.length` for any DOM probe so
  selection translation still works while the live text grows/shrinks.

It is constructed inside `NodeViewDesc.protectLocalComposition`
(`viewdesc.ts:835-852`), which is invoked from `updateChildren`
(L767-813) only when *both* `view.composing` is true *and*
`localCompositionInfo` (L815-833) located a text node currently used by
the IME inside this very node:

```ts
if (updater.changed || this.dirty == CONTENT_DIRTY) {
  if (localComposition) this.protectLocalComposition(view, localComposition)
  renderDescs(this.contentDOM!, this.children, view)
  ...
}
```

### 4a. `protectLocalComposition` step-by-step

The full algorithm (annotated):

```ts
// viewdesc.ts:835-852, slightly elided
protectLocalComposition(view, {node, pos, text}) {
  // (1) Bail if the textNode is already wrapped (e.g. on re-entry)
  if (this.getDesc(node)) return

  // (2) Hoist node up to be a direct child of this.contentDOM,
  //     peeling siblings and detaching wrappers.
  let topNode = node
  for (;;) {
    topNode.pmViewDesc = undefined
    if (topNode.parentNode == this.contentDOM) break
    let parent = topNode.parentNode!
    while (parent.firstChild != topNode) parent.removeChild(parent.firstChild!)
    while (parent.lastChild != topNode) parent.removeChild(parent.lastChild!)
    if (parent.pmViewDesc) parent.pmViewDesc = undefined
    topNode = parent
  }

  // (3) Build the CompositionViewDesc and remember it for later cleanup.
  let desc = new CompositionViewDesc(this, topNode, node, text)
  view.input.compositionNodes.push(desc)

  // (4) Splice it into our children array at [pos, pos+text.length].
  this.children = replaceNodes(this.children, pos, pos + text.length, view, desc)
}
```

The substitution model is the key insight: **PM substitutes the live Text
node into its own desc tree** rather than building a fresh DOM node. The
new `CompositionViewDesc.dom` *is* `topNode`, the actual node the browser
is editing. After the splice, `renderDescs` walks `this.children`, sees a
desc whose `dom` is already correctly placed, and skips. The browser
keeps editing into a Text node that PM has implicitly promised to leave
alone for the duration of the composition.

The peel-siblings loop in step (2) is necessary because the browser
sometimes wraps the composition in a `<span class="...">` of its own
making — typing "あ" with macOS Japanese IME, for instance, briefly
inserts a `<span style="background-color: rgba(...)">` underline-decoration
wrapper. Hoisting up to `contentDOM` means our `CompositionViewDesc.dom`
captures that wrapper *as well as* the inner text, so `renderDescs`
preserves the entire subtree, decorations and all.

### 4b. `localCompositionInfo` scoring

`localCompositionInfo` (L815-833) returns either:
- `{node, pos: textPos, text}` when the composition text sits in *this*
  node's inline content,
- `{node, pos: -1, text: ""}` when the composition is in a *child* node
  (`compositionInChild`, used at L771, L788),
- or `null` when the composition has nothing to do with this subtree.

The decision tree:

1. **Is the selection a `TextSelection`?** No → return `null` (other
   selection types can't host a composition; let normal reconcile run,
   which has the side-effect of ending the composition).
2. **Is `view.input.compositionNode` still attached to `view.dom`?**
   (Tracked via `composingInside(view, view.input.compositionNode)`.)
   No → return `null` (the IME is editing a node we already discarded;
   force fall-through).
3. **Is the composition text node a descendant of `this.contentDOM`?**
   Yes-and-inline → call `findTextInFragment(this.node.content, …)` to
   compute the PM offset of the text within this node and return
   `{node, pos: textPos, text: compositionNode.nodeValue}`.
   Yes-but-in-a-child → return `{node, pos: -1, text: ""}` (the
   `compositionInChild` sentinel).
   Neither → return `null`.

The `compositionInChild` branch (L788-792 of `updateChildren`) targets a
different optimization: it forces the `ViewTreeUpdater` to update the
*specific existing* child desc that contains the composition rather than
creating a new one, so the DOM identity is preserved. The actual shield
is constructed by *that* child desc when it later runs `updateChildren`.

### 4c. Why `markParentsDirty` (not `markDirty`) on cleanup?

When composition ends, `clearComposition` (`input.ts:520-526`) loops
over `compositionNodes` and calls `markParentsDirty()` on each. Crucially,
it does **not** call `markDirty(from, to)` with a precise range. Why?

Because by the time we're cleaning up, the IME has been mutating the DOM
for an unknown duration; we don't know exactly which positions were
affected, and the browser may have inserted/removed text outside the
original `[pos, pos+text.length]` range we initially shielded.
`markParentsDirty` walks up from each desc setting `CHILD_DIRTY` /
`CONTENT_DIRTY` flags, guaranteeing the next reconcile fully redraws all
of the affected subtrees rather than trusting a possibly-stale range.
Over-dirtying is safe and cheap; under-dirtying would leave divergent
DOM/state that any subsequent operation would crash on.

---

## 5. Deferred reconciliation — `updateState` while composing

`index.ts:153-220` is the canonical reconcile loop. The composition-aware
bits:

```ts
if (state.storedMarks && this.composing) {     // L157
  clearComposition(this)                       // forcibly end IME
  updateSel = true
}
...
if (updateDoc) {
  let chromeKludge = browser.chrome ? (this.trackWrites = ...focusNode) : null
  if (this.composing) this.input.compositionNode = findCompositionNode(this)  // L199
  if (redraw || !this.docView.update(state.doc, outerDeco, innerDeco, this)) {
    ...
  }
}
```

What's happening:
* If the new state introduces *stored marks* mid-composition we have no
  choice but to abort the IME — the marks need to wrap the cursor, which
  requires DOM surgery the IME can't survive.
* Otherwise, before we ask the docView to update, we **snapshot
  `compositionNode`**: `findCompositionNode(view)` (`input.ts:528-545`)
  inspects `domSelectionRange()` and finds the text node either side of
  the focus, returning whichever one is currently being mutated (it
  cross-references `view.domObserver.lastChangedTextNode`,
  `domobserver.ts:46`, and the previous `compositionNode` to keep
  identity stable across reconciles).
* `docView.update` then runs through `updateChildren`, which sees
  `view.composing` and routes through `localCompositionInfo` →
  `protectLocalComposition` → DOM untouched.

The selection block (L184-220) wraps DOM writes in
`domObserver.stop()` / `start()` so the mutation observer doesn't see
ProseMirror's own writes as "external" changes.

The only visible-to-state effect of edits during composition is that
**transactions still get applied** (state changes, plugins fire, history
records steps), but the **DOM stays as the IME left it**. State and DOM
diverge; the DOM is treated as authoritative for the composition area
until `compositionend`.

---

## 6. `forceFlush` / `flushSoon` / `endOfComposition`

From `domobserver.ts`:

* `flushSoon()` (L83-86): debounces a flush 20 ms in the future. Used
  when IE11 and Safari produce mutations that aren't safe to read
  synchronously (L62, L69).

  **Why 20 ms specifically?** The number is empirically chosen to balance
  two competing pressures:

  1. **Short enough to feel synchronous.** A burst of mutations from a
     single user action (one keystroke, one paste) typically arrives
     within 1-3 ms. 20 ms is below the 100-ms human-perception threshold
     for "instant" feedback, so the editor doesn't feel laggy.
  2. **Long enough to coalesce.** A single user action often produces
     multiple `MutationRecord`s — typing a Korean syllable can fire 3-4
     records (composition wrapper insertion, characterData, wrapper
     removal, characterData again). Flushing immediately on the first
     record would produce three separate `readDOMChange` calls, three
     transactions, three round-trips through the plugin system. The 20 ms
     debounce lets them coalesce into one logical edit.

  Lower values (5 ms, 10 ms) were tried in the historical commits and
  caused noticeable transaction storms on Safari with long compositions.
  Higher values (50 ms+) felt sluggish.

* `forceFlush()` (L88-94): cancels the debounce and runs `flush()` now.
  Called by `endComposition` (`input.ts:556`) and by every non-229
  `keydown` (`input.ts:116`).
* `flush()` (L174-250): the heart. Stops the observer implicitly via
  `pendingRecords()`, computes a `(from, to, typeOver, added)` tuple by
  iterating `registerMutation` (L252-302), then calls
  `handleDOMChange` — which `index.ts:89` wires to `readDOMChange` in
  `domchange.ts`. **This is the single point where DOM mutations become
  ProseMirror transactions.**

The flush is also the place where the post-composition transaction
acquires its `composition` metadata (`domchange.ts:82-83`):

```ts
let compositionID = view.input.compositionPendingChanges ||
                    (view.composing ? view.input.compositionID : 0)
view.input.compositionPendingChanges = 0
```

So if `compositionend` queued a flush via `Promise.resolve().then(...)`
(`input.ts:509`), the next `readDOMChange` will tag the dispatched tr
with that ID and clear the pending flag.

---

## 7. Browser-specific quirks documented in source

### 7a. Android Chrome (`browser.android` ≡ `/Android \d/.test(agent)`, `browser.ts:22`)

Android is the worst environment because gboard *always* composes:

* **`keydown 229` handling.** `input.ts:116` — `if (event.keyCode != 229)
  view.domObserver.forceFlush()`. We *don't* flush on 229 because that's
  the marker that the keystroke is being routed into an active IME
  composition; the actual DOM mutation will arrive later.
* **Suppressed Enter.** `input.ts:115` — `if (browser.android &&
  browser.chrome && event.keyCode == 13) return`. Chrome Android fires
  Enter as part of a confused IME sequence; we let `readDOMChange`
  synthesise the Enter from the resulting DOM mutation instead.
* **Synthetic Enter from mutations.** `domchange.ts:124-130` and
  `domchange.ts:181-189`: if a DOM mutation contains a new block-level
  node and the existing change wouldn't naturally produce one, we fire a
  fake `keydown(13, "Enter")` through the user's `handleKeyDown` so
  command bindings still work.
* **Backspace simulation.** `domchange.ts:191-196`: if the diff
  *looks* like a backspace at a block boundary, we fire a synthetic
  `keydown(8, "Backspace")`. After firing, on Android we call
  `view.domObserver.suppressSelectionUpdates()` (issue #820) because
  Android then moves the selection in a way that would otherwise fight
  the dispatched transaction.
* **5 s composition timeout.** `input.ts:455` — `const timeoutComposition
  = browser.android ? 5000 : -1`. Some IMEs never fire `compositionend`
  if the user just walks away; we force it after 5 s.
* **Selection-then-mutation race.** `domchange.ts:212-219`: when an
  Android virtual keyboard "pick suggestion" splits a paragraph, the DOM
  mutation lands *before* the selection move. We trim the spurious new
  paragraph from the change and then `setTimeout(..., 20)` a synthetic
  Enter.
* **Don't bail on paste during composing.** `input.ts:660` — pastes are
  ignored while composing *except* on Android, where the IME is always
  on so we'd never paste otherwise.

### 7b. iOS Safari (`browser.ios`, `browser.ts:19`)

* **`lastIOSEnter`.** `input.ts:122-130`: pressing Enter inside an iOS
  contenteditable is hostile — `preventDefault` confuses the virtual
  keyboard. We instead set `view.input.lastIOSEnter = now` and a 200 ms
  fallback `setTimeout` that fires the synthetic Enter if no DOM
  mutation arrived (the keyboard sometimes swallows it entirely).
* `domchange.ts:124, 181-189` re-check `lastIOSEnter > Date.now() - 225`
  to attribute incoming block-creating mutations to that Enter press.
* **Composition during autocorrect.** Autocorrect is implemented as an
  IME in iOS; the `compositionstart`/`end` flow above handles it. The
  important interaction is that key events are *suppressed* during
  composition — `inOrNearComposition` (`input.ts:435-452`) returns true
  for `keydown` and `keypress` while composing, so we never run command
  bindings.
* **`brokenClipboardAPI`.** `input.ts:592-593` includes
  `browser.ios && browser.webkit_version < 604`, falling back to the
  copy-via-DOM hack.

### 7c. macOS / iOS Safari (`browser.safari`, `browser.ts:17`)

* **Composition + Enter (Japanese).** `input.ts:447` —
  `if (browser.safari && Math.abs(event.timeStamp -
  view.input.compositionEndedAt) < 500) { ... return true }`. Safari
  fires both `compositionend` and `keydown Enter` when the user hits
  Enter to confirm a Japanese candidate. We swallow the Enter once if it
  arrives within 500 ms of the compositionend.
* **Composition in a table cell.** `domobserver.ts:63-69` — Safari
  inserts the composed text *into the surrounding `<tr>`* instead of the
  cell. We set `view.input.badSafariComposition = true` and call
  `flushSoon`. After the flush, `domobserver.ts:241-244` calls
  `fixUpBadSafariComposition` (L371-392) which walks each orphaned node,
  finds the next `<TD>`/`<TH>`, and reparents the node into it
  (collapsing the selection back if it was on that node).
* **Phantom input listener.** `input.ts:58` —
  `if (browser.safari) view.dom.addEventListener("input", () => null)`.
  The comment is candid: *"for reasons beyond my understanding, adding
  an input event handler makes an issue where the composition vanishes
  when you press enter go away"*.
* **BR-replaces-LI bug.** `domchange.ts:66-72` — Safari sometimes
  replaces a list item or table cell with a literal `<br>`; the
  `ruleFromNode` helper detects this during `parseBetween` and either
  injects a synthetic `<li>` parser rule or ignores the BR.
* **Dead keys.** A macOS dead-key sequence (option-e, e → é) goes
  through the same `compositionstart`/`update`/`end` cycle. There's no
  special-case code for it because the standard flow handles it; the
  Enter-near-end logic above is what matters.
* **`safariShadowSelectionRange`.** `domobserver.ts:332-357` — when the
  editor is hosted in a shadow root, Safari refuses to expose the
  selection. We use `getComposedRanges` if available, otherwise hack
  around it by triggering a `beforeinput` via `execCommand("indent")`
  and reading `event.getTargetRanges()`.

### 7d. IE / Edge legacy (`browser.ie`, `browser.ts:5-10`)

Surviving paths:

* **`useCharData`.** `domobserver.ts:16` — IE11's MutationObserver is
  broken for character data, so we additionally listen to
  `DOMCharacterDataModified` and queue a synthetic record
  (L74-79, L101-102).
* **Out-of-order mutation/observer callback.** `domobserver.ts:55-62` —
  on IE11, backspacing a single-char text node after a `<br>` fires the
  observer callback before the DOM is actually updated; we `flushSoon`
  to wait one tick.
* **Wrong sibling in addedNodes.** `domobserver.ts:272-280` — IE11
  reports incorrect `previousSibling` / `nextSibling`; we recompute by
  scanning `mut.addedNodes`.
* **Selection-change-before-DOM-change.** `domobserver.ts:138-143` — IE
  fires selectionchange first; if so we `flushSoon` instead of `flush`.
* **NBSP-ahead-of-space bug.** `domchange.ts:167-173` — IE inserts a
  non-breaking space ahead of an existing space; we shift the change
  range left by one to absorb it.
* **Backspace at start of textblock.** `domchange.ts:248-251` — IE
  weirdly moves the DOM selection after backspacing the first character;
  we `suppressSelectionUpdates` and re-`selectionToDOM` 20 ms later.
* **Cursor wrapper disable hack.** `selection.ts:160-163` — IE11's
  control-selection on an invisible cursor wrapper produces resize
  handles; we toggle `disabled` to kill it.
* **Don't trust `Selection.isCollapsed`.** `domobserver.ts:140` — we
  call `isEquivalentPosition` ourselves.

### 7e. Gecko / Firefox (`browser.gecko`, `browser.ts:11`)

* **Mark inheritance during compositionstart.** `input.ts:474-487` —
  walks the DOM selection into the trailing text node so the IME inserts
  *inside* the marked span.
* **Spurious style mutations.** `domobserver.ts:259` —
  `mut.attributeName == "style" && !mut.oldValue && !target.getAttribute("style")`
  is filtered out as a Firefox bug.
* **Double-BR handling.** `domobserver.ts:208-222` — Firefox sometimes
  inserts two `<br>` nodes when one would do; we strip the extras.
* **Mightdrag uneditable kludge.** `input.ts:343-353` sets
  `contenteditable=false` on the dragged target on Gecko.
* **`requiresGeckoHackNode`.** `domobserver.ts:312` — when CSS
  whitespace isn't `pre`/`pre-wrap`, Gecko needs an extra hack node to
  render trailing whitespace; the flag is read by `viewdesc.ts`.

---

## 8. Android-specific MutationObserver-driven path

On Android the composition events are unreliable (event content lies,
ordering is wrong). The de-facto strategy is therefore:

1. Let the IME mutate the DOM.
2. The MutationObserver collects every characterData / childList change
   (`domobserver.ts:7-14`).
3. On `flushSoon`/`flush` (every 20 ms, or sooner on
   `forceFlush`), `registerMutation` (L252-302) computes the affected
   PM range.
4. `readDOMChange` (`domchange.ts:81+`) re-parses that range and diffs.
5. Heuristics in `domchange.ts:124-130, 181-189, 191-196, 212-219`
   decide whether to:
   - synthesise an `Enter` keydown,
   - synthesise a `Backspace` keydown,
   - drop a spurious "new paragraph" inserted before the selection
     moved,
   - or just dispatch a regular `tr.replace`.

So on Android, the *actual* event we trust is `MutationRecord`, not
`compositionupdate`. The composition flag exists mainly to avoid
clobbering the in-flight DOM during state-driven redraws, not to drive
the read.

---

## 9. Marks during composition

The flow:

1. Stored marks at `compositionstart` would silently be lost (the IME
   types into the existing parent's mark span). `input.ts:461-468`
   detects this and calls `endComposition(view, true)` with
   `view.markCursor` set to the stored marks. The restart re-renders the
   selection inside a freshly marked cursor wrapper, then the user's
   composition begins inside that wrapper.
2. `index.ts:155-160`: if `state.storedMarks` arrive *during*
   composition (e.g. via a plugin), we `clearComposition` and force a
   selection update.
3. After a normal `compositionend`-driven `readDOMChange`, the dispatched
   transaction uses `tr.insertText` when possible
   (`domchange.ts:265-270`), which preserves marks-around-cursor via the
   transform's normal text-insertion logic. If the change spans nodes,
   we fall back to `tr.replace` which carries marks from the parsed
   slice.
4. `domchange.ts:253` — for the deletion-shaped inline case we call
   `marksAcross` and `tr.ensureMarks(marks)` so the cursor still has the
   right active marks after a backspace-style composition end.
5. `isMarkChange` (`domchange.ts:287-306`) recognises the case where the
   browser added or removed a single mark type via autocorrect (e.g.
   converting `iPhone` to bold-`iPhone` via spellcheck rewrite). It
   diffs the mark sets and dispatches `tr.addMark` / `tr.removeMark`
   instead of a content replace.

---

## 10. Ending composition prematurely

Triggers, in order of how the source structures them:

| trigger | site | call |
|---|---|---|
| Mouse down | `input.ts:281` | `forceDOMFlush(view)` → `endComposition` |
| Touch start | `input.ts:424` | same |
| Context menu | `input.ts:433` | same |
| Non-229 keydown | `input.ts:116` | `view.domObserver.forceFlush()` |
| Stored marks added by state | `index.ts:157-160` | `clearComposition(view)` |
| 5 s timeout (Android) | `input.ts:492, 455` | `endComposition(view)` |
| Plugin/programmatic dispatch that dirties docView | `endComposition` itself | dispatches a setSelection or runs `updateState` |
| Focus loss | covered by selectionchange / `hasFocusAndSelection` (`domobserver.ts:133`) which causes `flush` to early-return; on next focus, observer is reattached fresh |

`clearComposition` (`input.ts:520-526`) is the lowest-level "tear down"
primitive: it marks `composing = false`, fakes a timestamp, and pops
every `CompositionViewDesc` calling `markParentsDirty()` so the next
reconcile redraws the previously-shielded DOM with the canonical PM
output.

`endComposition` is a superset that also `forceFlush`es and dispatches
state-corrective transactions if needed.

---

## 11. Selection during composition

Critical rule: **don't move the DOM selection while composing**.

Where the rule shows up:

* `selectionToDOM` is called from `updateStateInner` only after
  `domObserver.stop()` (`index.ts:185-219`). During composition the
  reconciler does *not* touch the DOM (because of
  `protectLocalComposition`), so there's no DOM rewrite to follow up
  with a selection rewrite — the existing IME selection stays put.
* `domobserver.ts:127-130` exposes `suppressSelectionUpdates()`, called
  for 50 ms whenever PM has just made a synthetic change that would
  cause a misleading selectionchange (e.g. simulated Backspace on
  Android Chrome, `domchange.ts:194`).
* `selection.ts:55-102` — `selectionToDOM` disconnects the selection
  listener while it writes. Combined with `domObserver.stop` in
  `updateState`, this means even our explicit selection writes don't
  trip the observer.
* During composition, `readDOMChange` *avoids* moving the cursor in
  certain Chrome-mid-composition false reports
  (`domchange.ts:233-237`):

  ```ts
  if (sel && !(browser.chrome && view.composing && sel.empty &&
       (change.start != change.endB || view.input.lastChromeDelete < Date.now() - 100) &&
       (sel.head == chFrom || sel.head == tr.mapping.map(chTo) - 1) || ...))
    tr.setSelection(sel)
  ```

  i.e. if Chrome reports an empty selection at the wrong end of a
  composition replace, we skip the selection update.

---

## 12. Sequence diagram — IME compose + commit

```
USER            BROWSER               PM input.ts          PM domObserver       PM docView                state
─────           ───────               ───────────          ──────────────       ─────────                 ─────
"あ" key  ──▶  compositionstart  ──▶  compositionstart h.
                                      flush()         ──▶  flush() → maybe readDOMChange
                                      composing=true
                                      scheduleComposeEnd(5000) [Android only]

                compositionupdate ─▶  same handler (already composing) → just resets timeout

                DOM mutation:
                "あ" inserted into  ─▶  MutationObserver
                a text node             queue.push(record)
                                        flush() (20ms debounced)
                                                              ─▶ registerMutation → from..to
                                                              ─▶ readDOMChange (composing=true)
                                                                    parseBetween()
                                                                    findDiff()
                                                                    dispatch tr.insertText()
                                                                                                ──▶ updateState
                                                                                                ──▶ updateStateInner
                                                                                                ──▶ docView.update
                                                                                                      updateChildren:
                                                                                                        composing=true
                                                                                                        localCompositionInfo → text node
                                                                                                        protectLocalComposition →
                                                                                                          new CompositionViewDesc
                                                                                                          patches children
                                                                                                        renderDescs (skips comp desc)
                                                                                                                                  state.doc updated
                                                                                                                                  DOM untouched in IME area

[user types more]   compositionupdate / mutations    ←── repeat ──→
                    each mutation ──► same path: tr.replaceRange tagged with compositionID;
                                       DOM stays as IME-rendered

USER hits Enter to confirm:
                compositionend  ──▶  compositionend handler (input.ts:502)
                                       composing=false
                                       compositionEndedAt=event.ts
                                       compositionPendingChanges = pendingRecords ? compID : 0
                                       compositionNode = null
                                       Promise.resolve().then(domObserver.flush)
                                       compositionID++
                                       scheduleComposeEnd(20)
                keydown Enter   ──▶  inOrNearComposition? Safari: yes if within 500ms,
                                       returns early (Enter swallowed)

                microtask:           domObserver.flush()
                                       readDOMChange picks up compositionPendingChanges
                                       tr.setMeta("composition", compID)
                                       view.dispatch(tr)  → updateState
                                                              composing=false now → no
                                                              CompositionViewDesc; full reconcile
                                                              CompositionViewDescs popped, DOM == state
```

### 12a. Worked trace — Japanese kanji conversion ("にほん" → "日本")

```
t=0ms  user presses 'n' on macOS Japanese IME
       ┌─ keydown(229)              [input.ts:114, IME passthrough]
       └─ compositionstart           [input.ts:457]
            view.input.composing = true
            view.input.compositionID++           // e.g. 7
            updateCursorWrapper()                // no-op (no markCursor)
       ┌─ compositionupdate "ん"     [input.ts:469]
       └─ MutationRecord (characterData "" → "ん") arrives
            domobserver.flushSoon(20ms)          // debounce
       ┌─ flush() at t=22ms                       [domobserver.ts:174]
       │   updateChildren() called from updateState
       │   localCompositionInfo() → {node: textNode, pos: 5, text: "ん"}
       │   protectLocalComposition(view, info)
       │     - hoist textNode to direct child of contentDOM
       │     - new CompositionViewDesc(parent, textNode, textNode, "ん")
       │     - children = [..., compDesc, ...]
       │   renderDescs() preserves textNode untouched
t=400ms user types 'i' → "にほ"; same cycle, compositionupdate
t=900ms user presses Space to convert → IME shows kanji candidates
t=1400ms user picks "日本"
       ┌─ compositionupdate "日本"   [input.ts:469]
       └─ MutationRecord characterData "にほん" → "日本"
            (CompositionViewDesc.text is stale "にほん"; ignoreMutation
             returns false because oldValue !== nodeValue;
             the mutation flows through; flushSoon scheduled)
       ┌─ flush() at t=1422ms
       │   the existing CompositionViewDesc still points to the same
       │   textNode but with new content; updateChildren is called,
       │   localCompositionInfo finds it and re-shields
t=1500ms user presses Enter to commit
       ┌─ compositionend             [input.ts:502]
       │   composing = false; compositionEndedAt = t
       │   view.input.compositionPendingChanges = 7   // the ID stamp
       │   Promise.resolve().then(() => domObserver.flush())
       │   scheduleComposeEnd(view, 20)
       └─ microtask: flush()
            readDOMChange detects characterData change
            tr = state.tr.replaceWith(5, 8, schema.text("日本"))
            tr.setMeta("composition", 7)         // domchange.ts:82-83
            view.dispatch(tr)
            clearComposition: markParentsDirty on every queued desc
```

The `compositionID` (7) on the dispatched tr lets plugins reasoning about
composition (e.g. collab, history-grouping) know the run of mutations
between `compositionstart` and now belongs to a single user gesture.

### 12b. Worked trace — Android Enter as DOM mutation (no compositionend)

Android Chrome with gboard often fires Enter *during* an active
composition by inserting a `<br>` or splitting the paragraph at the
DOM level rather than by firing a real `keydown(13)` event.

```
t=0   user composing "hello" in a paragraph; view.input.composing = true
t=200 user taps the Enter key on gboard
      keydown(13) fires but [input.ts:115] swallows it on Android+Chrome:
        if (browser.android && browser.chrome && event.keyCode == 13) return
      meanwhile the IME mutates the DOM:
        <p>hello|</p>  →  <p>hello</p><p>|</p>
      MutationRecords arrive: a removed-text + childList insertion
      domObserver flushSoon(20)
t=222 flush() → handleDOMChange → readDOMChange
      registerMutation reports a childList change with `added: <p>` desc
      domchange.ts:124-130:
        // looks like an Enter? synthesise the keystroke through handleKeyDown
        if (looksLikeEnter(...)) {
          let key = new KeyboardEvent("keydown", {keyCode: 13, key: "Enter"})
          if (view.someProp("handleKeyDown")?.(view, key)) {
            view.domObserver.suppressSelectionUpdates()
            return
          }
        }
      → keymap binding for Enter (e.g. splitBlock) runs
      → tr is dispatched as a real "Enter" rather than a raw childList op
```

Without the synthetic-keydown bridge, every Enter on Android would bypass
the user's Enter binding and just commit whatever mess gboard inserted
verbatim — losing list-splitting, code-block-newline, etc.

### 12c. Worked trace — stored marks restart (`endComposition(view, true)`)

```
state: cursor inside a paragraph, storedMarks = [bold]
       user starts typing on macOS Japanese IME
t=0   compositionstart                        [input.ts:457]
       composing = true
       in input.ts:466-468:
         if (state.storedMarks && !sameMarkSet(...)) {
           view.markCursor = state.storedMarks    // [bold]
           endComposition(view, true)             // ★ second arg
         }

      endComposition(view, restarting=true):
        forceFlush() → no pending records
        clearComposition(view)                    // pops compositionNodes
        view.docView.dirty is false, but restarting=true → take the
        "markCursor || restarting" branch:
          parent.inlineContent → view.dispatch(tr.deleteSelection())
          (else)                → view.updateState(view.state)
        either path triggers a redraw
      redraw runs updateCursorWrapper(view, [bold], null)  [index.ts:537]
        → inserts <img class="ProseMirror-separator" mark-placeholder>
          wrapped in <strong>…</strong>
      now the IME composition target is the <img> wrapper's nearby
      Text node, which lives inside <strong> — typed characters
      automatically inherit bold without PM having to mark them.
t+1ms compositionstart fires again (because endComposition called
      view.dispatch(...) which triggered selectionToDOM, which the
      browser interprets as a selection move that re-arms IME).
      This time storedMarks now match the cursor's actual mark
      context, so the if-branch is skipped, composition proceeds
      normally with the protected wrapper in place.
```

Without the `restarting=true` path, `view.markCursor = [bold]` would
be assigned but never rendered — the IME would type into a Text node
*outside* any `<strong>` wrapper, the resulting characterData mutation
would have no marks attached, and the eventual transaction would lose
the user's bold intent.

---

## 13. Reference index (file:line)

| concept | citation |
|---|---|
| `view.composing` getter | `index.ts:108-110` |
| `InputState` composition fields | `input.ts:32-40` |
| `compositionstart`/`update` handler | `input.ts:457-493` |
| `compositionend` handler | `input.ts:502-513` |
| `clearComposition` | `input.ts:520-526` |
| `findCompositionNode` | `input.ts:528-545` |
| `endComposition` | `input.ts:554-566` |
| `forceDOMFlush` | `input.ts:272-274` |
| `inOrNearComposition` | `input.ts:435-452` |
| Android Enter suppression | `input.ts:115` |
| 229 keydown skip flush | `input.ts:116` |
| iOS lastIOSEnter | `input.ts:122-130` |
| Safari ghost input listener | `input.ts:58` |
| `CompositionViewDesc` | `viewdesc.ts:586-605` |
| `localCompositionInfo` | `viewdesc.ts:815-833` |
| `protectLocalComposition` | `viewdesc.ts:835-852` |
| `updateChildren` composition fork | `viewdesc.ts:767-813` |
| `updateStateInner` storedMarks-during-compose | `index.ts:155-160` |
| `updateStateInner` snapshot compositionNode | `index.ts:199` |
| Bad Safari composition fix | `domobserver.ts:63-69, 241-244, 371-392` |
| `flushSoon`/`forceFlush` | `domobserver.ts:83-94` |
| Android composition timeout | `input.ts:455` |
| `tr.setMeta("composition", ...)` | `domchange.ts:96, 140, 239` |
