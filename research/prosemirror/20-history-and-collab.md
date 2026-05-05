# 20 — History & Collaboration (HD)

> Source: `prosemirror-history/src/history.ts` (465 lines), `prosemirror-collab/src/collab.ts` (184 lines), backed by `prosemirror-transform` `Step`, `StepMap`, `Mapping`. All file:line citations are to these files.

---

## 0. Why both subsystems exist on top of `Step`

ProseMirror's transform layer guarantees two properties of every `Step`:

1. **Invertibility** — given the document the step was applied to, `step.invert(doc)` returns a step that exactly undoes it. (`prosemirror-transform/src/step.ts`)
2. **Mappability** — `step.map(mapping)` returns a new step whose positions have been adjusted through some other set of changes (or `null` if the step has been deleted out of existence). (`prosemirror-transform/src/step.ts`, with `StepMap`/`Mapping` from `map.ts`)

Both **history** (undo/redo) and **collab** (OT-style rebase) are pure consumers of these two properties:

| Subsystem | Uses invertibility for…                      | Uses mappability for…                                                        |
| --------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| history   | Storing `step.invert(doc)` so undo can replay | Adjusting old inverted steps when later changes (incl. remote) shift their positions |
| collab    | Replaying local steps in reverse to rebase    | Re-mapping local unconfirmed steps over remote steps                         |

Without both properties, neither system is implementable. Anything we design for our editor that participates in undo or collab MUST be expressible as a Step (or sequence of them). This is the single most consequential rule in ProseMirror's architecture.

---

## 1. History

### 1.1 Shape of state

```
HistoryState
├── done:   Branch    // undo stack
├── undone: Branch    // redo stack
├── prevRanges: number[] | null  // ranges touched by last recorded change
├── prevTime: number             // timestamp of last recorded change
└── prevComposition: number      // IME composition id, for grouping
```
(history.ts:246–254)

A `Branch` is the heart of the data structure:

```
Branch
├── items: RopeSequence<Item>   // rope-sequence for cheap append/slice
└── eventCount: number          // # of grouped events on this branch
```
(history.ts:24–25)

The undo stack and redo stack are *both* `Branch` instances; they are symmetric. (history.ts:206 `Branch.empty`)

### 1.2 `Item`: a node in the rope

```
Item
├── map:           StepMap                 // forward step map (ALWAYS present)
├── step?:         Step                    // INVERTED step (the one that undoes the original)
├── selection?:    SelectionBookmark       // marks the START of an event group
└── mirrorOffset?: number                  // index of a mirroring earlier item (for rebase compression)
```
(history.ts:220–233)

Crucial design notes from the file's prologue (history.ts:5–19):

- **Every** item carries a forward `StepMap`, even items that are pure "air" (map-only, no step). This is because later items still need to map *through* them.
- An item that has both a `step` and a `selection` bookmark marks the **start of an event** — a group that undo/redo treats atomically.
- The bookmark is stored, not a full Selection, because resolving a Selection requires a document — and during compression the document isn't around.
- An item with only a `map` (no `step`) is a **map-only item**, also called an *empty item*. These appear when:
  - a transaction is recorded with `addToHistory: false` (history.ts:294–296),
  - a remote change is rebased into history (history.ts:121–124, `addMaps`).

### 1.3 Rope structure (`RopeSequence<Item>`)

`Branch.items` is a `rope-sequence` (history.ts:1). This gives:

- O(log n) append, slice, and indexed access.
- Cheap `append`/`slice` so operations like "drop the oldest event" or "concat new items" don't mutate or copy the whole stack.
- A persistent functional structure — `Branch` is immutable; every mutation returns a new `Branch`.

The rope is iterated forward and backward via `items.forEach(cb, from, to)` where `from > to` means reverse iteration (used everywhere in `popEvent` and `compress`).

### 1.4 Recording: `Branch.addTransform`

(history.ts:83–109)

```
addTransform(transform, selection, histOptions, preserveItems) -> Branch
```

For each step in the transaction:

1. Compute the inverted step: `transform.steps[i].invert(transform.docs[i])` (history.ts:89).
2. Build a new `Item(map = forwardMap, step = invertedStep, selection = bookmarkOrUndef)`.
3. **Merge with previous item** when possible — only the FIRST step of the new transaction may merge with the LAST item of the existing branch (lastItem; history.ts:86, 91–95). Merge is delegated to `Item.merge`:

   ```
   Item.merge(other):
     if both have steps and `other` is not a group-start (no selection):
       try Step.merge(this.step, other.step)
       if it returns a combined step, return new Item(combinedMap.invert(), combinedStep, this.selection)
   ```
   (history.ts:235–240)

   This is what coalesces a run of single-character insertions into one undoable event.

4. After the first step, `selection = undefined` so subsequent steps in the same transaction don't start new events (history.ts:97–100).

5. **Depth overflow** — if `eventCount > histOptions.depth + DEPTH_OVERFLOW (20)`, drop the oldest events via `cutOffEvents` (history.ts:103–107, 209–218). The +20 hysteresis prevents thrashing on every insert.

6. `preserveItems` (set true when collab is active, see §2.2) prevents merging across transaction boundaries; each step keeps its own item so that rebase can locate it later.

### 1.5 Mapping new outside changes onto history: `addMaps`

When a transaction is recorded with `addToHistory: false` (e.g. a remote step from collab's `receiveTransaction`), history isn't allowed to forget about it — it still needs to map the existing inverted steps through the new change so they apply to the new document.

```ts
addMaps(maps: readonly StepMap[]) {
  if (this.eventCount == 0) return this
  return new Branch(this.items.append(maps.map(m => new Item(m))), this.eventCount)
}
```
(history.ts:121–124)

The branch grows by one map-only item per outside step. `popEvent` later remaps through these.

### 1.6 Detecting event boundaries

The decision "should this transaction start a new event or extend the current one?" lives in `applyTransaction` (history.ts:259–298), specifically lines 277–286:

```ts
let newGroup =
  history.prevTime == 0
  || (!appended
      && history.prevComposition != composition
      && (history.prevTime < (tr.time || 0) - options.newGroupDelay
          || !isAdjacentTo(tr, history.prevRanges)))
```

Triggers for a new event:
- First change after history was reset (`prevTime == 0`, also set by `closeHistory`, history.ts:263).
- Time gap exceeds `newGroupDelay` (default **500ms**, history.ts:393).
- The transaction touches a range non-adjacent to `prevRanges` (history.ts:300–310 — overlap test on the first map's ranges).
- IME composition id changed.

`appendedTransaction` is special: it's never a group boundary (`!appended` short-circuits) — see §1.10.

The user can force a new event with the `closeHistory` helper:

```ts
export function closeHistory(tr: Transaction) {
  return tr.setMeta(closeHistoryKey, true)
}
```
(history.ts:366–368)

### 1.7 `popEvent`: undoing one event

(history.ts:29–80)

This is the core algorithm. Walking the rope **backwards** from `items.length`:

```
1. Find the most recent item with a `selection` bookmark.
   That index `end` marks the start of the event being popped.

2. (preserveItems mode): Build a `remap: Mapping` that contains the
   forward maps of every item AFTER `end` (these are the changes that
   landed since the event was recorded — including remote changes
   inserted by addMaps).

3. Iterate items in reverse from items.length-1 down to end:

   if item has no step (map-only filler):
     push its map onto addBefore (preserve in remaining branch),
     mapFrom--

   if item has a step:
     - addBefore.push(new Item(item.map))            // keep the forward
                                                     // map at this slot
     - mappedStep = item.step.map(remap.slice(mapFrom))
     - if mappedStep applies to current doc (transform.maybeStep):
         capture the new forward map produced by transform,
         addAfter.push(new Item(newMap, undefined, undefined,
                                addAfter.length+addBefore.length))
                                ^^^^^^ mirrorOffset — points back at
                                       the item this step UNDOES
     - mapFrom--
     - if newMap, append it to remap so subsequent reversed items
       see the updated mapping

   if item has a selection bookmark (the event boundary):
     selection = remap ? bookmark.map(remap.slice(mapFrom)) : bookmark
     remaining = new Branch with addBefore.reverse() ++ addAfter,
                                 eventCount - 1
     break
```

Returned: `{ remaining: Branch, transform: Transform, selection: SelectionBookmark }`.

The `mirrorOffset` is the trick that lets later operations recognize an item as the inverse of an earlier item, so a `Mapping` built across them can mark them as mirror pairs (`maps.appendMap(map, mirrorPos)` in `remapping`, history.ts:111–119). That makes intervening positions cancel cleanly.

**Why regenerate inverted steps when pushing onto the OTHER branch?** Look at `histTransaction`:

```ts
let pop = (redo ? history.undone : history.done).popEvent(state, preserveItems)
let added = (redo ? history.done : history.undone)
              .addTransform(pop.transform, state.selection.getBookmark(),
                            histOptions, preserveItems)
```
(history.ts:331–343)

`addTransform` calls `transform.steps[i].invert(transform.docs[i])` — re-inverting against the **freshly produced documents**, not against the originals. This matters because during rebase / remap, an originally-invertible operation may have been mapped in a way that the cached inverse is no longer valid; recomputing from the actual `docs` produced by the just-applied transform is always correct.

### 1.8 `Branch.rebased` — collab feedback into history

(history.ts:130–165)

When the collab plugin lands a remote-update transaction with `meta("rebased") = nUnconfirmed`, history calls `done.rebased(tr, nUnconfirmed)` AND `undone.rebased(tr, nUnconfirmed)` (history.ts:287–292).

The `rebasedTransform` looks like (built by `collab.rebaseSteps`, see §2.3):

```
[ inverted local₁, inverted local₂, …, inverted localN,    <- "undo" of locals
  remote₁, remote₂, …, remoteM,                            <- remote changes
  remappedLocal₁, remappedLocal₂, …, remappedLocalK ]       <- locals re-applied (K ≤ N)
```

The mapping has **mirror pairs** between each `inverted localᵢ` and its corresponding `remappedLocalᵢ` (set via `transform.mapping.setMirror`, collab.ts:22).

`rebased(rebasedTransform, rebasedCount)` walks history items at the tail (last `rebasedCount` items, the locals that were rebased) and:

- For each old local item, finds the position of its mirror in the rebasedTransform via `mapping.getMirror(--iRebased)` (history.ts:142). That mirror is the **rebased step** — both its forward map and the freshly inverted step (`rebasedTransform.steps[pos].invert(rebasedTransform.docs[pos])`, history.ts:147).
- Maps the item's selection bookmark through the slice of the mapping between its inverse and its remapped position (history.ts:148).
- If the rebased step disappeared (`getMirror` returns null because the local became a no-op after remote changes), the item is dropped — `eventCount` is decremented for any selection bookmark on dropped items (history.ts:138).
- New map-only items are inserted for the *remote* steps that don't have mirrors in the local set (history.ts:156–158), so future maps see them.

Finally, if too many empty (map-only) items have accumulated (`> max_empty_items = 500`, history.ts:22, 162), `compress` is invoked to squeeze them out (history.ts:179–204).

### 1.9 `compress` — garbage-collecting map-only items

(history.ts:179–204)

Walks items in reverse, building a `remap` accumulating maps, and keeps only items whose step survives mapping. Pure map-only items below `upto` are dropped; their effect is folded into the surviving items via the accumulated `remap`. The result is a leaner branch with the same observable undo/redo behaviour, plus mergeable items get merged via `Item.merge` (history.ts:194–197).

The `upto` parameter exists because `rebased` needs the most recent items to remain in their pre-rebase positions for the next round of rebase to work; only items below the rebase boundary are compressed (history.ts:163).

### 1.10 Interaction with `appendTransaction`

(history.ts:265–276)

```ts
let appended = tr.getMeta("appendedTransaction")
if (appended && appended.getMeta(historyKey)) { ... }
```

When a plugin appends a transaction (via `appendTransaction`) on top of an undo/redo, that appended transaction inherits the undo/redo grouping — i.e. an appended transaction following `undo` is recorded onto `done` as part of the same redo event (history.ts:269–273). When it follows a regular edit, the appended steps are pulled into the current event (the `!appended` test in `newGroup`, line 281, prevents starting a new event purely because of an appended tr).

`appended.getMeta("addToHistory") === false` is honoured (history.ts:277): a plugin can append untracked corrections.

### 1.11 `addToHistory: false`

(history.ts:277, 294–296)

A transaction with `setMeta("addToHistory", false)` does NOT add a recorded event. Its maps are still rolled into both branches via `addMaps` so that existing inverted steps remap correctly. This is exactly what collab's `receiveTransaction` uses (collab.ts:150).

### 1.12 `historyPreserveItems`

(history.ts:345–361, 350: `mustPreserveItems`)

If any plugin in `state.plugins` has `historyPreserveItems: true` in its spec, the history operates in "preserve" mode — no merging, every step keeps its slot, `popEvent` builds the full `remap`, etc. The collab plugin sets this flag (collab.ts:95), because rebase relies on items existing in identifiable positions.

The result is computed lazily and cached against `state.plugins` identity (history.ts:345, 351–360).

### 1.13 `historyKey`, `closeHistoryKey`, public surface

```ts
const historyKey      = new PluginKey("history")          // history.ts:370
const closeHistoryKey = new PluginKey("closeHistory")     // history.ts:371

export function history(config?): Plugin                  // history.ts:391
export function closeHistory(tr: Transaction): Transaction// history.ts:366

export const undo, redo, undoNoScroll, redoNoScroll       // history.ts:436–447
export function undoDepth(state): number                   // history.ts:450
export function redoDepth(state): number                   // history.ts:456
export function isHistoryTransaction(tr): boolean          // history.ts:463
```

The plugin also wires `beforeinput` for `historyUndo` / `historyRedo` input types (history.ts:410–418), which is how undo from the macOS Edit menu / browser native undo reaches PM.

---

## 2. Collab

### 2.1 State shape

```
CollabState
├── version: number                     // last version received from authority
└── unconfirmed: readonly Rebaseable[]  // local steps not yet acked
```
(collab.ts:34–45)

```
Rebaseable
├── step:     Step        // the (possibly rebased) step we want the server to know
├── inverted: Step        // step.invert(docBefore) — used to roll back during rebase
└── origin:   Transform   // the original Transform this step came from (for metadata)
```
(collab.ts:4–10)

The plugin sets `historyPreserveItems: true` so the history plugin keeps each step in its own item slot for rebase (collab.ts:95).

### 2.2 Recording local edits (the apply hook)

```ts
apply(tr, collab) {
  let newState = tr.getMeta(collabKey)
  if (newState) return newState                                        // server-driven
  if (tr.docChanged)
    return new CollabState(collab.version,
                           collab.unconfirmed.concat(unconfirmedFrom(tr)))
  return collab
}
```
(collab.ts:81–88)

Every local docChanged tr appends new `Rebaseable`s — one per step — built by `unconfirmedFrom`:

```ts
function unconfirmedFrom(transform: Transform) {
  let result = []
  for (let i = 0; i < transform.steps.length; i++)
    result.push(new Rebaseable(transform.steps[i],
                               transform.steps[i].invert(transform.docs[i]),
                               transform))
  return result
}
```
(collab.ts:47–54)

Note: `inverted` is captured *eagerly* against `docs[i]` — the live document at the time the step was applied. After rebase, both `step` and `inverted` are recomputed (§2.4).

### 2.3 `sendableSteps(state)`

```ts
export function sendableSteps(state): {
  version, steps, clientID, origins
} | null
```
(collab.ts:162–178)

Returns `null` when `unconfirmed` is empty. Otherwise returns the snapshot the client needs to POST to the authority:

- `version`: collab state's current version (the version the steps are "based on").
- `steps`: the (possibly rebased) `step` field of each unconfirmed.
- `clientID`: from plugin config, defaulting to a 32-bit random int (collab.ts:73).
- `origins`: lazy getter exposing the original `Transform` objects so callers can fish out `tr.time` or other metadata.

The authority is expected to either accept and broadcast at version `v + steps.length`, or reject because a newer version exists, in which case the client polls and `receiveTransaction`s the gap before retrying.

### 2.4 `rebaseSteps(steps, over, transform)` — the core algorithm

(collab.ts:14–27)

Given:
- `steps`: our local unconfirmed `Rebaseable[]` (length N).
- `over`:  the remote `Step[]` arriving from authority (length M).
- `transform`: an empty Transform anchored on the *current* (locally edited) document.

```
Phase 1 — undo all locals (last to first):
  for i = N-1 ↓ 0:
    transform.step(steps[i].inverted)
  // transform.doc is now the doc BEFORE we made local changes,
  // which is exactly the doc the remote steps were authored against.

Phase 2 — apply remote steps in order:
  for i = 0 → M-1:
    transform.step(over[i])
  // transform.doc is now the authoritative new document.

Phase 3 — re-apply locals, rebased through everything that came after:
  result = []
  mapFrom = N
  for i = 0 → N-1:
    mapped = steps[i].step.map(transform.mapping.slice(mapFrom))
    mapFrom--
    if mapped && transform.maybeStep(mapped) succeeded:
      transform.mapping.setMirror(mapFrom, transform.steps.length - 1)
      result.push(new Rebaseable(
        mapped,
        mapped.invert(transform.docs[transform.docs.length - 1]),
        steps[i].origin))
  return result
```

Key details:

- `transform.mapping.slice(mapFrom)` selects only the maps newer than the inverse of step `i`: those are the maps that have moved positions since step `i` was originally applied (the inverses N-1..i+1 plus all of `over` plus already-rebased earlier locals).
- `setMirror` ties each undo-of-local to its rebased re-application so that downstream consumers (notably `Branch.rebased`) can walk mirror pairs. (collab.ts:22 ↔ history.ts:114, 142)
- A step may **fail to apply after rebase** (e.g. it edited content that the remote deleted). Such a step is dropped; the loop continues. The corresponding history item will lose its mirror and be discarded by `Branch.rebased`.
- The freshly inverted step is computed against the *post-rebase* docs, ensuring correctness for non-trivially-invertible operations.

### 2.5 `receiveTransaction(state, steps, clientIDs, options)`

(collab.ts:102–151)

```
1. version' = collabState.version + steps.length
2. ourID = config.clientID

3. // Strip prefix that originated with us:
   ours = number of leading clientIDs equal to ourID
   unconfirmed = collabState.unconfirmed.slice(ours)
   steps       = steps.slice(ours)

4. If steps is empty:
     // pure ack — just bump version, drop ack'd unconfirmed
     return state.tr.setMeta(collabKey,
                             new CollabState(version', unconfirmed))

5. nUnconfirmed = unconfirmed.length
   tr = state.tr
   if nUnconfirmed:
     unconfirmed = rebaseSteps(unconfirmed, steps, tr)
   else:
     for s in steps: tr.step(s)
     unconfirmed = []

6. (optional) mapSelectionBackward: re-resolve text selection with bias -1
   so caret stays "before" inserted content. (collab.ts:145–149)

7. tr.setMeta("rebased",      nUnconfirmed)   // history will pick this up
     .setMeta("addToHistory", false)          // these are remote, not local
     .setMeta(collabKey,      new CollabState(version', unconfirmed))
   return tr
```

Why pop matching `ours` first? When the authority confirms our own steps and broadcasts them back, we receive them with `clientIDs[i] == ourID`. Those don't need re-applying; they only confirm our `unconfirmed` head, which we drop via `slice(ours)`.

The `rebased` meta value is the count of local steps that had to be undone+remapped. The history plugin uses this to know how many of its trailing items correspond to those locals (history.ts:130, "rebasedCount").

### 2.6 Authority responsibilities

The website's `prosemirror-website` collab example implements an authority that:

- Holds the canonical doc and an ever-growing `steps` log with `clientIDs`.
- Accepts `POST /collab/<doc>/events` with `{ version, steps, clientID }`. If `version` matches its current version, it appends and replies 200. Otherwise replies 409 (or returns the gap immediately).
- Serves `GET /collab/<doc>/events?version=<v>` long-polling, returning new steps + clientIDs from version `v` onward.
- Optionally tracks comments/cursors in the same envelope.

The authority itself does no rebasing — clients rebase locally on receive. The authority is just a serial log.

### 2.7 `getVersion(state)`

```ts
export function getVersion(state) {
  return collabKey.getState(state).version
}
```
(collab.ts:182–184)

---

## 3. End-to-end OT-style rebase walkthrough

Two clients **A** and **B** both start at version 3 with the document:

```
v3:  "Hello world"
      0123456789012
```

(Indices are doc positions; punctuation at end included.)

### 3.1 Step 1 — both clients edit locally

**A** types "!" at the end (insert one char at pos 11):
```
A.local₁ = replace(11, 11, "!")
A.docA   = "Hello world!"
A.unconfirmed = [ Rebaseable(local₁, invert(local₁ vs v3), origin) ]
```
A sends `{version:3, steps:[local₁], clientID:A}` to authority.

**B**, simultaneously, replaces "world" with "there" (5..11):
```
B.local₁ = replace(6, 11, "there")
B.docB   = "Hello there"
B.unconfirmed = [ Rebaseable(local₁, invert(local₁ vs v3), origin) ]
```
B sends `{version:3, steps:[local₁], clientID:B}` to authority.

### 3.2 Step 2 — authority serializes A first

Authority accepts A at v3, advances to v4, broadcasts `{steps:[A.local₁], clientIDs:[A]}` to all.
Authority then receives B's request `{version:3, ...}`. **Mismatch.** Authority replies with the gap: `[A.local₁]`.

Client A receives its own confirmation:

```
receiveTransaction(stateA, [A.local₁], [A]):
  ours = 1 (leading clientID matches A)
  unconfirmed = unconfirmed.slice(1) = []
  steps = []
  → state.tr.setMeta(collabKey, new CollabState(4, []))
A.version = 4, A.unconfirmed = []
```

Client B receives the gap:

```
receiveTransaction(stateB, [A.local₁], [A]):
  ours = 0
  nUnconfirmed = 1
  tr = state.tr
  unconfirmed' = rebaseSteps([B.local₁_rebaseable], [A.local₁], tr)
```

Inside `rebaseSteps`:

```
Phase 1: tr.step(B.local₁.inverted)
         tr.doc = "Hello world"      (back to v3)
Phase 2: tr.step(A.local₁)            // insert "!" at 11
         tr.doc = "Hello world!"     (now at v4)
Phase 3: mapped = B.local₁.step.map(tr.mapping.slice(1))
         // tr.mapping has 2 maps: [invert-of-B-local₁, A-local₁].
         // slice(1) starts at A-local₁.
         // A's insertion at 11 doesn't overlap B's range 6..11
         // (A inserts at the boundary; default bias keeps B's range stable).
         mapped = replace(6, 11, "there")           // unchanged here
         tr.maybeStep(mapped) → succeeds
         tr.doc = "Hello there!"
         setMirror(0, 2)   // pair invert-of-B with rebased-B
         result = [ Rebaseable(mapped, mapped.invert(tr.docs[2]), origin) ]
```

`tr` has steps `[invert(B.local₁), A.local₁, mapped(B.local₁)]` and:

```
tr.setMeta("rebased",      1)            // 1 local step was rebased
  .setMeta("addToHistory", false)
  .setMeta(collabKey, new CollabState(4, [Rebaseable(mapped, mapped⁻¹, origin)]))
```

State after applying:
- B.doc: `"Hello there!"`
- B.version: 4
- B.unconfirmed: [the rebased version of B's edit]
- B's history `done` branch — let's trace it:
  - Before receive, `done` had one item: `Item(map=B.local₁.map, step=B.local₁⁻¹, selection=bookmark)`.
  - `applyTransaction` sees `meta("rebased") = 1`:
    ```
    return new HistoryState(
      done.rebased(tr, 1),
      undone.rebased(tr, 1),
      mapRanges(prevRanges, tr.mapping), prevTime, prevComposition)
    ```
    (history.ts:287–292)
  - `done.rebased(tr, 1)`:
    - `start = items.length - 1 = 0` (only one item).
    - Walk last 1 item: find mirror of `iRebased = 0` in `tr.mapping` → that's `pos = 2` (set via setMirror).
    - `step = tr.steps[2].invert(tr.docs[2])` — fresh inverse of *rebased* B step against post-rebase doc.
    - `selection' = bookmark.map(tr.mapping.slice(1, 2))` — map bookmark over A.local₁'s map.
    - rebasedItems = [Item(tr.mapping.maps[2], step', selection')]
    - newMaps for `i in [1, newUntil)` where newUntil = 2: pushes `Item(tr.mapping.maps[1])` — the bare map for A.local₁.
    - items' = [] ++ [Item(A.local₁.map)] ++ [Item(rebased-B-map, rebased-B⁻¹, selection')]
  - Result: B's history now has TWO items — a map-only item for A's remote insertion, then the rebased local — and one event. Undo will correctly remove "there" → "world" while leaving "!" intact.

### 3.3 Step 3 — B retries

B's collab plugin still has one unconfirmed (the rebased version). It POSTs `{version:4, steps:[mapped], clientID:B}`. Authority accepts at v4 → v5, broadcasts `{steps:[mapped], clientIDs:[B]}`.

A receives:

```
receiveTransaction(stateA, [mapped], [B]):
  ours = 0
  nUnconfirmed = 0      // A has no local pending
  tr = state.tr
  for s in steps: tr.step(mapped)
  unconfirmed = []
A.doc = "Hello there!"
A.version = 5
```

B receives its own ack:

```
receiveTransaction(stateB, [mapped], [B]):
  ours = 1
  unconfirmed = []
  steps = []
  → just bump version: B.version = 5, B.unconfirmed = []
```

Both clients converged on `"Hello there!"` at version 5. ✅

### 3.4 ASCII diagram of the rebase

```
             time ─────►
A:  v3 ── localA ──┐                            ack
                   ▼                             │
                 [authority log: A]              │
B:  v3 ── localB ──┐                             │
                   │                             │
                   ▼                             │
                 [authority rejects B,           │
                  sends [A] back at v4]          │
                                                 │
B receives  [A]  →  rebaseSteps(unconfirmed=[localB], over=[A], tr)
            tr =  invert(localB)  ;  A  ;  mapped(localB)
            mapping mirrors: 0 ↔ 2
            new B.doc = "Hello there!"
            B.unconfirmed = [mapped(localB)]
            history.done is rebased: prepend Item(map=A) , replace
            local item with rebased step + remapped bookmark.

B sends mapped(localB) at v4  →  authority accepts → broadcasts.
A applies mapped(localB) directly (no unconfirmed to rebase).
B sees its own clientID, drops unconfirmed, bumps version.

Final convergence: both clients at v5, "Hello there!".
```

A more general two-client diagram:

```
client A unconfirmed: [a₁ a₂ a₃]
client A version: v
                           authority broadcast at v: [r₁ r₂]
                           (these are remote steps from B, not in clientIDs as A)

receiveTransaction([r₁, r₂], [B, B]):
  Phase 1 (undo locals, last→first):
        +--- a₃⁻¹ ---+--- a₂⁻¹ ---+--- a₁⁻¹ ---+
  doc:  D₃  ◄────    D₂   ◄────   D₁  ◄────    D₀     (D₀ = doc at version v)

  Phase 2 (apply remotes):
        +--- r₁ ---+--- r₂ ---+
  doc:  D₀  ────►   D₀'  ───► D₀''                    (the new authoritative doc)

  Phase 3 (re-apply locals, rebased):
        +--- a₁' ---+--- a₂' ---+--- a₃' ---+
  doc:  D₀'' ───►   D₁''  ───►  D₂''   ───► D₃''      (final local view)

  mapping mirrors: invert(aᵢ) ↔ aᵢ'
  unconfirmed' = [a₁', a₂', a₃']     (any aᵢ' that failed is dropped)
  meta: rebased=3, addToHistory=false, collabKey=CollabState(v+2, [a₁',a₂',a₃'])
```

---

## 4. Cross-references and design pickups for our editor

| Concern in our spec                | Mechanism to mirror                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Undo/redo with pluggable extensions | History records ONLY at the Step level. Any extension that wants undo support MUST emit Steps. Side effects in plugins must use `appendTransaction` and either set `addToHistory:false` or rely on grouping (history.ts:265–276). |
| Coalesced typing                   | `Item.merge` + `Step.merge` (history.ts:235–240, plus `prosemirror-transform` ReplaceStep merging). Threshold = `newGroupDelay` (default 500ms). |
| Forced event boundary              | `closeHistory(tr)` meta (history.ts:366–368).                                                                                       |
| "Untracked" mutations              | `setMeta("addToHistory", false)` — still maps history items via `addMaps` (history.ts:121–124, 294–296).                          |
| Collab integration                 | Plugin sets `historyPreserveItems: true` (collab.ts:95). On receive, we emit a tr with `meta("rebased", N)` so history rebases its trailing N items via mirror pairs in the rebase Transform (history.ts:130–165). |
| Authority shape                    | Linear log of `{steps, clientIDs}`; clients submit at known version, authority returns gap on conflict; clients rebase locally (collab.ts:14–27, 102–151). |
| Convergence guarantee              | Sequential rebase against a totally ordered authority log = OT in the "always rebase, never transform-pairs" sense. As long as Step.map is well-defined, all clients converge. |
| Selection preservation             | Bookmarks (`SelectionBookmark`), not Selections, are stored in history items (history.ts:228) and remapped via `bookmark.map(mapping.slice(...))` in both `popEvent` (history.ts:73) and `Branch.rebased` (history.ts:148). |
| Compression                        | When map-only items > 500 (`max_empty_items`), `Branch.compress` collapses them; only items below the rebase boundary (history.ts:163, 179). |

---

## 5. Source citations summary

- `RopeSequence` import — history.ts:1
- `Branch` class — history.ts:24–207
- `Branch.popEvent` — history.ts:29–80
- `Branch.addTransform` — history.ts:83–109
- `Branch.remapping` — history.ts:111–119
- `Branch.addMaps` — history.ts:121–124
- `Branch.rebased` — history.ts:130–165
- `Branch.emptyItemCount` / `compress` — history.ts:167–204
- `cutOffEvents` — history.ts:209–218
- `Item` class with `merge` — history.ts:220–241
- `HistoryState` — history.ts:246–254
- `DEPTH_OVERFLOW` — history.ts:256
- `applyTransaction` (event detection, addToHistory, rebased meta) — history.ts:259–298
- `isAdjacentTo` / `rangesFor` / `mapRanges` — history.ts:300–327
- `histTransaction` — history.ts:331–343
- `mustPreserveItems` — history.ts:350–361
- `closeHistory` — history.ts:366–368
- Plugin keys — history.ts:370–371
- Plugin factory + DOM bindings — history.ts:391–421
- `undo` / `redo` / `*NoScroll` / `undoDepth` / `redoDepth` / `isHistoryTransaction` — history.ts:436–465

- `Rebaseable` class — collab.ts:4–10
- `rebaseSteps` — collab.ts:14–27
- `CollabState` — collab.ts:34–45
- `unconfirmedFrom` — collab.ts:47–54
- `collabKey` — collab.ts:56
- `collab(config)` plugin factory + `historyPreserveItems` — collab.ts:70–97
- `receiveTransaction` — collab.ts:102–151
- `sendableSteps` — collab.ts:162–178
- `getVersion` — collab.ts:182–184

— end of file —

---

## 6. Gap-fill addenda

### 6.1 `depth` and `newGroupDelay` parameters in detail

`history(config?)` (`history.ts:391–393`) accepts:

```ts
{
  depth?: number,            // default 100
  newGroupDelay?: number     // default 500 (ms)
}
```

**`depth`** caps `Branch.eventCount` (the *grouped event* count, not
total step count). Concretely, when `addTransform` lands a step, it
checks `eventCount > histOptions.depth + DEPTH_OVERFLOW` where
`DEPTH_OVERFLOW = 20` (`history.ts:103, 256`):

- The hysteresis (+20) means we only call `cutOffEvents`
  (`history.ts:209–218`) *occasionally*, not on every recording past
  the cap. After each cull, `eventCount` drops back to `depth`, then
  the user adds 20 more events before the next cull — amortizing the
  rope-slice cost.
- `cutOffEvents` walks `items` from the front, finds the first
  group-start (selection bookmark) past the overflow threshold, and
  returns `items.slice(cut)` plus the recomputed `eventCount`.
- An item with a step but **no** selection bookmark inside the cut
  range becomes orphaned (the event-start it referred to has been
  dropped); these items get their step replaced with `null` (line 213)
  so they survive as map-only filler — preserving forward maps for
  remaining items to remap through.

**`newGroupDelay`** is the time gap (in ms) above which a new
transaction starts a *new* event group:

- Compared against `tr.time` (`history.ts:282`), which is a
  `Transaction` field set to `Date.now()` when the tr is constructed.
- 500ms is "between two keystrokes in fluent typing" — so a typing run
  coalesces into a single undo event, but a pause of half a second
  starts a new one.
- Value of 0 disables time-based grouping; only `closeHistory`,
  composition changes, or non-adjacent ranges break events. Value of
  `Infinity` makes the *whole session one event* unless other
  triggers fire — useful for "macro recording" UX.
- Composition-change boundary (`history.prevComposition != composition`,
  line 281) uses `tr.getMeta("composition")` set by `prosemirror-view`'s
  domobserver (file 15); each IME composition session gets its own
  number.

### 6.2 `historyPreserveItems` ref-counting × `compress`

`mustPreserveItems(state)` (`history.ts:345–361`) is **boolean** at any
moment — but it's computed by *iterating state.plugins* and OR-ing
their `historyPreserveItems` spec flag:

```ts
function mustPreserveItems(state: EditorState) {
  let plugins = state.plugins
  if (cachedPreserveItems != plugins) {
    cachedPreserveItemsPlugins = plugins
    cachedPreserveItems = plugins.some(p => p.spec.historyPreserveItems)
  }
  return cachedPreserveItems
}
```

This is **effectively a ref-count over plugin lifetimes**:

- Add the collab plugin → `mustPreserveItems` flips to `true`. From
  this moment, `addTransform` no longer merges items
  (`history.ts:86, 91, 101`) and `popEvent` builds a full `remap`
  (`history.ts:39–62`).
- Remove the collab plugin (e.g. user goes offline, you swap state for
  a single-player one) → flag flips back to `false`. The next
  `addTransform` resumes merging from the *end*, but **existing items
  remain unmerged**. The branch carries the historical "no-merge"
  shape until `compress` collapses it.

Interaction with `compress` (`history.ts:179–204`):

- `compress` is invoked from `Branch.rebased` when
  `branch.emptyItemCount() > max_empty_items (500)` (line 162). It is
  *not* invoked on plain recording.
- During preserve mode, `compress` is *still safe*: items that are pure
  map-only fillers below the rebase boundary (`upto`) get folded into
  the next surviving step's map. Items with steps survive but get
  re-merged via `Item.merge` (lines 194–197) when the predecessor's
  step accepts a `Step.merge`.
- After preserve mode ends, the branch is "long but consistent". The
  next `compress` (which only fires in `rebased`) won't fire because
  there's no rebase. So the branch *stays* shaped as it was during
  collab. This is **intentional** — past undo events recorded during
  collab still have to map cleanly through future remote changes that
  arrive after collab is re-enabled.

In practice: don't toggle `historyPreserveItems` on/off mid-session if
you can avoid it. Either start in preserve mode and stay there, or
keep collab off entirely.

### 6.3 `Selection.getBookmark()` / `bookmark.resolve()` mechanics

History items store `SelectionBookmark`, never `Selection`. The
contract is on `Selection` (file 08) and looks like:

```ts
abstract class Selection {
  abstract getBookmark(): SelectionBookmark
}

interface SelectionBookmark {
  map(mapping: Mappable): SelectionBookmark
  resolve(doc: Node): Selection
}
```

Each `Selection` subclass implements its own bookmark:

- **`TextSelection`** → `TextBookmark { anchor: number, head: number }`.
  `map(m)` returns `new TextBookmark(m.map(anchor), m.map(head))`.
  `resolve(doc)` → `TextSelection.between(doc.resolve(anchor),
  doc.resolve(head))` (note: `between` falls back to a near-by valid
  text position if the exact one is no longer a textblock).
- **`NodeSelection`** → `NodeBookmark { anchor: number }`.
  `map(m)` → `new NodeBookmark(m.map(anchor))`.
  `resolve(doc)` → `NodeSelection.create(doc, anchor)` *if* the
  position still resolves to a node-start; otherwise falls back to
  `Selection.near(doc.resolve(anchor))`.
- **`AllSelection`** → singleton bookmark; `resolve(doc)` → fresh
  `AllSelection(doc)`.

Why bookmarks, not selections, in history items:

1. **A `Selection` requires a `Node` (the doc) to exist.** History
   items survive across many doc generations. Storing a Selection
   would mean storing a stale `Node` reference too, defeating the
   GC-friendliness of immutable history.
2. **Bookmarks are mappable through `Mapping` directly** without doc
   access (`history.ts:73, 148`). `popEvent` builds a `remap: Mapping`
   from later items' StepMaps and calls `bookmark.map(remap.slice(...))`.
3. **Resolution is deferred** to the moment we actually need a
   Selection — typically `setSelection(bookmark.resolve(state.doc))`
   when applying an undo. By that time the doc is the *current* doc,
   so the resolution is meaningful.

A custom `Selection` subclass MUST provide a bookmark (and `map`/
`resolve` on it) for it to participate in undo/redo. Without one,
selections collapse to `TextSelection.between` defaults during undo —
visible to the user as "my fancy column-selection lost its shape after
Ctrl-Z".

### 6.4 `closeHistory(tr)` — full effect

The function (`history.ts:366–368`) is one line:

```ts
export function closeHistory(tr: Transaction) {
  return tr.setMeta(closeHistoryKey, true)
}
```

Then `applyTransaction` (`history.ts:263`) reads the meta:

```ts
if (tr.getMeta(closeHistoryKey))
  history = new HistoryState(history.done, history.undone, null, 0, -1)
```

The reset is *applied before the rest of `applyTransaction` runs*. Its
fields, in detail:

| Field | Pre-reset | After `closeHistory` | Consequence |
|---|---|---|---|
| `done` | preserved | preserved | The undo stack is untouched; the *current* event is closed but everything before it stays. |
| `undone` | preserved | preserved | Same — redo stack survives. |
| `prevRanges` | array of touched ranges | `null` | Adjacency check (`isAdjacentTo`) returns `false` for the next tr → guaranteed new event. |
| `prevTime` | Date.now of last recording | `0` | First check in `newGroup` (`history.ts:280`) is `prevTime == 0` → unconditionally a new event. |
| `prevComposition` | last composition id (or -1) | `-1` | Composition-grouping bypassed; even if the next tr's composition matches the *original* `prevComposition`, `-1` ≠ that value → new event regardless. |

Use cases:

- **Programmatic boundaries**: after running a multi-step refactor (e.g.
  "format document"), wrap the dispatched tr with `closeHistory(tr)` so
  the next user typing starts a new undo event rather than coalescing
  with your formatter.
- **InputRule boundary** (see file 19 §8.6): inside a rule handler,
  `return closeHistory(tr)` to make the rule a discrete undo step.
- **Atomic AI/translation results**: when an async command (file 19
  §8.3) lands its result, dispatch `closeHistory(tr)` to lock that
  insertion as one atomic undo event distinct from preceding typing.

### 6.5 Collab cursor / awareness — full section

The `prosemirror-collab` package handles **document state**, not
**presence**. Showing where peer cursors are — "Alice is editing
here", "Bob has selected this paragraph" — is a separate layer.

The PM-canonical recipe is **decorations driven by peer-state mapped
through `tr.mapping`**.

#### 6.5.1 Data model

```ts
// What you receive from your transport (WebSocket, Yjs, custom):
type PeerAwareness = {
  clientID: string
  name: string
  color: string                    // hex, for the cursor flag
  selection: { anchor: number, head: number }   // in *peer's* version
  basedOnVersion: number           // the collab version they sent at
}
```

Two challenges:

1. **Peer positions are based on a possibly-different version**.
2. **Local edits move peers' cursors** — when I type before Alice's
   cursor, her caret should shift.

#### 6.5.2 The plugin

```ts
import { Plugin, PluginKey } from "prosemirror-state"
import { Decoration, DecorationSet } from "prosemirror-view"

const awarenessKey = new PluginKey<DecorationSet>("collab-awareness")

export function awarenessPlugin(getPeers: () => PeerAwareness[]) {
  return new Plugin<DecorationSet>({
    key: awarenessKey,
    state: {
      init(_, state) { return buildPeerDecorations(state.doc, getPeers()) },
      apply(tr, set, oldState, newState) {
        // 1. Map existing decorations through this transaction's mapping.
        set = set.map(tr.mapping, tr.doc)

        // 2. If the transaction carries new peer state, rebuild.
        const update = tr.getMeta(awarenessKey)
        if (update) set = buildPeerDecorations(newState.doc, update.peers)

        return set
      }
    },
    props: {
      decorations(state) { return awarenessKey.getState(state) }
    }
  })
}

function buildPeerDecorations(doc: Node, peers: PeerAwareness[]) {
  const decos: Decoration[] = []
  for (const peer of peers) {
    const { anchor, head } = peer.selection
    if (anchor < 0 || head > doc.content.size) continue   // out of range
    if (anchor == head) {
      // Caret: a widget decoration with a colored bar
      const flag = document.createElement("span")
      flag.className = "peer-caret"
      flag.style.borderLeftColor = peer.color
      flag.setAttribute("data-name", peer.name)
      decos.push(Decoration.widget(head, flag, {
        side: -1, key: `caret-${peer.clientID}`,
        ignoreSelection: true,
      }))
    } else {
      // Range: an inline decoration with a tinted background
      const [from, to] = anchor < head ? [anchor, head] : [head, anchor]
      decos.push(Decoration.inline(from, to,
        { style: `background:${peer.color}33` },        // 20% alpha
        { inclusiveStart: false, inclusiveEnd: false }))
    }
  }
  return DecorationSet.create(doc, decos)
}
```

#### 6.5.3 Mapping peer cursors through *local* edits

The `set.map(tr.mapping, tr.doc)` call (`apply` step 1 above) is where
peer cursors stay glued to content. `DecorationSet.map`
(`prosemirror-view/src/decoration.ts`):

- For **widget** decorations (carets), uses the `side` to bias mapping:
  `side: -1` keeps the caret on the *left* of an inserted character at
  that position (so my typing pushes Alice's caret right, like a real
  selection would). Use `side: 1` for "stick to right".
- For **inline** decorations (ranges), uses `inclusiveStart` /
  `inclusiveEnd` to control whether insertions at the boundary expand
  or stay outside the highlight.

This means: **once peer awareness is in plugin state, you never need
to re-receive it on every local keystroke** — local edits map peer
positions automatically. You only re-send / re-receive when the *peer*
moves their selection.

#### 6.5.4 Mapping peer cursors through *remote* (collab) edits

When `prosemirror-collab.receiveTransaction` lands remote steps, the
returned tr carries the remote steps in `tr.steps` and the mapping
includes both `invert(localᵢ)` and the remote steps and the rebased
locals (§2.4). `set.map(tr.mapping, tr.doc)` shifts peer positions
through *all* of that — **including** the rebase undo+redo cycle.

But peer cursors are typically based on a specific authority
*version*, not the local view. To handle a peer's broadcast:

```ts
// Transport layer fires this when peer awareness changes.
function onPeerAwareness(peer: PeerAwareness) {
  const localVersion = getVersion(view.state)
  if (peer.basedOnVersion < localVersion) {
    // Map peer.selection forward through the steps the local client
    // has applied since peer.basedOnVersion. The steps are the ones
    // currently in the authority log past peer.basedOnVersion.
    peer.selection = mapPeerSelection(peer.selection, peer.basedOnVersion,
                                       localVersion)
  } else if (peer.basedOnVersion > localVersion) {
    // We're behind — defer or buffer until receiveTransaction catches us
    // up. In practice this is rare because the same transport delivers
    // both step broadcasts and awareness updates; awareness for v=X
    // typically arrives just after step v=X.
    pendingPeerAwareness.push(peer)
    return
  }

  view.dispatch(view.state.tr.setMeta(awarenessKey,
    { peers: [/* updated list */] }))
}
```

`mapPeerSelection` requires access to the authority's step log — the
same log used by `receiveTransaction`. Most apps cache the last `K`
steps locally for exactly this purpose. If you can't map (peer is
arbitrarily far behind), fall back to clamping to nearest-valid via
`TextSelection.between`.

#### 6.5.5 Rendering details

- The widget decoration sets `ignoreSelection: true` so PM's own
  selection management doesn't try to put the local caret into the
  peer-caret DOM.
- Use CSS `::after` for the name flag rather than inline DOM, so the
  flag doesn't affect text layout (peer carets shouldn't reflow lines).
- For **avatars at start-of-paragraph**, prefer `Decoration.widget`
  with a side-padding style; for **inline name labels next to the
  caret**, the same widget with absolute positioning works.

#### 6.5.6 Why this pattern, not native CSS carets

Browsers don't expose multi-cursor carets. Even Selection API's
`addRange` doesn't render visible carets for non-focus selections. The
DecorationSet path is the only way to render peer presence without
forking PM's view-rendering, *and* it composes correctly with
mapping-through-edits.

### 6.6 Comments / annotations anchored across collab

The same DecorationSet pattern handles comments and annotations:

```ts
type Comment = {
  id: string,
  from: number, to: number,        // in *current* local doc
  basedOnVersion: number,
  text: string,
  author: string,
}

const commentKey = new PluginKey<{ comments: Comment[],
                                   decos: DecorationSet }>("comments")

const commentPlugin = new Plugin({
  key: commentKey,
  state: {
    init() { return { comments: [], decos: DecorationSet.empty } },
    apply(tr, val, _, newState) {
      // 1. Map all comment positions through tr.mapping. Use bias=1 for
      //    'from' and bias=-1 for 'to' so insertions at boundaries don't
      //    expand the comment range.
      const comments = val.comments.map(c => ({
        ...c,
        from: tr.mapping.map(c.from, 1),
        to:   tr.mapping.map(c.to, -1),
      })).filter(c => c.from < c.to)              // dropped if collapsed

      // 2. Map decoration set in lockstep
      let decos = val.decos.map(tr.mapping, tr.doc)

      // 3. Apply meta updates (add/remove/edit comments)
      const action = tr.getMeta(commentKey)
      if (action?.add) {
        comments.push(action.add)
        decos = decos.add(tr.doc, [Decoration.inline(action.add.from,
          action.add.to, { class: "comment" }, { id: action.add.id })])
      } /* …remove / edit branches… */

      return { comments, decos }
    }
  },
  props: { decorations(s) { return commentKey.getState(s)!.decos } }
})
```

Properties:

- **Anchors are positions, not content offsets.** They are mapped
  through every transaction (local AND `receiveTransaction`'s rebase
  tr) so they survive collab automatically.
- **Bias control**: `from` mapped with `1` (right-bias), `to` with
  `-1` (left-bias) means typing at either boundary keeps the comment
  range exactly over its original content. Without explicit bias,
  PM's default is to expand inclusively — a comment on "world" becomes
  a comment on "world!" if you type `!` after it.
- **Collapse-on-delete**: when a remote user deletes the entire
  commented range, `from == to` and we filter the comment out
  (line: `.filter(c => c.from < c.to)`). The convention varies — some
  apps keep "orphaned" comments visible at the deletion site; that's a
  product decision. If keeping orphans, store `originalText` and render
  it inline as a strikethrough.
- **Persistence**: the same `setMeta(commentKey, { add: {...} })`
  pattern works for round-tripping comments through your transport.
  Send `(commentId, basedOnVersion, from, to, text)`; on receive, map
  `(from, to)` from `basedOnVersion` to current version using the
  authority's step log (same as awareness in §6.5.4).

### 6.7 Step JSON wire compression

`Step.toJSON()` produces compact-ish objects:

```json
// ReplaceStep("Hello world!" → "Hi world!", from=0, to=5)
{ "stepType": "replace", "from": 0, "to": 5,
  "slice": { "content": [{ "type": "text", "text": "Hi" }] } }
```

Wire-size considerations:

- **Step JSON is the canonical transport** in the official collab
  example. Every confirmed step lives forever in the authority log as
  JSON. For documents with millions of steps, this is the dominant
  storage cost.
- **Per-step overhead is ~30–80 bytes** for typical text edits. A
  paragraph rewrite that touches 5 KB of content is ~5.2 KB of step
  JSON. A single-character insertion is ~80 bytes.
- **Mark sets** are repeated verbatim per text node in the slice — a
  bold insertion repeats `"marks":[{"type":"strong"}]` on every text
  node. For documents with many marks, this is the biggest expansion.
- **Batching**: send N steps per network round-trip rather than 1.
  `sendableSteps` already returns the entire `unconfirmed` array;
  POST it as a single JSON array. The authority serializes them
  atomically.
- **gzip / brotli on the transport**: step JSON compresses extremely
  well (>10×) because mark sets, attribute keys, and step types
  repeat. **Always enable transport compression** for collab — it's
  free win.
- **Schema-aware compression** (custom): if your schema has a fixed
  small set of node/mark types, you can shrink stepType, marks, and
  attribute keys to integer IDs. This is what Yjs/Automerge do
  natively. For PM, a shim layer converting `Step.toJSON()` to a
  varint-tagged binary format is feasible but not in any published
  package.
- **Snapshot vs incremental**: late-joiners (§6.10) get a full doc
  snapshot, not a step replay. After the bootstrap, they switch to
  incremental step receipt. The break-even depends on your edit
  density; 10K steps ≈ 1 MB JSON, which is roughly the size of a
  100KB doc snapshot (the doc itself), so for active docs the snapshot
  is cheaper. For mostly-archived docs with sparse edits, replay can
  be cheaper.

### 6.8 CRDT comparison — PM (OT) vs Yjs / Automerge

| Property | `prosemirror-collab` (OT/rebase) | Yjs (CRDT) | Automerge (CRDT) |
|---|---|---|---|
| **Authority** | Required (single serializer) | Optional (P2P-capable) | Optional (P2P-capable) |
| **Convergence proof** | Sequential rebase against total log; provably converges | Mathematical CRDT proof per type | Mathematical CRDT proof per type |
| **Offline edits** | Possible but unbounded rebase chain on reconnect | First-class, no limit | First-class, no limit |
| **Conflict resolution** | "Last writer (in serialization order) wins"; rebased steps may drop | Per-CRDT-type rules (Y.Text uses fractional indexing) | Per-CRDT-type rules |
| **Per-edit overhead on wire** | ~30–80 bytes (step JSON) | ~10–30 bytes (Yjs binary) | ~30–60 bytes |
| **Per-edit overhead in memory** | None (steps confirmed → discarded) | Tombstones grow with history | Full op log retained |
| **Doc-as-CRDT integration with PM** | Native (this package) | `y-prosemirror` binding maintains a Y.XmlFragment in lockstep with PM doc | Less mature; community bindings |
| **Selection / undo / inputrules** | Native PM, fully integrated | Works through `y-prosemirror` shim, with caveats around undo on remote ops | Limited |
| **Bandwidth on idle** | 0 (no log replay) | Minimal (sync protocol pings) | Minimal |
| **Scale** | Bounded by authority throughput; ~100s of edits/s typical | Lower coordinator load, higher per-doc memory | Higher per-doc memory |
| **Schema** | Strict (PM schema enforced at every step) | Loose (Y.XmlFragment is structurally permissive) | Strict-ish |

**When to choose PM-collab (this package)**:
- You have, or can run, a serializing authority (Node, Rust, Cloudflare
  DO, Postgres-as-coordinator).
- Edits arrive online; offline tolerance is minutes, not days.
- You want native PM history, input rules, and selection semantics with
  zero shim layer.

**When to choose Yjs (`y-prosemirror`)**:
- You need offline editing for hours/days.
- You need P2P or no-server architecture (WebRTC).
- You can accept that PM's history plugin needs replacement (Yjs has
  its own Y.UndoManager that's per-client; semantics differ).

**When to choose Automerge**:
- You need formal verification or are integrating with other
  Automerge-using systems.
- The schema is loose enough that PM's strict validation isn't a fit.

PM-collab's "OT-style rebase" is mathematically OT in the limited form
"clients always rebase against authoritative serialization, never
transform pairs". It avoids the full OT minefield (operation
transformation matrices, transformation property TP1/TP2) by punting
serialization to the authority. Convergence holds as long as
`Step.map` is well-defined for every Step type — which is enforced by
the Step interface contract (file 05).

### 6.9 Mirror map — *why* (expanded)

`transform.mapping.setMirror(invertI, rebasedI)` (`collab.ts:22`) is
called for each successfully-rebased local step. The "mirror"
relationship records that the position-shift introduced by `invert(i)`
is *exactly cancelled* by the position-shift of `rebased(i)`.

Without mirror pairing, a position mapped through the entire rebase
transform would be **double-shifted**. Imagine a position at offset 50
in the original local doc:

```
maps in transform.mapping (in order):
  m_inv_3   = invert of localStep 3   (e.g. "delete chars at [40,45]" inverted → insert)
  m_inv_2   = invert of localStep 2
  m_inv_1   = invert of localStep 1
  m_remote_1, m_remote_2, …          (remote inserts/deletes)
  m_local_1' = rebased localStep 1   (re-applies a delete at remapped position)
  m_local_2' = rebased localStep 2
  m_local_3' = rebased localStep 3
```

A naive `mapping.map(50)` would walk all 9 maps. The inverts shift 50
"up" (re-inserting deleted content), then the rebased copies shift it
"back down" (deleting it again). The result *should* be 50 (or 50
shifted by the *remote* effects), but if the inverts and re-applies
weren't recognized as paired, intermediate maps could mis-apply
deletion bias.

With `setMirror`, `Mapping.map` (file 06) detects the pair and **skips
the redundant pair** for positions that fall *outside* the deletion's
range. Specifically, the mirroring information is used by
`StepMap.recover` and friends to know that a position deleted by
`m_local_1'` and re-inserted by `m_inv_1` should be tracked as
"recoverable" rather than "lost".

`Branch.rebased` (`history.ts:130–165`) uses `mapping.getMirror(i)` to
**locate the rebased copy of an inverted step** — given the inverted-
local position `i`, it asks "where did this step end up after rebase?"
and gets back the rebasedᵢ index, or `null` if the rebased step
failed to apply (was dropped). That's how history items recover their
rebased forward-map without scanning the whole transform.

The TL;DR: mirror pairing is what makes the rebase *transparent* to
position consumers (history items, decorations, comments, awareness)
that map through the entire combined transform.

### 6.10 Late-joining client bootstrap

A new client at version `v_new` joining a doc currently at
`v_authority` must obtain a starting state and reach
`v_authority` before applying any local edits. Two patterns:

#### Pattern A — Snapshot

```
1. Client requests GET /collab/<doc>/state
2. Authority responds:
     {
       version: 142,
       doc: { ... full PM doc JSON, via doc.toJSON() ... },
       schemaVersion: "1.3",
       comments: [...],
       awareness: [...]   // current peer states
     }
3. Client constructs EditorState:
     EditorState.create({
       doc: schema.nodeFromJSON(snapshot.doc),
       plugins: [..., collab({ version: snapshot.version })],
     })
4. Client begins long-polling GET /collab/<doc>/events?version=142
5. Steps committed during steps 1-4 arrive in step 4's response and
    are applied via receiveTransaction.
```

**Pros**: O(doc size) bandwidth regardless of history depth.
**Cons**: doesn't give the client the step history (so no client-local
undo of pre-join changes). Most apps accept this — undo across
sessions is a separate problem (§6.12).

#### Pattern B — Step replay

```
1. Client requests GET /collab/<doc>/state?fromVersion=0
2. Authority responds with all steps + clientIDs from version 0.
3. Client builds an empty doc (or a known-template doc), then applies
    every step via Transform / dispatch.
4. Switches to incremental polling.
```

**Pros**: client gets full history, can show "edited by N changes",
allows time-travel.
**Cons**: O(step-count) bandwidth — typically much larger than the
snapshot for an active doc.

**Practical recommendation**: Pattern A for default. Reserve Pattern B
for time-travel UIs ("show me the doc at version 50") that compute
intermediate doc snapshots from `step.apply` walks server-side.

### 6.11 Permanent undo across sessions — persistence patterns

PM's history plugin stores `HistoryState` in plugin state, which lives
in `EditorState`, which lives in memory. **Closing the browser drops
undo history.** To persist:

#### Naive: serialize plugin state

```ts
// Save
const json = historyKey.getState(view.state).toJSON?.()
localStorage.setItem(`hist:${docId}`, JSON.stringify(json))
// Load
const json = JSON.parse(localStorage.getItem(`hist:${docId}`))
const state = EditorState.create({
  doc, plugins: [history({ /* config */ })]
})
// then... no public API to restore HistoryState from JSON
```

`HistoryState` has **no `toJSON`** (`history.ts:246–254`) and no
public restore path. The rope-of-Items structure isn't designed for
serialization (selection bookmarks are abstract; some Step subtypes
serialize but Items aren't a Step).

#### Practical: store the inverted-step transcript yourself

Because you know what `addTransform` *will* store (one Item per Step
with the inverted Step), you can shadow-record:

```ts
const undoLog: { invertedJSON: any, selectionBefore: any }[] = []

const view = new EditorView(target, {
  state,
  dispatchTransaction(tr) {
    // Capture inversions BEFORE applying.
    if (tr.docChanged && tr.getMeta("addToHistory") !== false) {
      const invs = tr.steps.map((s, i) => s.invert(tr.docs[i]).toJSON())
      undoLog.push({
        invertedJSON: invs,
        selectionBefore: view.state.selection.toJSON(),
      })
      persistAsync(undoLog)
    }
    view.updateState(view.state.apply(tr))
  }
})
```

Restore by replaying. Caveats:

- **Position rebasing across sessions**: if remote edits happened
  while you were offline, the inverted steps need rebasing through
  the remote step log before they can be applied. This is the
  `rebaseSteps` algorithm (§2.4) used in reverse — undo the local
  steps, apply the remote ones, then map the inversions through.
- **Schema changes**: if the schema has changed, old step JSON may
  reference removed node/mark types and `Step.fromJSON` will throw.
  Either freeze schema versions or migrate the log (§6.16).

For most products, "undo only within the current session" is the
right scope; persistent undo is a niche feature. Linear and Notion
both reset undo on reload.

### 6.12 3-client conflict scenario

Three clients **A**, **B**, **C** at version 5 with doc `"foo bar"`
(positions 1..7).

- **A** appends `"!"` at end (insert at 8) → `local_A`.
- **B** replaces `"bar"` with `"baz"` (4..7) → `local_B`.
- **C** wraps the whole thing in bold (mark range 1..8) → `local_C`.

All three send `{ version: 5, ... }` simultaneously.

#### Phase 1: Authority serializes (say, A then B then C)

Authority log appends `local_A` at v=6, `local_B` at v=7, `local_C` at
v=8.

#### Phase 2: A receives `[local_B, local_C]` (clientIDs `[B, C]`)

- `ours = 0` (A's queue head is unrelated to incoming clientIDs).
- `nUnconfirmed = 0` (A's local_A was already acked at v=6 in a prior
  receive).

Wait — actually, A's request for `local_A` returns:
- *its own ack* `{ steps: [local_A], clientIDs: [A] }` arrives first
  (v=5→6).
- Then `[local_B, local_C]` arrives at v=6→8.

Each is a separate `receiveTransaction`. After both, A's doc is
`"foo baz!"` with bold over 1..8. No rebase needed.

#### Phase 2': B receives `[local_A]` (clientIDs `[A]`) at v=5→6

- `ours = 0`, `nUnconfirmed = 1` (local_B in queue).
- `rebaseSteps([local_B], [local_A], tr)`:
  - Phase 1: `tr.step(invert(local_B))` → doc back to `"foo bar"`.
  - Phase 2: `tr.step(local_A)` → doc `"foo bar!"`.
  - Phase 3: `mapped = local_B.map(slice(1))` → `replace(4,7,"baz")`
    is unaffected by A's append at 8 → `mapped = local_B`.
  - `tr.maybeStep(mapped)` → doc `"foo baz!"`.
  - `setMirror(0, 2)`.
- `tr` carries `meta: rebased=1, addToHistory=false, collabKey={v=6,
  unconfirmed=[mapped(local_B)]}`.

B's doc now `"foo baz!"`, version 6, unconfirmed `[mapped(local_B)]`.
B sends `{version:6, steps:[mapped(local_B)], clientID:B}`.

But authority is already at v=8. Authority responds with the gap:
`{steps: [local_B (already-applied), local_C], clientIDs: [B, C]}`.

Wait — actually authority responded earlier when B's POST arrived
*after* A's commit but *before* C's commit. It would have replied with
just `[local_A]`. Then B retries at v=6 and fails because authority
is now at v=7 (after B was applied). Authority replies with **gap from
v=6 to v=8**: `[local_B, local_C]`. Wait — but `local_B` is B's own;
authority's log records it at v=7 with clientID `B`. So the gap reply
is `{steps: [local_B, local_C], clientIDs: [B, C]}` at version `8`.

#### Phase 2'': B receives `[local_B, local_C]` (clientIDs `[B, C]`)

- `ours = 1` (clientID[0] == B). Pop unconfirmed[0], drop steps[0].
- Remaining: `steps = [local_C]`, `clientIDs = [C]`,
  `unconfirmed = []`.
- `nUnconfirmed = 0`, so just `tr.step(local_C)`.
- B's doc `"foo baz!"` + bold 1..8 = `"foo baz!"` with bold.

B is now at v=8, unconfirmed `[]`. ✓

#### Phase 2''': C receives `[local_A]` then `[local_B]`

When C is at v=5 and receives `[local_A]`:
- `nUnconfirmed=1`, rebase `local_C` over `local_A`:
  - Phase 1: undo local_C (remove bold).
  - Phase 2: apply local_A.
  - Phase 3: `mapped = local_C.map(slice(1))` → bold range was 1..8,
    A's insertion at 8 with default right-bias keeps end at 8 (or
    extends to 9, depending on AddMarkStep's mapping bias — it's
    9 because AddMarkStep treats end inclusively). `mapped = bold
    1..9`.
- C's doc `"foo bar!"` with bold 1..9.

When C is at v=6 and receives `[local_B]`:
- `nUnconfirmed=1` (mapped local_C). Rebase over local_B.
  - Phase 1: undo mapped local_C → doc `"foo bar!"`.
  - Phase 2: apply local_B → doc `"foo baz!"`.
  - Phase 3: `mapped' = mapped.map(slice(1))` → bold 1..9 maps to
    bold 1..9 (B replaced 4..7 with same length, so end position
    unchanged).
- C now at v=7, unconfirmed `[mapped' local_C]`.

C sends `mapped' local_C` at v=7. Authority receives, but its log
already has C's bold at v=8 (which was `local_C` *un-rebased*). HERE'S
THE TRICKY BIT: the authority *can't* recognize that the rebased
mapped' local_C and the original local_C (already in the log) are
"the same edit" — they're different Step JSONs.

In practice, the authority would have committed C's *original* steps
when they arrived at version 5; if they arrived after A and B, the
authority would've rejected them with a gap from 5→7. C would then
rebase as above. The authority log only contains the *final* rebased
form.

#### Convergence

All three at version 8, doc `"foo baz!"` with bold 1..9 (or 1..8
depending on Step bias). The three operations commute under PM's
StepMap because:

- Insertions and replacements at non-overlapping ranges commute
  trivially.
- Mark addition over the full range commutes with both, *as long as
  AddMarkStep.map handles end-position bias consistently* (it does;
  see file 05).

The 3-client case works because **each pair-wise receive** is an
independent rebase against an authoritative serialization. Conflicts
that would be hard in classical OT (3-way merging with concurrent
edits at the same position) reduce to "rebase against the linear log
in the order the authority chose".

### 6.13 Step-fork attack detection on the server

A malicious client could:

1. **Lie about version**: claim `version: 42` when it's really at 30,
    hoping to skip rebasing 12 remote steps and overwrite content.
2. **Replay**: re-POST steps from old version with new clientID.
3. **Forged steps**: craft a Step JSON that, when applied to authority's
    doc, produces a doc the client never agreed to (e.g. inserting at
    a position they couldn't have known about).

Authority defenses:

- **Version match required for accept**: authority MUST refuse any
  POST whose `version` ≠ its current version. This is the single most
  important check (`collab.ts` example server: see file 06 / file 21
  cross-refs and the `prosemirror-website` collab example).
- **Apply server-side**: authority MUST execute every incoming step
  via `Step.apply(currentDoc)` and only accept on success. A forged
  step that would mutate disallowed structure throws and is rejected.
  This eliminates "forge a step that the schema rejects".
- **ClientID auth**: clientID in the POST is *user-asserted*. The
  authority should **also** authenticate the connection (cookie,
  bearer token) and verify the asserted clientID matches the
  authenticated user. Otherwise client A can claim to be B.
- **Rate / size limits**: per-client step rate, per-step size. PM
  itself has no such limits.
- **Version-skew detection**: if a client repeatedly POSTs at a
  *higher* version than the authority's current version (claiming
  edits-from-the-future), drop the connection. This shouldn't happen
  legitimately.
- **Step-shape sanity**: reject step JSONs whose `from`/`to` exceed
  `currentDoc.content.size`. PM's `Step.fromJSON` doesn't validate
  positions — it only validates structure.

The attacks **PM cannot defend against** at this layer:
- A client with valid auth that simply makes a destructive valid edit
  (e.g. delete the whole doc). This is an authorization problem,
  solved with per-range or per-document permissions outside PM.
- Replay of a *valid* step the user already submitted: the version-
  match check filters these unless the attacker also predicts the
  current version. For idempotency, authority can dedup by
  `(clientID, version)` pairs.

### 6.14 Selective undo (undo-just-my-change) in collab

PM's `undo` command pops the **most recent event** from `done`, period.
In collab, that event is *your* most recent local edit (because remote
edits go into history as map-only items via `addMaps`, not as recorded
events — `history.ts:121–124, 294–296`).

So **selective undo "just my changes" is the default**. There's no
need to filter by clientID; remote changes never appear in your
`done` stack as undoable events.

Caveat: if your most recent local edit was at position X and a remote
user has since deleted the content at X, the inverted step from your
edit may fail to apply post-rebase (`maybeStep` returns null,
`history.ts:53–56`). In that case `popEvent` finds an effectively-
empty event and `undo` returns `false`. The next `undo` call pops the
*previous* local event.

For "undo a specific local edit, not necessarily the most recent",
PM does **not** support this directly. Patterns:

- **Tagged events**: stamp each local tr with a meta key
  `tr.setMeta("editTag", uniqueId)`. To undo a specific edit, walk
  history... except history items don't expose meta. You'd need to
  shadow-record (similar to §6.11) and replay the inverted step
  manually, then dispatch with `addToHistory: false`.
- **Linear inverse**: dispatch `tr.step(originalStep.invert(originalDoc))`
  with the cached inversion. Mark `addToHistory: false` so it doesn't
  show up as a regular undo. This is what comment-system "delete
  edit" features typically do.

### 6.15 Failure mode — step `from`-pos no longer exists post-rebase

`tr.maybeStep(mapped)` (`collab.ts:24`) returns a result object:

```ts
{ failed?: string, ...transform fields }
```

If `failed`, the transform is unchanged (the step was not appended).
`rebaseSteps` checks `!result.failed` (line 24); if failed, the step
is **dropped** — no exception, no warning. Specifically:

- **Position deleted**: the original step inserted at position 50, but
  remote steps deleted [45, 60]. `mapped.from` = `mapped.to` = the
  collapsed deletion point; the insert applies *there* (technically
  succeeds). For `replace` steps over a now-deleted range, `mapped`
  becomes `replace(point, point, content)` — also applies as an
  insert.
- **Range invalid**: an `addMark(50, 100, ...)` step where positions
  50 and 100 ended up in different parents post-rebase. `Step.map`
  returns `null` *or* `Step.apply` fails. Dropped.
- **Schema invalidation**: a `setBlockType(node, paragraph)` step
  where the parent post-rebase no longer permits paragraph as that
  child. `apply` fails. Dropped.

When dropped, `Branch.rebased` (`history.ts:138`) loses the mirror,
so the corresponding history item is removed, decrementing
`eventCount` if the dropped item carried a selection bookmark
(`history.ts:138`).

User-visible consequence: **the local edit silently disappears** as
if it had been transformed away. There's no signal at the API
boundary. If you need to detect this, wrap `receiveTransaction` and
compare `unconfirmed.length` before vs after the meta payload:

```ts
const before = unconfirmedBefore.length
const tr = receiveTransaction(state, steps, clientIDs)
const after = (tr.getMeta(collabKey) as any).unconfirmed.length
const dropped = (before - sames(steps, clientIDs)) - after
if (dropped > 0) console.warn(`${dropped} local steps dropped on rebase`)
```

In practice, dropped-on-rebase is rare for typical text edits but
common for structural edits (lift, wrap, setBlockType) under
concurrent edits.

### 6.16 Schema migration on the wire

PM steps are tied to schema by:

- Node/mark **type names** (strings) referenced in `nodeFromJSON`,
  `Mark.fromJSON`, and `Step.fromJSON`.
- **Required attributes** — a `NodeType` with a non-defaulted attr
  fails to construct from JSON missing it.
- **Content expressions** — a step that produces content valid in v1's
  schema may violate v2's content match.

Thus collab does **not** handle schema migration on the wire. If the
authority's schema changes:

1. **Old clients send step JSON valid for v1**, the authority parses
   it against v2 — `Node.fromJSON` may throw, or the step may apply
   but produce a doc that *next* steps reject.
2. **Old clients receive step JSON valid for v2** (unknown node type,
   new required attrs) — the client's `Step.fromJSON` throws.

Migration patterns used in production (none built-in to PM):

- **Frozen schema versions**: each doc records its `schemaVersion`.
  Authority refuses connections for clients on a different version.
  Migration is a separate offline operation: read all steps, replay
  through a v1 schema to build the doc, transform the doc with a
  custom function to v2 shape, then snapshot at v2 with no preserved
  history.
- **Backward-compatible additions only**: never rename or remove a
  node/mark type; never add a required attribute (always default).
  Removed types become "frozen" types still parseable by old clients.
- **Reverse-compatibility-shim layer**: at the wire boundary,
  serialize the doc through `doc.toJSON()` then through a shim that
  rewrites unknown attrs / adds defaults / collapses removed types.
  The shim runs both directions and is keyed on
  `(stepJsonSchemaVersion, localSchemaVersion)`.

Realistically: lock your schema before going live with collab. Treat
schema changes as breaking and require all clients to reload before
any v2 step lands on the authority.

### 6.17 Authority server example (Node + Express)

A minimal in-memory authority for the official `prosemirror-collab`
client. Single-doc, single-process; production needs a database and
locking but the protocol is the same:

```ts
// server.ts
import express from "express"
import { Schema, Node } from "prosemirror-model"
import { Step } from "prosemirror-transform"
import { schema } from "./schema"            // your shared schema

const app = express()
app.use(express.json({ limit: "1mb" }))

type StoredStep = { stepJson: any, clientID: string }

class Authority {
  doc: Node
  steps: StoredStep[] = []
  waiters: Array<(steps: StoredStep[]) => void> = []

  constructor(initialDoc: Node) { this.doc = initialDoc }

  get version() { return this.steps.length }

  /** POST /events */
  receive(version: number, stepJsons: any[], clientID: string) {
    if (version != this.version) {
      // Conflict: caller is behind. They will GET to catch up, then retry.
      return { status: 409, body: this.gapFrom(version) }
    }
    let doc = this.doc
    const newStored: StoredStep[] = []
    for (const j of stepJsons) {
      const step = Step.fromJSON(schema, j)
      const result = step.apply(doc)
      if (result.failed) return { status: 400, body: result.failed }
      doc = result.doc!
      newStored.push({ stepJson: j, clientID })
    }
    this.doc = doc
    this.steps.push(...newStored)
    this.flushWaiters()
    return { status: 200, body: { version: this.version } }
  }

  /** GET /events?version=N (long-poll) */
  async events(fromVersion: number, signal?: AbortSignal): Promise<StoredStep[]> {
    if (fromVersion < this.version) return this.gapFrom(fromVersion)
    return new Promise(resolve => {
      const onSteps = (steps: StoredStep[]) => resolve(steps)
      this.waiters.push(onSteps)
      signal?.addEventListener("abort", () => {
        this.waiters = this.waiters.filter(w => w !== onSteps)
        resolve([])
      })
    })
  }

  private gapFrom(version: number): StoredStep[] {
    return this.steps.slice(version)
  }
  private flushWaiters() {
    const ws = this.waiters; this.waiters = []
    for (const w of ws) w(this.gapFrom(this.version - 1))
  }

  /** GET /state — snapshot for late joiners */
  snapshot() {
    return { version: this.version, doc: this.doc.toJSON() }
  }
}

const authority = new Authority(schema.node("doc", null, [schema.node("paragraph")]))

app.get("/state", (req, res) => res.json(authority.snapshot()))

app.get("/events", async (req, res) => {
  const v = parseInt(req.query.version as string, 10) || 0
  const ac = new AbortController()
  req.on("close", () => ac.abort())
  const steps = await authority.events(v, ac.signal)
  res.json({
    version: v + steps.length,
    steps:     steps.map(s => s.stepJson),
    clientIDs: steps.map(s => s.clientID),
  })
})

app.post("/events", (req, res) => {
  const { version, steps, clientID } = req.body
  const r = authority.receive(version, steps, clientID)
  res.status(r.status).json(r.body)
})

app.listen(3000)
```

Properties this implements:

- **Linear log**: `steps` is append-only. Every accepted POST appends
  N entries; version is the array length.
- **Apply server-side**: every step is `Step.fromJSON(schema, json)`
  then `step.apply(doc)`. A failure is a 400, not silent corruption.
- **Long-poll for events**: GET blocks until new steps exist past
  `fromVersion`, using a waiter list. AbortSignal cleans up if the
  client disconnects.
- **Late-joiner snapshot**: GET /state returns the live doc + version.

**Production gaps** (intentionally omitted): persistence (steps in
Postgres/Redis), per-doc routing (multiple docs), authentication,
rate-limiting, dedup of `(clientID, version)`, schema-version
matching, awareness/comments envelopes (§6.5/6.6).

### 6.18 WebSocket / SSE / CRDT integration example

The HTTP long-poll above is the simplest transport but high-latency.
A WebSocket variant inverts the polling:

```ts
// client.ts (sketch)
const ws = new WebSocket("ws://localhost:3000")

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.type == "steps") {
    const stepObjs = msg.steps.map((j: any) => Step.fromJSON(schema, j))
    view.dispatch(receiveTransaction(view.state, stepObjs, msg.clientIDs))
  } else if (msg.type == "ack") {
    // Pure ack — receiveTransaction with empty steps still progresses version.
    view.dispatch(receiveTransaction(view.state, [], []))
  } else if (msg.type == "awareness") {
    view.dispatch(view.state.tr.setMeta(awarenessKey, { peers: msg.peers }))
  }
}

// Send local edits whenever there are unconfirmed.
view.someProp = "..."
function send() {
  const sendable = sendableSteps(view.state)
  if (!sendable) return
  ws.send(JSON.stringify({
    type: "steps",
    version: sendable.version,
    steps: sendable.steps.map(s => s.toJSON()),
    clientID: sendable.clientID,
  }))
}
```

Server side, broadcast on accept:

```ts
// In Authority.receive, after accepting:
broadcast({ type: "steps", steps: stepJsons, clientIDs: [clientID, ...] })
```

For **SSE**, the server side becomes a `text/event-stream` response;
the client uses `EventSource`. Same JSON shapes. SSE is one-way, so
the client still POSTs to send.

For **CRDT integration** (Yjs / Automerge under PM):

```ts
import * as Y from "yjs"
import { ySyncPlugin, yCursorPlugin, yUndoPlugin }
                                    from "y-prosemirror"

const ydoc = new Y.Doc()
const yXmlFragment = ydoc.getXmlFragment("prosemirror")

const state = EditorState.create({
  schema,
  plugins: [
    ySyncPlugin(yXmlFragment),       // replaces prosemirror-collab
    yCursorPlugin(awareness),         // awareness from y-protocols
    yUndoPlugin(),                    // replaces prosemirror-history
  ]
})
```

When using y-prosemirror:

- **Don't include `prosemirror-collab` or `prosemirror-history`** in
  the plugin list — they'd conflict. yUndoPlugin is per-client
  (origin-aware undo) and uses Yjs's built-in undo manager.
- The `Y.Doc` is the source of truth; PM's doc is regenerated from it
  on every sync. Bidirectional shim handles the conversion.
- Awareness is a Yjs protocol concept (`y-protocols/awareness`); the
  awareness plugin renders peer cursors via decorations the same way
  §6.5 describes.

**Inconsistency note (§1.13 fix)**: in §1.13 the line "`historyKey,
closeHistoryKey, public surface`" lists `closeHistoryKey` as a public
API name. It is **not** — `closeHistoryKey` is a private `PluginKey`
(`history.ts:371`) and the public function is `closeHistory(tr)`
(`history.ts:366`). The public surface is:

```ts
export function history(config?): Plugin
export function closeHistory(tr: Transaction): Transaction
export const undo, redo, undoNoScroll, redoNoScroll
export function undoDepth(state): number
export function redoDepth(state): number
export function isHistoryTransaction(tr): boolean
// Plus the historyKey PluginKey is exposed via type-checking only.
// closeHistoryKey is internal.
```

Don't reference `closeHistoryKey` from application code — use
`closeHistory(tr)` to set the meta, and the plugin will read it via
its own private key.
