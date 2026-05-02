# ProseMirror transform, replacement, and collaboration deep dive

## Why this document matters

The earlier packet explains the state and transaction architecture. This document goes one layer lower: how ProseMirror represents edits as steps, how replacements are made schema-valid, how position mappings survive complex edits, and how those same primitives power history and central-authority collaboration.

For a new editor inspired by ProseMirror, this is the core design lesson: **the model is not just immutable; every mutation is captured as an explicit, replayable, mappable, invertible operation.**

Source references use the snapshot table in `00-source-index.md`.

## Operation stack

```text
Command / DOM reconciliation / API call
  -> Transaction
    -> Transform methods
      -> Step objects
        -> Node.replace / mark/attr update
          -> StepResult
    -> StepMap per step
    -> Mapping across all steps
  -> EditorState.applyTransaction
  -> plugin state, history, collaboration, decorations, selection mapping
```

`Transaction` inherits from `Transform`, so every transaction is a transform plus editor-state fields such as selection, stored marks, metadata, and scroll intent. The pure operation layer is in `prosemirror-transform`.

## Step contract

`Step` is the abstract operation unit (`prosemirror-transform/src/step.ts`, local lines 7-67). A step must provide:

| Method | Purpose |
| --- | --- |
| `apply(doc)` | Try to apply to a specific document and return `StepResult` |
| `getMap()` | Return the position map from old doc to new doc |
| `invert(doc)` | Build the inverse step from the pre-step document |
| `map(mapping)` | Map the step through other changes, or return null if deleted |
| `merge(other)` | Optionally combine adjacent steps |
| `toJSON()` / `fromJSON()` | Serialize for persistence/collaboration |

Important nuance: the source comment says a step generally only applies to the document it was created for because its stored positions only make sense in that document (`step.ts`, local lines 7-15). Mapping is what lets a step survive concurrent or intervening changes.

`StepResult` wraps success or failure. `StepResult.fromReplace` calls `Node.replace` and catches `ReplaceError`, converting schema/replacement failures into step failure results (`step.ts`, local lines 69-97). `Transform.step` throws on failure, while `Transform.maybeStep` records successful steps and ignores failed ones (`transform.ts`, local lines 46-60).

## Built-in step families

### ReplaceStep

`ReplaceStep` replaces `[from, to)` with a `Slice` (`replace_step.ts`, local lines 6-88). It is the primitive for text insertion, deletion, paste, many structure edits, and DOM reconciliation.

Key details:

- The step's map is a single changed range triple: `[from, to - from, slice.size]` (`replace_step.ts`, local lines 34-36).
- `invert(doc)` creates a replace that restores the old slice (`replace_step.ts`, local lines 38-40).
- `map(mapping)` maps both endpoints and drops the step if both sides were deleted across (`replace_step.ts`, local lines 42-47).
- `structure: true` makes the step fail when the replaced range contains real content, not just closing/opening tokens. This protects rebased structural edits from overwriting unexpected content (`replace_step.ts`, local lines 11-14 and 28-31).
- `ReplaceStep.MAP_BIAS` controls how insertions remap across concurrent insertions at the same position; the source notes the compatibility tradeoff for collaborative editing (`replace_step.ts`, local lines 79-85).

### ReplaceAroundStep

`ReplaceAroundStep` replaces a range while preserving a subrange by moving it into the inserted slice (`replace_step.ts`, local lines 90-170). This is essential for wrapping, lifting, changing block types, and other structural transforms where existing child content must survive inside a new wrapper.

Its map contains two changed ranges:

```text
[from, gapFrom - from, insert,
 gapTo, to - gapTo, slice.size - insert]
```

That shape says: replace content before the preserved gap, preserve/move the gap, then replace content after the gap (`replace_step.ts`, local lines 131-134).

The apply path validates that:

- structure-guarded outer content is empty of real content;
- the gap slice is flat;
- preserved gap content fits into the inserted slice at `insert` (`replace_step.ts`, local lines 118-128).

### Mark steps

`AddMarkStep` and `RemoveMarkStep` rewrite inline content in a range by slicing the old content, mapping inline children, and replacing the range with the rewritten slice (`mark_step.ts`, local lines 17-128).

Details that matter for a new editor:

- Mark operations are still represented as steps and can be inverted, mapped, merged, and serialized.
- Mark steps map their range with opposite endpoint associations and drop if the mapped range collapses or both endpoints are deleted (`mark_step.ts`, local lines 44-48 and 100-104).
- `AddMarkStep.apply` only changes inline nodes where the parent allows the mark (`mark_step.ts`, local lines 30-37).
- `merge` combines overlapping/adjacent mark operations with the same mark (`mark_step.ts`, local lines 50-57 and 106-113).

`AddNodeMarkStep` and `RemoveNodeMarkStep` target a specific node position, replacing that node with an updated copy (`mark_step.ts`, local lines 130-224). This supports marks on inline atom nodes and other markable nodes.

### Attribute steps

`AttrStep` updates one attribute on a node at a document position, replacing the node with a copy that has updated attrs (`attr_step.ts`, local lines 5-53). `DocAttrStep` updates attrs on the document node itself (`attr_step.ts`, local lines 55-98).

Their maps are empty because no positions move (`attr_step.ts`, local lines 29-31 and 75-77). They still invert and map: node attr steps drop if the target node was deleted, while doc attr steps map to themselves (`attr_step.ts`, local lines 33-40 and 79-85).

Design implication: not every operation changes coordinates. Plim should distinguish "content-shape changes" from "metadata/attribute changes" while still recording both in the operation log.

## Transform as mutable operation builder

`Transform` stores:

- `steps`: successful steps;
- `docs`: the pre-step document for each step;
- `mapping`: accumulated `StepMap`s;
- `doc`: current post-step document (`transform.ts`, local lines 23-41).

When a step succeeds, `addStep` pushes the previous doc, pushes the step, appends the step map, and updates `doc` (`transform.ts`, local lines 88-94).

This means a transform contains everything needed to:

- inspect the operation sequence;
- invert each step against its source document;
- map selections/decorations/plugin anchors through all steps;
- serialize steps for remote peers;
- build history entries.

`Transform.changedRange()` can summarize replacement changes into a single post-transform range, but it explicitly ignores mark-only changes (`transform.ts`, local lines 68-86). A new editor should expose both structural changed ranges and mark/attribute changed ranges if extensions need precise invalidation.

## StepMap and Mapping

`StepMap` is the coordinate bridge between document versions. Each map stores triples `[start, oldSize, newSize]` (`map.ts`, local lines 68-80). Mapping a position walks the triples, accumulates size deltas, and uses `assoc` to decide which side of an insertion/deletion a boundary position belongs to (`map.ts`, local lines 93-116).

`MapResult` also reports deletion information:

- `deleted`: token on the associated side was deleted;
- `deletedBefore`: token before the position was deleted;
- `deletedAfter`: token after the position was deleted;
- `deletedAcross`: content was deleted across the position (`map.ts`, local lines 38-66).

Those flags are why selections, decorations, and steps can make nuanced decisions instead of merely shifting offsets.

`Mapping` chains many `StepMap`s and can store mirror pairs (`map.ts`, local lines 166-249). Mirror pairs matter when an operation sequence contains a step and its inverse, as in rebasing and history. During `_map`, when a map result has a recovery value and the map has a later mirror, the mapping jumps to the mirror and recovers the position there (`map.ts`, local lines 263-283).

Design implication: if Plim supports undo, collaboration, or operation rebasing, a simple "range delta" list is not enough. It needs recoverable mapping semantics or an equivalent anchor transform system.

## Primitive model replacement

The deepest replace primitive lives in `prosemirror-model/src/replace.ts`.

`Slice` stores a fragment plus `openStart` and `openEnd`, describing how many edge nodes were cut through (`replace.ts`, local lines 21-47). Open slices are why paste and drag/drop can carry partial paragraphs, table cells, list content, or inline fragments without pretending they are complete documents.

`Node.replace` eventually calls `replace($from, $to, slice)`:

1. Reject inserted content whose open depth is deeper than the insertion position.
2. Reject mismatched open depths between replacement endpoints.
3. Recurse through `replaceOuter`.
4. Validate joins and content with schema checks.
5. Return a new tree that structurally shares unchanged content (`prosemirror-model/src/replace.ts`, local lines 122-225).

There are three replacement cases:

- recursive replacement inside the same child (`replaceOuter`, local lines 130-135);
- deletion/two-way join when slice is empty (`replaceOuter` and `replaceTwoWay`, local lines 135-136 and 207-215);
- three-way replacement when inserted open content must be joined to both sides (`replaceOuter`, `prepareSliceForReplace`, and `replaceThreeWay`, local lines 140-143 and 187-225).

`close(node, content)` runs `node.type.checkContent(content)` before copying, so primitive replacement enforces schema validity at the boundary (`replace.ts`, local lines 182-185).

## `replace` vs `replaceRange`

ProseMirror deliberately exposes both precise and WYSIWYG-friendly replacement APIs.

### `Transform.replace`

`Transform.replace(from, to, slice)` calls `replaceStep(doc, from, to, slice)`. `replaceStep` first checks whether the slice trivially fits in the same parent; otherwise it invokes the `Fitter` algorithm (`prosemirror-transform/src/replace.ts`, local lines 8-24).

The `Fitter` tracks:

- `frontier`: the open right edge of the replacement target, as `{type, match}` stack;
- `unplaced`: remaining slice content;
- `placed`: content already fitted into the gap (`replace.ts`, local lines 34-73).

The fit loop repeatedly:

1. finds fittable content at a slice depth and frontier depth;
2. places nodes directly or through wrappers;
3. otherwise opens the slice deeper or drops a node;
4. closes the frontier against `$to`;
5. returns `ReplaceStep` or `ReplaceAroundStep` (`replace.ts`, local lines 77-107, 112-154, and 177-287).

This is schema-aware paste/insert repair, not just array splicing.

### `Transform.replaceRange`

`replaceRange(from, to, slice)` treats `from`, `to`, and `slice.openStart` as hints rather than exact boundaries (`transform.ts`, local lines 120-137). The implementation can expand the replaced range over non-defining parents, preserve defining context, close open slice nodes, or try several target depths (`replace.ts`, local lines 334-403).

The source comments make its role explicit: it is the method to handle paste; primitive `replace` is for precise control (`transform.ts`, local lines 120-136).

### `Transform.deleteRange`

`deleteRange(from, to)` can expand a deletion over covered parent nodes until a valid replacement is found (`transform.ts`, local lines 154-158). It has special handling for deleting from the start of one textblock to the start of another, avoiding isolating nodes, and tries covered depths before falling back to raw deletion (`replace.ts`, local lines 426-458).

Design implication: a better-DX editor should name these modes clearly. Extension authors need to know whether they are asking for an exact structural mutation, a user-intent paste/insert fit, or a deletion that can expand for natural editing behavior.

## Structural transforms

Higher-level structure helpers build `ReplaceStep` and `ReplaceAroundStep` after checking schema validity.

| Helper | What it does | Source |
| --- | --- | --- |
| `liftTarget` / `lift` | Find and perform a valid lift without crossing isolating parents | `structure.ts`, local lines 12-58 |
| `findWrapping` / `wrap` | Find wrapper chain and wrap a range | `structure.ts`, local lines 60-115 |
| `setBlockType` | Convert textblocks, clear incompatible content/marks, convert linebreak representation if needed | `structure.ts`, local lines 117-142 |
| `setNodeMarkup` | Change node type/attrs/marks, preserving content when valid | `structure.ts`, local lines 170-186 |
| `canSplit` / `split` | Validate and perform split by constructing open before/after fragments | `structure.ts`, local lines 188-221 |
| `canJoin` / `joinPoint` / `join` | Validate and perform joins, including linebreak substitution compatibility | `structure.ts`, local lines 225-299 |
| `insertPoint` / `dropPoint` | Find nearby valid insertion/drop positions | `structure.ts`, local lines 301-349 |

Most helpers inspect `ContentMatch`, `canReplace`, `canReplaceWith`, isolating flags, and allowed marks before constructing a replace step. The model rules and editing commands are therefore not separate worlds: commands are thin logic around schema-aware transform primitives.

## Mark transforms and incompatible content cleanup

`addMark` and `removeMark` scan inline descendants and build minimal mark steps (`mark.ts`, local lines 8-73). `addMark` first records steps to remove marks excluded by the new mark, then records add steps (`mark.ts`, local lines 8-36). `removeMark` groups adjacent matching inline ranges before creating remove steps (`mark.ts`, local lines 38-73).

`clearIncompatible` is used when changing parent type or joining content. It removes children that cannot match the new parent's content expression, removes disallowed marks, converts newlines to spaces when needed, fills required missing content, and applies deletions from right to left (`mark.ts`, local lines 75-106).

Design implication: schema transitions need normalizers. Plim should make these normalizers explicit and observable, rather than hiding cleanup inside commands.

## Collaboration mechanics

`prosemirror-collab` is intentionally small because it relies on steps, inverses, and mappings.

The model assumes a central authority with monotonically increasing version numbers. The plugin stores:

- `version`: last authority version integrated;
- `unconfirmed`: local steps not yet accepted by the authority (`prosemirror-collab/src/collab.ts`, local lines 29-44).

Each unconfirmed item stores:

- the local step;
- the inverted step;
- the origin transform/transaction (`collab.ts`, local lines 4-9 and 47-53).

### Sending local changes

`sendableSteps(state)` returns null if there are no unconfirmed steps. Otherwise it exposes:

- current authority version;
- unconfirmed steps;
- client ID;
- origin transactions, lazily computed (`collab.ts`, local lines 153-178).

The authority can serialize and broadcast the steps with a client ID.

### Receiving remote changes

`receiveTransaction(state, steps, clientIDs, options)` integrates authority steps (`collab.ts`, local lines 99-151):

1. Compute the new authority version.
2. Count how many received steps came from this client.
3. Drop that many unconfirmed local steps as confirmed.
4. If no new remote steps remain, only update collab state.
5. If there are remote steps and local unconfirmed steps, rebase locals over remotes.
6. Otherwise apply remote steps directly.
7. Optionally map text selections backward for cursor behavior around remote insertions.
8. Tag the transaction with `"rebased"`, `"addToHistory": false`, and new collab plugin state.

### Rebase algorithm

`rebaseSteps` is the critical operation (`collab.ts`, local lines 12-27):

```text
for each local step in reverse:
  apply its inverted step to undo local changes

apply all remote steps

for each original local step:
  map it through the transform mapping
  try to apply the mapped step
  if it succeeds:
    set mirror relationship between undo map and redo map
    store mapped step, its new inverse, and original origin
```

This explains why step inversion and mirror-aware mappings are core, not optional. Without them, ProseMirror could not keep local pending edits while integrating remote authority changes.

## History relationship

The history plugin uses the same primitives but with different policy:

- it stores inverted steps and maps, not whole document snapshots;
- it groups events by time and changed ranges;
- it maps history items through non-history transactions such as remote collab changes;
- the collab plugin sets `historyPreserveItems: true` to prevent history compression from losing information needed for rebasing (`prosemirror-collab/src/collab.ts`, local lines 91-96; `prosemirror-history/src/history.ts`, local lines 5-20).

Design implication: undo/redo and collaboration should be designed together. If Plim's operation format cannot invert, map, and preserve event boundaries, history and collaboration will become special-case systems.

## Component interaction summary

```text
Schema
  -> validates nodes, marks, replacement fit, wrappers, join/split legality

Node/Fragment/Slice
  -> immutable content values and partial-content replacement payloads

Step
  -> atomic operation over one document version

StepMap
  -> position correspondence for that operation

Transform/Transaction
  -> ordered operation builder plus accumulated mapping

Selection/Decoration/Plugin state
  -> map through Transaction.mapping

History
  -> stores inverted steps/maps/bookmarks and replays inverse operations

Collab
  -> sends unconfirmed steps and rebases them over authority steps

View
  -> turns browser DOM changes into transactions and renders accepted state
```

## Design implications for Plim

1. **Keep explicit operations.** Directly mutating immutable state without operation objects would make history, collaboration, selection mapping, debugging, and plugin state much harder.
2. **Separate exact mutations from user-intent fitting.** ProseMirror's `replace` vs `replaceRange` distinction is worth preserving with clearer names.
3. **Make mapping a first-class API.** Anchors, selections, comments, decorations, async suggestions, and remote cursors all need deterministic mapping.
4. **Use typed operation metadata.** ProseMirror has strongly structured steps but loosely typed transaction causes. Plim can keep typed steps and add typed causes.
5. **Expose normalization.** Schema repairs such as filler insertion, mark cleanup, or dropped slice nodes should be inspectable in devtools.
6. **Design collaboration early.** Rebase requirements feed back into operation shape, inversion, mapping recovery, history grouping, and node identity.
7. **Consider stable IDs as an addition, not a replacement.** Stable block/node IDs improve app-level DX, but text selections and inline decorations still need offset/position mapping.
8. **Support null/dropped operations explicitly.** ProseMirror's `Step.map` can return null when an operation was deleted by intervening changes. Plim APIs should make that outcome easy to handle.
