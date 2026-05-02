# 15 — `DOMObserver` & `domchange`

> Source basis: `prosemirror-view/src/domobserver.ts`, `domchange.ts`,
> `viewdesc.ts` (parseRange, ignoreMutation), `selection.ts`,
> `browser.ts`, `index.ts`. Citations are `file:line` against
> `/tmp/prosemirror-research/prosemirror-view/src/`.

---

## 1. Why a MutationObserver at all

ProseMirror is built on `contenteditable`. That gives us free typing,
arrow-key navigation, IME, autocorrect, native drag-drop, and
spellcheck rewrites — **all of which mutate the DOM behind our backs**.
Some of those events we can intercept and `preventDefault` (keydown,
beforeinput, paste, drop), others we *cannot*:

| change | catchable? | how |
|---|---|---|
| Plain typed character (Latin) | yes via beforeinput, but PM still observes for safety | mutation |
| IME composition | NO — composition events lie | mutation |
| iOS / Android virtual keyboard suggestion swap | NO | mutation |
| Spellcheck / autocorrect rewrite | NO | mutation |
| Native drag-drop reorder | partly | mutation |
| Browser-inserted `<br>` after backspace | NO | mutation |
| `execCommand`-internal cleanup | NO | mutation |
| Paste of HTML | partly (paste handler) | mutation as fallback |
| User-toggled spellcheck underline DOM nodes | NO | filtered mutation |

The `MutationObserver` is therefore the **lower bound** on what PM has
to react to: regardless of how the DOM got changed, the observer fires,
PM diffs the affected range against state, and either:

* **forward**: translates the mutation into a `Transaction` via
  `domchange.ts:readDOMChange`, or
* **rollback**: detects the change is incompatible and re-renders the
  area from state, overwriting the browser's edit.

---

## 2. The `DOMObserver` class

`domobserver.ts:39-303`. Configuration and instance fields:

```ts
const observeOptions = {        // L7-14
  childList: true,
  characterData: true,
  characterDataOldValue: true,
  attributes: true,
  attributeOldValue: true,
  subtree: true
}
const useCharData = browser.ie && browser.ie_version <= 11   // L16
```

Why those flags?

* `childList + subtree` — inserts/removes anywhere under `view.dom`.
* `characterData + characterDataOldValue` — typed text. We need
  `oldValue` to detect "characterData event with same value", which
  Safari fires during composition (`registerMutation` returns
  `typeOver: true` in that case, see `domobserver.ts:296-300`).
* `attributes + attributeOldValue` — for things like
  `class="ProseMirror-selectednode"` and Firefox style cleanups.

Instance fields (L40-46):

| field | purpose |
|---|---|
| `queue: MutationRecord[]` | Buffer of records to process on next flush. |
| `flushingSoon: number` | Timer handle for the 20 ms debounced flush; -1 when idle. |
| `observer: MutationObserver \| null` | Underlying browser observer, may be null in legacy/test envs. |
| `currentSelection: SelectionState` | Last-seen DOM selection (anchor/focus node + offset, L18-37). Used to detect selection drift. |
| `onCharData: (e) => void \| null` | IE11 fallback handler for `DOMCharacterDataModified`. |
| `suppressingSelectionUpdates: boolean` | When true (50 ms window), `onSelectionChange` writes the state-derived selection back to DOM instead of treating it as user intent. |
| `lastChangedTextNode: Text \| null` | The most recently mutated text node — used by `findCompositionNode` (`input.ts:534`) to anchor the composition. |

### `start()` / `stop()` (L96-117)

```ts
start() {
  if (this.observer) {
    this.observer.takeRecords()           // discard pending
    this.observer.observe(this.view.dom, observeOptions)
  }
  if (this.onCharData)
    this.view.dom.addEventListener("DOMCharacterDataModified", this.onCharData)
  this.connectSelection()
}

stop() {
  if (this.observer) {
    let take = this.observer.takeRecords()
    if (take.length) {
      for (let i = 0; i < take.length; i++) this.queue.push(take[i])
      window.setTimeout(() => this.flush(), 20)
    }
    this.observer.disconnect()
  }
  if (this.onCharData) this.view.dom.removeEventListener("DOMCharacterDataModified", this.onCharData)
  this.disconnectSelection()
}
```

Important detail: `stop()` **doesn't drop records**. It pulls anything
the observer queued and schedules a deferred `flush()`. This makes
`stop()` safe to wrap around any DOM write — pending mutations from
*before* the stop will still be processed. `start()` does the opposite
(discards records via `takeRecords()`), so anything we wrote between
`stop()` and `start()` is *not* observed.

This bracket is used everywhere PM writes to the DOM:

* `index.ts:185, 219` around `selectionToDOM` and docView updates.
* `index.ts:338-341` around an explicit re-render API.
* `input.ts:347-353, 365-368` around the mightDrag attribute toggles.
* `selection.ts:75, 100-101` for selection writes (uses
  `disconnectSelection`/`connectSelection`, not full stop).

### `flushSoon` / `forceFlush` (L83-94)

```ts
flushSoon() {
  if (this.flushingSoon < 0)
    this.flushingSoon = window.setTimeout(() => { this.flushingSoon = -1; this.flush() }, 20)
}
forceFlush() {
  if (this.flushingSoon > -1) {
    window.clearTimeout(this.flushingSoon)
    this.flushingSoon = -1
    this.flush()
  }
}
```

* `flushSoon` debounces: lets multi-record bursts (single typed
  character often produces 2-3 records) coalesce.
* `forceFlush` is called from non-229 `keydown` (`input.ts:116`),
  from `endComposition` (`input.ts:556`), and from `compositionend`
  on bad Safari (`input.ts:508`).

### `pendingRecords()` (L169-172)

```ts
pendingRecords() {
  if (this.observer) for (let mut of this.observer.takeRecords()) this.queue.push(mut)
  return this.queue
}
```

Drains the *browser-level* buffer into our queue and returns the
union. Used by `flush` and by `compositionend` to detect "yes, there
are pending changes".

### Selection tracking (L119-145)

```ts
connectSelection() {
  this.view.dom.ownerDocument.addEventListener("selectionchange", this.onSelectionChange)
}
disconnectSelection() { ... }

onSelectionChange() {
  if (!hasFocusAndSelection(this.view)) return
  if (this.suppressingSelectionUpdates) return selectionToDOM(this.view)
  if (browser.ie && browser.ie_version <= 11 && !this.view.state.selection.empty) {
    let sel = this.view.domSelectionRange()
    if (sel.focusNode && isEquivalentPosition(sel.focusNode, sel.focusOffset, sel.anchorNode!, sel.anchorOffset))
      return this.flushSoon()
  }
  this.flush()
}
```

Note: `selectionchange` is *also* what triggers a flush. Selection
changes alone (no DOM mutations) hit the `from < 0` early-out branch
in `readDOMChange` (`domchange.ts:85-100`), which dispatches a pure
`tr.setSelection`.

`suppressingSelectionUpdates` guard: when PM has just emitted a
selection that the browser is about to fire selectionchange for, we
avoid treating it as user intent (and instead re-assert
`selectionToDOM`).

### `withFlushedSelection` (informal API)

There isn't a method literally named `withFlushedSelection` in the
current source, but the equivalent pattern is the
`forceFlush()` + `setCurSelection()` sequence. Callers that need to
guarantee they're operating on the *current* DOM selection do:

1. `view.domObserver.forceFlush()` — drain pending mutations.
2. Read `view.domSelectionRange()` directly.
3. `view.domObserver.setCurSelection()` (L147-149) — store as the new
   baseline so the next selectionchange that just reflects this read
   doesn't re-fire.

---

## 3. The `flush()` algorithm

`domobserver.ts:174-250`. Annotated:

```ts
flush() {
  let {view} = this
  if (!view.docView || this.flushingSoon > -1) return        // L176

  let mutations = this.pendingRecords()                       // L177
  if (mutations.length) this.queue = []

  let sel = view.domSelectionRange()                          // L180
  let newSel = !this.suppressingSelectionUpdates &&
               !this.currentSelection.eq(sel) &&
               hasFocusAndSelection(view) &&
               !this.ignoreSelectionChange(sel)               // L181

  let from = -1, to = -1, typeOver = false, added: Node[] = []
  if (view.editable) {
    for (let i = 0; i < mutations.length; i++) {
      let result = this.registerMutation(mutations[i], added)
      if (result) {
        from = from < 0 ? result.from : Math.min(result.from, from)
        to   = to   < 0 ? result.to   : Math.max(result.to,   to)
        if (result.typeOver) typeOver = true
      }
    }
  }
  // [BR cleanup blocks: L195-222]
  // [Focus-reset workaround: L228-235]

  if (from > -1 || newSel) {
    if (from > -1) {
      view.docView.markDirty(from, to)                        // L238
      checkCSS(view)                                          // L239
    }
    if (view.input.badSafariComposition) {                    // L241
      view.input.badSafariComposition = false
      fixUpBadSafariComposition(view, added)
    }
    this.handleDOMChange(from, to, typeOver, added)           // L245 → readDOMChange
    if (view.docView && view.docView.dirty) view.updateState(view.state)  // L246
    else if (!this.currentSelection.eq(sel)) selectionToDOM(view)        // L247
    this.currentSelection.set(sel)                            // L248
  }
}
```

Steps:

1. **Reentrancy guards** (L176): no docView → editor destroyed; pending
   debounced flush → bail (the timer will run).
2. **Drain queue** (L177-178). Empty queue is fine (selection-only
   change still proceeds via `newSel`).
3. **Compute selection delta** (L180-181). `ignoreSelectionChange`
   (L151-167) checks if the focus node is inside a custom NodeView whose
   `ignoreMutation({type: "selection", ...})` returns true; if so,
   update `currentSelection` and return `true` (= ignore).
4. **Per-mutation `from..to` accumulation** (L184-193) via
   `registerMutation` (see §4).
5. **Browser-quirk DOM cleanup** (L195-222):
   - L195-207: if a `<br>` was added during a Backspace/Delete, *and*
     it's followed by a `contenteditable=false` element, remove it (PM
     issue #1552).
   - L208-222: Gecko frequently inserts duplicate `<br>` nodes; we
     remove the duplicates, with a special case for `<li>` parents.
6. **Browser focus-reset rescue** (L228-235): some browsers reset the
   selection to the very start of the document right after focus
   without any DOM changes. If `from < 0 && newSel && lastFocus` is
   recent and the new selection is exactly the start-of-doc, *ignore
   the selection event* and force ours back via `selectionToDOM`.
7. **Apply** (L236-249): if there was a real DOM change *or* a real
   selection delta, mark the affected range dirty, run optional Safari
   table fixup, and call `handleDOMChange` (which is wired to
   `readDOMChange` at `index.ts:89`).
8. **Reconcile**: if reading the DOM change marked the docView dirty
   (e.g. we bailed on the change and want to redraw), call
   `updateState`. Otherwise, if our internal selection record is stale,
   write the state's selection back via `selectionToDOM`.

`checkCSS(view)` at L239 is a one-shot warning if the user forgot to
load `prosemirror.css` (white-space must be set, ideally to
`pre-wrap`).

---

## 4. `registerMutation` — translating a record to a PM range

`domobserver.ts:252-302`. Filters and converters:

```ts
registerMutation(mut, added) {
  if (added.indexOf(mut.target) > -1) return null              // L254
  let desc = this.view.docView.nearestDesc(mut.target)
  if (mut.type == "attributes" &&                              // L256-260
      (desc == this.view.docView ||
       mut.attributeName == "contenteditable" ||
       (mut.attributeName == "style" && !mut.oldValue && !target.getAttribute("style"))))
    return null
  if (!desc || desc.ignoreMutation(mut)) return null            // L261
  ...
}
```

Filter cases:
* Mutations on already-noted added nodes are noise (they're inside
  inserts we already track).
* Attribute mutations on the editor root (e.g. `class` toggles by PM
  itself), `contenteditable` toggles, and Firefox empty-style clears
  are ignored.
* Per-NodeView `ignoreMutation` callback decides for custom views (§7).

### childList branch (L263-287)

* Pushes added nodes onto `added[]`; remembers any added text node as
  `lastChangedTextNode`.
* If the mutation target's descriptor has a contentDOM that doesn't
  contain the target, the mutation hit the *outer* DOM of a node view
  — return the whole node's range.
* Otherwise compute `[from, to]` from `previousSibling` / `nextSibling`
  positions (with IE11 sibling fix-up at L272-280), translating DOM
  offsets via `desc.localPosFromDOM`.

### attributes branch (L288-289)

Returns the entire node's range including borders.

### characterData branch (L290-301)

```ts
this.lastChangedTextNode = mut.target as Text
return {
  from: desc.posAtStart,
  to:   desc.posAtEnd,
  typeOver: mut.target.nodeValue == mut.oldValue
}
```

`typeOver: true` = "characterData event with no actual change". Some
IMEs emit this when the user types a key that gets discarded; we
forward it to `readDOMChange` so it can decide if a same-content
selection-overwrite should be treated as an overwrite-replace
(`domchange.ts:131-145`).

`lastChangedTextNode` is the bridge to composition: when
`updateStateInner` runs `findCompositionNode`, it picks this node.

---

## 5. `readDOMChange` — algorithm

`domchange.ts:81-277`. The full pipeline:

### 5a. Selection-only path (L85-100)

If `from < 0` (no content mutations, only `newSel`), build a Selection
from the DOM and dispatch:

```ts
let origin = view.input.lastSelectionTime > Date.now() - 50 ? view.input.lastSelectionOrigin : null
let newSel = selectionFromDOM(view, origin)
if (newSel && !view.state.selection.eq(newSel)) {
  ...
  let tr = view.state.tr.setSelection(newSel)
  if (origin == "pointer") tr.setMeta("pointer", true)
  else if (origin == "key") tr.scrollIntoView()
  if (compositionID) tr.setMeta("composition", compositionID)
  view.dispatch(tr)
}
```

Special case at L89-92: on Chrome Android right after `Enter` (we
suppressed the keydown — see file 14 §7a), if the selection move comes
back as a synthetic move, fire the synthetic Enter handler instead.

### 5b. Widen the range to a sharedDepth boundary (L102-105)

```ts
let $before = view.state.doc.resolve(from)
let shared = $before.sharedDepth(to)
from = $before.before(shared + 1)
to   = view.state.doc.resolve(to).after(shared + 1)
```

We always re-parse a complete textblock (or block group) range, not the
narrow mutation range. This makes the parser's job tractable — it gets
a coherent context node to parse into.

### 5c. `parseBetween` (`domchange.ts:15-56`)

```ts
let {node: parent, fromOffset, toOffset, from, to} = view.docView.parseRange(from_, to_)
```

`parseRange` (`viewdesc.ts:343-381`) walks down the docView until it
finds the *single DOM parent* that covers `[from, to]`, returning the
DOM offsets to feed into the parser.

Then it gathers `find` positions from the current DOM selection so the
parser can map anchor/head into PM positions:

```ts
find = [{node: anchor, offset: domSel.anchorOffset}]
if (!selectionCollapsed(domSel))
  find.push({node: domSel.focusNode!, offset: domSel.focusOffset})
```

A Chrome backspace-with-bogus-BR workaround at L28-34 trims trailing
empty/BR offspring from the parse range so the parser doesn't see the
spurious node.

The actual parse (L36-49) uses `view.someProp("domParser")` (or
`DOMParser.fromSchema`) with:

* `topNode: $from.parent` and `topMatch: contentMatchAt($from.index())`
  so the parser knows the schema constraints.
* `topOpen: true` — emit a slice rather than a closed node.
* `from, to` — the precise DOM offset range.
* `preserveWhitespace: $from.parent.type.whitespace == "pre" ? "full" : true`.
* `findPositions: find` — lets us recover selection positions in the
  output.
* `ruleFromNode` — custom per-DOM-node hook (see L58-77) which delegates
  to `pmViewDesc.parseRule()` for custom node views and special-cases
  Safari's `<br>`-replacing-LI bug.

Returns `{doc: parsedSlice, sel: {anchor, head} | null, from, to}`.

### 5d. Diff & decide (L107-146)

```ts
let doc = view.state.doc, compare = doc.slice(parse.from, parse.to)
let preferredPos, preferredSide
if (view.input.lastKeyCode === 8 && Date.now() - 100 < view.input.lastKeyCodeTime) {
  preferredPos = view.state.selection.to;   preferredSide = "end"
} else {
  preferredPos = view.state.selection.from; preferredSide = "start"
}
let change = findDiff(compare.content, parse.doc.content, parse.from, preferredPos, preferredSide)
```

`findDiff` (`domchange.ts:353-377`) calls `Fragment.findDiffStart`
+ `findDiffEnd` (model package) and adjusts the result so the diff
*overlaps the cursor* if possible — this avoids attributing typed text
to the wrong side of an unchanged duplicate. Surrogate-pair guard at
L364-365 / L371-372 prevents splitting an emoji.

If no diff is found *and* the selection collapsed onto its `to` while
`typeOver` is set, synthesise a same-text overwrite (L131-134); else
just dispatch the parsed selection if it differs (L135-145).

### 5e. iOS / Android Enter detection (L124-130)

```ts
if ((browser.ios && lastIOSEnter > Date.now() - 225 || browser.android) &&
    addedNodes.some(n => n.nodeType == 1 && !isInline.test(n.nodeName)) &&
    (!change || change.endA >= change.endB) &&
    view.someProp("handleKeyDown", f => f(view, keyEvent(13, "Enter")))) {
  view.input.lastIOSEnter = 0
  return
}
```

If we suspect an Enter (a block-level node was inserted and we're on
mobile), fire the user's `handleKeyDown` with a synthetic `keyEvent(13,
"Enter")`. If the handler returns true (consumed), we abandon the
mutation-derived change — the handler will produce its own transaction.

Mirror block at L181-189 for the structural variant ("non-inline change
that creates an empty wrapper").

### 5f. Backspace detection (L191-196)

```ts
if (view.state.selection.anchor > change.start &&
    looksLikeBackspace(doc, change.start, change.endA, $from, $to) &&
    view.someProp("handleKeyDown", f => f(view, keyEvent(8, "Backspace")))) {
  if (browser.android && browser.chrome) view.domObserver.suppressSelectionUpdates()
  return
}
```

`looksLikeBackspace` (L308-334) checks the diff matches the shape of
"join the next textblock to this one". On Android we suppress
selectionchange for 50 ms because the OS will move the cursor in a way
that fights our dispatched transaction.

### 5g. Build & dispatch the transaction (L221-276)

```ts
let chFrom = change.start, chTo = change.endA
let mkTr = (base) => {
  let tr = base || view.state.tr.replace(chFrom, chTo, parse.doc.slice(...))
  if (parse.sel) {
    let sel = resolveSelection(view, tr.doc, parse.sel)
    if (sel && !(/* Chrome misreport guard */)) tr.setSelection(sel)
  }
  if (compositionID) tr.setMeta("composition", compositionID)
  return tr.scrollIntoView()
}
```

Then dispatch one of three shapes:
1. **Pure deletion** (L245-255): inline change with empty result →
   `tr.delete(chFrom, chTo)` plus `marksAcross` to preserve cursor
   marks.
2. **Mark add/remove** (L256-264): inline change of equal content but
   different marks → `isMarkChange` (L287-306) detects which mark, and
   we `tr.addMark` / `tr.removeMark` instead of replacing content. This
   is what catches autocorrect bold rewrites.
3. **Text insert** (L265-270): both endpoints in the same text node →
   `tr.insertText(text, chFrom, chTo)` so step merging works (multiple
   keystrokes coalesce in history).
4. **Generic replace** (L271-276): the slice-based fallback.

The text-insert path also runs through `view.someProp("handleTextInput", ...)`
giving plugins a chance to substitute the change.

---

## 6. Structural mutations vs simple text edits

The decision tree in §5g is the formal answer, but informally:

* `inlineChange = $from.sameParent($to) && $from.parent.inlineContent && $fromA.end() >= change.endA`
  (`domchange.ts:178`) — the change stays inside one textblock.
* If `inlineChange`:
  * Pure delete (same `$from.pos == $to.pos`).
  * Same content, different marks → mark-change.
  * Same single text node → `insertText`.
  * Otherwise generic replace.
* If **not** `inlineChange`:
  * Possible synthesised Enter (L181-189).
  * Otherwise generic replace, which is risky — multi-block diffs are
    where heuristics most often go wrong, and where the
    "bail and redraw" path is most likely to fire.

---

## 7. When to bail and force redraw

There's no explicit "bail" return in `readDOMChange`; instead, the
recovery happens in `flush()` itself (`domobserver.ts:246`):

```ts
this.handleDOMChange(from, to, typeOver, added)
if (view.docView && view.docView.dirty) view.updateState(view.state)
else if (!this.currentSelection.eq(sel)) selectionToDOM(view)
```

After `markDirty(from, to)` (L238) marks the affected subtree, the
docView is dirty. `readDOMChange` may either:
* dispatch a transaction that triggers `updateState`, which re-renders
  and clears the dirty flag *or*
* **return without dispatching** (e.g. when nothing parsed cleanly, or
  when a synthesised Enter consumed the change).

If after `readDOMChange` returns the docView is still dirty, the
trailing `view.updateState(view.state)` re-renders the dirty range
**from current state**, *overwriting whatever the browser did*. This is
the implicit "bail" path — silently corrects the DOM.

Other forced redraws:
* `endComposition`'s post-flush `view.updateState(view.state)`
  (`input.ts:562`).
* `selection.ts:55-101` when selection moves into an invalid place.
* `index.ts:200-205` Chrome focus-node-rewrite kludge: if our update
  blew away the selection's focus node, we set `forceSelUpdate` so the
  selection is re-asserted from state.

---

## 8. `ignoreMutation` from custom NodeView

`viewdesc.ts:86, 111` declare the optional spec; defaults at:

* `ViewDesc` (L488-490): `return !this.contentDOM && mutation.type != "selection"`
  — leaf views that have no content ignore everything except
  selection-into-them.
* `MarkViewDesc` (L653-655): delegates to spec or super.
* `CompositionViewDesc` (L602-604): ignores no-op characterData.
* `TextViewDesc` (L954-956): only allow characterData and selection
  through.
* `NodeViewDesc` custom (L1031-1032): delegates to `spec.ignoreMutation`.

The plugin/customer-defined `ignoreMutation(mutation)` returning `true`
makes `registerMutation` (`domobserver.ts:261`) skip the record
entirely. This is how widgets implement "I render dynamic decorations
inside myself; PM, please don't touch". The selection variant
(`type: "selection"`) is queried from `ignoreSelectionChange`
(L159-166) when the user clicks/cursors into the widget — returning
true keeps PM from trying to translate the DOM selection into a PM
position (which would land somewhere weird inside an opaque node).

---

## 9. Edge case — selection moved into a widget

`ignoreSelectionChange` (`domobserver.ts:151-167`):

```ts
ignoreSelectionChange(sel) {
  if (!sel.focusNode) return true
  // find common ancestor of anchor and focus
  let ancestors = new Set, container
  for (let scan = sel.focusNode; scan; scan = parentNode(scan)) ancestors.add(scan)
  for (let scan = sel.anchorNode; scan; scan = parentNode(scan)) if (ancestors.has(scan)) {
    container = scan; break
  }
  let desc = container && this.view.docView.nearestDesc(container)
  if (desc && desc.ignoreMutation({type: "selection", target: ...})) {
    this.setCurSelection()                  // accept as new baseline, but...
    return true                             // ...don't translate to PM selection
  }
}
```

If the user drags the cursor into a widget (e.g. a code editor mounted
inside a NodeView), the widget's `ignoreMutation` says "selection here
is mine". PM:

1. Stops trying to derive a PM Selection from this DOM selection.
2. Doesn't dispatch a selection transaction.
3. Stores the DOM selection as the new baseline so the *next* change is
   measured against here, not the previously-translated PM position.

The PM state's selection therefore stays where it was; the DOM is
allowed to drift. When the user clicks back into editable PM content,
that selectionchange is no longer ignored, and we translate normally.
PM doesn't *correct* the selection back into editable content — the
widget owns that DOM region.

For the *opposite* case (selection moved by browser into a place PM
considers invalid, e.g. between two atom nodes), `selectionFromDOM`
(`selection.ts:9-48`) returns `null`, `readDOMChange` skips the
selection update (L96-98), and the trailing `selectionToDOM` in `flush`
re-asserts state's selection.

---

## 10. Sequence diagram — autocorrect mutation read

iOS Safari rewriting `teh` → `the` while the cursor sits after the
word:

```
TIME    BROWSER                       PM domObserver               PM domchange.readDOMChange     state
─────   ───────                       ──────────────               ──────────────────────────     ─────
t0      User types "h" after "te "
        characterData mutation:
          oldValue="te ", newValue="teh "
                                  ─▶  queue.push(record)
                                       flush()
                                         registerMutation:
                                           lastChangedTextNode=text
                                           {from=p0, to=pN, typeOver=false}
                                         markDirty(p0,pN)
                                         handleDOMChange(p0,pN,...)
                                                                 ─▶ parseBetween → parsed slice "teh "
                                                                    findDiff vs state slice "te "
                                                                    change={start: pN-1, endA: pN-1, endB: pN}
                                                                    inlineChange=true
                                                                    sameTextNode → tr.insertText("h", pN-1, pN-1)
                                                                    dispatch                                     ──▶ state has "teh "

t1     [autocorrect kicks in,
        500ms later]
        characterData mutation:
          oldValue="teh ", newValue="the "
                                  ─▶  queue.push
                                       flushSoon(20ms)                    
                                       flush()
                                         registerMutation:
                                           {from=p0, to=pN+1, typeOver=false}
                                         handleDOMChange
                                                                 ─▶ parseBetween → "the "
                                                                    findDiff: change covers "eh"→"he"
                                                                    inlineChange=true
                                                                    same text node → tr.insertText("he", pStart, pStart+2)
                                                                    setMeta("composition", 0)
                                                                    dispatch                                     ──▶ state "the "
                                                                    NO synthetic Enter (no block added)
                                                                    NO backspace (looksLikeBackspace false)
                                       updateState picks up tr.doc
                                       docView.update reconciles
                                         (composing=false, no
                                          CompositionViewDesc)
                                       DOM matches state                                          ✓ in sync

t2      BROWSER may also fire an
        attribute change adding
        spellcheck underline span
        ──► registerMutation:
            mark-change-shaped diff
            isMarkChange detects "underline added"
            tr.addMark(...) dispatched

[If the parse had returned an incompatible slice — say a malformed     │
 block boundary — readDOMChange returns without dispatching, docView   │
 stays dirty from markDirty, and flush()'s trailing                    │
 view.updateState(view.state) RE-RENDERS the range, overwriting the    │
 browser's autocorrect.]                                               │
```

The full *autocorrect-rewrite-with-mark* case (e.g. Safari turning
`url` into a hyperlink):

* Diff covers same text content but different marks.
* `isMarkChange` (`domchange.ts:287-306`) builds the
  cur/prev mark sets, computes their symmetric difference, demands
  exactly *one* mark added or *one* mark removed.
* Falls through to the `markChange.type == "add"` branch
  (L262-263): `tr.addMark(chFrom, chTo, markChange.mark)`.
* Dispatched with composition meta intact if we were composing.

---

## 11. Reference index (file:line)

| concept | citation |
|---|---|
| `observeOptions` | `domobserver.ts:7-14` |
| `useCharData` (IE11) | `domobserver.ts:16` |
| `SelectionState` | `domobserver.ts:18-37` |
| `DOMObserver` constructor & quirks | `domobserver.ts:48-81` |
| `flushSoon`, `forceFlush` | `domobserver.ts:83-94` |
| `start`, `stop` | `domobserver.ts:96-117` |
| `connectSelection`, `disconnectSelection` | `domobserver.ts:119-125` |
| `suppressSelectionUpdates` | `domobserver.ts:127-130` |
| `onSelectionChange` | `domobserver.ts:132-145` |
| `setCurSelection` | `domobserver.ts:147-149` |
| `ignoreSelectionChange` | `domobserver.ts:151-167` |
| `pendingRecords` | `domobserver.ts:169-172` |
| `flush` | `domobserver.ts:174-250` |
| `registerMutation` | `domobserver.ts:252-302` |
| `checkCSS` | `domobserver.ts:308-317` |
| `safariShadowSelectionRange` | `domobserver.ts:332-357` |
| `fixUpBadSafariComposition` | `domobserver.ts:371-392` |
| `parseBetween` | `domchange.ts:15-56` |
| `ruleFromNode` | `domchange.ts:58-77` |
| `readDOMChange` | `domchange.ts:81-277` |
| selection-only branch | `domchange.ts:85-100` |
| widen to sharedDepth | `domchange.ts:102-105` |
| iOS/Android Enter heuristic | `domchange.ts:124-130, 181-189` |
| backspace heuristic + suppress | `domchange.ts:191-196` |
| Chrome composition selection misreport | `domchange.ts:198-202, 233-237` |
| Android virtual-keyboard pick-suggestion | `domchange.ts:212-219` |
| `mkTr`, dispatch shapes | `domchange.ts:223-276` |
| `isMarkChange` | `domchange.ts:287-306` |
| `looksLikeBackspace` | `domchange.ts:308-334` |
| `findDiff` | `domchange.ts:353-377` |
| `parseRange` (DOM offset compute) | `viewdesc.ts:343-381` |
| `ignoreMutation` defaults | `viewdesc.ts:488-490, 570, 602-604, 653-655, 954-956, 1031-1032` |
| `handleDOMChange` wiring | `index.ts:89` |
| Stop/start around state writes | `index.ts:185, 219` |
| Chrome focus-node-rewrite kludge | `index.ts:198, 205` |
