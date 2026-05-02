# ProseMirror edge-case gap closure

## Purpose

This appendix closes the remaining QA/audit gaps after the main ProseMirror architecture packet. It focuses on places where "high-level architecture" is not enough for a new editor design:

- exact rebasing failure behavior;
- replacement fitting fallbacks;
- mark exclusion determinism;
- content-expression compilation;
- slice open-depth validation;
- composition, selection, and browser filler-node edge cases;
- custom node-view lifecycle ambiguity;
- history/collab interaction.

Source references use the pinned snapshots in `00-source-index.md`.

## Collaboration and transform edge cases

### Rebase failure handling

`prosemirror-collab` rebases unconfirmed local steps with `rebaseSteps` (`prosemirror-collab/src/collab.ts`, local lines 14-27):

```text
undo local unconfirmed steps in reverse
apply remote authority steps
for each original local step:
  map local step through the transform mapping
  maybe apply the mapped step
  if it maps and applies:
    record mirror pair
    keep it as a new unconfirmed step
```

The failure behavior is important:

- If `step.map(...)` returns `null`, the local step is dropped from the new unconfirmed queue.
- If `transform.maybeStep(mapped).failed` is truthy, the mapped local step is also dropped.
- There is no local fallback, no partial resend, and no automatic full-document resync in this helper.
- The original `origin` transform is preserved only for successfully rebased steps: `new Rebaseable(mapped, mapped.invert(...), steps[i].origin)`.

So ProseMirror's collab helper is optimistic and central-authority based. It assumes authority steps are valid and that dropped local steps are acceptable conflict resolution. A production Plim collab layer should decide whether "drop conflicted local operation" is acceptable UX, or whether to surface a conflict, preserve intent for retry, or request a state resync.

### Mirror mapping semantics

`Mapping` can store mirror pairs between maps (`prosemirror-transform/src/map.ts`, local lines 166-249). `_map` uses those pairs when a mapped position gets a recovery value: if the current map has a later mirror, it jumps to the mirror map and recovers the position there (`map.ts`, local lines 263-283).

In collab rebase:

```text
maps 0..N-1       undo local steps
maps N..N+R-1     apply remote authority steps
maps later        redo successfully mapped local steps
```

When a local step is successfully re-applied, collab records:

```ts
transform.mapping.setMirror(mapFrom, transform.steps.length - 1)
```

where `mapFrom` points at the corresponding undo map and `transform.steps.length - 1` points at the redo map (`prosemirror-collab/src/collab.ts`, local lines 18-23).

This helps selections, decorations, and history items avoid being treated as deleted when they pass through an undo+redo pair for the same logical local edit. If the local step fails to map or apply, no redo map is created and no mirror pair is recorded. Positions that belonged to that dropped edit must then map through the deletion/removal normally.

Design implication for Plim: if operations can be rebased by temporarily undoing local edits, the mapping layer needs a way to represent "this delete and this later insert are the same logical edit" for anchors that should survive the rebase. Stable node IDs alone do not replace this for text offsets and inline ranges.

### Replacement fitting failure behavior

There are three related APIs:

| API | Source | Behavior |
| --- | --- | --- |
| `Node.replace($from, $to, slice)` | `prosemirror-model/src/replace.ts`, local lines 122-143 | Primitive replacement. Throws `ReplaceError` for open-depth mismatch, impossible joins, or invalid content. |
| `replaceStep(doc, from, to, slice)` | `prosemirror-transform/src/replace.ts`, local lines 8-19 | User-friendly fitter entry point. Returns a `Step` or `null` when there is no meaningful insertion/no-op. |
| `Transform.replaceRange(from, to, slice)` | `prosemirror-transform/src/transform.ts`, local lines 120-139; `replace.ts`, local lines 334-403 | Paste/WYSIWYG-oriented replacement. Treats boundaries and open depth as hints, tries expansion/closing strategies, then falls back through target depths. |

`Fitter.fit()` is lossy by design (`prosemirror-transform/src/replace.ts`, local lines 77-107):

1. While unplaced slice content remains, it tries to find a compatible insertion frontier.
2. If no frontier fits, it tries `openMore()`.
3. If opening deeper is impossible, it calls `dropNode()`.
4. Once all content is placed or dropped, it tries to close to `$to`.
5. If closing fails, it returns `null`.

"Drop a node" means removing content from the unplaced slice (`dropFromFragment`), not throwing. This is why paste can discard wrapper/content that cannot fit into the target schema. `replaceRange` first tries direct/expanded replacements for defining-context behavior, then repeatedly calls `tr.replace(from, to, slice)` and expands covered depths until a step is added or no target remains (`prosemirror-transform/src/replace.ts`, local lines 395-403).

Design implication for Plim: expose whether a user-intent insert was exact, repaired, expanded, wrapped, or lossy. ProseMirror's API returns the final transaction but does not make the repair trace easy for extensions or devtools to inspect.

### Exact replace vs user-intent replace

| Case | `replace` / `Node.replace` | `replaceRange` |
| --- | --- | --- |
| Open depth deeper than insertion position | Throws `ReplaceError("Inserted content deeper than insertion position")` (`prosemirror-model/src/replace.ts`, local lines 122-124). | May close/open or choose a different target depth before falling back to `replace`. |
| `$from.depth - openStart` differs from `$to.depth - openEnd` | Throws `ReplaceError("Inconsistent open depths")` (`replace.ts`, local lines 125-126). | Treats `from`, `to`, and `openStart` as hints and may change boundaries (`prosemirror-transform/src/transform.ts`, local lines 120-136). |
| Slice has parent context that should be preserved | Only uses the exact slice and endpoints. | May include defining content from the slice or drop non-defining covered parents (`transform.ts`, local lines 120-136; `replace.ts`, local lines 370-391). |
| Content cannot fit | Step application fails/throws through `Transform.step`; `maybeStep` can capture failure. | Fitter can drop unplaceable nodes or return no step if no meaningful fit is possible. |
| Intended caller | Precise programmatic structural edits. | Paste, drag/drop, and user-facing insertion where WYSIWYG repair is expected. |

## Schema and data-model edge cases

### Mark exclusion determinism

`Mark.addToSet` defines exact conflict behavior (`prosemirror-model/src/mark.ts`, local lines 19-45):

1. If the same mark is already present, return the existing set.
2. If the new mark excludes an existing mark, copy the set up to that point and omit the excluded existing mark.
3. If an existing mark excludes the new mark, return the original set unchanged.
4. Otherwise insert the new mark by rank order.

This creates deterministic but order-sensitive semantics around the attempted operation:

| Existing set | New mark | Result |
| --- | --- | --- |
| `[bold]`, `code.excludes = "bold"` | add `code` | `code` replaces `bold` because the new mark excludes the existing one. |
| `[code]`, `code.excludes = "bold"` | add `bold` | unchanged `[code]` because the existing mark excludes the new one. |
| `[link href=a]`, default self-exclusion | add `link href=b` | new link replaces old link if the new link excludes same mark type and is not equal. |
| `[bold, italic]`, no mutual exclusions | add `link` | `link` inserted by schema rank. |

Mark exclusions are computed once per schema (`prosemirror-model/src/schema.ts`, local lines 622-625). `excludes: null/undefined` means a mark excludes itself; `excludes: ""` excludes nothing; otherwise names/groups are resolved with `gatherMarks`, so group names can be used.

Plim implication: a clearer extension API should distinguish "new mark wins", "existing mark wins", "merge attrs", and "allow multiple instances" rather than encoding all of that through string groups plus add order.

### Mark attribute defaults and cached instances

`MarkType` computes attribute defaults in its constructor and pre-allocates `this.instance` when all attrs have defaults (`prosemirror-model/src/schema.ts`, local lines 300-304). `MarkType.create(null)` returns that shared instance (`schema.ts`, local lines 306-312).

This is safe because marks are intended as immutable values, like nodes. The cache is per `MarkType`, and a `MarkType` is per `Schema`. There is no mutable global mark instance shared across schemas. If callers mutate `mark.attrs` manually, they violate ProseMirror's value-object convention and can corrupt shared data.

Plim implication: if Plim wants stronger DX, freeze attrs in development or make attrs structurally immutable so cached defaults cannot be accidentally mutated.

### Slice open-depth validation

`Slice.maxOpen(fragment, openIsolating)` walks the first and last child chains until a leaf or isolating boundary to compute the largest valid open depths for that fragment (`prosemirror-model/src/replace.ts`, local lines 88-95). It does not clamp arbitrary user-provided slices.

Primitive replacement validates a slice against the insertion positions:

- `slice.openStart > $from.depth` throws `ReplaceError("Inserted content deeper than insertion position")`.
- `$from.depth - slice.openStart != $to.depth - slice.openEnd` throws `ReplaceError("Inconsistent open depths")`.
- Later joins/content checks can throw other `ReplaceError`s when node types cannot join or content does not satisfy schema constraints (`replace.ts`, local lines 122-148 and below).

Plim implication: "partial content" should be a first-class type with validated constructors. Letting extension authors construct arbitrary open-depth payloads makes failures occur too late, inside editing operations.

### ContentMatch compilation and constraints

Content expressions are compiled at schema construction, not during every edit. `Schema` caches `ContentMatch.parse(contentExpr, nodes)` by content-expression string so node types with identical expressions share the same automaton (`prosemirror-model/src/schema.ts`, local lines 605-612).

Compilation details:

1. `TokenStream` tokenizes the content-expression string (`prosemirror-model/src/content.ts`, local lines 169-188).
2. Names resolve either to a node type or to all node types in a group (`content.ts`, local lines 246-255).
3. Mixing inline and block node types in one expression throws a syntax error (`content.ts`, local lines 263-267).
4. The parser builds an expression AST with `choice`, `seq`, `plus`, `star`, `opt`, `range`, and `name` nodes (`content.ts`, local lines 190-270).
5. The compiler builds an NFA where edge order is significant because filler generation uses it (`content.ts`, local lines 276-350).
6. The DFA builder explores null-closure state sets and memoizes states by their state-list label (`content.ts`, local lines 373-400).
7. `checkForDeadEnds` rejects required positions that can only be filled by text or node types with required attrs (`content.ts`, local lines 402-412).

Groups do not recursively reference other groups; they are membership labels on node specs. The risk is not circular group expansion but unintentionally broad groups and schema-order-dependent defaults. The cost is paid when constructing the schema and then reused in `ContentMatch` checks, `fillBefore`, `findWrapping`, and transform validation.

Plim implication: typed schema builders can still compile to a DFA, but they should surface generated states, default filler choices, and "non-generatable required position" errors at extension-load time.

## Browser input and rendering edge cases

### `beforeinput` posture

In the pinned `prosemirror-view` snapshot, `beforeinput` is not the primary editing-intent API. The source comment says support is "so spotty" and the built-in handler only implements a narrow Chrome Android `deleteContentBackward` workaround after an uneditable node (`prosemirror-view/src/input.ts`, local lines 806-827).

The packet should be read as source posture, not a universal browser-compatibility claim. A future Plim browser adapter can choose a `beforeinput`-first strategy for modern targets, but it still needs a MutationObserver + contextual parse/diff fallback for:

- IME/composition mutations that arrive out of order;
- mobile keyboard behavior;
- native autocorrect/spellcheck;
- uneditable node islands;
- shadow DOM selection quirks;
- drag/drop and clipboard DOM insertion;
- browser bugs where intent events fire but no DOM change happens, or DOM changes happen without a useful intent event.

### Composition ID semantics

`InputState.compositionID` starts at `1` per `EditorView` instance (`prosemirror-view/src/input.ts`, local lines 19-44). On `compositionend`, ProseMirror:

- stores the current ID in `compositionPendingChanges` if mutation records are still pending;
- clears `compositionNode`;
- schedules or forces a flush;
- increments `compositionID` (`input.ts`, local lines 502-512).

`readDOMChange` then tags transactions produced from those pending DOM changes with `tr.setMeta("composition", compositionID)` (`prosemirror-view/src/domchange.ts`, local lines 223-240).

This ID is local to a view and groups DOM-change transactions that came from one IME session. It is not a cross-client, cross-tab, or persistent operation ID. There is no overflow/collision handling in the source; JavaScript number limits make overflow irrelevant for practical editor sessions.

Plim implication: use a typed composition session object with phase and view identity for diagnostics, but do not confuse browser composition IDs with collaborative operation IDs.

### Multi-range and complex selection handling

`selectionFromDOM` maps the browser selection through `docView.posFromDOM` (`prosemirror-view/src/selection.ts`, local lines 9-47). For multi-range DOM selections, ProseMirror collapses them into one model range:

1. Initialize `min` and `max` from the focus/head position.
2. Iterate every DOM range.
3. Map each range start/end into document positions.
4. Use the minimum and maximum document positions as the model range.
5. Choose anchor/head orientation based on whether `max` equals the previous state selection's anchor.

So ProseMirror's model remains single-range even when the browser can represent multiple ranges.

Selection writing has two notable hacks:

- WebKit/old Chrome cannot reliably select between non-editable block nodes, so ProseMirror temporarily sets a nearby uneditable DOM node to `contentEditable=true`, writes the selection, then restores it (`selection.ts`, local lines 104-130).
- Safari shadow DOM selection access may require triggering `document.execCommand("indent")` solely to receive a `beforeinput` event and read its target range; the handler prevents default and stops propagation (`domobserver.ts`, local lines 332-356).

Plim implication: a browser adapter should represent "read DOM selection", "normalize to model selection", and "write DOM selection" as testable phases with explicit browser-workaround traces.

### Browser-inserted filler `<br>` handling

ProseMirror handles several kinds of unwanted browser `<br>` nodes:

- `parseBetween` trims a Chrome Backspace case where deleted content is replaced by an untracked BR (`prosemirror-view/src/domchange.ts`, local lines 26-34).
- `DOMObserver.flush` removes BR nodes inserted after Backspace/Delete before an uneditable inline-flex-like node (`prosemirror-view/src/domobserver.ts`, local lines 195-207).
- In Gecko, if two BRs are added, it removes one depending on their parent relationship; it also removes BRs inserted into list items when the current selection is not in that list item (`domobserver.ts`, local lines 208-221).
- Rendering also creates intentional `TrailingHackViewDesc` nodes for contenteditable workarounds; those parse as ignored and can be ignored for coordinates when appropriate (`viewdesc.ts`, local lines 974-980).

The distinction is descriptor ownership. Intentional editor hacks have view descriptors or parse rules. Browser-inserted filler nodes show up as added DOM nodes without meaningful descriptors and are removed before DOM parsing/diffing treats them as document content.

Plim implication: filler handling should not be a generic "delete all BRs" rule. It must know which DOM nodes are editor-owned hacks, schema linebreak nodes, and browser garbage.

### Coordinate mapping quirks

| Platform/source condition | Issue | ProseMirror workaround | Impact for Plim |
| --- | --- | --- | --- |
| Safari + draggable element | `caretRangeFromPoint` can return nonsense on draggable DOM. | Ignore the caret result if the hit element/ancestor is draggable (`domcoords.ts`, local lines 289-293). | Pointer selection around draggable blocks/atoms. |
| Firefox + form/image DOM | `caretPositionFromPoint` can return offsets into childless inputs or before images behind the coordinate. | Clamp offset to child count and advance past image when its rect is left of the click (`domcoords.ts`, local lines 296-307). | Click placement near media and embedded controls. |
| WebKit + uneditable node | Clicking above the right side of an uneditable node can report a cursor after it. | Move offset before the uneditable previous sibling when its top is below/at click top (`domcoords.ts`, local lines 309-313). | Node-view/widget selection accuracy. |
| End of document | Caret APIs may not return the final document position. | If click is below the last child, return `doc.content.size` (`domcoords.ts`, local lines 314-318). | Appending blocks and placing caret after last node. |
| Positions after `<br>` | Caret APIs round positions after a BR that are more accurately before it. | Ignore positions directly after BR in `posAtCoords` (`domcoords.ts`, local lines 319-323). | Empty textblock and hard-break behavior. |
| Bidi or empty text range | Rects at a text offset can be ambiguous or wrong. | Prefer empty text ranges in WebKit/Gecko for bidi/end offsets and use whitespace kludges for Gecko (`domcoords.ts`, local lines 348-368). | Tooltips, selection handles, slash menus, collaborative cursors. |

### Custom node-view lifecycle ambiguity

Custom node views are integrated through `NodeViewDesc.create` (`prosemirror-view/src/viewdesc.ts`, local lines 690-723). A custom spec may provide `dom`, `contentDOM`, `update`, `selectNode`, `deselectNode`, `setSelection`, `destroy`, `stopEvent`, and `ignoreMutation` (`viewdesc.ts`, local lines 986-1033).

Important ordering/ownership details:

- Event routing checks `eventBelongsToView`; if a target or ancestor descriptor's `stopEvent(event)` returns true, the event never reaches custom props or built-in editor handlers (`prosemirror-view/src/input.ts`, local lines 90-98).
- DOM mutation routing calls the nearest descriptor's `ignoreMutation`; if true, the mutation is not converted into a document range (`prosemirror-view/src/domobserver.ts`, local lines 252-262).
- Rendering tries to reuse/update existing descriptors before creating new ones. For custom node views, `spec.update` can accept or reject an update; if it accepts and has `contentDOM`, ProseMirror then updates children (`viewdesc.ts`, local lines 993-1006).
- Selection rendering first syncs node-selection classes/callbacks via `selectNode`/`deselectNode`, then writes the DOM selection through `docView.setSelection`; custom views can override `setSelection` for selections inside their content (`selection.ts`, local lines 55-101 and 166-186; `viewdesc.ts`, local lines 1009-1020).
- During composition, `updateChildren` may lock/reuse the child containing the composition and protect orphaned composition DOM before rendering descriptors (`viewdesc.ts`, local lines 763-852).

Example event sequence:

```text
mousedown inside custom node view
  -> eventBelongsToView walks target ancestors
  -> custom stopEvent may isolate the event from the editor
  -> if not stopped, built-in mouse logic may update selection/drag state
  -> browser may mutate DOM/selection
  -> DOMObserver.flush calls ignoreMutation on nearest descriptor
  -> non-ignored mutation becomes a model range and may dispatch a transaction
  -> EditorView.updateStateInner rerenders
  -> custom update/selectNode/setSelection hooks may run depending on state/selection
```

Plim implication: expose explicit component modes. "Opaque atom", "managed editable content", and "hybrid interactive island" should have different default event/mutation/selection policies rather than one loose node-view object.

## History, collaboration, and custom marks

History stores inverted steps and maps, not full snapshots (`prosemirror-history/src/history.ts`, local lines 5-20). The history plugin maps stored history items through non-history transactions and checks for `historyPreserveItems` so steps are not merged in ways that would break rebasing (`history.ts`, local lines 345-360). The collab plugin sets `historyPreserveItems: true` (`prosemirror-collab/src/collab.ts`, local lines 91-96).

Worked example:

```text
Initial: paragraph("hello")
Local: add comment mark over "ell"
  -> AddMarkStep is stored unconfirmed by collab
  -> inverse RemoveMarkStep is stored in history
Remote: delete "ell"
  -> receiveTransaction rebases local AddMarkStep over remote deletion
  -> mapped AddMarkStep returns null or fails because its range was deleted
  -> local mark operation is dropped from unconfirmed steps
  -> remote deletion is tagged addToHistory=false
Local undo:
  -> history undoes the last local history event if it still maps
  -> because the marked text was deleted remotely, the mark-only inverse may map to nothing
```

The exact result depends on step mapping and history item remapping, but the architectural lesson is stable: marks are operations over ranges. If the range disappears under remote edits, the mark operation can disappear too. Durable annotations need either document content, mapped range anchors with conflict policy, or stable IDs beyond plain mark ranges.

Plim implication: do not treat custom marks, comments, or annotations as "just inline styling" if product semantics require survival across remote deletion/reinsertion. Define their persistence, mapping, and conflict behavior explicitly.

