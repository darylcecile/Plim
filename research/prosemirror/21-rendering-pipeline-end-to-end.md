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

> **Note on the apparent contradiction with §K.1.** §A says "DOM first,
> state second" while §K.1 (Boundary 1) says "DOM is *downstream* of doc".
> Both are true at different scopes. **§A** describes the *event-time*
> direction for the typing path: the browser mutates the DOM, then PM
> derives a `Step` from the mutation. **§K.1** describes the *invariant*
> direction: at any moment when the system is at rest, the DOM that
> exists must be derivable from `state.doc` via `docView`. The typing
> path *temporarily* violates the steady-state invariant (DOM has a
> character the doc doesn't yet have), and `readDOMChange` →
> `view.dispatch` → `updateStateInner` is the mechanism that restores
> it within the same microtask. "DOM first" is the *transient*
> direction; "doc upstream of DOM" is the *settled* direction. The
> reconciler exists precisely to keep the transient short-lived.

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

Cross-references: [14-ime-composition.md §5](./14-ime-composition.md),
[15-domobserver-and-domchange.md](./15-domobserver-and-domchange.md),
[18-cross-browser-quirks.md §2.1, §2.2, §2.3 (Android, iOS, Safari composition quirks)](./18-cross-browser-quirks.md),
[22 §10 (composition pitfalls)](./22-edge-cases-and-pitfalls.md).

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

Cross-references: [20-history-and-collab.md §2.4 rebase, §3 walkthrough](./20-history-and-collab.md),
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
[09 §4](./09-view-and-viewdesc.md), [08 §1–§4 (Selection model & NodeSelection)](./08-selection.md).

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

## F. "User drags a node"

Cross-references: [13 §6.4 dragstart, §6.5 drop](./13-input-pipeline.md),
[16 §4 drag-internal](./16-clipboard.md), [08 §4 NodeSelection](./08-selection.md),
[06 §3 mapping](./06-position-mapping.md).

### F.1 Path

```
EVENT: mousedown on draggable atom (or selected range)
  → input.ts handlers.mousedown:
     - record InputState.lastClick
     - if click on atom marked draggable, do NOT NodeSelection yet —
       wait for the drag/click disambiguation (13 §6.5)
EVENT: dragstart                                    (input.ts:680-742)
  1. selectClickedNode if not already selected → NodeSelection
  2. view.dragging = { slice, move: !e.altKey }    (16 §4.1)
  3. e.dataTransfer.setData("text/html", serialized)
     e.dataTransfer.setData("text/plain",  …)
     e.dataTransfer.setData(
        "application/x-prosemirror",
        sliceJSON + sourceClientID
     )                                              (16 §4.2 internal token)
  4. PM does NOT preventDefault — browser owns the drag image.
EVENT: dragover (target editor; could be same or another PM instance)
  → handlers.dragover (input.ts:744-760):
     - posAtCoords(e.clientX, e.clientY)            (17 §3)
     - dropcursor plugin (if installed) renders a Decoration.widget
       at the projected drop position (10 §1.1, 13 §6.5)
EVENT: drop                                         (input.ts:762-849)
  1. Read application/x-prosemirror header → identify same-editor vs cross
  2. If same editor + move:
       a. tr.deleteRange(source.from, source.to)
       b. dropPos' = tr.mapping.map(dropPos)        (06 §3)
       c. tr.replaceRangeWith(dropPos', slice.content)
     If cross-editor or copy:
       a. tr.replaceRangeWith(dropPos, parsedSlice) (11 §6.2 parseSlice
          on the text/html payload)
  3. tr.setSelection(NodeSelection.create(...))     so the dropped node
     is selected after the drop
  4. view.dispatch(tr)                              same path as A/E
```

### F.2 Why drag uses two `dataTransfer` channels

The `text/html` channel is for cross-app paste. The
`application/x-prosemirror` channel preserves the *exact* `Slice` (with
open-depth) so a same-editor or cross-PM-instance drop does **not** go
through HTML round-trip. See [16 §3.3 data-pm-slice](./16-clipboard.md)
for the analogous mechanism on copy.

### F.3 The "delete-then-insert" ordering matters

`tr.deleteRange` *must* run before `tr.replaceRangeWith`, then the drop
position is mapped through the deletion's mapping. Reversing the order
would either delete the just-inserted content (if the drop landed inside
the source range) or use a stale position. This is the canonical example
of why `tr.mapping` (06 §3) is the substrate for everything multi-step.

### F.4 Decorations & dragging

* The `prosemirror-dropcursor` plugin owns the visual drop indicator via
  a widget decoration on `dragover` and clears it on `drop`/`dragleave`.
* Inline & node decorations on the *source* range get torn down naturally
  when the source content is deleted; on the *destination* they get
  reconstructed because decorations live in plugin state and are mapped
  through `tr.mapping`, not attached to the dragged content.

---

## G. "User undo while collaborator types"

Cross-references: [20 §1 history rope](./20-history-and-collab.md),
[20 §2 collab.rebaseSteps](./20-history-and-collab.md),
[20 §3 walkthrough](./20-history-and-collab.md),
[19 §5 undo command](./19-commands-keymap-inputrules.md).

This is the canonical "two engines fighting" scenario. The local user
presses `Cmd-Z` while a remote step is in flight or has just been rebased.

### G.1 Path

```
[t0]  Local doc v=4, history.done = [E1, E2, E3]
      where E3 is the user's most recent edit "hello".
[t1]  Remote step R arrives via collab.receiveTransaction:
        a. rebaseSteps([], over=[R], ...)             // unconfirmed empty
        b. tr.step(R)                                  // applied locally
        c. history.rebased(transform=[R], oldEvents=3) (20 §1.8)
           → Branch.rebased rewrites E1..E3 such that each event's
             inverted steps are mapped through R's mapping pipeline.
           → done now stores [E1', E2', E3'] with new inverted steps
             that, when re-applied, undo the user's edit *as if R had
             never happened*. (20 §1.8 Branch.rebased proof)
[t2]  User hits Cmd-Z.
      undo command (history.ts):
        a. Pop last event E3' from done.
        b. For each (inverted) step in E3', apply it as a new
           transaction with addToHistory:false.
        c. Push the *forward* steps onto undone (redo stack).
[t3]  view.dispatch(tr) → state.apply → updateStateInner.
      Local doc is now in a state where R is still present but the
      user's "hello" insertion has been reversed.
[t4]  collab.sendableSteps(state) returns []  (the undo had
      addToHistory:false, but does NOT have collab "local"
      semantics: it IS a regular step that propagates).
      Wait — actually undo *does* propagate. The transaction
      from undo carries setMeta("addToHistory", false) but does
      NOT carry setMeta(collabKey, ...). So collab.apply does
      push it onto unconfirmed. (20 §2.2)
[t5]  Outgoing POST /steps → authority broadcasts inverse-of-E3.
[t6]  Other clients see "user undid their edit" — exactly right.
```

### G.2 Why this is correct

Two invariants make this work:

1. **`Branch.rebased` keeps inverted steps coordinate-correct.** After
   the rebase at t1, the inverted step in `E3'` operates on the
   *post-R* doc, not the *pre-R* doc. So undoing produces a doc in
   which only the user's edit is reversed and R is preserved.
2. **Undo is a regular transaction for collab purposes.** The undo
   does not bypass collab; it generates new steps that are sent like
   any others, so peer clients converge.

### G.3 Where this can go wrong

* **Preservation across rebase windows.** If the rebase happened
  *during* the undo (a remote step lands between `tr.step(invertedE3)`
  and `view.dispatch`), the inverted steps were mapped at t1 — they
  remain valid; collab.apply remaps them again on dispatch. PM's
  `Mapping` composability ([06 §4 setMirror](./06-position-mapping.md))
  is what permits a *second* rebase pass without bookkeeping
  duplication.
* **`addToHistory:false`.** If the *remote* transaction at t1 carried
  `addToHistory: true` by accident, the user's `Cmd-Z` would undo the
  *remote* edit instead. Hence the strict convention that
  `receiveTransaction` always sets `addToHistory: false`
  ([22 §16.2](./22-edge-cases-and-pitfalls.md)).
* **Pruning.** If the user has been idle long enough that history has
  pruned `E3`, `Cmd-Z` is a no-op and the user thinks undo is broken.
  (20 §1.4 newGroupDelay)

---

## H. "Plugin appendTransaction loop — a second pass through state.apply"

Cross-references: [07 §5 applyTransaction](./07-state-and-plugins.md),
[07 §8 appendTransaction](./07-state-and-plugins.md),
[19 §4 input rules](./19-commands-keymap-inputrules.md),
[22 §4.2 infinite-loop pitfall](./22-edge-cases-and-pitfalls.md).

This scenario shows what happens *inside* `state.apply` when one or
more plugins react to a transaction by appending another.

### H.1 Path

```
view.dispatch(trA)                                    // user typed "(c)"
  state.apply(trA):
    1. for each plugin: filterTransaction(trA) → must all return true
    2. trs = [trA]
    3. fixed-point loop (state.ts:applyTransaction):
       iteration k=0:
         apply each StateField.apply(trA, …) → newFields[0..N]
         hasNew = false
         for each plugin in order:
           appendTr_k = plugin.spec.appendTransaction(trs, oldState, tempState_k)
           if appendTr_k:
             trs.push(appendTr_k)
             // re-derive tempState_k by applying appendTr_k
             apply each StateField.apply(appendTr_k, …)
             hasNew = true
         if !hasNew: break
       iteration k=1:
         input-rules plugin sees trs[1] (autoreplaced "(c)"→"©") and
         decides not to react further → returns null
         smart-quotes plugin sees the prior "©" and decides not to
         react → returns null
         hasNew = false → exit
    4. final state = tempState after last iteration
    5. return { state: final, transactions: trs }
view.updateState(final)
  → docView.update reconciles using the *combined* mapping of all trs
  → DOM goes from "(c)" → "©" in one paint, no flicker
```

### H.2 Why the loop is required (vs. just one pass)

Plugin B may react to plugin A's appended transaction. Inputrules
([19 §4](./19-commands-keymap-inputrules.md)) is a frequent example:
typing "*foo*" produces a base transaction (insert "*"), then a
*second* transaction (replace `*foo*` → bold "foo") emitted by the
inputrules `appendTransaction`. A typing-time mark-inheritance plugin
([08 §10 storedMarks](./08-selection.md)) might then add a third
transaction to copy the bold mark onto subsequent typed characters.

Each appended tr re-runs the per-plugin `apply` chain, so a plugin can
*see* its own and earlier plugins' appended transactions in the next
iteration.

### H.3 Termination & the absence of a hard counter

PM relies on plugin authors to *eventually return null*. There is no
hard cap. The standard discipline:

* Use `tr.getMeta(myKey)` to mark "I produced this" and skip on the
  next iteration.
* Never react to a transaction that already carries your meta marker.
* See [22 §4.2](./22-edge-cases-and-pitfalls.md) for the war-story
  variant where two plugins react to each other forever.

### H.4 What the view sees

The view never witnesses an intermediate iteration. `view.updateState`
runs once with the final `EditorState` and the *combined* list of
transactions; reconciliation maps positions through the combined
mapping. From the DOM's point of view, the entire fixed-point loop is
atomic: one paint, one selection sync, one history event (unless one
of the trs has `addToHistory:false`).

---

## I. "Decoration update without a doc change" — the DecorationSet diff path

Cross-references: [10 §3 DecorationSet](./10-decorations.md),
[10 §5 mapping](./10-decorations.md),
[10 §6 cost model](./10-decorations.md),
[09 §3.4 decoration application](./09-view-and-viewdesc.md).

A common scenario: a search plugin highlights matches as the user
types into a search box *outside* the editor. The doc has not
changed, only the plugin state — but the on-screen decorations must
update.

### I.1 Path

```
External UI: user types "x" in search box.
searchPlugin.dispatch(view.state.tr.setMeta(searchKey, {query: "x"}))
  → state.apply(tr):
       searchPlugin.state.apply(tr, prevSet, oldState, newState):
         - prevSet was a DecorationSet of N matches for "old query"
         - compute new matches for "x" — returns Decoration[] for hits
         - return DecorationSet.create(newState.doc, newDecos)
       Note: tr has zero steps. tr.docChanged === false.
  → newState !== oldState (new field value); doc === oldDoc.
view.updateState(newState):
  updateStateInner (09 §1.5):
    1. prevState.doc === newState.doc → docChanged = false
    2. compute decorations:
         oldDecos = previousOuterDeco
         newDecos = view.someProp("decorations", f => f(newState))
       This calls each plugin's `decorations(state)` prop → assembles
       new outer DecorationSet (10 §5).
    3. docView.update(doc, outerDecos, innerDecos, view):
         - because doc unchanged, the matchChildren walk only compares
           decoration sets node-by-node (DecorationSet has `eq`
           — pointer compare on inner trees). (10 §6)
         - subtrees whose decorations are === to the prior set
           short-circuit immediately (NO DOM touch)
         - subtrees whose decorations differ have inline decorations
           re-applied via syncToMarks; widgets re-rendered if their
           toDOM result differs (10 §3.5)
    4. selection sync — selection unchanged → no-op
    5. NO scrollIntoView
```

### I.2 Why this is fast even on a 100MB doc

Because `DecorationSet` mirrors the doc tree, two `DecorationSet`s for
two queries share the structure of every node-subtree they don't
touch. A search query that matches in 3 paragraphs out of 100,000
produces a `DecorationSet` whose root delegates to the same subtree
references as the previous set, except for those 3 paragraph subtrees.
The node-walk in `docView.update` compares decoration subtrees by
pointer; 99,997 paragraph subtrees short-circuit at O(1) each. (See
[10 §6](./10-decorations.md) for the cost model.)

### I.3 Why state must still be replaced

Even though the doc didn't change, the new `EditorState` instance is
required so that `view.state` matches the new plugin field. PM enforces
I10 (`view.state` is the most-recently-applied state — see §K.3 below)
unconditionally; there is no "decoration-only update" code path that
bypasses state, because plugin views, props callbacks, and command
queries all read `view.state` and would get stale data otherwise.

### I.4 When this path is *also* skipped — the redraw short-circuit

`view.updateState` short-circuits to a no-op if **both** of the
following hold (see [09 §1.5](./09-view-and-viewdesc.md)):

1. `prevState === newState` (reference equality)
2. `prevDecorations === newDecorations` and `prevInnerDecos === newInnerDecos`

In practice this means: a plugin that returns the *same* `DecorationSet`
instance (typical when the plugin's `decorations(state)` prop is
memoized) and a state object that happens to be `===` produces zero
DOM work. This is how the typical "no-op transaction" path stays cheap.

---

## J. "Trace through a real bug — flicker after autoreplace"

A user reports: typing `(c)` causes a one-frame flash where `(c)` is
visible briefly before becoming `©`. We use the model in §A and §H to
explain.

### J.1 The bug

```
t=0 ms   keydown ")"           browser inserts ")" into DOM
t=1 ms   MutationObserver flushes → readDOMChange → tr1: insertText ")"
         view.dispatch(tr1)
         state.apply(tr1):
           inputrules.appendTransaction sees "(c)" → returns tr2
           that replaces "(c)" with "©"
         view.updateState(final state)  // both trs combined
         docView.update reconciles → DOM shows "©"
         browser paints: "©"
```

If the user reports flicker, that means somewhere the browser painted
"(c)" before `view.updateState` ran. Three possible causes ordered by
frequency:

1. **`dispatchTransaction` is async.** Some app integrations wrap
   `view.dispatch` in `setTimeout(fn, 0)` or a React batch that
   defers state propagation. Result: the DOM mutation from t=0 has
   *already* painted before tr2 runs. Fix: never defer; the entire
   pipeline must complete in the same microtask/task as the input
   event. ([22 §11.1](./22-edge-cases-and-pitfalls.md))
2. **A plugin runs `view.updateState` early via `setProps`.** A
   plugin view's `update()` synchronously calls `view.dispatch`
   between t=1 and the inputrules append. The intermediate render
   shows "(c)". Fix: only react in `appendTransaction` (which is
   inside the same `state.apply`).
3. **Inputrules is configured with a `requestAnimationFrame` debounce.**
   Some forks of the package defer the `*foo*` → bold replacement to
   the next frame. The user briefly sees the asterisks. Fix: leave
   inputrules synchronous.

### J.2 What the boundary model tells us

§K.4 invariant I18 says "selection sync is the *last* thing
`updateStateInner` does, after DOM mutations are flushed". The
*corollary* is that DOM mutations are themselves the *next-to-last*
thing. The browser paint is gated on the JS task ending. So if every
state transition completes synchronously in the same task as the
input that triggered it, no paint happens between them — guaranteed
by the JS event loop, not by PM. Flicker means something is breaking
that synchronicity.

### J.3 Annotated `view.update` profiler trace (pseudo-trace)

A typical Chromium profiler timeline of one keystroke (with
`performance.measure` markers added by an instrumented build):

```
┌──────────── input event 0.18 ms ────────────┐
│  keydown handler           0.02 ms          │
│  (browser native insert)   0.00 ms (defer)  │
│  beforeinput handler       0.01 ms          │
└──────────────────────────────────────────────┘
┌──────────── microtask queue ─────────────────┐
│  MutationObserver callback 0.04 ms           │
│  └─ flushSoon dispatch     0.00 ms           │
└──────────────────────────────────────────────┘
┌──────────── flush() 0.84 ms ─────────────────┐
│  takeRecords               0.05 ms           │
│  registerMutation×N        0.07 ms           │
│  readDOMChange:                              │
│   ├ parseBetween           0.31 ms ← hot     │
│   ├ diff fragments         0.04 ms           │
│   └ tr.insertText          0.02 ms           │
│  view.dispatch:                              │
│   ├ state.apply            0.18 ms           │
│   │  ├ filterTransaction   0.01 ms           │
│   │  ├ apply each field    0.06 ms           │
│   │  └ appendTransaction×2 0.10 ms (loop)    │
│   └ view.updateState       0.13 ms           │
│      ├ docView.update      0.09 ms ← hot     │
│      │  ├ matchChildren    0.04 ms           │
│      │  ├ syncToMarks      0.02 ms           │
│      │  └ patchText        0.01 ms           │
│      └ selectionToDOM      0.03 ms           │
└──────────────────────────────────────────────┘
┌──────────── browser paint ~3 ms ─────────────┐
└──────────────────────────────────────────────┘
```

Hot spots, measured: `parseBetween` (DOM read + DOMParser allocation)
and `docView.update` (the reconciliation walk). On a 100MB doc the
order is preserved but absolute times scale with the *local* edit
range, not doc size — provided locality holds (see §L).

---

## K. The Unified Architectural Model — 5 Boundaries, N Invariants

ProseMirror enforces correctness by reducing the problem to **five
boundaries**, each with a small set of invariants. The first four are
the steady-state pipeline; the fifth — *plugin views* — is the explicit
escape hatch where the unidirectional model is allowed to break, in a
contained way. If you understand these, you understand 80% of the
codebase.

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

### K.1 Boundary 1 — DOM ↔ doc

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

### K.2 Boundary 2 — doc ↔ state

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

### K.3 Boundary 3 — state ↔ view

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

### K.4 Boundary 4 — view ↔ DOM (reconciliation)

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

### K.5 Boundary 5 — view ↔ side-effect world (plugin views)

The first four boundaries form a strictly unidirectional pipeline.
Real applications need a controlled way to break out of it: toolbars
need to read state and update DOM outside `view.dom`, autosave needs
to fire HTTP requests, presence indicators need to push to a
WebSocket. Plugin views (`PluginSpec.view`) are the *only* sanctioned
exit.

* `PluginSpec.view(view) → { update?(view, prevState), destroy?() }`
* Created at `view.constructor` time; `update` runs on every
  `view.updateState`; `destroy` runs on `view.destroy`.
* Receive `EditorView` (live, mutable) and the previous `EditorState`.
* The escape hatch: anything *not* a function of `state` lives here —
  imperative DOM (toolbar buttons), network calls (autosave), timers,
  observers.

**Invariants:**

* I19. Plugin views must NOT call `view.dispatch` synchronously from
       inside their `update` callback in a way that diverges (it is
       allowed, but each dispatch will trigger another `update`; the
       author owns the convergence proof). Convention: gate on
       `prevState.doc === view.state.doc` to skip unchanged docs.
* I20. Plugin views own `destroy()` cleanup — every event listener,
       timer, and observer attached must be torn down. This is the
       only place where leaks beyond the `view.destroy` chain can
       occur. (See [22 §19 Memory leaks](./22-edge-cases-and-pitfalls.md).)
* I21. Plugin views may render DOM *outside* `view.dom`; that DOM is
       not subject to reconciliation invariants I14–I18. The reverse
       direction (plugin-view DOM → state) goes through `view.dispatch`
       like any other input.

**Why this is the only exit.** Letting plugin fields produce side
effects in their `apply` would break I7 (state.apply is pure). Letting
the reconciler call out to userland would break I14 (DOM bijective
with docView). Plugin views are the *single* place where mutable side
effects are allowed; making them a dedicated boundary, separate from
plugin state, keeps the rest of the system reasoning-friendly.

### K.6 Boundary diagram (5-boundary version)

```
              parse                     apply                    update
   ┌────────┐  ───►  ┌──────────┐  ───►  ┌──────────┐  ───►  ┌──────────┐
   │  DOM   │        │   doc    │        │  state   │        │   view   │  ┐
   │ (host) │  ◄───  │ (Node tr)│  ◄───  │(immutab.)│  ◄───  │ (mutable │  ▼
   └────────┘ readDOM└──────────┘  step  └──────────┘ docView│   DOM)   │ DOM
        ▲       Change               (Transform)               └──────────┘
        │                                                            │
        └────────────────────  reconcile  ───────────────────────────┘
                                          │
                                          ▼
                                   ┌─────────────┐
                                   │ plugin view │  K.5 — escape hatch
                                   │ (toolbar,   │  side effects only;
                                   │  autosave,  │  cannot violate
                                   │  presence)  │  K.1–K.4 invariants.
                                   └─────────────┘
```

### K.7 The complete invariant ledger

Each invariant is keyed by its boundary number (B1–B5) so the ledger can be
cross-referenced from any scenario above.

| #    | Boundary | Owner    | Invariant                                                                                | Enforced in                         |
|------|----------|----------|------------------------------------------------------------------------------------------|-------------------------------------|
| I1   | B1       | Model    | doc is schema-valid                                                                      | `Node.check` ([02 §2.7](./02-document-model.md)) |
| I2   | B1       | Model    | exactly one content-bearing element per `contentDOM` hole                                 | `renderSpec` ([12 §5](./12-dom-serializer.md))   |
| I3   | B1       | Model    | toDOM/parseDOM round-trip stable up to equivalence                                        | empirical, [11 §7](./11-dom-parser.md)           |
| I4   | B1       | Clipboard| open-depth survives copy via `data-pm-slice`                                              | [16 §3.3](./16-clipboard.md)         |
| I5   | B2       | Transform| every Step has invert + map                                                               | [05 §2](./05-transform-and-steps.md) |
| I6   | B2       | Transform| `tr.docs[i]` precedes `tr.steps[i]`                                                       | [07 §4](./07-state-and-plugins.md)   |
| I7   | B2       | State    | `state.apply` is pure                                                                     | [07 §5](./07-state-and-plugins.md)   |
| I8   | B2       | State    | filter runs before fields; append runs after; atomic commit                               | [07 §5](./07-state-and-plugins.md)   |
| I9   | B2       | State    | selection is mapped through tr.mapping with bookmark                                      | [08 §9](./08-selection.md)           |
| I10  | B3       | View     | view.state == last applied state                                                          | [09 §1.2](./09-view-and-viewdesc.md) |
| I11  | B3       | View     | DecorationSets in plugin fields are mapped per tr                                         | [10 §5](./10-decorations.md)         |
| I12  | B5       | View     | mutable side effects only in plugin views                                                 | [07 §6](./07-state-and-plugins.md)   |
| I13  | B3       | View     | props are read each call                                                                  | [09 §1.3](./09-view-and-viewdesc.md) |
| I14  | B4       | View     | docView ↔ DOM bijection via positions                                                     | [09 §5](./09-view-and-viewdesc.md)   |
| I15  | B4       | View     | ignoreMutation gates feedback loops                                                       | [15 §8](./15-domobserver-and-domchange.md) |
| I16  | B4       | View     | NodeView.contentDOM is the unique child-host                                              | [09 §4](./09-view-and-viewdesc.md)   |
| I17  | B4       | View     | composing range is reconciliation-frozen                                                  | [14 §5](./14-ime-composition.md)     |
| I18  | B4       | View     | selection sync is last in updateStateInner                                                | [09 §1.5](./09-view-and-viewdesc.md) |
| I19  | B5       | View     | plugin views must converge (no infinite update cycles)                                    | author convention; see [22 §19.2](./22-edge-cases-and-pitfalls.md) |
| I20  | B5       | View     | plugin views own destroy() cleanup                                                        | [22 §19](./22-edge-cases-and-pitfalls.md)        |
| I21  | B5       | View     | plugin-view DOM is outside reconciliation                                                  | [09 §1.4](./09-view-and-viewdesc.md) |

---

## L. Performance Characteristics

This system is fast because immutability is paired with structural sharing
and locality at every layer. This section is split: §L.1–§L.4 cover the
*asymptotic* model (worst-case theory), §L.5 covers *operational* guidance
(what's actually slow on real hardware in practice). For deep operational
profiling — flame graphs, large-document strategies, memoization patterns
— see [26-performance.md](./26-performance.md).

### L.1 Asymptotic table

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

### L.2 Structural sharing payoffs

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

### L.3 Reconciliation locality

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

**How these compose.** The interesting question is what happens when
several locality tricks apply at once. Concrete example: a 10,000-paragraph
doc, user inserts a single character at the start of paragraph 5,000,
*and* a search plugin has decorations on 50 of the paragraphs, *and* an
IME composition is running on paragraph 7,500.

* The reuse-key walk (#1) at the doc level finds 9,999 paragraph children
  that are `===` to the previous doc and short-circuits each in O(1).
* For paragraph 5,000, the reuse-key walk at the inline level uses suffix
  anchoring (#2) to match every child after the insertion in O(1) each;
  only the prefix up to the insertion point is rewritten.
* The mark-stack sync (#3) only rebuilds wrappers around the inserted
  character if it acquired/lost marks; otherwise the existing wrapper
  is reused.
* `markDirty` (#4) is never invoked: the change is dirty-by-omission
  through the reuse-key check.
* The composition-frozen subtree (#5) means paragraph 7,500 is skipped
  entirely from reconciliation even though the doc-level mapping
  technically renumbered its position.

The combined cost is O(prefix length within paragraph 5,000) + O(50)
for the decoration walk, *not* O(doc size) and *not* O(decoration count
across the whole doc). This is why PM scales to 100MB documents on
hot-path edits — but see §L.5 for cold-path realities.

### L.4 What we observed but is *not* O(...)-bounded

* `appendTransaction` loop. Bounded by plugin good behaviour. Bad plugin =
  loop forever. ([07 §5](./07-state-and-plugins.md))
* `MutationObserver` flush latency. Debounced by `flushSoon`, but a tab-
  switch / keypress-burst can stack up; PM relies on `forceFlush` at the
  next user event ([15 §3](./15-domobserver-and-domchange.md)).
* Selection sync loops. PM has explicit guards (`view.input.lastSelectionTime`,
  `view.input.lastSelectionOrigin`) to break browser feedback ([13 §2](./13-input-pipeline.md)).

### L.5 Operational guidance — what's actually slow in practice

Asymptotic complexity tells you the *shape* of the curve. Operational
performance tells you which constants dominate on real hardware. For
flame-graph-driven analysis and full benchmark data, see
[26-performance.md](./26-performance.md). The headline observations:

**Hot paths (single keystroke, p99 under 1ms on a 2024 laptop):**

1. `parseBetween` — DOM read + `DOMParser` allocation. Constant factors
   dominate; the actual work is small but DOMParser construction is
   measurable. Cache hits are not exploited.
2. `docView.update` walk — most of its time is in `Node.eq` calls
   short-circuiting reuse keys. On a balanced doc, this is dominated
   by the depth (≈ log n) not by n.
3. `selectionToDOM` — `Selection.setBaseAndExtent` is a synchronous DOM
   call; on Safari it is occasionally surprisingly slow (10–100µs) due
   to the bidi resolver running.

**Cold paths (worst-case operations):**

* **Initial render of a large doc.** First `view.constructor` walks the
  entire doc to build `docView`. Linear in doc size with high constants
  (each text node and mark wrapper allocates). On a 100MB doc this
  takes several hundred milliseconds and *cannot* be incrementally
  warmed — see [26 §3 large-document strategies](./26-performance.md)
  for virtualizing-NodeView patterns.
* **Full clipboard paste with parser.** `parseSlice` over a 1MB HTML
  payload runs the rule matcher per node and per style; can take
  10–50ms.
* **Collab rebase storm.** A burst of 100 remote steps each triggers
  a full `Branch.rebased` walk over the local history rope; in the
  pathological case (large rope, many cross-step mappings) this is
  O(rope × steps).

**Slowest operation when typing in a 100MB document — the answer.**

The slowest *recurring* operation per keystroke in a 100MB document
is **`coordsAtPos` when called for `scrollIntoView`** if scroll is
required after the edit ([17 §2](./17-coordinates-and-hit-testing.md)).
The reason: `coordsAtPos` walks down to a text node and calls
`Range.getBoundingClientRect`, which forces the browser to compute
layout for any pending mutations. On a 100MB doc with many recently
modified subtrees, that layout pass can be 20–100× the cost of the
reconciliation itself.

The slowest *pure-PM* operation per keystroke is `parseBetween` when
the dirty range happens to widen to a large block (e.g., a long code
block with many text node children); this is bounded by local DOM
size, not doc size, but a single 1MB `<pre>` will hurt.

Other large-doc costs that are *not* per-keystroke:

* `Node.eq` in deep `appendTransaction` chains where a plugin computes
  a fresh decoration set. Mitigation: memoize on `(doc, plugin-input)`.
* Garbage collection pressure from rope items in `Branch` history when
  `historyPreserveItems` keeps inverted steps for a long session
  ([20 §1.4](./20-history-and-collab.md)).

### L.6 When is `view.update` skipped entirely?

`view.updateState` short-circuits to a complete no-op ("the redraw
short-circuit") when ALL of the following hold:

1. `prevState === newState` — the new state is *literally* the same
   object reference. This happens when `state.apply(noopTr)` returns
   the same instance — but PM does **not** do this currently
   ([22 §4.7](./22-edge-cases-and-pitfalls.md)). In practice, it
   happens only when an external caller passes the existing state.
2. `prevOuterDecos === newOuterDecos` and `prevInnerDecos === newInnerDecos`
   — every plugin's `decorations(state)` prop returned the same
   `DecorationSet` reference. This is normal for a no-op state.
3. The view itself is not flagged dirty (no `setProps` since last
   update).

When all three hold, `view.updateState` exits before `docView.update`
runs at all. There is no DOM access, no selection check, no scroll
computation. This is the "true zero-cost update" path and is rare in
production unless the host explicitly avoids dispatching no-ops.

A *softer* short-circuit also exists: if doc and decorations are equal
but state differs (e.g., a plugin's internal field changed but no DOM
output changed), `docView.update` runs but bails after the first
matchChildren call because every child reuse-key passes pointer
equality. The DOM is not touched, but the function still runs.

### L.7 Where to look first when something is slow

1. Use Chrome DevTools Performance with "Side-Panel Source Maps" on a
   PM-symbolicated build. Look for `parseBetween`, `docView.update`,
   `coordsAtPos`, `getBoundingClientRect`.
2. Add `performance.measure` markers around `view.dispatch` and
   `state.apply` if you suspect the loop in §H. Plugins that misuse
   `appendTransaction` show up as repeated state.apply spans in one
   dispatch.
3. For collab rebases, log the `transform.steps.length` and the
   `unconfirmed.length` per receive; a sustained ratio > 5:1 means
   you're losing time in `rebaseSteps`.
4. For decoration costs, check whether the plugin returns the same
   `DecorationSet` reference for unchanged input — a plugin that
   creates a fresh set every `apply` defeats the I.4 short-circuit.

See [26-performance.md §6 profiling cookbook](./26-performance.md) for
full instrumentation recipes and reference benchmarks.

---

## M. Where to go from here

* For the war-stories (every footgun encountered), see
  [22-edge-cases-and-pitfalls.md](./22-edge-cases-and-pitfalls.md).
* For operational performance — large-doc strategies, profiling
  recipes, memoization patterns — see
  [26-performance.md](./26-performance.md).
* For accessibility, i18n, mobile, security, testing, plugin
  cookbooks: see new files 23 (a11y), 25 (mobile), 27 (testing),
  28 (i18n/RTL), 31 (plugin cookbook), 32 (security), 37 (async
  transactions).
* For a single-file map of every entry point, see
  [00-index.md](./00-index.md) and [01 §7](./01-architecture-overview.md).
* For the design lessons we want to bake into our next-gen editor, see
  the closing section of [22-edge-cases-and-pitfalls.md §17](./22-edge-cases-and-pitfalls.md).
