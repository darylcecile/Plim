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
* **Redesign:** Explicit priority on `PluginSpec`; document it; reject ties.

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
* **Redesign:** Stable outer container; `view.dom` is a child.

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
* **Redesign:** Compose mark intent + text intent independently, merged at
  commit.

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

The 25 highest-leverage observations from this dossier, in priority order.

### Architecture & invariants
1. **Make appendTransaction loop bounded by topology, not by author hygiene.**
   Cycles must be detected and rejected.
   ([4.2](#42-appendtransaction-infinite-loop))
2. **Single mutation-source token.** Every PM write tags its DOM mutations so
   the observer can ignore them at the record level.
   ([11.1](#111-feedback-loops))
3. **Composition as a first-class editor state**, not a flag on `view.input`.
   NodeView authors must opt-in to composition handling explicitly.
   ([10.5](#105-composition-view-desc-shielding))
4. **Boundaries are types.** `LeftPosition`/`RightPosition`, doc-versioned
   positions, branded `PluginKey`s, frozen attrs.
   ([2.2](#22-assoc-flips-behaviour-at-deletion-boundaries),
    [4.4](#44-pluginkey-collisions))

### Schema / model
5. **Replace content expressions with a tractable DSL** that auto-fills
   common patterns and rejects exponential DFAs.
   ([1.1](#11-content-expressions-are-nfas-not-regexes))
6. **Single `kind` enum** for inline/block/leaf/atom/isolating.
   ([1.3](#13-atom-true-vs-leaf-vs-isolating-true--three-orthogonal-flags))
7. **Auto-derive parseDOM from toDOM** as a baseline. Authors can override.
   ([1.5](#15-forgetting-parsedom-makes-a-node-un-pasteable))
8. **Stable, schema-declared mark order.** Ban `addToSet` ordering surprises.
   ([1.2](#12-marks-order-matters-and-is-implicit), [8.3](#83-mark-order-in-serializenode))

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

> The full takeaways list (priorities for our editor) appears in
> [01 §8](./01-architecture-overview.md) — these 25 supplement it with the
> war-story evidence.

---

## 18. Quick reference — pitfall to file map

```
Schema design         → 03-schema-and-content-expressions.md, 02-document-model.md
Position arithmetic   → 04-resolved-positions.md, 06-position-mapping.md
Transform / Step      → 05-transform-and-steps.md
State / plugins       → 07-state-and-plugins.md
View / reconciliation → 09-view-and-viewdesc.md
Decorations           → 10-decorations.md
Parser                → 11-dom-parser.md
Serializer            → 12-dom-serializer.md
Input pipeline        → 13-input-pipeline.md
IME / composition     → 14-ime-composition.md
DOMObserver           → 15-domobserver-and-domchange.md
Clipboard             → 16-clipboard.md
Coordinates           → 17-coordinates-and-hit-testing.md
Cross-browser         → 18-cross-browser-quirks.md
Commands / keymap     → 19-commands-keymap-inputrules.md
History / collab      → 20-history-and-collab.md
End-to-end synthesis  → 21-rendering-pipeline-end-to-end.md
```
