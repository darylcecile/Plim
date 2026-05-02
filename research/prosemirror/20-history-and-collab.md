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
