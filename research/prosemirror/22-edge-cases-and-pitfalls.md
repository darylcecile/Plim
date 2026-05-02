# 22 — Edge Cases & Pitfalls — The War-Story Manual

A taxonomy of every gotcha discovered while writing files 01–20. Format:

```
N.M. Title
  • Where it manifests
  • Source citation (file:line) — points into /tmp/prosemirror-research/
  • Mitigation in PM
  • If we are designing a new editor: what to do differently
```

When a citation appears as `prosemirror-view/src/X.ts:NNN` it means the
upstream source; when it appears as `[see N-foo.md §K](./N-foo.md)` it
points at our own dossier file.

---

## 1. Schema design pitfalls

### 1.1 Content expressions are NFAs, not regexes

* **Manifests as:** Cryptic "node not allowed at position" errors when authors
  write content like `(paragraph | heading)+ block*`. The DFA derived from
  Thompson construction is unintuitive when groups overlap.
* **Source:** `prosemirror-model/src/content.ts` — see
  [03 §4–§6](./03-schema-and-content-expressions.md).
* **Mitigation:** PM caches `ContentMatch` per node type and surfaces
  `defaultType` and `fillBefore` so editors don't have to think in NFA terms
  ([03 §6.3, §6.6](./03-schema-and-content-expressions.md)).
* **Pathological example.** The classic NFA-to-DFA blow-up is `(a|aa)*`
  for regexes; the analog in PM content expressions is:

  ```
  // schema:
  group_a: { content: "para+" },
  group_b: { content: "(para | para para)*" }
  // group_b's NFA has overlapping epsilon transitions: accept para,
  // OR consume two paras and recurse. The NFA does not blow up
  // exponentially because PM's matcher is non-backtracking, but
  // ContentMatch.matchType has to enumerate both branches every
  // time it sees a `para`, doubling the work for every additional
  // child node. On a doc with 10,000 paragraphs in a `group_b`,
  // matchType becomes a measurable hot spot.

  // A worse case — mark-style overlap on inline content:
  inline: "(text | text mention)*"
  // Same shape: each text token has two matching paths. Multiplied
  // by the inline parser's per-token call, this can dominate parse
  // time on large documents.
  ```

  Equivalent of `(a|aa)*` in PM grammar:
  `"(text | text text)*"` — every text node consumed has two NFA
  paths to track. Authors should write `"text*"` instead. PM's
  `ContentMatch.compile` does *not* warn about this; it cheerfully
  builds the over-permissive NFA.
* **Redesign:** Provide a higher-level "this node accepts these children
  in this order" DSL with an explicit "auto-fill" operator. Reject
  expressions whose DFA blows up (`*` over groups with overlap).

### 1.2 Marks order matters and is implicit

* **Manifests as:** Decorations rendering in the wrong nesting order
  (italic-inside-link vs link-inside-italic), or `<em><a>` vs `<a><em>`.
* **Source:** `prosemirror-model/src/mark.ts` `addToSet` —
  [02 §4.2](./02-document-model.md).
* **Mitigation:** `MarkSpec.inclusive`, `excludes`, and the position of marks
  in `schema.marks` are all consulted.
* **Redesign:** Force authors to declare an explicit total order on marks at
  schema time; reject ambiguous `excludes` cycles.

### 1.3 `atom: true` vs leaf vs `isolating: true` — three orthogonal flags

* **Manifests as:** Authors wonder why their custom node "still gets edited
  inside" when they set `atom: true` but forgot `isolating`.
* **Source:** [02 §2.2](./02-document-model.md), `prosemirror-model/src/schema.ts` NodeSpec.
* **Mitigation:** PM keeps them orthogonal, but the docstrings warn.
* **Redesign:** Collapse to a single enum: `kind: 'inline' | 'block' | 'leaf' | 'atom' | 'isolating-block'`.

### 1.4 `inclusive: false` marks bleed across boundaries

* **Manifests as:** Typing inside a link continues the link, but typing right
  after it also continues it because PM defaults inclusive at end.
* **Source:** [02 §4.4](./02-document-model.md), [08 §10](./08-selection.md).
* **Mitigation:** `MarkSpec.inclusive = false` and `tr.removeStoredMark`.
* **Redesign:** Make boundary inheritance per-side explicit in the spec.

### 1.5 Forgetting `parseDOM` makes a node un-pasteable

* **Manifests as:** Internal copy/paste works, external paste loses the node.
* **Source:** [11 §3 ParseRule](./11-dom-parser.md), [16 §3.3](./16-clipboard.md).
* **Mitigation:** PM's `ruleFromNode` walks back up the DOM looking for any
  matching tag rule; without one, the node is dropped.
* **Redesign:** Auto-derive a baseline `parseDOM` from `toDOM` for round-tripping.

### 1.6 `attrs` defaults must be deeply identity-stable

* **Manifests as:** Plugins re-running because `node.attrs` changes identity
  every render.
* **Source:** [02 §2.4](./02-document-model.md).
* **Mitigation:** PM freezes `attrs` and reuses the same reference where
  possible.
* **Redesign:** Make `attrs` immutable records with structural equality by
  default.

---

## 2. Position arithmetic pitfalls

### 2.1 `pos = 0` is not the same as `pos = 1`

* **Manifests as:** off-by-one when comparing "before doc start" (pos 0,
  invalid) and "inside first child at offset 0" (pos 1).
* **Source:** [04 §1.1](./04-resolved-positions.md), `prosemirror-model/src/resolvedpos.ts`.
* **Mitigation:** `Selection.atStart(doc)` instead of literal 0.
* **Redesign:** Use opaque position handles, not bare integers, in the public API.

### 2.2 `assoc` flips behaviour at deletion boundaries

* **Manifests as:** Cursor jumps to the wrong side after a delete, or stays
  inside a removed range and ends up in a "ghost" location.
* **Source:** [06 §3.3, §3.4](./06-position-mapping.md), `StepMap._map`.
* **Mitigation:** `Mapping.map(pos, assoc)` defaults to `assoc=1` (right);
  `assoc=-1` for "stick to left".
* **Redesign:** Two distinct types — `LeftPosition` and `RightPosition` — or
  always carry an explicit bias.

### 2.3 Position mapping inside a replaced range — bitmask semantics

* **Manifests as:** `mapResult.deleted` mis-interpreted as boolean when it's a
  bitmask.
* **Source:** [06 §2.4](./06-position-mapping.md), `prosemirror-transform/src/map.ts`.
* **Mitigation:** PM exposes `mapResult.deleted` as bool but also raw bits.
* **Redesign:** First-class enum `{Survived, MovedInsideDelete, Crossed}`.

### 2.4 `resolve` is not idempotent across docs

* **Manifests as:** A `ResolvedPos` from `oldDoc` used against `newDoc`
  silently misbehaves.
* **Source:** [04 §3](./04-resolved-positions.md).
* **Mitigation:** None — it's contract; PM uses `tr.mapping` to translate
  positions then `newDoc.resolve` to re-resolve.
* **Redesign:** Type-tag positions with their owning doc version.

### 2.5 `nodeBefore`/`nodeAfter` are null at boundaries

* **Manifests as:** Naive code calls `.type` on null.
* **Source:** [04 §3.5](./04-resolved-positions.md).
* **Mitigation:** Manual null guards; PM provides `parentOffset`, `index`.
* **Redesign:** Optional types should be exposed as discriminated unions, not bare nulls.

### 2.6 `sharedDepth` returns 0 for cross-document positions

* **Manifests as:** Authors think a return of 0 means "same parent" when it
  means "no shared parent".
* **Source:** [04 §3.8](./04-resolved-positions.md).
* **Mitigation:** Read the doc carefully.
* **Redesign:** Return `{depth, ancestor}` not bare integers.

---

## 3. Transform / Step pitfalls

### 3.1 `ReplaceAroundStep` gap rule violation

* **Manifests as:** Throws "invalid content for node X" on `apply`.
* **Source:** [05 §3.2](./05-transform-and-steps.md),
  `prosemirror-transform/src/replace_step.ts`.
* **Mitigation:** Use the high-level helpers (`split`, `wrap`, `lift`) that
  compute valid gap ranges. `findWrapping` to discover.
* **Redesign:** Replace the dual-step model with a more general "rewrite the
  range with a tree-template" primitive that statically rejects invalid gaps.

### 3.2 `Slice` open-depth mismatch

* **Manifests as:** Pasted content arrives flattened or with extra wrappers.
* **Source:** [02 §5.1, §5.3](./02-document-model.md), [11 §6.2](./11-dom-parser.md).
* **Mitigation:** `parseSlice` carefully tracks open sides; `fitSlice` finds
  a compatible insertion shape ([05 §5](./05-transform-and-steps.md)).
* **Redesign:** Make slice open-depth a *side effect* of the slice's first
  and last positions — derive, not declare.

### 3.3 `tr.replaceRangeWith` versus `tr.replaceWith` versus `tr.replace`

* **Manifests as:** Subtle differences: one finds wrappings, one doesn't.
* **Source:** `prosemirror-transform/src/replace.ts`,
  [05 §4.2](./05-transform-and-steps.md).
* **Mitigation:** Read which one walks `findWrapping`.
* **Redesign:** One name, options object.

### 3.4 `clearIncompatible` drops marks silently

* **Manifests as:** Pasted content loses its bold/italic without warning.
* **Source:** `prosemirror-transform/src/structure.ts` clearIncompatible,
  [05 §4.2](./05-transform-and-steps.md).
* **Mitigation:** Surface a `tr.replacementInfo` callback if you care.
* **Redesign:** Emit `IncompatibleMarkDropped` events and let the transaction
  aggregate them for UI surfacing.

### 3.5 Step ordering is not commutative

* **Manifests as:** Two steps that work individually fail when reordered.
* **Source:** [05 §2 StepResult](./05-transform-and-steps.md).
* **Mitigation:** Use `tr.steps` order or rely on `Mapping`.
* **2-step counterexample.**

  ```
  Doc (positions in [brackets]):
    [0]<p>[1]hello[6]</p>[7]
                                                      // doc length = 7

  Step S1: ReplaceStep(from=1, to=1, slice=" world ")  // insert at start
  Step S2: ReplaceStep(from=6, to=6, slice="!")        // insert at end

  Apply [S1, S2]:
    after S1 → <p> worldhello</p>      length 13
    S2.from=6 still refers to the old position 6 (which was end of "hello").
    To map: tr.mapping.map(6) = 12 (after the 6 inserted chars).
    But ReplaceStep(6,6,"!") does NOT auto-map; it operates on raw
    positions. Applying it to the post-S1 doc yields:
      <p> worl!dhello</p>   ← INSERT AT WRONG SPOT

  Apply [S2, S1]:
    after S2 → <p>hello!</p>            length 8
    S1.from=1, to=1 still valid (no shift before pos 1) → insert at 1
    yields: <p> worldhello!</p>         length 14   ← CORRECT-LOOKING

    But this is only correct because S1 is *before* S2's range.
    Reverse the example (S1 inserts at end, S2 at start) and the
    bug surfaces in the [S2, S1] order instead.
  ```

  The general rule: a raw `Step` only knows its pre-image positions;
  `Transform` re-maps automatically as you call `tr.replaceWith` etc.
  Reordering raw `Step`s without re-mapping breaks them. Two steps
  commute only if their ranges are disjoint AND neither shifts a
  position the other depends on. Mapping operationally serializes them.

* **Redesign:** Consider an "operational transform" model where steps carry
  the metadata needed to commute.

---

## 4. State / plugin pitfalls

### 4.1 `filterTransaction` recursion

* **Manifests as:** A plugin's `filterTransaction` calls `state.tr` to test,
  recurses, blows the stack.
* **Source:** [07 §5](./07-state-and-plugins.md).
* **Mitigation:** PM does not call `state.apply` from inside filter; authors
  must follow suit.
* **Redesign:** Make filter callbacks take a *frozen* state with no `tr` factory.

### 4.2 `appendTransaction` infinite loop

* **Manifests as:** Two plugins each react to the other's appended transaction
  forever.
* **Source:** [07 §5, §8](./07-state-and-plugins.md), `prosemirror-state/src/state.ts`.
* **Mitigation:** *None enforced*. Convention: check for a "marker" via
  `tr.getMeta(myKey)` and skip if present.
* **Redesign:** Either a hard fixed-point counter, or a topological order
  with cycle detection. **HIGH PRIORITY.**

### 4.3 Plugin order matters but is implicit

* **Manifests as:** Two plugins that both define keymaps for `Enter` —
  whichever is first wins.
* **Source:** [19 §3.3](./19-commands-keymap-inputrules.md), [07 §6](./07-state-and-plugins.md).
* **Mitigation:** Document order; users must read source to know.
* **Why this is more subtle than "first wins".** Plugins have *two*
  orderings, and they can diverge:

  1. **Init order** is `state.plugins` declaration order. `EditorState.create`
     walks plugins front-to-back and calls `state.init(config, instance)` on
     each plugin's state field. If plugin B's init reads plugin A's state
     via `pluginA.getState(instance)`, it works only if A precedes B.
  2. **Apply order** is also declaration order (front-to-back). On every
     transaction, each plugin field's `apply(tr, value, oldState, newState)`
     runs in declaration order. The `newState` argument is a *partially-built*
     state in which fields earlier in the plugin list have already been
     updated, but later fields still hold their old values.

  These orderings normally coincide. The divergence happens when plugin
  B's `apply` *also* reads plugin A's state (now correctly the new value)
  but plugin B's *init* runs before A — possible only if plugins were
  reconfigured in a different order between sessions.

  Concrete trap: a "selection-history" plugin that records the previous
  selection on every `apply`. If a "decoration-of-selection" plugin
  declared *after* it reads the selection-history's *new* value, that
  works. If declared *before*, it reads the *old* value — a one-step lag.
  Because both are valid plugin patterns, neither error is caught.

* **Redesign:** Explicit priority on `PluginSpec`; document it; reject ties.
  Topological sort by declared dependency on other `PluginKey`s.

### 4.4 `PluginKey` collisions

* **Manifests as:** Two plugins with the same key — one's state replaces the
  other.
* **Source:** [07 §7](./07-state-and-plugins.md).
* **Mitigation:** PM auto-generates suffixes; authors should use unique
  string names.
* **Redesign:** Keys as branded types, compile-time checked.

### 4.5 `EditorState.create` order of `init`

* **Manifests as:** A plugin field reads another plugin's state at init time
  and gets undefined.
* **Source:** [07 §3 create](./07-state-and-plugins.md).
* **Mitigation:** Plugins are init'd in declaration order; document
  dependencies.
* **Redesign:** Topologically sort by declared deps.

### 4.6 `transaction.setMeta` is opaque and untyped

* **Manifests as:** Authors can't tell what metas a transaction carries.
* **Source:** [07 §4](./07-state-and-plugins.md).
* **Mitigation:** Convention via `PluginKey`.
* **Redesign:** Typed meta channels per plugin.

### 4.7 `state.apply` allocates new instances even for no-op

* **Manifests as:** Reference equality of `state` changes after a transaction
  with no steps and no field changes.
* **Source:** `prosemirror-state/src/state.ts:apply`,
  [07 §5](./07-state-and-plugins.md).
* **Mitigation:** Always compare by `state.doc === oldState.doc` etc., not
  `state === oldState`.
* **Redesign:** Short-circuit no-op transactions to return the same instance.

---

## 5. View / reconciliation pitfalls

### 5.1 NodeView contentDOM contract is fragile

* **Manifests as:** Custom NodeView changes its layout, contentDOM gets
  detached, PM panics or quietly stops syncing children.
* **Source:** [09 §4](./09-view-and-viewdesc.md), `prosemirror-view/src/viewdesc.ts:31-91`.
* **Mitigation:** `update()` must keep the same `contentDOM` element;
  `destroy()` to recreate.
* **Redesign:** Make the contract enforced at runtime; fail loudly if
  `contentDOM` moves.

### 5.2 `ignoreMutation` traps

* **Manifests as:** Returning `true` from `ignoreMutation` for a mutation that
  was *not* PM-caused — the doc and DOM diverge silently.
* **Source:** [15 §8](./15-domobserver-and-domchange.md).
* **Mitigation:** Author hygiene; only ignore mutations on *your* DOM
  outside `contentDOM`.
* **Redesign:** Provide a default `ignoreMutation` based on DOM ownership tags.

### 5.3 Reconciliation stops at NodeView boundaries

* **Manifests as:** A change that crosses into a custom NodeView triggers a
  full re-render of that view, surprising authors who expected granular
  diffing.
* **Source:** [09 §3.1, §4](./09-view-and-viewdesc.md).
* **Mitigation:** Implement `update()` carefully.
* **Redesign:** Provide a default `update()` that diffs attrs and content
  separately.

### 5.4 `view.dom` swap during update

* **Manifests as:** External code holds a ref to `view.dom` from before a
  reconfigure; ref still points but is detached.
* **Source:** [09 §1.4 setProps](./09-view-and-viewdesc.md).
* **Mitigation:** Re-read `view.dom` after any `setProps`/`updateState` that
  could change it.
* **React/Vue/Svelte lifecycle interactions.** Frameworks own DOM lifecycles
  on their schedule, which collides with PM's ownership of `view.dom`:

  * **React StrictMode double-mount.** In development, React intentionally
    mounts → unmounts → re-mounts components to catch effect leaks. If your
    PM wrapper component creates `new EditorView` in `useEffect` without
    a destroy in the cleanup, you end up with two `EditorView`s pointing
    at the same DOM after the second mount. The first one's `DOMObserver`
    is still alive and races with the second on every keystroke.
    Fix: always return a cleanup that calls `view.destroy()` and null
    out the ref. Verify by setting StrictMode and watching for duplicate
    selectionchange listeners.

  * **React 18 concurrent rendering.** A render that's interrupted (Suspense,
    transitions) may have created a `view.dom` that never gets attached.
    PM doesn't know it's orphaned and will leak it. Solution: gate
    `EditorView` construction on `useLayoutEffect` (synchronous) so it
    can never be interrupted, or use a `useRef` + `useEffect` pattern
    that ties view lifetime to a stable container ref.

  * **Vue 3 keep-alive / Svelte component caching.** When a parent keeps
    a component "alive" but unmounts its DOM (route transition), PM's
    `view.dom` is detached but `view.destroy` was not called. On
    re-activation, PM tries to reconcile against detached DOM nodes and
    `getBoundingClientRect` returns zeros, which cascades into wrong
    `coordsAtPos` results. Fix: hook `onDeactivated`/`onActivated` and
    either destroy/recreate the view or `view.dom.replaceWith(currentDom)`.

  * **HMR (hot module replacement).** Reloading the schema or a plugin via
    HMR replaces the module but leaves the existing `EditorView` running
    against old plugin instances. Symptoms: keymap commands stop working
    or use the old version. Fix: register an HMR `dispose` handler that
    destroys the view and reconstructs it.

* **Redesign:** Stable outer container; `view.dom` is a child. See
  [22 §20 Destroy/recreate](#20-destroying--recreating-a-view-spa-route-changes).

### 5.5 Reuse keys mistake — same node, same dom, different mark stack

* **Manifests as:** A bold span replaced by a non-bold span at same position
  reuses the wrong DOM.
* **Source:** [09 §3.2, §3.5](./09-view-and-viewdesc.md).
* **Mitigation:** `syncToMarks` rebuilds the wrapper chain.
* **Redesign:** Keys are `(type, attrs hash, marks hash)`.

### 5.6 `requestAnimationFrame`-driven reads can race

* **Manifests as:** A plugin view reads coords at rAF time but the DOM was
  just patched in the same frame.
* **Source:** [09 §1.5](./09-view-and-viewdesc.md), implicit.
* **Mitigation:** Read after `view.updateState` returns synchronously.
* **Redesign:** Force layout-read API — `view.measure((dom) => {...})`.

---

## 6. Decoration pitfalls

### 6.1 Widget side ordering

* **Manifests as:** Two widgets at the same position render in inconsistent
  order between renders.
* **Source:** [10 §1.1, §7](./10-decorations.md), `decoration.ts`.
* **Mitigation:** `spec.side` (default 0) breaks ties.
* **Redesign:** Stable secondary key (insertion order or explicit `priority`).

### 6.2 Inline decoration crossing block boundaries

* **Manifests as:** `Decoration.inline(from, to, ...)` where `from`/`to` span
  paragraphs — silently splits per-block.
* **Source:** [10 §1.2](./10-decorations.md).
* **Mitigation:** PM splits inline decorations per textblock automatically.
* **Redesign:** Reject up-front; force authors to declare per-textblock.

### 6.3 Mutating decoration spec post-creation

* **Manifests as:** Decoration's `spec` mutated later — `eq` returns true
  with stale data, no re-render.
* **Source:** [10 §2.8](./10-decorations.md).
* **Mitigation:** Treat specs as immutable.
* **Redesign:** Freeze specs in `Decoration.widget`/etc.

### 6.4 Forgetting to `.map(tr.mapping, doc)` in plugin field

* **Manifests as:** Decorations stuck at old positions after edits.
* **Source:** [10 §5](./10-decorations.md), [I11](./21-rendering-pipeline-end-to-end.md).
* **Mitigation:** Plugin convention.
* **Concrete corruption example.** A spell-check plugin keeps inline
  decorations at error positions. The naive plugin `apply`:

  ```ts
  apply(tr, set: DecorationSet) {
    // BUG: not mapping
    return set
  }
  ```

  Initial doc: `<p>helo world</p>`, decoration at (1, 5) underlining "helo".

  User selects "helo" and replaces with "HELLO" (length 5 → 5). Doc
  becomes `<p>HELLO world</p>`. The decoration is still at (1, 5),
  which now points at "HELLO" — coincidentally still correct.

  Now user types "X" at position 1: doc becomes `<p>XHELLO world</p>`,
  length now 13. The decoration is still at (1, 5) but the underlined
  range is now "XHELL" — *wrong word, wrong boundaries*.

  The corruption escalates: user deletes paragraph and types a new
  one. Doc becomes `<p>fresh</p>`, length 7. The decoration at (1, 5)
  points into a position past the doc end. PM's `DecorationSet.add`
  silently clamps; the decoration "lands" inside the new word it never
  applied to. Worse, `DecorationSet.find` still reports the underline
  exists, so any plugin that reads "is there an error here" gets a
  false positive.

  Fix:

  ```ts
  apply(tr, set: DecorationSet) {
    return set.map(tr.mapping, tr.doc)  // remaps positions; drops
                                        // decorations whose range
                                        // was entirely deleted
  }
  ```

  `DecorationSet.map` walks the set, applies `tr.mapping.map(pos)` to
  each decoration's from/to, and drops decorations whose mapping
  collapsed (start == end and not a widget). This is the canonical
  pattern; PM's lack of an automatic mechanism is the war story.

* **Redesign:** First-class `decorations: DecorationField` that auto-maps.

### 6.5 Widget DOM with focusable/editable contents

* **Manifests as:** Selection unexpectedly enters the widget; PM can't reason
  about it.
* **Source:** [10 §4.3, §7](./10-decorations.md), [15 §9](./15-domobserver-and-domchange.md).
* **Mitigation:** Widgets should set `contenteditable="false"` and avoid
  focusable children (or be NodeViews instead).
* **Redesign:** Disallow focusable widgets; require NodeView for interactive content.

---

## 7. Parser pitfalls

### 7.1 Whitespace modes — `preserveWhitespace`

* **Manifests as:** Pasted code loses indentation, or pasted prose gains
  newlines.
* **Source:** [11 §6.3 ParseOptions](./11-dom-parser.md), `from_dom.ts`.
* **Mitigation:** `preserveWhitespace: 'full' | true | false` per-rule.
* **Redesign:** Explicit per-node-type whitespace policy.

### 7.2 Ambiguous tag rules

* **Manifests as:** Two rules match `<span>`; first wins, unintuitively.
* **Source:** [11 §4.1](./11-dom-parser.md).
* **Mitigation:** Use `priority` field on `ParseRule`.
* **Redesign:** Reject ambiguous rules at compile time.

### 7.3 Browser-injected DOM (`<br>` for empty paragraphs, `<font>` from old
Word)

* **Manifests as:** Extra empty paragraphs, unwanted font tags.
* **Source:** [11 §7](./11-dom-parser.md), [18 §3.1](./18-cross-browser-quirks.md).
* **Mitigation:** PM's `<br>` rule, `<meta>` strip, Office wrapper detection.
* **Redesign:** Pluggable input sanitizer pipeline before parse.

### 7.4 Style rules require explicit `getAttrs` returning attrs

* **Manifests as:** Author writes `style: "font-weight=bold"` rule, doesn't
  return attrs, mark dropped silently.
* **Source:** [11 §4.2](./11-dom-parser.md).
* **Mitigation:** Read the docs.
* **Redesign:** Type the rule shape so the compiler enforces.

### 7.5 Context constraint surprises

* **Manifests as:** Rule with `context: "blockquote/"` doesn't match because
  parse stack uses a synthetic root.
* **Source:** [11 §4.3](./11-dom-parser.md).
* **Mitigation:** Test with explicit context strings.
* **Redesign:** Drop context strings; use predicate functions.

### 7.6 `getAttrs` returning `false` vs returning `null`

* **Manifests as:** Returning `null` is treated as "no attrs"; returning
  `false` is treated as "rule does not match"; subtle difference.
* **Source:** [11 §3](./11-dom-parser.md).
* **Mitigation:** Doc.
* **Redesign:** Use explicit `{match: false}` / `{match: true, attrs: ...}`.

---

## 8. Serializer pitfalls

### 8.1 Leaf with hole (`0` placeholder) — must be exactly one

* **Manifests as:** A custom toDOM with two `0`s throws at runtime.
* **Source:** [12 §5, §8](./12-dom-serializer.md), `to_dom.ts:115-128`.
* **Mitigation:** PM's `renderSpec` validates.
* **Redesign:** Type-level constraint via discriminated DOMOutputSpec union.

### 8.2 Serializing a leaf with content silently drops it

* **Manifests as:** Author defines `code_block` as `[node, 0]` but spec is
  declared a leaf — children disappear.
* **Source:** [12 §8](./12-dom-serializer.md).
* **Mitigation:** None — it's the contract.
* **Redesign:** Reject at `Schema.compile`.

### 8.3 Mark order in serializeNode

* **Manifests as:** Output HTML has marks in unpredictable order.
* **Source:** [12 §4](./12-dom-serializer.md).
* **Mitigation:** PM uses `Mark.addToSet` order.
* **Redesign:** Stable, schema-declared order.

### 8.4 `renderSpec` XSS guard rejects `data:` and `javascript:` href

* **Manifests as:** Author creates a `data:image/png;...` href, PM's
  suspicious-attribute heuristic strips it.
* **Source:** [12 §6](./12-dom-serializer.md), `to_dom.ts:164-191, 204-206`.
* **Mitigation:** Pass through a `DOMSerializer` subclass override.
* **Redesign:** Explicit allowlist instead of heuristic blocklist.

### 8.5 SSR — no `document` available

* **Manifests as:** `serializeFragment` throws on Node.
* **Source:** [12 §7](./12-dom-serializer.md).
* **Mitigation:** Pass `{document}` from `jsdom`.
* **Redesign:** Default DOM facade adapter.

---

## 9. Input pitfalls

### 9.1 Read-only event leaks

* **Manifests as:** Read-only editor still receives keystrokes that fall
  through to plugin handlers.
* **Source:** [13 §1.3, §11](./13-input-pipeline.md).
* **Mitigation:** PM's dispatch wrapper has an `editable` gate, but custom
  events bypass it.
* **Redesign:** Centralized editable gate at the props layer.

### 9.2 Focus / blur ordering

* **Manifests as:** Click on a toolbar button blurs the editor before the
  command runs; selection lost.
* **Source:** [13 §8](./13-input-pipeline.md).
* **Mitigation:** Toolbar must `mousedown.preventDefault` to keep focus.
* **Redesign:** Capture-phase "focus shield" pattern documented and provided.

### 9.3 Touch tap-vs-drag disambiguation

* **Manifests as:** Long press on iOS triggers selection that PM didn't
  expect; tap on a leaf doesn't select.
* **Source:** [13 §7](./13-input-pipeline.md), [18 §2.2](./18-cross-browser-quirks.md).
* **Mitigation:** PM uses `Touch.identifier` and time-based heuristics.
* **Redesign:** Use Pointer Events; unify mouse/touch/pen.

### 9.4 Synthetic / programmatic events bypass `eventBelongsToView`

* **Manifests as:** A test fires `dispatchEvent` and PM rejects it because
  `composedPath` doesn't include `view.dom`.
* **Source:** [13 §1.5 dispatchEvent](./13-input-pipeline.md).
* **Mitigation:** Fire events on `view.dom` itself.
* **Redesign:** Public `view.simulateInput` API.

### 9.5 keypress is deprecated, beforeinput is partial

* **Manifests as:** PM still uses keypress as a fallback for charCode-based
  insertion (legacy code).
* **Source:** [13 §3.5, §3.6](./13-input-pipeline.md).
* **Mitigation:** Working today, brittle long term.
* **Redesign:** Adopt `beforeinput` as primary; treat `keypress` as
  deprecated.

---

## 10. IME / composition pitfalls

### 10.1 Android Chrome compositionend not firing

* **Manifests as:** Composition appears stuck; subsequent edits go nowhere.
* **Source:** [14 §3c, §7a, §8](./14-ime-composition.md), [18 §2.1](./18-cross-browser-quirks.md).
* **Mitigation:** Timer-based `endComposition` heuristic and
  MutationObserver-driven flush.
* **Redesign:** Explicit text-input adapter that *we* own end-of-composition,
  not the browser.

### 10.2 Premature compositionend on selection change

* **Manifests as:** Clicking elsewhere during composition kills the IME mid-character.
* **Source:** [14 §10](./14-ime-composition.md).
* **Mitigation:** PM listens for selectionchange during composing and ignores
  unless triggered by user.
* **Redesign:** Always finalize composition on selection change to the *PM
  state*, not the DOM selection.

### 10.3 Mark inheritance during composition

* **Manifests as:** Bolding inside an IME run yields mixed-mark output.
* **Source:** [14 §9](./14-ime-composition.md), [08 §10](./08-selection.md).
* **Mitigation:** `storedMarks` applied at flush.
* **Code-level repro.**

  ```ts
  // Setup: caret at end of <p>hello|</p>
  // User toggles bold via toolbar button → state.tr.setStoredMarks([bold])
  toolbarButton.onmousedown = (e) => {
    e.preventDefault()  // keep focus
    view.dispatch(view.state.tr.setStoredMarks([
      view.state.schema.marks.strong.create()
    ]))
  }

  // User starts an IME composition, types ぁ → ah → "ah" candidate
  //   t1: compositionstart fires; view.input.composing = true
  //       PM does NOT consume storedMarks yet (no insert happened).
  //   t2: compositionupdate × N — DOM mutates with composing text;
  //       PM ignores at the state level.
  //   t3: compositionend fires; view.input.composing = false.
  //       forceFlush → readDOMChange diffs old vs new fragment →
  //       tr = state.tr.replaceWith(from, to, schema.text("ah"))
  //       Note: tr.replaceWith does NOT honor storedMarks.
  //       (storedMarks would have been consumed by tr.insertText,
  //       which IS the path PM takes for typing — but composition
  //       goes through replaceWith based on the diff result.)

  // Result: "ah" is inserted WITHOUT bold. The user's intent was
  // "bold the IME-composed text" but storedMarks fire-and-forget
  // semantics meant they were consumed by some intervening event
  // (selection change, or simply because storedMarks reset on most
  // transactions per 08 §10).

  // Workaround at the user level:
  function insertComposedText(view: EditorView, text: string,
                              from: number, to: number) {
    let { storedMarks } = view.state
    let tr = view.state.tr.replaceRangeWith(
      from, to,
      view.state.schema.text(text, storedMarks ?? undefined)
    )
    view.dispatch(tr)
  }
  ```

  The deeper bug: the composition-flush path in
  [15 §5g](./15-domobserver-and-domchange.md) calls `tr.replace` for
  composition ends with multi-character changes, which constructs a
  `Slice` directly and bypasses `storedMarks`. Single-character
  composition ends *do* go through `tr.insertText` and inherit marks.
  This means "bold then type one IME character" works; "bold then type
  three IME characters" doesn't.
* **Redesign:** Compose mark intent + text intent independently, merged at
  commit. Treat composing text as a first-class transaction in the queue,
  not a diff result, so the path through `tr.insertText` is preserved.

### 10.4 Safari composition end with no text change

* **Manifests as:** A "phantom" compositionend that fires without compositionstart.
* **Source:** [14 §7c](./14-ime-composition.md), [18 §2.3](./18-cross-browser-quirks.md).
* **Mitigation:** PM checks `composing` flag; ignores stray end.
* **Redesign:** State-machine that requires start before end.

### 10.5 Composition view desc shielding

* **Manifests as:** A custom NodeView that contains composing text gets its
  contentDOM "frozen" but author didn't expect it.
* **Source:** [14 §4, §5](./14-ime-composition.md).
* **Mitigation:** Document; provide `view.composing` flag for NodeView authors.
* **Redesign:** Composition is a first-class state that NodeView authors must
  acknowledge.

---

## 11. DOMObserver pitfalls

### 11.1 Feedback loops

* **Manifests as:** PM writes to DOM, MutationObserver fires, PM reads,
  diffs, re-writes — infinite loop.
* **Source:** [15 §3 flush, §7](./15-domobserver-and-domchange.md).
* **Mitigation:** `withFlushedSelection` boundary; `observer.disconnect()`
  during `docView.update`; `view.input.lastWrite` time gate.
* **Redesign:** Single mutation-source token: every PM write tagged so the
  observer can ignore at the record level, not the write level.

### 11.2 `ignoreMutation` misuse

* **Manifests as:** A NodeView returns `true` always — DOM and doc diverge.
* **Source:** [15 §8](./15-domobserver-and-domchange.md).
* **Mitigation:** Doc; convention.
* **Redesign:** Default to `false`; require explicit ranges to ignore.

### 11.3 Pending records on tab-switch

* **Manifests as:** Switching tabs mid-edit leaves records that fire late
  and apply against a stale state.
* **Source:** [15 §2 pendingRecords](./15-domobserver-and-domchange.md).
* **Mitigation:** `flushSoon` debouncing + `forceFlush` at next event.
* **Redesign:** Block events outside the active tab; flush on visibility change.

### 11.4 ChildList vs CharacterData ambiguity

* **Manifests as:** A single typed character lands as a childList mutation
  (text node split) instead of characterData; PM's diff has to handle both.
* **Source:** [15 §4](./15-domobserver-and-domchange.md).
* **Mitigation:** Unified `parseBetween` re-parse step.
* **Redesign:** Always re-parse the dirty range, never trust mutation
  granularity.

### 11.5 `addedNodes` containing PM-injected DOM

* **Manifests as:** Decoration widgets show up in `addedNodes`; PM has to
  whitelist them.
* **Source:** [15 §4 childList](./15-domobserver-and-domchange.md).
* **Mitigation:** PM tracks ownership via NodeView/widget references.
* **Redesign:** Tag every PM-owned DOM with a sentinel attribute.

---

## 12. Clipboard pitfalls

### 12.1 `data-pm-slice` tampering

* **Manifests as:** A user pastes from a malicious app that inserts a
  hand-crafted `data-pm-slice` to coerce open-depth, breaking the schema.
* **Source:** [16 §3.3, §6](./16-clipboard.md).
* **Mitigation:** PM validates the slice through the schema after parse.
* **Redesign:** HMAC the slice marker, or never trust external `data-pm-slice`.

### 12.2 Trusted Types

* **Manifests as:** CSP environments reject PM's clipboard `innerHTML` writes.
* **Source:** [18 §3.7](./18-cross-browser-quirks.md), `prosemirror-view/src/clipboard.ts`.
* **Mitigation:** PM provides a pluggable Trusted Types policy.
* **Redesign:** Use only `DocumentFragment`-based parsing, never `innerHTML`.

### 12.3 Plain-mode detection

* **Manifests as:** Pasting plain text into a code block re-parses as HTML
  if the user's clipboard had both formats.
* **Source:** [16 §3.3, §8.3](./16-clipboard.md).
* **Mitigation:** PM checks `view.input.shiftKey` (forces plain) and
  `$cursor.parent.type.spec.code`.
* **Redesign:** Explicit "plain text mode" toggle on the editor; deterministic.

### 12.4 Office / Google Docs paste containing `<!--StartFragment-->`

* **Manifests as:** PM's `readHTML` must strip Office sentinels.
* **Source:** [16 §3.3](./16-clipboard.md), [18 §3.8](./18-cross-browser-quirks.md).
* **Mitigation:** Regex strip plus body reconstruction.
* **Redesign:** Pluggable pre-parse sanitizer keyed by source app.

### 12.5 Drag-internal vs external

* **Manifests as:** Dragging within the editor should preserve the slice;
  dragging from another app should sanitize.
* **Source:** [16 §6](./16-clipboard.md), [13 §10](./13-input-pipeline.md).
* **Mitigation:** PM compares `dragging.slice` reference equality.
* **Redesign:** Use a UUID token in the dataTransfer.

### 12.6 Files in clipboard (images, PDFs)

* **Manifests as:** Default paste does nothing for files; authors must hook
  `handlePaste`.
* **Source:** [16 §5](./16-clipboard.md).
* **Mitigation:** PM exposes the raw event.
* **Redesign:** First-class file paste API with progress callbacks.

---

## 13. Coordinates pitfalls

### 13.1 BR-as-last-child

* **Manifests as:** `caretRangeFromPoint` returns the parent block when click
  lands on a trailing `<br>`.
* **Source:** [17 §3.9](./17-coordinates-and-hit-testing.md), [18 §3.1](./18-cross-browser-quirks.md).
* **Mitigation:** PM's BR-avoidance fallback (`posFromCaret`).
* **Redesign:** Render trailing BR as a positioned widget with a known offset.

### 13.2 Firefox whitespace caret normalisation

* **Manifests as:** Click in trailing whitespace lands one char too far left.
* **Source:** [17 §3.6](./17-coordinates-and-hit-testing.md), [18 §2.5](./18-cross-browser-quirks.md).
* **Mitigation:** Custom DOMRect probe.
* **Redesign:** Don't trust `caretPositionFromPoint` on Firefox; always
  fallback walk.

### 13.3 RTL bidi ranges

* **Manifests as:** `coordsAtPos` returns the visually leftmost rect even when
  the cursor is logically at the rightmost in RTL text.
* **Source:** [17 §2.2](./17-coordinates-and-hit-testing.md).
* **Mitigation:** PM picks the "side"-correct rect via `side` parameter and
  `Range.getClientRects()` order.
* **Redesign:** Return `{logical, visual}` rects, not a single one.

### 13.4 `endOfTextblock` cache invalidation

* **Manifests as:** After a layout change, arrow-key behaviour is wrong
  because the cached `endOfTextblock` result is stale.
* **Source:** [17 §4.1](./17-coordinates-and-hit-testing.md).
* **Mitigation:** PM invalidates cache on `view.updateState`.
* **Redesign:** Tie the cache to `ResizeObserver`.

### 13.5 Safari `draggable` kludge re-routes clicks

* **Manifests as:** Click on a draggable region lands on the wrapper, not
  the inner DOM.
* **Source:** [17 §3.4](./17-coordinates-and-hit-testing.md), [18 §3.2](./18-cross-browser-quirks.md).
* **Mitigation:** PM's `targetKludge`.
* **Redesign:** Don't use `draggable=true` on contentEditable=false wrappers;
  use Pointer Events drag.

### 13.6 WebKit "uneditable after click" bug

* **Manifests as:** After clicking a `contenteditable=false` sibling, the
  editor "loses" caret on next keystroke.
* **Source:** [17 §3.7](./17-coordinates-and-hit-testing.md), [18 §2.3, §2.9](./18-cross-browser-quirks.md).
* **Mitigation:** PM force-blurs and re-focuses.
* **Redesign:** Pinned focus invariant — the editor always owns focus until
  blur is explicit.

---

## 14. Cross-browser pitfalls (consolidated)

See the full inventory in [18-cross-browser-quirks.md](./18-cross-browser-quirks.md).
A short summary keyed by browser:

| Browser            | Worst quirks                                                                  | Cite                                                          |
|--------------------|--------------------------------------------------------------------------------|---------------------------------------------------------------|
| Android Chrome     | composition: no compositionend, beforeinput backspace, IME re-enters on write  | [18 §2.1](./18-cross-browser-quirks.md), [14 §7a](./14-ime-composition.md) |
| iOS Safari         | autocorrect during compositionupdate, draggable kludge, keyup mismatches       | [18 §2.2](./18-cross-browser-quirks.md), [17 §3.4](./17-coordinates-and-hit-testing.md) |
| macOS Safari       | dead key composition, "uneditable after click", Range.getClientRects empty     | [18 §2.3](./18-cross-browser-quirks.md), [17 §3.7](./17-coordinates-and-hit-testing.md) |
| Chrome desktop     | beforeinput inputType drift, autocorrect popups during edit                    | [18 §2.4](./18-cross-browser-quirks.md)                       |
| Firefox            | whitespace caret normalisation, requiresGeckoHackNode, dragstart focus loss    | [18 §2.5, §3.6](./18-cross-browser-quirks.md)                 |
| IE / legacy Edge   | clipboard wrapper trick, Trident-specific keymap normalization                 | [18 §2.6](./18-cross-browser-quirks.md), [16 §2.4](./16-clipboard.md)         |

The structural workarounds — hack `<br>`/`<img>` separators, `contenteditable=false`
placeholders, zero-width sentinels, pre-emptive blur/focus, suppression
windows — are all listed in [18 §3](./18-cross-browser-quirks.md).

---

## 15. Commands / keymap / inputrules pitfalls

### 15.1 `Mod-` platform variance

* **Manifests as:** `Mod-z` works on Mac (Cmd) but on Windows (Ctrl) — PM
  normalizes, but forgetting to use `Mod-` and writing `Cmd-z` literally
  fails on non-Mac.
* **Source:** [19 §3.1](./19-commands-keymap-inputrules.md), `prosemirror-keymap/src/keymap.ts:8-26`.
* **Mitigation:** Always use `Mod-`.
* **Redesign:** Reject literal `Cmd-`/`Ctrl-` at compile time.

### 15.2 `Shift-` retry semantics

* **Manifests as:** A binding for `Enter` doesn't fire on `Shift-Enter`
  because PM tries `Shift-Enter` first, then `Enter`. Authors writing both
  bindings clobber each other.
* **Source:** [19 §3.2](./19-commands-keymap-inputrules.md), `keymap.ts:83-109`.
* **Mitigation:** PM's documented retry order.
* **Redesign:** Explicit `fallthrough` in binding spec; no implicit retry.

### 15.3 First-plugin-wins in keymap precedence

* **Manifests as:** Two plugins binding `Tab` — earlier one wins regardless
  of return value, *unless* it returns `false`.
* **Source:** [19 §3.3](./19-commands-keymap-inputrules.md).
* **Mitigation:** Return `false` from a command that "doesn't apply here".
* **Redesign:** Explicit priority field.

### 15.4 Input rules and undo

* **Manifests as:** Markdown shortcut `*foo*` becomes italic; user undoes,
  expects `*foo*` text — PM's `undoInputRule` runs only if the cursor is at
  the right position.
* **Source:** [19 §4.4, §4.7](./19-commands-keymap-inputrules.md).
* **Mitigation:** PM tracks the input-rule transaction with a meta marker.
* **Redesign:** Treat input rules as reversible transformations with an
  explicit history slot.

### 15.5 Input rule scan window

* **Manifests as:** A rule that needs to match more than ~500 chars before
  cursor never fires.
* **Source:** [19 §4.3](./19-commands-keymap-inputrules.md).
* **Mitigation:** PM uses a fixed lookback.
* **Redesign:** Per-rule lookback declaration.

### 15.6 Command dual-mode (dry-run vs apply)

* **Manifests as:** Author forgets to check `if (dispatch)` — calls
  `dispatch(...)` with undefined.
* **Source:** [19 §1.1](./19-commands-keymap-inputrules.md).
* **Mitigation:** Lint rule; doc.
* **Redesign:** Two distinct types — `CommandPredicate` and
  `CommandExecutor`.

### 15.7 `chainCommands` short-circuit on first success

* **Manifests as:** Chain returns true on the first command, masking that
  later ones might also apply.
* **Source:** [19 §1.2](./19-commands-keymap-inputrules.md), `commands.ts`.
* **Mitigation:** Doc; order matters.
* **Redesign:** First-match semantics is fine — but make ordering explicit.

---

## 16. History / collab pitfalls

### 16.1 Rebase invalidates inverted steps

* **Manifests as:** After a remote rebase, `undo` does the wrong thing
  because the inverted step was computed against the old doc.
* **Source:** [20 §1.8 Branch.rebased](./20-history-and-collab.md).
* **Mitigation:** `Branch.rebased` rewrites every affected item in the
  rope.
* **Redesign:** Compute inverted steps lazily *at undo time*, not at record
  time.

### 16.2 `addToHistory: false` misuse

* **Manifests as:** A "system" transaction (e.g. autosave marker) flagged
  `addToHistory: false` mixes with user transactions and the user's undo
  skips intermediate state.
* **Source:** [20 §1.11](./20-history-and-collab.md).
* **Mitigation:** Only use `addToHistory: false` for transactions that
  don't change `doc`.
* **Redesign:** Disallow `addToHistory: false` for transactions with steps.

### 16.3 Mirror map integrity

* **Manifests as:** A custom step with a non-mirrored map breaks rebase
  invariants; subsequent collab rebases diverge.
* **Source:** [06 §4.1, §4.2](./06-position-mapping.md), [20 §2.4](./20-history-and-collab.md).
* **Mitigation:** Always set mirror via `mapping.appendMappingInverted`.
* **Redesign:** Make `setMirror` automatic when `step.invert` is computed.

### 16.4 `historyPreserveItems` and pruning

* **Manifests as:** Long sessions blow out memory because compress doesn't
  collapse map-only items inside a "preserved" range.
* **Source:** [20 §1.12, §1.9](./20-history-and-collab.md).
* **Mitigation:** Trim preserved windows manually.
* **Redesign:** Use a sliding window, not a flag.

### 16.5 `closeHistoryKey` event boundary detection

* **Manifests as:** Two unrelated transactions get coalesced into one undo
  unit because PM's heuristic (time delta) merges them.
* **Source:** [20 §1.6](./20-history-and-collab.md).
* **Mitigation:** Set `historyKey` meta to force a boundary.
* **Redesign:** Explicit "begin/end batch" API; heuristics off by default.

### 16.6 Collab `sendableSteps` returning empty after race

* **Manifests as:** Local edit, network call in flight, second edit appended
  while first POST returns success; second edit's version mismatches.
* **Source:** [20 §2.3, §2.5](./20-history-and-collab.md).
* **Mitigation:** Pipeline: don't POST again until previous returns; rebase
  on receive.
* **Redesign:** Explicit promise pipeline with version reconciliation.

### 16.7 Authority dropping a step ID

* **Manifests as:** `clientID` mismatch causes silent loss of history
  attribution.
* **Source:** [20 §2.6 Authority responsibilities](./20-history-and-collab.md).
* **Mitigation:** Authority must echo client IDs back exactly.
* **Redesign:** Sign step batches; authority cannot rewrite client IDs.

---

## 17. "If we were redesigning…"

The 31 highest-leverage observations from this dossier, in priority order.

### Architecture & invariants
1. **Make appendTransaction loop bounded by topology, not by author hygiene.**
   Cycles must be detected and rejected.
   ([4.2](#42-appendtransaction-infinite-loop);
   `prosemirror-state/src/state.ts` `applyInner` loop — see
   [07 §5](./07-state-and-plugins.md))
2. **Single mutation-source token.** Every PM write tags its DOM mutations so
   the observer can ignore them at the record level.
   ([11.1](#111-feedback-loops);
   `prosemirror-view/src/domobserver.ts` `currentSelection` — see
   [15 §6](./15-domobserver-and-domchange.md), [15 §8 ignoreMutation](./15-domobserver-and-domchange.md))
3. **Composition as a first-class editor state**, not a flag on `view.input`.
   NodeView authors must opt-in to composition handling explicitly.
   ([10.5](#105-composition-view-desc-shielding);
   `prosemirror-view/src/input.ts` compositionstart/end handlers — see
   [14 §3](./14-ime-composition.md), [14 §5](./14-ime-composition.md))
4. **Boundaries are types.** `LeftPosition`/`RightPosition`, doc-versioned
   positions, branded `PluginKey`s, frozen attrs.
   ([2.2](#22-assoc-flips-behaviour-at-deletion-boundaries),
    [4.4](#44-pluginkey-collisions);
   `prosemirror-model/src/resolvedpos.ts` — see
   [04 §3](./04-resolved-positions.md), [07 §7](./07-state-and-plugins.md))

### Schema / model
5. **Replace content expressions with a tractable DSL** that auto-fills
   common patterns and rejects exponential DFAs.
   ([1.1](#11-content-expressions-are-nfas-not-regexes);
   `prosemirror-model/src/content.ts` `ContentMatch.parse` — see
   [03 §4](./03-schema-and-content-expressions.md))
6. **Single `kind` enum** for inline/block/leaf/atom/isolating.
   ([1.3](#13-atom-true-vs-leaf-vs-isolating-true--three-orthogonal-flags);
   `prosemirror-model/src/schema.ts` NodeSpec — see
   [02 §2.2](./02-document-model.md))
7. **Auto-derive parseDOM from toDOM** as a baseline. Authors can override.
   ([1.5](#15-forgetting-parsedom-makes-a-node-un-pasteable);
   `prosemirror-model/src/from_dom.ts`,
   `prosemirror-model/src/to_dom.ts` — see
   [11 §4](./11-dom-parser.md), [12 §3](./12-dom-serializer.md))
8. **Stable, schema-declared mark order.** Ban `addToSet` ordering surprises.
   ([1.2](#12-marks-order-matters-and-is-implicit), [8.3](#83-mark-order-in-serializenode);
   `prosemirror-model/src/mark.ts` `addToSet` — see
   [02 §4.2](./02-document-model.md))

### Transform
9. **Tree-template rewrite primitive** instead of dual `ReplaceStep` /
   `ReplaceAroundStep`. Statically rejects invalid gaps.
   ([3.1](#31-replacearoundstep-gap-rule-violation))
10. **Operational-transform-style steps** that carry enough metadata to
    commute, eliminating rebase loop costs.
    ([3.5](#35-step-ordering-is-not-commutative), [16.1](#161-rebase-invalidates-inverted-steps))
11. **Lazy invert.** Compute inverted steps at undo time, not record time.
    ([16.1](#161-rebase-invalidates-inverted-steps))

### State / plugins
12. **Topologically-sorted plugins** with declared dependencies, explicit
    priorities, and cycle detection.
    ([4.3](#43-plugin-order-matters-but-is-implicit), [4.5](#45-editorstatecreate-order-of-init))
13. **Typed meta channels per plugin** instead of `setMeta(key, value)` blob.
    ([4.6](#46-transactionsetmeta-is-opaque-and-untyped))
14. **First-class `decorations` field** that auto-maps through tr.mapping;
    plugins don't manually call `.map()`.
    ([6.4](#64-forgetting-to-maptrmapping-doc-in-plugin-field))
15. **Reference-equal no-op transactions** — `state.apply(noopTr) === state`.
    ([4.7](#47-stateapply-allocates-new-instances-even-for-no-op))

### View / reconciliation
16. **NodeView contract enforced at runtime.** Detached `contentDOM` fails
    loudly. Default `update()` provided.
    ([5.1](#51-nodeview-contentdom-contract-is-fragile),
     [5.3](#53-reconciliation-stops-at-nodeview-boundaries))
17. **Reuse keys = `(type, attrs hash, marks hash)`.** Eliminates the
    "right node, wrong wrapper" bug class.
    ([5.5](#55-reuse-keys-mistake--same-node-same-dom-different-mark-stack))
18. **PM-owned-DOM sentinel attribute** so the observer can ignore at the
    record level and NodeView authors don't need `ignoreMutation`.
    ([11.2](#112-ignoremutation-misuse), [11.5](#115-addednodes-containing-pm-injected-dom))

### Input / browser
19. **Pointer Events for everything**, no separate mouse/touch paths;
    deprecate keypress; rely on beforeinput.
    ([9.3](#93-touch-tap-vs-drag-disambiguation), [9.5](#95-keypress-is-deprecated-beforeinput-is-partial))
20. **Browser-quirk plugins**, not hardcoded `browser.*` checks scattered
    through the engine. Each quirk is testable in isolation.
    ([14](#14-cross-browser-pitfalls-consolidated))
21. **Centralized editable gate** at the props layer; no leaks of read-only
    events.
    ([9.1](#91-read-only-event-leaks))

### Clipboard / parser / serializer
22. **HMAC `data-pm-slice`** or never trust external paste markers; validate
    schema after parse always.
    ([12.1](#121-data-pm-slice-tampering))
23. **Explicit allowlist for serializer attributes**, not the suspicious-
    attribute heuristic.
    ([8.4](#84-renderspec-xss-guard-rejects-data-and-javascript-href))
24. **Pluggable input sanitizer pipeline** before the DOMParser, keyed by
    source app (Office, Google Docs, etc.).
    ([7.3](#73-browser-injected-dom-br-for-empty-paragraphs-font-from-old-word),
     [12.4](#124-office--google-docs-paste-containing-startfragment))

### History / collab / commands
25. **Explicit history batch API** (`begin/end`) instead of time-delta
    coalescing. Commands declare their own boundary.
    ([16.5](#165-closehistorykey-event-boundary-detection))

### Accessibility
26. **`role="textbox"` and ARIA by default**, not author-supplied. PM
    sets `contenteditable` but leaves accessible-name, role, aria-multiline,
    aria-readonly, and live-region announcement for collab presence to
    the consumer. Result: the median PM editor is not screen-reader-usable
    out of the box. Default ARIA, with hooks to override.
    See [23-accessibility.md](./23-accessibility.md).
27. **NodeView accessibility contract.** `nodeViews` should require an
    accessible-name function and keyboard-handler descriptors. Atom
    NodeViews without keyboard handling and proper `tabindex`/`role`
    are silently inaccessible; the API gives no feedback.
    See [23-accessibility.md §4 NodeView a11y](./23-accessibility.md).

### Internationalization & RTL
28. **First-class bidi.** PM's `dir` handling is left to the host;
    `unicode-bidi: plaintext` should be the default, with per-paragraph
    direction stored in the doc model. Selection movement, `coordsAtPos`,
    and clipboard round-trip must all be bidi-aware by construction,
    not by browser quirk patches.
    ([13.3](#133-rtl-bidi-ranges); see
    [28-i18n-bidi.md](./28-i18n-bidi.md).)

### Async commands & data
29. **Async commands with cancellation.** Commands today are sync
    `(state, dispatch) => boolean`. Real apps need "fetch a mention,
    insert it" — a placeholder/replace pattern is the only recourse.
    Bake async commands and their cancellation into the type so
    transactions composing async results have first-class semantics
    (mapping through history, collab, and undo).
    See [37-async-transactions.md](./37-async-transactions.md).

### Testing
30. **Built-in test harness with selection markers.** `prosemirror-test-builder`
    is the de facto standard but lives outside PM core, and has no
    integration test recipes. Bake `<a>`/`<b>` selection markers into a
    canonical `view.simulateInput`/`expectDoc` API, with jsdom and
    Playwright presets. See [27-testing.md](./27-testing.md).

### Plugin authoring & idioms
31. **Plugin cookbook in core.** Placeholders, mention-autocomplete,
    decoration-as-cache, async-fetch, cursor decorations, word-count —
    these are the patterns that every PM consumer reinvents. Ship them
    as opt-in core packages with a single coherent style guide so
    plugin ecosystems don't fragment. See
    [31-plugin-cookbook.md](./31-plugin-cookbook.md).

### Mobile-first
32. **Pointer events end-to-end with mobile defaults.** Tap-vs-drag
    disambiguation, virtual keyboard layout shifts (`visualViewport`),
    iOS magnifier hit-testing, Android predictive text, and
    long-press context menus are all retro-fits in PM today. A mobile-first
    redesign would build on Pointer Events from day one and treat the
    desktop case as the simplification, not the other way around.
    ([9.3](#93-touch-tap-vs-drag-disambiguation), [10.1](#101-android-chrome-compositionend-not-firing);
    see [25-mobile.md](./25-mobile.md).)

> The full takeaways list (priorities for our editor) appears in
> [01 §8](./01-architecture-overview.md) — these 31 supplement it with the
> war-story evidence.

---

## 19. Memory leaks

PM editors are often long-lived (a page-app session, hours of use). Three
classes of leak appear in production.

### 19.1 Plugin state retention via closures

* **Manifests as:** Memory grows monotonically over a session; heap snapshots
  show plugin state objects with retained refs to old `EditorState`s.
* **Source:** `prosemirror-state/src/plugin.ts`,
  [07 §6](./07-state-and-plugins.md).
* **Repro:**

  ```ts
  // BAD: plugin.spec.view captures `view` and a counter that holds
  // the previous state for diffing.
  let plugin = new Plugin({
    view(view) {
      let prevState: EditorState | null = null
      return {
        update(view, lastState) {
          // BAD: stores prevState across updates, holds onto big docs
          prevState = lastState
        },
        destroy() {
          // BAD: forgot to null prevState
        }
      }
    }
  })
  ```

  Each `EditorState` snapshot retains its `doc`, all plugin field values,
  and (transitively) every `Mark`/`Attrs` instance referenced. On a 10MB
  doc, holding one extra state means holding ~10MB extra.

* **Mitigation:** Plugin views must null out captured state in `destroy()`
  and avoid retaining `lastState` across `update` calls. Use shallow
  derived data instead.
* **Detection:** Heap snapshot, look for multiple `EditorState` instances
  with `next` chains.

### 19.2 Plugin views with un-removed event listeners or timers

* **Manifests as:** After `view.destroy()`, console errors fire on
  document/window events because old listeners are still registered.
* **Source:** plugin.spec.view contracts, [21 §K.5](./21-rendering-pipeline-end-to-end.md).
* **Mitigation:**

  ```ts
  view(view) {
    let onResize = () => { /* ... */ }
    window.addEventListener("resize", onResize)
    let timer = setInterval(() => { /* ... */ }, 1000)
    return {
      destroy() {
        window.removeEventListener("resize", onResize)
        clearInterval(timer)
      }
    }
  }
  ```

* **Detection:** In Chrome DevTools, `getEventListeners(window)` after
  `view.destroy()` should not show plugin-installed listeners.

### 19.3 DecorationSet accumulation in long-running sessions

* **Manifests as:** Memory grows steadily even with a stable doc size.
* **Source:** [10 §5](./10-decorations.md).
* **Cause:** A plugin that recomputes a *fresh* `DecorationSet` on every
  transaction, even when the underlying data hasn't changed, creates
  garbage at every keystroke. Old sets are reachable from the history
  rope until that history event is pruned.
* **Mitigation:** Memoize: return the same `DecorationSet` reference if
  the input data is unchanged. Use `DecorationSet.map(tr.mapping, doc)`
  and only call `.add()`/`.remove()` when content differs.

### 19.4 History rope retention

* **Manifests as:** Memory grows during long undo-able sessions.
* **Source:** [20 §1.4 newGroupDelay & pruning](./20-history-and-collab.md).
* **Cause:** `Branch` keeps inverted steps + bookmarks for every event,
  capped by `depth`. The cap defaults to 100 events; each event in a
  large doc retains a slice of the doc.
* **Mitigation:** Lower `depth` for memory-constrained pages; call
  `closeHistory(state)` to flush the current event and allow pruning.

### 19.5 `view.destroy()` checklist

When tearing down an editor, PM destroys: docView tree, ViewDescs and
their NodeViews, plugin views (calling each `destroy()`), DOMObserver,
input listeners, and the `view.dom` element ownership. PM does NOT
destroy: plugin state values, `view.state.doc`, history items, or any
references the host has captured. The host must:

1. Null out any refs to `view`, `view.state`, `view.dom`.
2. Cancel any in-flight async work tagged with this view.
3. Disconnect any `IntersectionObserver`/`ResizeObserver` watching
   `view.dom`.
4. Verify `view.dom.parentNode` is null after destroy.

See [33-memory.md](./33-memory.md) for the full memory-management deep dive.

---

## 20. Destroying & recreating a view (SPA route changes)

A common SPA pattern: route from `/doc/123` to `/doc/456` keeps the same
`<Editor>` component mounted but needs to swap the underlying document.

### 20.1 The naive approach (broken)

```tsx
function Editor({ docId }: { docId: string }) {
  let viewRef = useRef<EditorView | null>(null)
  let containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    fetchDoc(docId).then(doc => {
      // BAD: creates a NEW view on every docId change without
      // destroying the old one
      viewRef.current = new EditorView(containerRef.current!, {
        state: EditorState.create({ doc, plugins: [...] })
      })
    })
  }, [docId])

  return <div ref={containerRef} />
}
```

Symptoms: stacked `EditorView`s, duplicate selectionchange listeners,
duplicate DOM trees inside the container, IME confusion (multiple
DOMObservers fight over the same DOM).

### 20.2 The correct pattern

```tsx
function Editor({ docId }: { docId: string }) {
  let viewRef = useRef<EditorView | null>(null)
  let containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchDoc(docId).then(doc => {
      if (cancelled || !containerRef.current) return
      // Destroy any prior view first
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
      }
      viewRef.current = new EditorView(containerRef.current, {
        state: EditorState.create({ doc, plugins: [...] })
      })
    })
    return () => {
      cancelled = true
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
      }
    }
  }, [docId])

  return <div ref={containerRef} />
}
```

### 20.3 The "prefer setState over recreate" alternative

If schema and plugins are unchanged, prefer to swap the doc in-place:

```ts
viewRef.current.updateState(
  viewRef.current.state.reconfigure({ /* same plugins */ }).apply(
    /* a tr that replaces the doc */
    state.tr.replaceWith(0, state.doc.content.size, newDoc.content)
  )
)
```

This keeps the same `EditorView` (no DOM rebuild, no listener churn,
preserves focus state if appropriate). Pitfall: history is preserved
across the swap unless you pass a fresh state with empty history. In
collab apps, a doc swap should always destroy/recreate to reset
collab's `unconfirmed` queue.

### 20.4 Edge cases

* **Modal-close during typing.** If the route change happens mid-IME,
  call `view.dom.blur()` *before* `view.destroy()` to force composition
  end. Otherwise, on Android, the IME holds a stale reference to
  `view.dom` and the next focus crashes.
* **Plugin view cleanup ordering.** PM destroys plugin views in *reverse*
  declaration order; symmetric to construction.
* **Strict-mode double-destroy.** `destroy()` is idempotent in core PM,
  but custom plugin views often aren't. Make `destroy` safe to call twice.

---

## 21. Multiple editors per page

Common patterns: a comment thread with N editors, a spreadsheet with
per-cell editors, a side-by-side diff with two editors. Several traps.

### 21.1 Plugin key collisions across editors

* **Manifests as:** Plugin from editor A reads state via `myKey.getState`
  and gets editor B's state by mistake (in custom plumbing).
* **Source:** [07 §7](./07-state-and-plugins.md).
* **Cause:** `PluginKey` is intentionally shared across editor instances —
  the same key references the same plugin's *spec*, not the same
  state instance. Authors who pass `view` and key around can confuse
  which view's state they want.
* **Mitigation:** Always pass the `EditorState` with the `PluginKey`.
  Never store `myKey.getState(globalView.state)` in module scope.

### 21.2 Focus stealing

* **Manifests as:** Clicking inside editor A while typing in editor B
  silently transfers focus mid-keystroke; the keystroke lands in A
  but with B's stored marks / IME state.
* **Source:** [13 §8 focus](./13-input-pipeline.md).
* **Mitigation:** Each editor should track its own focus state via
  `view.hasFocus()` and reject transactions that arrive while
  unfocused (toolbar `mousedown.preventDefault` is critical when the
  toolbar serves multiple editors).

### 21.3 Paste race conditions

* **Manifests as:** User copies in editor A, switches to editor B (still
  via OS clipboard), pastes — but `application/x-prosemirror` payload
  was set by A's clipboard hook and contains schema-incompatible
  content.
* **Source:** [16 §3.3 data-pm-slice, §3.4 cross-editor](./16-clipboard.md).
* **Mitigation:** Each editor's clipboard reader should validate the
  schema namespace embedded in `data-pm-slice` and fall back to
  HTML parsing if schemas mismatch. PM does this validation as a
  best-effort.

### 21.4 Selection arbitration

* **Manifests as:** Both editors think they have selection because they
  both responded to a `selectionchange` event.
* **Source:** [13 §2 selection events](./13-input-pipeline.md).
* **Mitigation:** PM filters `selectionchange` to events whose
  `document.activeElement` matches the view's `dom`. Custom code that
  reads `window.getSelection()` directly must do the same check.

### 21.5 Resource accumulation

* **Manifests as:** A page with 50 editors uses 500MB.
* **Mitigation:** Each `EditorView` constructs a full ViewDesc tree, a
  DOMObserver, input handlers, and plugin views. Use lazy mounting
  (build the editor on focus, tear down on blur for unfocused
  cells). Or use a single `EditorView` and switch its document on
  cell focus.

---

## 22. Server-side rendering & hydration

PM is fundamentally a contenteditable host; it cannot run on the server.
But many SSR frameworks (Next.js, Nuxt, SvelteKit) need to render *something*
during SSR and then upgrade to interactive on the client.

### 22.1 The "render static HTML server-side, hydrate to PM client-side" pattern

```tsx
// Server: render a static, non-editable representation of the doc
function ServerView({ doc }: { doc: Node }) {
  let html = useMemo(() => {
    let serializer = DOMSerializer.fromSchema(doc.type.schema)
    let div = jsdom.document.createElement("div")
    div.appendChild(serializer.serializeFragment(doc.content))
    return div.innerHTML
  }, [doc])
  return <div dangerouslySetInnerHTML={{ __html: html }} />
}
```

The server uses `DOMSerializer` with a `jsdom`-provided `document`
([22 §8.5](#85-ssr--no-document-available)) to produce static markup.

### 22.2 Hydration mismatches

* **Manifests as:** React/Vue console warning "Hydration mismatch:
  server rendered X, client rendered Y" because PM injects sentinel
  attributes (`pm-padding`, `data-prosemirror-marker`) that the server
  did not.
* **Source:** [09 §1.5 view init](./09-view-and-viewdesc.md),
  [12 §3 serializer](./12-dom-serializer.md).
* **Mitigation:** The hydration boundary must be the wrapper *around*
  `view.dom`, not `view.dom` itself. Render an empty container on the
  server; on `useEffect`/`onMounted`, parse the server-rendered HTML
  via `DOMParser.fromSchema` and construct the `EditorView` with the
  parsed doc. Or render a non-editable preview server-side and replace
  the entire subtree on client mount.

### 22.3 The "no document available" hard failure

* **Manifests as:** Importing `prosemirror-view` in a server-only file
  throws on module load because PM accesses `document` at top-level
  (e.g., `document.documentElement` in `browser.ts`).
* **Mitigation:** Lazy-import `prosemirror-view` only inside client-only
  code paths. Use Next.js `dynamic({ ssr: false })`, Nuxt's
  `<ClientOnly>`, or SvelteKit's `browser` guard.

### 22.4 Schema availability on the server

`prosemirror-model` and `prosemirror-schema-basic` *are* SSR-safe (no
DOM access at top-level). `prosemirror-view`, `prosemirror-keymap`,
`prosemirror-inputrules`, and `prosemirror-history` are not. Author your
code so the schema and `Node`-level operations can run server-side
(serialize, validate JSON, derive a content summary), with
`prosemirror-view` strictly client-only.

### 22.5 Streaming SSR / Suspense

If your framework streams HTML chunks (React 18 Suspense), the editor
container appears in the stream before its hydration script runs. Make
sure the placeholder is non-interactive (`tabindex="-1"`) so users
who interact early don't see ghost behavior. Set the editor up in a
`useEffect` (post-paint) for predictability.

---

## 23. Virtualized containers (react-window, react-virtuoso, etc.)

Embedding PM inside a virtualized list (e.g., comment editors in an
infinite-scroll thread) creates problems specific to each virtualization
strategy.

### 23.1 Editor unmount during scroll

* **Manifests as:** User starts typing in an editor near the viewport
  edge, scrolls slightly, virtualizer unmounts the editor's container,
  the user's keystrokes vanish.
* **Source:** virtualization decisions live in the host, not PM.
* **Mitigation:** Keep editors that are *focused* in the active set
  regardless of viewport. Most virtualizers support an `extraOverscan`
  prop or a "pinned items" API; pin focused editors. Alternatively,
  detect the unmount in your wrapper component and serialize the
  pending `view.state` to the host before destroying.

### 23.2 Recycled DOM containers

* **Manifests as:** A virtualizer reuses the same `<div>` container for
  different rows as the user scrolls; PM's `view.dom` ends up in a
  container belonging to a different doc.
* **Source:** PM is unaware of virtualization.
* **Mitigation:** The wrapper must call `view.destroy()` and create a
  fresh `EditorView` whenever the container is being reassigned to a
  different logical doc. React-window with `itemKey` and a stable
  React component identity helps; pass the docId as the key.

### 23.3 `coordsAtPos` returns wrong values

* **Manifests as:** Cursor positioning, scroll-to-cursor, decorations
  positioned by coordinates all show wrong layout in virtualized
  containers.
* **Source:** [17 §2 coordsAtPos](./17-coordinates-and-hit-testing.md).
* **Cause:** `coordsAtPos` uses `getBoundingClientRect`, which reports
  layout *after* the virtualizer's own transforms (scroll-translate,
  fixed-position items). PM does not adjust for arbitrary parent
  transforms beyond standard browser behavior.
* **Mitigation:** When dispatching `scrollIntoView`, do it after the
  next animation frame so the virtualizer has settled; or use
  `view.coordsAtPos(pos, side)` and combine with the virtualizer's
  scrollOffset manually.

### 23.4 Resize observation

* **Manifests as:** Editor's `view.dom` changes height as the user
  types but the virtualizer's row heights remain stale; rows after
  the editor render at the wrong y-coordinate.
* **Mitigation:** Wire a `ResizeObserver` to `view.dom` and propagate
  height changes to the virtualizer's measureRow API.

---

## 24. Error semantics — what happens if a transaction throws mid-`state.apply`?

* **Manifests as:** A custom plugin's `apply` throws (network error in
  `apply`, schema mismatch, programmer error). PM's behavior is
  surprising and varies by where the throw originates.
* **Source:** `prosemirror-state/src/state.ts:apply`,
  [07 §5](./07-state-and-plugins.md).

### 24.1 Throw in `filterTransaction`

The transaction is *aborted*. `state.apply` propagates the throw to the
caller (`view.dispatch`), which propagates to the user code that called
`view.dispatch`. The state is not modified. The view is not updated.
The DOM may be in a transient state (the keystroke that triggered the
event has already mutated DOM), and PM does NOT roll back the DOM.
On the next keystroke, `readDOMChange` re-detects the divergence and
generates a corrective transaction.

### 24.2 Throw in `StateField.apply` (a plugin field's apply)

Catastrophic: the loop building `newFields` is interrupted partway
through. Earlier fields have updated, later fields have not. The throw
propagates to `state.apply`, which lets it bubble. **The half-built
state is discarded.** But:

* `view.state` is not updated; the view holds the *previous* state.
* If the caller catches the throw and continues, subsequent
  transactions will be applied to the previous state — the failed
  transaction effectively never happened.
* If the caller does *not* catch, the entire JS task aborts with the
  exception, and depending on host (browser, framework error
  boundary), the editor becomes unrecoverable.

### 24.3 Throw in `appendTransaction`

The base transaction has succeeded. The append is discarded. The
combined-transactions list is truncated at the failing plugin. State
applies cleanly with whatever appended trs preceded the failure.
This is the *safest* failure mode.

### 24.4 Throw in `Step.apply` itself

Means a step is invalid for the current doc (e.g., bad position). PM
returns `StepResult.fail(message)` *as a value*, not as an exception.
`Transform` throws `TransformError` if `setStep` is called with a
failing result; the throw propagates up through `apply`. Same
semantics as 24.2.

### 24.5 Recovery patterns

```ts
// Wrap dispatch in a try/catch at the integration boundary.
try {
  view.dispatch(tr)
} catch (e) {
  console.error("PM dispatch failed", e)
  // The editor is in a consistent state (the failing tr never
  // committed), but the user's input may not have produced the
  // expected effect. Surface a notification.
  notifyUser("Edit failed; please retry")
}

// In a plugin's apply, never let internal errors escape:
apply(tr, value, oldState, newState) {
  try {
    return computeNewValue(tr, value)
  } catch (e) {
    console.error("plugin internal error", e)
    return value  // fall back to old value; do not throw
  }
}
```

* **Redesign:** `state.apply` should return a discriminated result —
  `{ ok: true, state } | { ok: false, error }` — so callers must
  handle the failure explicitly. The current behavior conflates
  "program bug" with "user-visible failure".

---

## 25. Quick reference — pitfall to file map

See also [00-index.md](./00-index.md) for the master index across the
entire dossier and [01 §7](./01-architecture-overview.md) for the
single-file architecture map.

```
Schema design          → 03-schema-and-content-expressions.md, 02-document-model.md
Position arithmetic    → 04-resolved-positions.md, 06-position-mapping.md
Transform / Step       → 05-transform-and-steps.md
State / plugins        → 07-state-and-plugins.md
View / reconciliation  → 09-view-and-viewdesc.md
Decorations            → 10-decorations.md
Parser                 → 11-dom-parser.md
Serializer             → 12-dom-serializer.md
Input pipeline         → 13-input-pipeline.md
IME / composition      → 14-ime-composition.md
DOMObserver            → 15-domobserver-and-domchange.md
Clipboard              → 16-clipboard.md
Coordinates            → 17-coordinates-and-hit-testing.md
Cross-browser          → 18-cross-browser-quirks.md
Commands / keymap      → 19-commands-keymap-inputrules.md
History / collab       → 20-history-and-collab.md
End-to-end synthesis   → 21-rendering-pipeline-end-to-end.md
Accessibility          → 23-accessibility.md
Mobile / touch         → 25-mobile.md
Performance & profiling→ 26-performance.md
Testing                → 27-testing.md
i18n / RTL / bidi      → 28-i18n-bidi.md
Plugin cookbook        → 31-plugin-cookbook.md
Security               → 32-security.md
Memory management      → 33-memory.md
Async transactions     → 37-async-transactions.md
```
