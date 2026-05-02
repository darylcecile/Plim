# 21 — The Rendering Pipeline, End-to-End

This file is the executive synthesis. Every claim is cross-linked to the deep-dive
files (01-20) where the file:line citations live. Read in order; each section
is a complete round-trip through the system viewed from a different starting
point.

> **Mental model going in.** ProseMirror is *not* a controlled DOM. It is two
> concurrent state machines (the immutable `EditorState` and the mutable DOM)
> linked by a *reconciler* (`docView`) and a *change reader* (`DOMObserver` →
> `readDOMChange`). The reconciler is push (state → DOM). The change reader is
> pull (DOM → state). Everything else is plumbing around making sure those two
> halves never deadlock or race.
> See [01-architecture-overview.md §2](./01-architecture-overview.md),
> [§3 Unidirectional flow](./01-architecture-overview.md), and
> [§4 DOM is not the source of truth](./01-architecture-overview.md).

---

## A. "User types a single character `a`"

A pristine path — no IME, no plugin handling, no decoration. We trace every
function call so you can see when each layer takes ownership.

### A.1 Timeline (microsecond resolution, conceptual)

```
t0  Hardware/OS keypress → browser keyboard event queue
                           |
t1  ┌─[ contenteditable focused ]──────────────────────────────────┐
    │  EVENT: keydown { key:"a", code:"KeyA" }                     │
    │  PM listener registered in initInput()                       │
    │      → input.ts:46-61   (see 13-input-pipeline.md §1.2)      │
    │  dispatch wrapper runs three gates:                          │
    │     (1) eventBelongsToView                                   │
    │     (2) skipAttrs (own contenteditable=false guards)         │
    │     (3) editable check                                       │
    │      → input.ts:63-75   (see 13 §1.3)                        │
t2  │  handlers.keydown (input.ts:106-136, see 13 §3.1):           │
    │     - InputState.shiftKey/lastKeyCode update                 │
    │     - call props.handleKeyDown via runCustomHandler          │
    │       → returns false (no plugin claimed it)                 │
    │     - call captureKeyDown (capturekeys.ts) — handles arrows, │
    │       backspace, enter, etc. Plain letters fall through.     │
    │       (see 13 §3.3)                                          │
t3  │  PM does NOT preventDefault. Browser proceeds with native    │
    │  text insertion. (See 13 §3.5 keypress + §3.6 beforeinput.)  │
    └──────────────────────────────────────────────────────────────┘
t4  EVENT: beforeinput { inputType:"insertText", data:"a" }
       PM ignores on most browsers (single-purpose Android Backspace
       fallback only). (See 13 §3.6, 18 §2.1.)
t5  Browser mutates the DOM:
       <p>foo|</p>  →  <p>foo[a]|</p>
       — a `characterData` mutation on the existing text node.
t6  ┌─[ MutationObserver fires synchronously after the microtask ]─┐
    │  DOMObserver.observer callback → flushSoon (debounced)        │
    │      → domobserver.ts (see 15 §2 flushSoon)                  │
    │  flush() runs (15 §3):                                       │
    │     1. takeRecords()                                         │
    │     2. registerMutation per record (15 §4)                   │
    │        → range = (textNodeStart, textNodeStart+oldLen+1)     │
    │     3. selection sample                                      │
t7  │  readDOMChange(view, from, to, typeOver, addedNodes)         │
    │      → domchange.ts (see 15 §5)                              │
    │     a. widen range to sharedDepth boundary (15 §5b)          │
    │     b. parseBetween() — local DOM parse using DOMParser      │
    │        with edit-time options                                │
    │        → see 11-dom-parser.md §6.2 parseSlice                │
    │     c. diff old vs new fragment → {start, endA, endB}        │
    │        (15 §5d)                                              │
    │     d. it's pure text insert → tr.insertText("a", from)      │
    │        (15 §5g)                                              │
    └──────────────────────────────────────────────────────────────┘
t8  view.dispatch(tr)  →  dispatchTransaction (default)
       → state.apply(tr)
        ┌──────────────────────────────────────────────────────────┐
        │ 1. filterTransaction (each plugin can VETO)             │
        │ 2. applyTransaction:                                    │
        │    a. apply each StateField.apply(tr, value, old, new)  │
        │    b. loop appendTransaction until fixed-point or limit │
        │    See 07-state-and-plugins.md §5.                      │
        └──────────────────────────────────────────────────────────┘
t9  view.updateState(newState)
       → updateStateInner (see 09-view-and-viewdesc.md §1.5):
       a. compare prev/next state
       b. compute decoration deltas (10 §5)
       c. docView.update(...) reconciles ViewDesc tree (09 §3)
          - syncToMarks (09 §3.5)
          - matchChildren by reuse keys (09 §3.2)
          - patch text nodes in place; recreate nodes only on real change
       d. selectionToDOM → set DOM Selection (08 §11, 09 §5)
       e. scrollToSelection if tr.scrolledIntoView
t10 Browser repaints. Composition idle. Editor ready for next event.
```

Total wall-clock for a steady-state keystroke on a modern machine: < 1 ms in
practice. The expensive paths (`parseBetween`, full reconciliation) are O(local
range), not O(doc).

### A.2 Why this path goes "DOM first, state second" for plain typing

Three reasons (all in [13 §3.1](./13-input-pipeline.md), [15 §1](./15-domobserver-and-domchange.md)):

1. **IME compatibility.** Hooking `keydown.preventDefault()` would break
   composition entirely, since IME composition goes through `input` /
   `compositionupdate`, not `keydown`.
2. **Cross-browser fidelity.** Native text insertion correctly handles
   bidi, normalization, dead keys, Unicode that PM would have to re-implement.
3. **Accessibility.** Letting the browser do its own thing means assistive
   tech sees a normal contenteditable.

The trade-off is the post-hoc diff in `readDOMChange`, which is the most
intricate piece of the entire codebase.

### A.3 What `appendTransaction` does to the typing path

Plugins like inputrules ([19 §4](./19-commands-keymap-inputrules.md)),
typing-time mark inheritance ([08 §10 storedMarks](./08-selection.md)), and
collab ([20 §2.2](./20-history-and-collab.md)) all use `appendTransaction`
hooks to *react* to a typing transaction synchronously inside `state.apply`.

Crucially, the loop is bounded but **not** by a hard counter — it terminates
when `appendTransaction` returns `null` for every plugin. See
[07 §5 subtleties](./07-state-and-plugins.md) for why this is dangerous (an
ill-behaved plugin can produce an infinite loop or amplification).

---

## B. "User pastes formatted HTML from another app"

Cross-references throughout: [16-clipboard.md](./16-clipboard.md),
[11-dom-parser.md](./11-dom-parser.md), [05-transform-and-steps.md](./05-transform-and-steps.md),
[10-decorations.md](./10-decorations.md).

### B.1 Path

```
EVENT: paste                                          (input.ts:654-667)
  └─ handlers.paste (13 §9.2):
     1. props.handlePaste(view, e, slice?) — short-circuit if true
     2. doPaste(view, e) (input.ts:634-645, 16 §3.2):
        a. read e.clipboardData.{getData("text/html"), getData("text/plain")}
        b. detect "internal paste" via data-pm-slice marker (16 §6)
        c. parseFromClipboard(view, text, html, $cursor) (16 §3.3)
           ├─ readHTML(html) — hosting <body> reconstruction
           │   • strip <meta> sentinels and Office wrappers
           │   • preserve open-depth markers via data-pm-slice
           │   (16 §3.3.1, 18 §3.8)
           ├─ ruleFromNode walk if no rule matches (11 §4.1, 11 §7)
           ├─ DOMParser.parseSlice(node, options)
           │     → ParseContext stack walk (11 §5)
           │     → respects schema content expressions (03 §6)
           ├─ normalize / closeRight / openSides
           └─ fitSlice($from, $to, slice)
                — finds insertion point that satisfies content match
                  (see 03 §6.6 fillBefore + 02 §5.3 replace open depths)
        d. tr = view.state.tr.replaceSelection(slice)
              — internally tr.replaceRange ⇒ ReplaceStep / ReplaceAroundStep
              (05 §3.1, §3.2). clearIncompatible runs to drop disallowed
              marks/attrs (05 §4.2 high-level → step lowering).
        e. view.dispatch(tr)
```

### B.2 Plugin and decoration interaction

* `state.apply(tr)` runs `filterTransaction` first — a plugin can veto an
  external paste (e.g. paywall, schema lock).
  ([07 §5](./07-state-and-plugins.md))
* All `DecorationSet`s in plugin state must be `.map(tr.mapping, newDoc)`-ed
  in their plugin's `StateField.apply`. The set keeps stable identities for
  decorations that survive; widget side ordering decides where new ones land.
  ([10 §5 mapping](./10-decorations.md))
* In the view, `updateStateInner` recomputes `outerDeco`/`innerDeco` and
  `docView.update` will rebuild only the spans that touched the paste range
  (locality is essential to perceived speed). ([09 §3](./09-view-and-viewdesc.md))

### B.3 What if paste is into an atom or code block?

* Atom: `replaceSelection` becomes a no-op or a `NodeSelection` replacement;
  the whole atom is replaced. ([16 §8.2](./16-clipboard.md))
* Code block: `parseFromClipboard` short-circuits — text is inserted as plain
  text (newlines as `\n`), no HTML re-parse. The hook is `$context.parent.type.spec.code`.
  ([16 §8.3](./16-clipboard.md))
* Partial HTML (e.g. `<li>foo</li>` with no `<ul>`): `fitSlice` resolves
  required wrapping via `findWrapping` ([05 §5.3](./05-transform-and-steps.md))
  or drops disallowed children.

---

## C. "User performs IME composition"

Cross-references: [14-ime-composition.md](./14-ime-composition.md),
[15-domobserver-and-domchange.md](./15-domobserver-and-domchange.md),
[18-cross-browser-quirks.md §2.1, §2.2, §2.3](./18-cross-browser-quirks.md).

### C.1 Lifecycle, normal happy path (Mac/Windows IME)

```
EVENT: compositionstart                       (input.ts:457-462)
  → view.input.composing = true
  → view.input.compositionID++
  → CompositionViewDesc constructed if needed (14 §4)
  → DOMObserver.flushSoon CANCELED until end (15 §2 selection tracking)

EVENT: compositionupdate (zero or more)        (input.ts:462-493)
  → DOM mutates freely; PM does NOT read those mutations into state
  → view.docView is "frozen" wrt that subtree
  → if `endOfComposition` flag was set, PM forces an early end (14 §3a)

EVENT: input  (browsers fire this for IME)
  → if composing: ignored at PM level; DOM is the truth here.

EVENT: compositionend                          (input.ts:502-513)
  → view.input.composing = false
  → forceFlush() runs (14 §6, 15 §2.forceFlush)
    └─ takeRecords + readDOMChange over the composition range
       → diff → tr.replaceWith / tr.insertText
  → state catches up; updateStateInner reconciles
```

### C.2 Why state must "stay frozen"

If PM updated state on every `compositionupdate`, the very act of writing back
to the DOM would either kill the active IME candidate window (Chrome/macOS) or
restart composition (Android Chrome). PM's solution: never touch the DOM range
under composition; defer all `updateStateInner` writes until `compositionend`.
This is the **deferred reconciliation** rule ([14 §5](./14-ime-composition.md)).

### C.3 Android Chrome — the special case

Android does not reliably fire `compositionend`. PM uses a MutationObserver-driven
heuristic to detect "composition is effectively over":

* `compositionPendingChanges` flag on `view.input` ([14 §2](./14-ime-composition.md))
* A timer that fires `endComposition` if the DOM hasn't mutated for ~50ms
  ([14 §3c](./14-ime-composition.md))
* `beforeinput` with `inputType === "deleteContentBackward"` is hooked
  *only* for Android backspace (the single use of beforeinput, [13 §3.6](./13-input-pipeline.md)).

See [18 §2.1](./18-cross-browser-quirks.md) for the full Android quirks list.

### C.4 Marks during composition

`view.input.compositionPendingChanges` and `storedMarks` ([08 §10](./08-selection.md))
cooperate so that bold + IME yields bold composed text — the marks are
applied at flush time, not at compositionstart, because the actual text
range is unknown until the IME commits.

---

## D. "Two clients edit concurrently (collab)"

Cross-references: [20-history-and-collab.md](./20-history-and-collab.md),
[06-position-mapping.md](./06-position-mapping.md),
[05-transform-and-steps.md](./05-transform-and-steps.md).

### D.1 Path (one rebase round)

```
[Client A]                          [Authority]                      [Client B]
local tr (typing "X" at pos 5)
state.apply → collab.apply
  → unconfirmed.push(stepA)         (no msg yet — pull model)
                                                                   local tr ("Y" at pos 5)
                                                                   collab.apply
                                                                     → unconfirmed.push(stepB)
sendableSteps(state) → {steps:[A], version:0, clientID:αA}
  POST /steps                       (server arbiter)
                                    → accept A   version=1
                                    ← {steps:[A], clientIDs:[αA]}
                                                                   GET /steps?since=0
                                                                   ← {steps:[A], clientIDs:[αA]}
                                                                   receiveTransaction(state, [A], [αA])
                                                                     1. rebaseSteps([B], [A], tr)
                                                                        a. invert each unconfirmed step
                                                                        b. apply the inverted steps
                                                                        c. apply incoming step A
                                                                        d. re-apply each old step,
                                                                           mapped through the new
                                                                           mapping pipeline
                                                                        See 20 §2.4 + 06 §4 setMirror
                                                                     2. addToHistory: false
                                                                     3. history.rebased called →
                                                                        Branch.rebased rewrites
                                                                        the rope (20 §1.8)
                                                                     view.updateState → reconcile
sendableSteps now empty
                                                                   sendableSteps → {[B'], version:1}
                                                                   POST /steps
                                    accept B'   version=2
                                    ← broadcast
GET /steps?since=1
← {steps:[B'], clientIDs:[αB]}
receiveTransaction → unconfirmed empty,
just apply B'
```

### D.2 Why this works

Three properties (proved by construction in [05 §2 StepResult](./05-transform-and-steps.md),
[06 §6 Step.map](./06-position-mapping.md)):

1. Every `Step` has a deterministic `map(mapping)` that yields a new `Step`
   in the *post-mapping coordinate frame*.
2. Every `Step` has `invert(doc)` returning a `Step` that perfectly undoes it.
3. `Mapping` composes losslessly via `setMirror` ([06 §4.1, 4.2](./06-position-mapping.md));
   that is the substrate that lets us "remove A, apply B, re-apply A'".

### D.3 History interaction

Each rebase calls `history.rebased(transform, oldEvents)`, which walks the
rope and rewrites recorded inverted steps so that *undoing my own work after
a rebase* does the right thing (it undoes my work, not someone else's).
This is the most subtle part of the system — see [20 §1.8](./20-history-and-collab.md).

### D.4 View updates only changed subtrees

After `receiveTransaction`, `updateStateInner` runs the same reconciliation
as Section A. The reuse-key matching ([09 §3.2](./09-view-and-viewdesc.md))
means subtrees the rebased mapping moved but did not modify are detached
and re-attached at their new DOM positions without re-creating nodes.
That preserves caret, selection, focus, and any user state held inside
NodeView elements.

---

## E. "Selection click on a node view"

Cross-references: [13 §6](./13-input-pipeline.md), [17 §3](./17-coordinates-and-hit-testing.md),
[09 §4](./09-view-and-viewdesc.md), [08 §4 NodeSelection](./08-selection.md).

### E.1 Path

```
EVENT: mousedown                              (input.ts:278-301)
 1. dispatch wrapper checks editable (13 §1.3)
 2. handlers.mousedown:
    - record InputState.lastClick {time, x, y}
    - call runHandlerOnContext(view, "handleMouseDown", e)
      → walks up the resolved-pos parent chain (13 §6.2);
        each ancestor's NodeView.stopEvent OR plugin handler can claim
 3. If no claim, construct MouseDown FSM (13 §6.3):
    - posAtCoords({left:e.clientX, top:e.clientY})
        → 17 §3 — caretFromPoint → fallbacks → posFromCaret → final inside
    - if click landed on an atom/leaf or selectable node:
        selectClickedNode → tr.setSelection(NodeSelection.create(doc, pos))
      else if double-click on word, etc.: word selection
 4. view.dispatch(tr)
 5. state.apply → updateStateInner →
    selectionToDOM (09 §5):
      - blockSelection: place a CSS class on the DOM for NodeSelection
      - else: window.getSelection().setBaseAndExtent(...)
EVENT: mouseup → MouseDown.up (13 §6.3)
```

### E.2 Why posAtCoords is so complicated

Browser `caretRangeFromPoint` / `caretPositionFromPoint` lie in well-known
ways: BR-as-last yields the parent node, Firefox snaps to whitespace in odd
ways, Safari's draggable kludge reroutes clicks to a wrapper, WebKit becomes
"un-editable after click" inside `contenteditable=false` siblings.
Each is patched by a named kludge in [17 §3.4–§3.9](./17-coordinates-and-hit-testing.md).

### E.3 Why mousedown drives selection (not click)

`click` fires after `mouseup` and after the browser's own selection logic
has already run. PM gates selection at `mousedown` so it can `preventDefault`
in cases where the FSM owns the gesture (drag, atom node selection, custom
NodeView).

---

## F. The Unified Architectural Model — 4 Boundaries, N Invariants

ProseMirror enforces correctness by reducing the problem to **exactly four
boundaries**, each with a small set of invariants. If you understand these,
you understand 80% of the codebase.

```
              parse                     apply                    update
   ┌────────┐  ───►  ┌──────────┐  ───►  ┌──────────┐  ───►  ┌──────────┐
   │  DOM   │        │   doc    │        │  state   │        │   view   │  ┐
   │ (host) │  ◄───  │ (Node tr)│  ◄───  │(immutab.)│  ◄───  │ (mutable │  ▼
   └────────┘ readDOM└──────────┘  step  └──────────┘ docView│   DOM)   │ DOM
        ▲       Change               (Transform)               └──────────┘
        │                                                            │
        └────────────────────  reconcile  ───────────────────────────┘
```

### F.1 Boundary 1 — DOM ↔ doc

Crossed in two directions:

* **DOM → doc**: `DOMParser.parseSlice` and `readDOMChange.parseBetween`.
  ([11 §6.2](./11-dom-parser.md), [15 §5c](./15-domobserver-and-domchange.md))
* **doc → DOM**: `DOMSerializer.serializeFragment` and per-node `toDOM` from
  `NodeSpec`. ([12 §3.3](./12-dom-serializer.md), [03 §2 toDOM](./03-schema-and-content-expressions.md))

**Invariants:**

* I1. The doc is *always* schema-valid (`Node.check` passes). DOM that violates
     schema is normalized by `parseSlice` before becoming a Node.
* I2. Every leaf with a `contentDOM` hole has *exactly one* content-bearing
     element when serialized. ([12 §8 Edge cases](./12-dom-serializer.md))
* I3. Round-tripping a Node through `serializeFragment` → `parseSlice` is
     idempotent up to schema-equivalent forms. (Empirical contract — broken
     by toDOM/parseDOM inconsistency, see [11 §7 pitfalls](./11-dom-parser.md)).
* I4. Open-depth markers on a `Slice` survive copy/paste through
     `data-pm-slice`. ([16 §3.3](./16-clipboard.md))

### F.2 Boundary 2 — doc ↔ state

* `Step.apply(doc) → StepResult` is the only way to evolve the doc.
* `Transaction extends Transform` and its mapping pipeline is the only way to
  carry positions across changes.

**Invariants:**

* I5. Every `Step` has `invert(doc)` and `map(mapping)` ([05 §2](./05-transform-and-steps.md)).
* I6. `tr.docs[i]` is the document *before* `tr.steps[i]`; thus invert and
     replay are O(1) per step ([07 §4](./07-state-and-plugins.md)).
* I7. `state.apply(tr)` is pure — it produces a new `EditorState` with no
     side effects. (`view.dispatch` is the side-effect bridge.)
     ([07 §5](./07-state-and-plugins.md))
* I8. `filterTransaction` runs *before* any field updates; `appendTransaction`
     runs *after* and may extend the transaction list. The list is committed
     atomically. ([07 §5](./07-state-and-plugins.md), [07 §8](./07-state-and-plugins.md))
* I9. Selection is mapped through `tr.mapping` by default with bookmark
     semantics ([08 §9 implicit update](./08-selection.md)).

### F.3 Boundary 3 — state ↔ view

* `view.updateState(newState)` is the single ingress.
* `view.dispatch(tr)` is the single egress.

**Invariants:**

* I10. `view.state` is the *exact* state most recently applied; the view never
      derives state ad hoc. ([09 §1.2](./09-view-and-viewdesc.md))
* I11. Decoration sets in plugin fields *must* be `.map(tr.mapping, newDoc)`
      to remain in sync. ([10 §5](./10-decorations.md))
* I12. Plugin views (`PluginSpec.view`) are the escape hatch for mutable
      side effects (toolbars, autosave). ([01 §5.4](./01-architecture-overview.md),
      [07 §6](./07-state-and-plugins.md))
* I13. `view.props` are read each call (no caching of derived props in
      `ViewDesc`). ([09 §1.3](./09-view-and-viewdesc.md))

### F.4 Boundary 4 — view ↔ DOM (reconciliation)

* `docView` is the only writer.
* `DOMObserver` is the only reader.

**Invariants:**

* I14. The DOM under `view.dom` is always reachable from the current `docView`
      tree via the position-bridge ([09 §5](./09-view-and-viewdesc.md)).
* I15. `ignoreMutation` returning `true` means "PM may have written this; do
      not re-read it" — used to avoid feedback loops ([15 §8](./15-domobserver-and-domchange.md)).
* I16. NodeView.contentDOM, if present, is the only DOM PM will write into
      for that node's children. NodeView.dom is the outer ([09 §4](./09-view-and-viewdesc.md)).
* I17. During composition, `docView.update` *must not* touch the composing
      range; deferred-reconciliation flag gates this ([14 §5](./14-ime-composition.md)).
* I18. Selection sync is the *last* thing `updateStateInner` does, after DOM
      mutations are flushed, so the browser's own selection-clamp does not
      fight us ([09 §1.5](./09-view-and-viewdesc.md)).

### F.5 The complete invariant ledger

| #    | Owner    | Invariant                                                                                | Enforced in                         |
|------|----------|------------------------------------------------------------------------------------------|-------------------------------------|
| I1   | Model    | doc is schema-valid                                                                      | `Node.check` ([02 §2.7](./02-document-model.md)) |
| I2   | Model    | exactly one content-bearing element per `contentDOM` hole                                 | `renderSpec` ([12 §5](./12-dom-serializer.md))   |
| I3   | Model    | toDOM/parseDOM round-trip stable up to equivalence                                        | empirical, [11 §7](./11-dom-parser.md)           |
| I4   | Clipboard| open-depth survives copy via `data-pm-slice`                                              | [16 §3.3](./16-clipboard.md)         |
| I5   | Transform| every Step has invert + map                                                               | [05 §2](./05-transform-and-steps.md) |
| I6   | Transform| `tr.docs[i]` precedes `tr.steps[i]`                                                       | [07 §4](./07-state-and-plugins.md)   |
| I7   | State    | `state.apply` is pure                                                                     | [07 §5](./07-state-and-plugins.md)   |
| I8   | State    | filter runs before fields; append runs after; atomic commit                               | [07 §5](./07-state-and-plugins.md)   |
| I9   | State    | selection is mapped through tr.mapping with bookmark                                      | [08 §9](./08-selection.md)           |
| I10  | View     | view.state == last applied state                                                          | [09 §1.2](./09-view-and-viewdesc.md) |
| I11  | View     | DecorationSets in plugin fields are mapped per tr                                         | [10 §5](./10-decorations.md)         |
| I12  | View     | mutable side effects only in plugin views                                                 | [07 §6](./07-state-and-plugins.md)   |
| I13  | View     | props are read each call                                                                  | [09 §1.3](./09-view-and-viewdesc.md) |
| I14  | View     | docView ↔ DOM bijection via positions                                                     | [09 §5](./09-view-and-viewdesc.md)   |
| I15  | View     | ignoreMutation gates feedback loops                                                       | [15 §8](./15-domobserver-and-domchange.md) |
| I16  | View     | NodeView.contentDOM is the unique child-host                                              | [09 §4](./09-view-and-viewdesc.md)   |
| I17  | View     | composing range is reconciliation-frozen                                                  | [14 §5](./14-ime-composition.md)     |
| I18  | View     | selection sync is last in updateStateInner                                                | [09 §1.5](./09-view-and-viewdesc.md) |

---

## G. Performance Characteristics

This system is fast because immutability is paired with structural sharing
and locality at every layer.

### G.1 Asymptotic table

| Operation                                           | Cost        | Why / where                                                                  |
|-----------------------------------------------------|-------------|------------------------------------------------------------------------------|
| `Node.copy(content)`                                | O(1)        | shares `attrs` and `marks`; only the `content` reference changes ([02 §2.4](./02-document-model.md)) |
| `Fragment.cut(from, to)`                            | O(log n) avg| binary-search-ish offset walk; reuses unchanged subtrees ([02 §3.3](./02-document-model.md))         |
| `doc.resolve(pos)`                                  | O(depth)    | one walk down the path; cached on the resolve tree ([04 §2](./04-resolved-positions.md))             |
| `Step.apply(doc)` — text-only ReplaceStep           | O(1) parents + O(replaced) | structural sharing of unchanged parents ([05 §3.1](./05-transform-and-steps.md)) |
| `Mapping.map(pos)`                                  | O(steps × ranges) ~ O(small) | linear in the steps in the transaction ([06 §3](./06-position-mapping.md))    |
| `state.apply(tr)` — N plugins, M steps              | O(N·M) + appendTransaction loop | each field gets each step                                                   |
| `docView.update` — local edit                       | O(changed subtree size) | reuse-keys + suffix anchoring (`preMatch`) ([09 §3](./09-view-and-viewdesc.md))    |
| `docView.update` — full re-render                   | O(doc size) | bail-out path; only after IME or DOM corruption ([15 §7](./15-domobserver-and-domchange.md))         |
| `DecorationSet.map(mapping, doc)`                   | O(changed children + log) | tree mirrors doc; unchanged subsets share structure ([10 §6](./10-decorations.md))      |
| `posAtCoords` / `coordsAtPos`                       | O(local)    | uses browser primitives + bounded fallback walks ([17 §2, §3](./17-coordinates-and-hit-testing.md))  |
| `endOfTextblock(dir)`                               | O(1) cached / O(local) probe | uses `Selection.modify` once per direction, cached per dom layout ([17 §4](./17-coordinates-and-hit-testing.md)) |
| `parseBetween` (DOM read on edit)                   | O(local DOM size) | only the dirty range — typically a paragraph                              |
| `rebaseSteps(steps, over, transform)`               | O((|steps|+|over|)²) worst | invert + apply + replay loop ([20 §2.4](./20-history-and-collab.md))            |
| `Branch.addTransform` (history)                     | O(1) amortized | rope append with compress ([20 §1.4, §1.9](./20-history-and-collab.md))                     |
| `Branch.rebased`                                    | O(rope size in window) | walks the recent items only ([20 §1.8](./20-history-and-collab.md))                  |

### G.2 Structural sharing payoffs

* `Fragment` is the canonical shared spine. A `tr.replaceWith` that touches
  one paragraph in a 10MB doc creates exactly one new path of `Fragment` /
  `Node` instances from the root to the touched paragraph; everything else
  is `===`-identical to the prior doc.
* `Mark` and `Attrs` are intentionally pointer-compared — equality is `===`
  on the array/object reference for hot-path cases, falling back to deep
  compare ([02 §4.1](./02-document-model.md)).
* `DecorationSet` mirrors the doc tree; unchanged subtrees share their
  decoration nodes after `map()` ([10 §2](./10-decorations.md)).
* `RopeSequence` in history allows O(log n) splits and concatenations and is
  the substrate for `Branch.rebased`'s in-place rewrite ([20 §1.3](./20-history-and-collab.md)).

### G.3 Reconciliation locality

The reconciler is the most performance-critical piece.
[09 §3](./09-view-and-viewdesc.md) covers it in depth, but the key tricks are:

1. **Reuse keys are the *Node* identity.** Two same-type nodes with
   `Node.eq`-equal attrs/marks/content are interchangeable in the DOM —
   PM uses pointer equality of `Node` to short-circuit `update()` ([09 §3.2](./09-view-and-viewdesc.md)).
2. **Suffix anchoring (`preMatch`)** lets the reconciler match the trailing
   children before walking, so that an insert at the *front* of a long
   paragraph touches only the front, not the entire run.
3. **Mark stack synchronisation (`syncToMarks`)** rebuilds only the mark
   wrapper chain that actually differs.
4. **Dirty propagation (`markDirty`)** is the only state crossing the boundary
   for explicit invalidation — most updates are dirty-by-omission.
5. **Composition-frozen subtree** during IME means even a transaction whose
   range *contains* the composing range will skip the affected DOM ([14 §5](./14-ime-composition.md)).

### G.4 What we observed but is *not* O(...)-bounded

* `appendTransaction` loop. Bounded by plugin good behaviour. Bad plugin =
  loop forever. ([07 §5](./07-state-and-plugins.md))
* `MutationObserver` flush latency. Debounced by `flushSoon`, but a tab-
  switch / keypress-burst can stack up; PM relies on `forceFlush` at the
  next user event ([15 §3](./15-domobserver-and-domchange.md)).
* Selection sync loops. PM has explicit guards (`view.input.lastSelectionTime`,
  `view.input.lastSelectionOrigin`) to break browser feedback ([13 §2](./13-input-pipeline.md)).

---

## H. Where to go from here

* For the war-stories (every footgun encountered), see
  [22-edge-cases-and-pitfalls.md](./22-edge-cases-and-pitfalls.md).
* For a single-file map of every entry point, see
  [00-index.md](./00-index.md) and [01 §7](./01-architecture-overview.md).
* For the design lessons we want to bake into our next-gen editor, see
  the closing section of [22-edge-cases-and-pitfalls.md §17](./22-edge-cases-and-pitfalls.md).
