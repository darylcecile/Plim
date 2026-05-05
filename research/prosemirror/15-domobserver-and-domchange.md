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

Why those flags? — each one is load-bearing for a specific class of
real-world DOM mutation:

| Flag                          | Catches                                                                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `childList`                   | Element/text-node insertions and removals. Triggered by IME wrapper spans, autocorrect replacing one Text with another, drag-drop, browsers splitting paragraphs at Enter, etc.          |
| `characterData`               | Edits *inside* an existing Text node. Triggered by typing, autocorrect, IME composition that mutates the same Text node, browser spell-checker silently fixing a typo.                   |
| `characterDataOldValue`       | Required by Safari's composition signalling: Safari fires a `characterData` event with `oldValue === target.nodeValue` to mean "user typed over a selection without changing the literal value yet" → this becomes `typeOver: true` (`domobserver.ts:296-300`), used by `domchange.readDOMChange` to distinguish "Safari typeOver" from a no-op. |
| `attributes`                  | `class="ProseMirror-selectednode"` toggles, plus Firefox sometimes leaves `style="..."` residue from copy-paste that PM strips.                                                          |
| `attributeOldValue`           | Lets PM ignore attribute changes whose `oldValue === newValue` (some browsers fire spuriously).                                                                                          |
| `subtree`                     | Recurses through every descendant of `view.dom`, including those inside node views. Without this flag the observer would only see direct-child mutations; node-view internal edits (e.g. CodeMirror inside a code block) would be invisible — but `ignoreMutation` then needs to filter those out (see §8). |

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

#### Public escape hatch — `view.domObserver.stop() / .start()`

`view.domObserver` is exposed (`index.ts` defines it as a public field
on the EditorView) precisely so userland code that needs to make a
known-safe DOM mutation outside the standard `ignoreMutation` flow can
bracket it:

```ts
view.domObserver.stop()
try {
  // ...mutate the DOM directly, e.g. update a custom widget,
  // animate a node-view, sync external state into a controlled DOM region.
} finally {
  view.domObserver.start()
}
```

This is the official sanctioned way; `ignoreMutation` is the
finer-grained per-record alternative (see §8). Use the bracket when:

* You're touching DOM PM normally owns (rare — most node-view code
  should *not* do this).
* You're toggling decorations imperatively without going through
  `view.dispatch`.
* You're integrating with a framework that fights PM's reconciler
  (e.g. animating a node enter/exit) for a brief window.

**Detached-mid-flush behavior** is the subtle property that makes this
safe: as the snippet above shows, `stop()` *doesn't drop records*. If
the user typed a character a microtask before your `stop()` ran, that
mutation is in the observer's internal buffer; `stop()` pulls it via
`takeRecords()`, pushes it onto `this.queue`, and schedules a deferred
`flush()` (20 ms). So your DOM write doesn't pre-empt or lose the
user's keystroke; the keystroke flushes after your write completes,
sees a now-divergent docView, and reconciles correctly. Without this
property, every `stop()` would be a race condition.

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
   change still proceeds via `newSel`). Note: `pendingRecords()` is
   called *again* at the start of `flush` rather than relying on the
   queue from the timer-callback closure. Why? Because between the
   debounce timer firing and `flush` actually running, more mutations
   may have arrived (the observer is still live). Also, `handleDOMChange`
   itself dispatches transactions which can produce *more* mutations
   (e.g. `selectionToDOM` writes to the DOM); a re-entrant `flush` call
   is possible and `pendingRecords` lets it pick up those late records.
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

#### Worked example — adjacent text node split & merge

Suppose the DOM was `<p>hello world|</p>` (cursor after "world", inside
a single Text node `"hello world"`). The user pastes "x" via the
browser autocorrect popup, which the browser implements as
*"split-and-replace"*: it removes the trailing portion `" world"`,
inserts a new Text node `" x"`, and leaves the leading `"hello"` as
the first child. The MutationObserver emits **two** records:

```
record[0]: childList; target=<p>; removed=[Text " world"]; added=[]
record[1]: childList; target=<p>; removed=[];                added=[Text " x"]
```

`registerMutation` runs once per record, but each call's
`{from, to}` is computed via `localPosFromDOM(target, fromOffset, -1)`
and `localPosFromDOM(target, toOffset, 1)`. Both records share the
same target `<p>`; the offsets straddle the same boundary (the index
where `"hello"` ends). The accumulator in `flush` then takes
`Math.min(from)` and `Math.max(to)`:

```
record[0]: from=5,  to=11   (positions of " world")
record[1]: from=5,  to=7    (positions of " x")
                     ↓
combined:   from=5,  to=11
```

The single combined PM range `[5, 11]` is what `readDOMChange` then
hands to `parseBetween`, which re-parses `<p>` and produces a
`replaceWith(5, 11, "x")` step. Two adjacent DOM mutations have
collapsed into one PM range, one parse pass, and one transaction.
This min/max accumulation is why coalescence works correctly even
when records arrive out of order or with overlapping but distinct
ranges.

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

#### Semantics of the `(from, to, typeOver)` tuple

The triple is the universal "what did the user do?" handoff between the
DOM observer and the change reader. Each component has a precise role:

* **`from`** — the *PM-position lower bound* of the affected range,
  computed as the min over every mutation record's `from`. The `from`
  passed to `parseBetween` is then *widened* (§5b, L102-105) to the
  shared-depth boundary so a `<p>` mutation gets re-parsed as a whole
  paragraph, not just the inner Text. After widening it may be smaller
  than the originally-reported `from`.

* **`to`** — the upper bound, max over records, also widened. Together
  with `from` it forms the [parseFrom..parseTo] window for
  `parseBetween` and the `compare = doc.slice(parse.from, parse.to)`
  baseline against which `findDiff` runs.

* **`typeOver: boolean`** — set when *any* characterData record's
  `oldValue === target.nodeValue` (`registerMutation` L296-300). This
  is Safari's idiosyncratic way of signalling "the user typed a key
  that produced no net change to this Text node" — typically because
  the user *replaced* a selected range of text with a single character
  whose content the input pipeline has already absorbed before the
  observer fires. Without `typeOver`, `findDiff` would correctly
  return null (the parse and the doc match), and the typed character
  would be lost. The `typeOver`-triggered branch at L131-134
  synthesises a same-text overwrite that re-applies the selection
  collapse so the cursor lands in the right place.

* **`uniformParentList`** is *not* part of the tuple but appears later
  in `findDiff`'s heuristics: when both endpoints of the diff are in
  list items at the same depth, the diff is interpreted as a
  list-level operation rather than text editing — important for
  shift-Tab / outdent flows.

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

> **★ This `view.updateState(view.state)` line is the load-bearing
> "force redraw" mechanism of the entire DOM-observation pipeline.** It is
> the implicit safety net that catches every case `readDOMChange` can't
> reason about: malformed parses, structurally impossible mutations,
> bailed Enter/Backspace synthesis, parse rules that produced a doc the
> schema rejected, etc. Whenever those happen, the docView is left
> `dirty` and this line silently re-renders the affected subtree from
> the *current* (untouched) state, overwriting the browser's mutation.
> The browser sees its DOM revert; the user sees no change — which is
> exactly right, because no PM transaction was dispatched. This is why
> typing inside a `contenteditable=false` decoration "doesn't do
> anything" rather than crashing.

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

#### NodeViewDesc reuse during `parseBetween`

A subtle but important property: `parseBetween` (`domchange.ts:15-56`)
and its helper `ruleFromNode` (L58-77) **reuse existing NodeViewDescs
rather than re-creating them**. When `parseBetween` runs,
`DOMParser.parseSlice` walks the DOM; for each node it consults
`ruleFromNode`, which checks `pmViewDesc.parseRule` first. If the desc
exists, its `parseRule()` (defined on `NodeViewDesc` at `viewdesc.ts`)
is returned and tells the parser exactly which schema node this DOM
element corresponds to — *bypassing* the schema-wide parse-rule
registry. The reconciler then preserves the existing desc when applying
the resulting transaction, so the DOM identity (and any internal
state, like CodeMirror's editor-instance, scroll position, attached
event listeners) survives. This is critical for performance and
correctness: re-parsing the world after every keystroke would destroy
node-view internal state on every typo correction.

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

#### Worked example — CodeMirror inside a code-block NodeView

A common pattern is embedding a CodeMirror 6 instance inside a
PM `code_block` node view. CodeMirror manages its own DOM and fires its
own MutationRecords whenever the user types or moves the cursor inside
it. PM must not interpret those:

```ts
const codeBlockNodeView = (node, view, getPos) => {
  const cm = new EditorView({
    state: EditorState.create({ doc: node.textContent, extensions: […] }),
    dispatch: tr => {
      cm.update([tr])
      // sync changes back to PM:
      if (tr.docChanged) view.dispatch(view.state.tr.replaceWith(
        getPos() + 1, getPos() + 1 + node.content.size,
        view.state.schema.text(cm.state.doc.toString())))
    }
  })
  return {
    dom: cm.dom,
    contentDOM: null,           // PM should never reach into us
    ignoreMutation: () => true, // ★ all our internal mutations are ours
    update: (newNode) => {
      if (newNode.type !== node.type) return false
      // Re-sync if PM changed our content out-of-band:
      if (newNode.textContent !== cm.state.doc.toString()) {
        cm.dispatch({ changes: { from: 0, to: cm.state.doc.length,
                                  insert: newNode.textContent } })
      }
      return true
    },
    selectNode: () => cm.focus(),
    stopEvent: () => true,      // do not let PM see CM's keys/clicks
    destroy: () => cm.destroy(),
  }
}
```

`ignoreMutation: () => true` is the line that prevents PM from trying
to interpret CM's character-data and child-list mutations as PM doc
changes. Combined with `stopEvent: () => true` (so the input pipeline
doesn't see CM's keystrokes either) and `contentDOM: null` (so the
reconciler doesn't try to render PM children inside CM), the embed is
fully sealed. Sync between CM and PM happens entirely through the
`dispatch` and `update` callbacks above — *no* DOM-level coupling.

The same pattern applies to React/Vue node views, embedded video
players, drawing canvases, etc. **Whenever an embedded component owns
a DOM region inside the editor, it should set
`ignoreMutation: () => true`.**

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

## 11. Shadow DOM, iframes, and `<slot>` re-projection

The DOM observer is a `MutationObserver`, which has well-defined
behaviour across DOM "boundaries" — but those rules are subtle and PM
ships explicit code to handle each.

### 11a. Shadow DOM

A `MutationObserver` configured with `subtree: true` **does observe
mutations inside a closed or open shadow root** *if* the root host is a
descendant of the observed node and you observe the root directly — but
the spec is ambiguous about cross-root mutations and browsers vary. PM
sidesteps the ambiguity by mounting `view.dom` (which gets observed) at
whatever level the consumer chooses. If `view.dom` is *itself* inside a
shadow root, the observer attaches inside that shadow root and works
normally; selections inside the same shadow root are visible via the
standard `getSelection()` calls.

The hard case is **selection** inside Safari's shadow DOM, which has a
broken `Selection.getRangeAt`:

`safariShadowSelectionRange` (`domobserver.ts:332-357`) handles it:

```ts
function safariShadowSelectionRange(view, sel) {
  let found
  if ((sel as any).getComposedRanges) {
    // Safari ≥ 17 — the proposed standard API
    let range = (sel as any).getComposedRanges(view.root)[0] as StaticRange
    if (range) return safariShadowRangeToRange(range, view.dom)
  }
  // Fallback for older Safari: the execCommand("indent") trick.
  // Indent inserts a beforeinput event whose getTargetRanges() is the
  // *real* shadow-correct selection. We capture it, then preventDefault.
  function read(event: InputEvent) {
    event.preventDefault()
    event.stopImmediatePropagation()
    found = (event as any).getTargetRanges()[0]
  }
  view.dom.addEventListener("beforeinput", read, true)
  document.execCommand("indent")
  view.dom.removeEventListener("beforeinput", read, true)
  if (found) return safariShadowRangeToRange(found as StaticRange, view.dom)
  return null
}
```

Two strategies:
1. **Modern Safari** exposes `Selection.getComposedRanges(root)` which
   returns the selection in terms of light-DOM positions — directly
   usable.
2. **Older Safari** has neither `getComposedRanges` nor working
   `getRangeAt` inside shadow roots, but `execCommand("indent")`
   *reliably* fires a `beforeinput` event whose `getTargetRanges()`
   returns the real selection. PM intercepts the event with
   `preventDefault` (so the indent never actually happens), captures
   the range, and returns it. This is one of the most beautifully evil
   workarounds in the codebase.

### 11b. iframes

Each iframe has its *own* `document` and *own* `MutationObserver`.
`view.dom` lives in exactly one document — wherever the consumer
constructed the EditorView. Mutations in a parent document or a sibling
iframe are not seen. If you embed PM *inside* an iframe, the observer
runs inside that iframe's document; selection APIs use that iframe's
`document.getSelection()`. This is automatic; no special code needed.

What you *do* need to handle is `view.root`: PM uses `view.root` (set
to `document` or the shadow root containing `view.dom`) for any
`addEventListener` that needs to catch events bubbling all the way up.
For an in-iframe editor, `view.root` is the iframe's own document.

### 11c. `<slot>` re-projection

A `<slot>` inside a shadow root projects light-DOM children into the
shadow tree. Mutations to the *projected* light-DOM children fire
`MutationRecord`s on their *original* parent (in the light DOM) — not
on the slot. This is the spec-compliant behaviour and PM doesn't need
special code, but it's worth noting: if your custom node view uses
slots to project content, mutations inside that content are observed
on the light-DOM ancestor. Since `view.dom` is the light-DOM ancestor
in the typical case, the observer sees the mutation and translates it
correctly via the desc tree.

---

## 12. Reference index (file:line)

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
