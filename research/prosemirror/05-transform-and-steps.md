# 05 — Transform & Steps

> Source: `prosemirror-transform/src/`
> Files cited: `step.ts`, `transform.ts`, `replace_step.ts`, `replace.ts`, `mark_step.ts`, `attr_step.ts`, `mark.ts`, `structure.ts`, `index.ts`.

This document is the deep dive on ProseMirror's mutation layer. The key idea: a document never mutates in place. Instead, every change is a **`Step`** — a tiny, self-contained, value-typed description of a delta. A `Transform` is just an ordered list of steps applied to a starting document. Everything else (history, collab, mapping selections, paste handling, list lifting…) is plumbing on top of that primitive.

---

## 1. Why steps exist

A `Step` is the smallest unit of change in ProseMirror. It must satisfy four properties — these are non-negotiable design contracts and motivate every API in the package:

1. **Atomic.** A single step describes one logical change. It either fully applies or fails (`StepResult.fail`); there is no half-applied state. Larger user actions (e.g. "paste a slice across three paragraphs") decompose into a *sequence* of steps. (`step.ts:16-46`).
2. **Invertible (given the pre-document).** Every step can be inverted into a step that undoes it, but **only when handed the document the step ran against**. The pre-doc is needed because a step like `ReplaceStep(5, 12, slice)` doesn't carry the *replaced* content — it only carries the *replacement* — so the inverter has to look up what was at `[5,12)` in the original doc. This is what makes undo (in `prosemirror-history`) cheap: store steps + pre-docs (or just enough state), invert on demand. (`step.ts:28-30`, `replace_step.ts:38-40`).
3. **Serializable.** Every step has `toJSON()` / `fromJSON()` and is registered under a string `stepType` ID via `Step.jsonID(...)`. This is what makes collab transmittable over the wire and what lets `prosemirror-history` survive a reload. (`step.ts:42-66`, e.g. `Step.jsonID("replace", ReplaceStep)` at `replace_step.ts:88`).
4. **Mappable / rebasable.** Each step exposes `getMap(): StepMap` describing how positions on the *old* doc translate to positions on the *new* doc, and `map(mapping): Step | null` to rebase the *step itself* through a mapping (so it can be re-applied on a different base, possibly returning `null` if the step was deleted by the rebase). This is what makes operational-transform-style collab work in ProseMirror. (`step.ts:23-35`).

The **collab** consequence: because steps are values that round-trip JSON and rebase through mappings, two clients can each emit a sequence of steps locally, ship them to a central authority, and have the authority rebase remote steps over local ones (or vice versa) without ever merging documents directly.

The **history** consequence: `prosemirror-history` keeps a stack of `(step, invertedStep, mapping)` tuples. Undo just re-applies the inverted step (after mapping it through anything that has happened since). No "snapshot the doc" needed.

---

## 2. `Step` abstract base & `StepResult`

`step.ts` defines two classes:

### `Step` (`step.ts:16-67`)

```ts
abstract class Step {
  abstract apply(doc: Node): StepResult           // 21
  getMap(): StepMap { return StepMap.empty }      // 26 — default: no position changes
  abstract invert(doc: Node): Step                // 30
  abstract map(mapping: Mappable): Step | null    // 35
  merge(other: Step): Step | null { return null } // 40 — default: never merges
  abstract toJSON(): any                          // 46
  static fromJSON(schema, json): Step             // 50  dispatches via stepsByID
  static jsonID(id, stepClass)                    // 61  registers a step type
}
```

A few subtleties:

- `getMap()` defaults to `StepMap.empty`, used by steps that don't move positions (e.g. mark steps, attribute steps — `attr_step.ts:29-31`, `attr_step.ts:75-77`). Replace-style steps override it to report deletions/insertions.
- `merge` is the **compaction** hook (see §7). A no-op by default; `ReplaceStep` and the mark steps override it.
- `Step.jsonID` registers the class in a private `stepsByID` table (`step.ts:5`) and *also* writes the ID onto the prototype as `jsonID` so `toJSON` implementations can pick the right `stepType` string. (Look at line 64: `;(stepClass as any).prototype.jsonID = id`.)

### `StepResult` (`step.ts:71-97`)

```ts
class StepResult {
  constructor(readonly doc: Node | null, readonly failed: string | null) {}
  static ok(doc): StepResult                              // 81
  static fail(message: string): StepResult                // 84
  static fromReplace(doc, from, to, slice): StepResult    // 89
}
```

`StepResult.fromReplace` is the universal "try `doc.replace(...)` and translate `ReplaceError` into a failed result" helper. Almost every concrete step uses it (`replace_step.ts:31`, `mark_step.ts:37, 93, 146, 198`, `attr_step.ts:26`).

This is the only failure channel in the whole step abstraction: `apply` returns a `StepResult`; `Transform.step` checks `result.failed` and throws a `TransformError` (`transform.ts:48-52`); `Transform.maybeStep` swallows the failure and returns the result for the caller to inspect (`transform.ts:56-60`). `DocAttrStep.apply` is the lone step that can never fail — see `attr_step.ts:67-73`, it never calls `fromReplace`.

---

## 3. Concrete step types

Six step classes are shipped. Each one is registered with `Step.jsonID(<id>, Class)`. The IDs are:

| Class                  | jsonID         | File:line             |
|------------------------|----------------|-----------------------|
| `ReplaceStep`          | `replace`      | `replace_step.ts:88`  |
| `ReplaceAroundStep`    | `replaceAround`| `replace_step.ts:170` |
| `AddMarkStep`          | `addMark`      | `mark_step.ts:72`     |
| `RemoveMarkStep`       | `removeMark`   | `mark_step.ts:128`    |
| `AddNodeMarkStep`      | `addNodeMark`  | `mark_step.ts:180`    |
| `RemoveNodeMarkStep`   | `removeNodeMark`| `mark_step.ts:224`   |
| `AttrStep`             | `attr`         | `attr_step.ts:53`     |
| `DocAttrStep`          | `docAttr`      | `attr_step.ts:98`     |

### 3.1 `ReplaceStep(from, to, slice, structure = false)`

Source: `replace_step.ts:7-88`.

Fields:

- `from: number` — start of replaced range (inclusive).
- `to: number` — end of replaced range (exclusive).
- `slice: Slice` — what to insert. May have `openStart` / `openEnd` > 0 — the open ends are *joined* to the surrounding context, they aren't inserted as nodes.
- `structure: boolean` — when `true`, fail if the content between `from` and `to` is anything other than "a sequence of closing then opening tokens" (i.e. only structural boundaries, no actual content). This guards rebased steps from clobbering content that wasn't there when the step was authored.

#### `apply` (`replace_step.ts:28-32`)

```ts
if (this.structure && contentBetween(doc, this.from, this.to))
  return StepResult.fail("Structure replace would overwrite content")
return StepResult.fromReplace(doc, this.from, this.to, this.slice)
```

`contentBetween` (`replace_step.ts:172-187`) walks down the right edge of `$from` while `$from.indexAfter(depth) == childCount` (i.e. we're at the last position) and decrements both `dist` and `depth`. If `dist` is exhausted to 0, all the tokens between `from` and `to` were closing tokens → the range is "structural only". If after that there's still distance left, peek at the next child and walk down its first-child spine; encountering anything non-leaf-but-with-content means content is in the way.

How open slices are handled: `doc.replace(...)` (in `prosemirror-model`) does the actual fitting — `ReplaceStep.apply` is just a thin wrapper. The step doesn't itself validate that the slice's open ends are compatible; if they aren't, `Node.replace` throws `ReplaceError`, `StepResult.fromReplace` catches it, and we get a failed result. So **validation is delegated to the model**.

#### `getMap` (`replace_step.ts:34-36`)

```ts
return new StepMap([this.from, this.to - this.from, this.slice.size])
```

A single 3-tuple `[oldStart, oldLen, newLen]`.

#### `invert` (`replace_step.ts:38-40`)

```ts
return new ReplaceStep(this.from, this.from + this.slice.size, doc.slice(this.from, this.to))
```

The inverted range starts at the same `from`, ends after the inserted slice, and the new slice is whatever was originally between `from` and `to`. This is why invert needs the *pre-doc*.

#### `map` (`replace_step.ts:42-47`)

```ts
let to = mapping.mapResult(this.to, -1)
let from = this.from == this.to && ReplaceStep.MAP_BIAS < 0 ? to : mapping.mapResult(this.from, 1)
if (from.deletedAcross && to.deletedAcross) return null
return new ReplaceStep(from.pos, Math.max(from.pos, to.pos), this.slice, this.structure)
```

Two notable points:

- **`from` and `to` are mapped with opposite biases** (`from` with `+1`, `to` with `-1`). This makes the *replaced range* shrink to nothing if the surrounding mapping deletes content, instead of growing into neighbouring content.
- **Pure inserts (where `from == to`) use `MAP_BIAS`** to choose where they collapse. The static `MAP_BIAS: -1 | 1 = 1` (`replace_step.ts:85`) defaults to `+1`, meaning a redo of an insertion at the same position as a remote insertion lands *after* the remote insertion. Setting it to `-1` flips that, which collab apps can do for nicer undo/redo behaviour.
- If both ends were deleted across, the step is dropped (`return null`).

#### `merge` (`replace_step.ts:49-63`) — see §7.

#### `toJSON` (`replace_step.ts:65-70`)

```ts
{ stepType: "replace", from, to, slice?, structure? }
```

`slice` is omitted if size 0 (so a pure deletion is `{stepType, from, to}`). `structure` is omitted if false. `fromJSON` rehydrates with `Slice.fromJSON(schema, json.slice)` (`replace_step.ts:73-77`).

### 3.2 `ReplaceAroundStep(from, to, gapFrom, gapTo, slice, insert, structure = false)`

Source: `replace_step.ts:93-170`. This is the most subtle of all the steps and the one that makes structural transforms (wrap, lift, setBlockType, setNodeMarkup, split-with-types) possible.

The intuition: a regular `ReplaceStep` can replace `[from, to)` with one slice. But many structural operations *want to keep the existing content in the middle untouched, while replacing what's around it*. That's the donut.

Fields:

- `from`, `to` — outer range to replace.
- `gapFrom`, `gapTo` — sub-range *inside* `[from, to)` whose existing content is preserved.
- `slice` — replacement slice for the *outside* of the donut.
- `insert` — position **inside the slice** where the gap content should be re-injected.
- `structure` — same flag/meaning as `ReplaceStep`.

#### Diagram

```
DOC (before):
   from     gapFrom              gapTo      to
    │         │                    │         │
    ▼         ▼                    ▼         ▼
  ┌─XXXXXXXX─[─────GAP CONTENT─────]─YYYYYY──┐
            ╰── preserved verbatim ──╯

SLICE (replacement, with `insert` mark):
  ┌─AAA──[insert]──BBB──┐
  openStart=os         openEnd=oe

DOC (after):
  ┌─AAA──[─────GAP CONTENT─────]──BBB─┐
        ╰─ slice opens up at `insert` ─╯
        ╰─ pos = from + insert         ─╯
```

Concretely, `apply` does (`replace_step.ts:118-129`):

1. If `structure`, verify there's no real content in `[from, gapFrom)` *or* `(gapTo, to]` (`contentBetween` again, both sides).
2. `gap = doc.slice(gapFrom, gapTo)` — must be a flat range (`gap.openStart == 0 && gap.openEnd == 0`); else fail with `"Gap is not a flat range"`.
3. `inserted = this.slice.insertAt(this.insert, gap.content)` — inject the gap's `Fragment` at offset `insert` into the slice. `Slice.insertAt` returns `null` on schema mismatch → `"Content does not fit in gap"`.
4. `StepResult.fromReplace(doc, from, to, inserted)` — replace the outer range with the merged slice.

The other four operations:

- **`getMap`** (`replace_step.ts:131-134`) — emits a *two-range* `StepMap`:

  ```ts
  new StepMap([from, gapFrom - from, insert,                  // before-gap range
               gapTo, to - gapTo, slice.size - insert])       // after-gap range
  ```

  i.e. positions outside the gap may move; positions inside the gap shift by a constant.

- **`invert`** (`replace_step.ts:136-142`) is a tiny gem:

  ```ts
  let gap = this.gapTo - this.gapFrom
  return new ReplaceAroundStep(
    this.from, this.from + this.slice.size + gap,
    this.from + this.insert, this.from + this.insert + gap,
    doc.slice(this.from, this.to)
       .removeBetween(this.gapFrom - this.from, this.gapTo - this.from),
    this.gapFrom - this.from, this.structure)
  ```

  Outer range becomes `[from, from + slice.size + gap)`. New gap is positioned at `[from + insert, from + insert + gap)`. The new slice is the *original* outer content with the original gap *removed*. The new `insert` is `gapFrom - from` — i.e. where the original gap originally sat in the outer range.

- **`map`** (`replace_step.ts:144-150`) maps `from`/`to` with biases `+1`/`-1` (like `ReplaceStep`), maps `gapFrom` (or coalesces with `from` if equal) and `gapTo` (or with `to` if equal), and returns `null` if both ends were fully deleted *or* if the gap escaped the outer range.

- **`toJSON`/`fromJSON`** (`replace_step.ts:152-167`) are identical in spirit to `ReplaceStep`, with five numbers + optional slice/structure.

ReplaceAroundStep does **not** override `merge` — gap-replaces don't compact.

### 3.3 `AddMarkStep` / `RemoveMarkStep`

Source: `mark_step.ts:17-128`. Both work by *re-running* the marked range as a slice replacement, but with marks remapped.

Both share a private helper `mapFragment` (`mark_step.ts:5-14`) that recursively walks a fragment and applies `f(child, parent, i)` to *inline* children only (block children are recursed into).

#### `AddMarkStep.apply` (`mark_step.ts:30-38`)

```ts
let oldSlice = doc.slice(this.from, this.to)
let $from = doc.resolve(this.from)
let parent = $from.node($from.sharedDepth(this.to))
let slice = new Slice(mapFragment(oldSlice.content, (node, parent) => {
  if (!node.isAtom || !parent.type.allowsMarkType(this.mark.type)) return node
  return node.mark(this.mark.addToSet(node.marks))
}, parent), oldSlice.openStart, oldSlice.openEnd)
return StepResult.fromReplace(doc, this.from, this.to, slice)
```

Key details:

- It only adds marks to **atoms** (`node.isAtom`). For text, "atom" means each text node, but the mark replaces the entire text run; for `inline-leaf` nodes (images, mentions), they're atoms. Block nodes are recursed into via `mapFragment`'s `child.copy(...)` branch; their marks aren't touched here.
- `parent.type.allowsMarkType(this.mark.type)` is checked **per-parent**, so the mark is only applied where the parent's schema permits.

#### `RemoveMarkStep.apply` (`mark_step.ts:88-94`) is the mirror image, calling `mark.removeFromSet`. No `parent` permission check — removing is always safe.

#### `invert` (`mark_step.ts:40-42`, `mark_step.ts:96-98`): just swaps Add↔Remove. Doesn't need the pre-doc.

#### `map` (`mark_step.ts:44-48`, `mark_step.ts:100-104`): biases `+1` / `-1`, returns `null` if both ends deleted *or if the range collapsed* (`from.pos >= to.pos`).

#### `merge` (`mark_step.ts:50-57`, `mark_step.ts:106-113`): two `AddMarkStep`s (resp. `RemoveMarkStep`s) with the same `mark.eq(...)` and overlapping/touching ranges merge into a single one with the union of ranges. **Different from `ReplaceStep.merge`**: ranges don't have to be exactly adjacent — `this.from <= other.to && this.to >= other.from`.

#### `toJSON` (`mark_step.ts:59-62`, `mark_step.ts:115-118`): `{stepType, mark, from, to}`.

### 3.4 `AddNodeMarkStep` / `RemoveNodeMarkStep`

Source: `mark_step.ts:131-224`. Newer than the inline mark steps; introduced to mark a specific node (typically a block node, or an inline atom you want to address by exact position).

Fields: `pos: number`, `mark: Mark`.

#### `AddNodeMarkStep.apply` (`mark_step.ts:142-147`)

```ts
let node = doc.nodeAt(this.pos)
if (!node) return StepResult.fail("No node at mark step's position")
let updated = node.type.create(node.attrs, null, this.mark.addToSet(node.marks))
return StepResult.fromReplace(doc, this.pos, this.pos + 1,
  new Slice(Fragment.from(updated), 0, node.isLeaf ? 0 : 1))
```

The replace replaces just the **opening token** of the node (`pos` to `pos + 1`) with a slice containing the rebuilt opening node. The trick is `openEnd: node.isLeaf ? 0 : 1` — for non-leaves, the slice is open at the end so the existing content of the node is preserved (the slice's "closing token" of `updated` is treated as missing → joined to the original closing token).

#### `AddNodeMarkStep.invert` (`mark_step.ts:149-161`) is non-trivial:

```ts
let node = doc.nodeAt(this.pos)
if (node) {
  let newSet = this.mark.addToSet(node.marks)
  if (newSet.length == node.marks.length) {
    // adding `mark` displaced an existing mark of the same exclusive group
    for (let i = 0; i < node.marks.length; i++)
      if (!node.marks[i].isInSet(newSet))
        return new AddNodeMarkStep(this.pos, node.marks[i])  // re-add the displaced mark
    return new AddNodeMarkStep(this.pos, this.mark)           // no-op displacement
  }
}
return new RemoveNodeMarkStep(this.pos, this.mark)
```

This handles `excludes` semantics on marks: if adding `mark` *replaced* another mark (because they're in the same exclusive group), inverting must re-add the *displaced* mark, not just remove the new one.

#### `RemoveNodeMarkStep.apply` (`mark_step.ts:194-199`) mirrors Add. Its `invert` (`mark_step.ts:201-205`) returns `this` (a no-op) if the mark wasn't actually on the node, otherwise an `AddNodeMarkStep`.

#### `map` (`mark_step.ts:163-166`, `mark_step.ts:207-210`): single position with bias `+1`; if the position is `deletedAfter`, the step drops to `null`.

These steps' `getMap()` is `StepMap.empty` (inherited from `Step.getMap`) — they don't move positions, even though `apply` does a `replace`. That's because the replacement preserves nodeSize.

### 3.5 `AttrStep` / `DocAttrStep`

Source: `attr_step.ts`.

#### `AttrStep(pos, attr, value)` (`attr_step.ts:6-53`)

`apply` (`attr_step.ts:19-27`):

```ts
let node = doc.nodeAt(this.pos)
if (!node) return StepResult.fail("No node at attribute step's position")
let attrs = Object.create(null)
for (let name in node.attrs) attrs[name] = node.attrs[name]
attrs[this.attr] = this.value
let updated = node.type.create(attrs, null, node.marks)
return StepResult.fromReplace(doc, this.pos, this.pos + 1,
  new Slice(Fragment.from(updated), 0, node.isLeaf ? 0 : 1))
```

Same "rebuild opening token, replace `[pos, pos+1)`, leave content via `openEnd: 1`" trick as the node-mark steps.

- `getMap()` is `StepMap.empty` (`attr_step.ts:29-31`).
- `invert(doc)` reads the original value out of `doc.nodeAt(pos).attrs[attr]` (`attr_step.ts:33-35`).
- `map` uses bias `+1`, drops if `deletedAfter` (`attr_step.ts:37-40`).
- Note: there is **no `merge`** override — two `AttrStep`s on the same node don't compact, even though they could. Reasonable: undo would lose the intermediate value.

#### `DocAttrStep(attr, value)` (`attr_step.ts:56-97`)

For attributes on the doc node itself. Conceptually similar but:

- `apply` (`attr_step.ts:67-73`) rebuilds the doc with `doc.type.create(attrs, doc.content, doc.marks)` and returns `StepResult.ok(updated)`. **Cannot fail** — there's no `fromReplace`, no positions to validate.
- `getMap()`: `StepMap.empty`.
- `invert(doc)` reads `doc.attrs[attr]`.
- `map(mapping)` returns `this` (`attr_step.ts:83-85`) — there's no position to remap.

---

## 4. The `Transform` class

Source: `transform.ts`.

`Transform` is the **builder** for a sequence of steps. It owns:

- `steps: Step[]` — applied steps in order (`transform.ts:30`).
- `docs: Node[]` — the doc *before* each step (`transform.ts:32`). Used by `invert` and by history.
- `mapping: Mapping` — accumulated `StepMap`s (`transform.ts:34`).
- `doc: Node` — the current (post-last-step) doc (`transform.ts:40`).

The starting doc is exposed as `transform.before` (returns `docs[0]` if any steps have run, else `doc`) (`transform.ts:44`).

### 4.1 Core mechanics

- `step(step)` (`transform.ts:48-52`) — applies, throws `TransformError` on failure.
- `maybeStep(step)` (`transform.ts:56-60`) — applies, returns `StepResult` (success or fail), only commits on success.
- `addStep(step, doc)` (`transform.ts:89-94`) — internal, pushes `this.doc` onto `docs`, the step onto `steps`, the step's map onto `mapping`, and replaces `this.doc`.
- `docChanged` getter (`transform.ts:64-66`) — true iff at least one step ran.
- `changedRange()` (`transform.ts:72-86`) — walks `mapping.maps` forward, mapping a sentinel `[1e9, -1e9]` range through everything and unioning each map's reported changes. Returns `{from, to}` in post-transform coords or `null`.

### 4.2 High-level API → step lowering

The "verb" methods on `Transform` are convenience wrappers that emit one or more steps. Here's the full mapping (file:line ⇒ what it does):

| Method                                           | Lowers to                         | Defined in            |
|--------------------------------------------------|-----------------------------------|-----------------------|
| `replace(from, to, slice)`                       | `replaceStep(...)` → `ReplaceStep` (or `ReplaceAroundStep` via Fitter) | `transform.ts:98-102` calls `replace.ts:12` |
| `replaceWith(from, to, content)`                 | `replace(from, to, new Slice(Fragment.from(content), 0, 0))` | `transform.ts:106-108` |
| `delete(from, to)`                               | `replace(from, to, Slice.empty)`  | `transform.ts:111-113` |
| `insert(pos, content)`                           | `replaceWith(pos, pos, content)`  | `transform.ts:116-118` |
| `replaceRange(from, to, slice)`                  | adaptive — see `replace.ts:334-403` | `transform.ts:137-140` |
| `replaceRangeWith(from, to, node)`               | `replaceRangeWith` helper (uses `insertPoint` for blocks) | `transform.ts:149-152` calls `replace.ts:418-424` |
| `deleteRange(from, to)`                          | walks coveredDepths, picks widest valid delete | `transform.ts:156-159` calls `replace.ts:426-458` |
| `lift(range, target)`                            | one `ReplaceAroundStep` (donut)   | `transform.ts:166-169` calls `structure.ts:30-58` |
| `wrap(range, wrappers)`                          | one `ReplaceAroundStep`           | `transform.ts:181-184` calls `structure.ts:102-115` |
| `setBlockType(from, to, type, attrs)`            | one `ReplaceAroundStep` per affected textblock + clearIncompatible + linebreak conversion | `transform.ts:188-191` calls `structure.ts:117-142` |
| `setNodeMarkup(pos, type?, attrs?, marks?)`      | leaf → `replaceWith`; non-leaf → `ReplaceAroundStep` over node | `transform.ts:195-198` calls `structure.ts:172-186` |
| `setNodeAttribute(pos, attr, value)`             | one `AttrStep`                    | `transform.ts:203-206` |
| `setDocAttribute(attr, value)`                   | one `DocAttrStep`                 | `transform.ts:209-212` |
| `addNodeMark(pos, mark)`                         | one `AddNodeMarkStep`             | `transform.ts:215-218` |
| `removeNodeMark(pos, mark)`                      | one `RemoveNodeMarkStep` (or many for a `MarkType`, in reverse — see below) | `transform.ts:222-236` |
| `split(pos, depth, typesAfter?)`                 | one `ReplaceStep` with structure flag | `transform.ts:243-246` calls `structure.ts:213-221` |
| `join(pos, depth)`                               | one `ReplaceStep` (Slice.empty, structure) + optional clearIncompatible + linebreak conversion | implicit via `structure.ts:274-299` |
| `addMark(from, to, mark)`                        | one or more `AddMarkStep`/`RemoveMarkStep` | `transform.ts:249-252` calls `mark.ts:8-36` |
| `removeMark(from, to, mark?)`                    | many `RemoveMarkStep`             | `transform.ts:258-261` calls `mark.ts:38-73` |
| `clearIncompatible(pos, parentType, match?)`     | many `ReplaceStep`/`RemoveMarkStep` | `transform.ts:267-270` calls `mark.ts:75-106` |

`removeNodeMark(pos, mark: MarkType)` is interesting (`transform.ts:227-234`): it builds the steps in *forward* order (find next instance, remove it, find again), then applies them **in reverse** so the second-found mark step doesn't get invalidated by a position shift. (Each `RemoveNodeMarkStep` has `getMap = StepMap.empty`, so technically positions don't shift here — but the doc state does, and applying earlier-found steps first would mean each step has stale node info. Reversed application is the safe choice.)

### 4.3 What `Transform` *doesn't* do

- It doesn't track selection — that's `prosemirror-state.Transaction`'s job (a subclass of `Transform`).
- It doesn't dispatch to a view.
- It doesn't enforce schema validity any more than the underlying step `apply` does.

---

## 5. `structure.ts` — the structural helpers

These are the *advisors* used by editor commands to figure out **whether** and **how** a structural change is possible before emitting a step. None of them mutate; they all return positions, depths, wrapping recipes, or `null`.

### 5.1 `liftTarget(range): number | null` (`structure.ts:15-28`)

Given a `NodeRange`, return the deepest target depth `< range.depth` to which the content of the range can be lifted. Walks outward from `range.depth`:

1. At depth `d`, compute `index` and `endIndex` of `$from` / `$to` adjusted by accumulated `contentBefore`/`contentAfter` flags.
2. If `node.canReplace(index, endIndex, content)` → `return depth`.
3. Else, if depth is 0, isolating, or can't be cut at `[index, endIndex]` → break and return `null`.
4. Otherwise update `contentBefore` (1 if `index > 0`) and `contentAfter` (1 if `endIndex < childCount`) and continue.

`canCut(node, start, end)` (`structure.ts:7-10`) is the helper: a node is cuttable if either `start == 0 || canReplace(start, childCount)` AND either `end == childCount || canReplace(0, end)` — meaning we can chop off the front or back without losing schema validity.

### 5.2 `lift(tr, range, target)` (`structure.ts:30-58`)

The actual implementation. Builds a `ReplaceAroundStep`:

- `gapStart, gapEnd = range.before(depth+1), range.after(depth+1)` — the gap is *exactly* the original range.
- Walk down from `depth` to `target`, accumulating `before` / `after` fragments of nodes that need to remain split-off either side. `splitting` is set once we encounter a non-trivial position (so we keep splitting all the way down once started).
- The slice is `new Slice(before.append(after), openStart, openEnd)` and `insert = before.size - openStart`.

This is the canonical "bite a hole in the surrounding nodes, sew the two sides back together with the gap content untouched in between" operation.

### 5.3 `findWrapping(range, nodeType, attrs?, innerRange?): {type, attrs}[] | null` (`structure.ts:66-77`)

Returns a flat list of `{type, attrs}` describing the chain of wrappers (outer → inner) needed so that `nodeType` can hold the `range`'s content. Three pieces:

1. `findWrappingOutside(range, type)` (`structure.ts:81-87`) — uses `parent.contentMatchAt(startIndex).findWrapping(type)` (model-side), and validates that `parent.canReplaceWith(startIndex, endIndex, outermostWrapper)`.
2. `findWrappingInside(range, type)` (`structure.ts:89-100`) — finds the wrappers needed inside the new wrapper to host the *first* child, and validates the rest of the children content-match through.
3. The final list is `outside.map(withAttrs).concat({type, attrs}).concat(inside.map(withAttrs))`.

`withAttrs` (`structure.ts:79`) just defaults the attrs to `null` for the discovered wrappers.

### 5.4 `wrap(tr, range, wrappers)` (`structure.ts:102-115`)

Takes the recipe from `findWrapping` and *materialises* it into a single `ReplaceAroundStep`:

- Build a single nested `Fragment` from the innermost wrapper to the outermost (`for i = wrappers.length - 1 ... 0` doing `content = Fragment.from(wrappers[i].type.create(...))`).
- Validate each wrapper's content against its parent wrapper's contentMatch.
- Emit `new ReplaceAroundStep(range.start, range.end, range.start, range.end, new Slice(content, 0, 0), wrappers.length, true)`.

Note `gapFrom == from` and `gapTo == to` — the entire original range is preserved as the gap. `insert = wrappers.length` because the gap content goes inside *all* the new wrapper opening tokens.

### 5.5 `setBlockType(tr, from, to, type, attrs)` (`structure.ts:117-142`)

Scans `nodesBetween(from, to)`, and for each textblock matching the criteria:

1. Decide whether to convert newlines (`type.schema.linebreakReplacement` interaction). If the new type is `whitespace: pre` and doesn't support the linebreak replacement node → strip linebreak nodes back to `\n`. Reverse for the other direction.
2. Call `clearIncompatible(tr, mappedPos, type, ..., convertNewlines === null)` to strip schema-invalid marks/children.
3. Emit `ReplaceAroundStep(startM, endM, startM+1, endM-1, Slice(Fragment.from(type.create(attrs, null, node.marks)), 0, 0), 1, true)` — the gap is `[startM+1, endM-1)` (the textblock's existing inline content), `slice` contains the new opening node, `insert: 1`.

This is the cleanest single demonstration of why `ReplaceAroundStep` exists: change the wrapper type without disturbing the content.

`canChangeType` (`structure.ts:165-168`) is the precondition check.

`replaceLinebreaks` / `replaceNewlines` (`structure.ts:144-163`) handle the `pre` ↔ non-`pre` whitespace conversion *as separate `replaceWith` calls*, mapped through `tr.mapping.slice(mapFrom)` so they survive the main `ReplaceAroundStep`.

### 5.6 `setNodeMarkup(tr, pos, type, attrs, marks)` (`structure.ts:172-186`)

Two cases:

- **Leaf**: `tr.replaceWith(pos, pos + node.nodeSize, newNode)` — full node replacement.
- **Non-leaf**: validate the existing content under the new type via `type.validContent(node.content)`, then `ReplaceAroundStep(pos, pos+nodeSize, pos+1, pos+nodeSize-1, Slice(Fragment.from(newNode), 0, 0), 1, true)` — same trick as `setBlockType`.

### 5.7 `canSplit(doc, pos, depth, typesAfter?): boolean` (`structure.ts:189-211`)

Validates a hypothetical split:

1. The innermost split's parent (`$pos.parent`) must not be isolating, must be able to lose content from `$pos.index()` onward (`canReplace($pos.index(), childCount)`), and the new "after" type's `validContent` must accept the cut-off content.
2. Walking upward from `$pos.depth - 1` down to `base`, each ancestor must not be isolating, must be `canReplace(index+1, childCount)`, and the proposed `typesAfter[i]` (or original type) must `validContent` the rest.
3. At the base, the parent must `canReplaceWith(index, index, baseType)` — i.e. there's room to insert the new sibling.

### 5.8 `split(tr, pos, depth, typesAfter?)` (`structure.ts:213-221`)

Builds twin fragments `before` and `after` by walking from `$pos.depth` down by `depth` levels, copying each node into the spine. Then emits:

```ts
new ReplaceStep(pos, pos, new Slice(before.append(after), depth, depth), true)
```

`from == to == pos`, slice is open `depth` on both sides — so the `before` chain joins to the left context and the `after` chain joins to the right. `structure: true` asserts there's nothing in the way.

### 5.9 `canJoin(doc, pos)` / `joinPoint(doc, pos, dir)` / `join(tr, pos, depth)` (`structure.ts:225-299`)

- `canJoin` — `joinable(nodeBefore, nodeAfter) && parent.canReplace(index, index+1)`.
- `joinable(a, b)` (`structure.ts:245-247`) requires both non-leaf and `canAppendWithSubstitutedLinebreaks(a, b)` — meaning `a` could host all of `b`'s children, with any `linebreakReplacement` nodes substituted to text where needed.
- `joinPoint` walks outward looking for the first depth at which a join is valid; returns the position or `undefined`.
- `join(tr, pos, depth)` does the linebreak-conversion dance like `setBlockType`, calls `clearIncompatible` for the receiving textblock if it's inline-content, and then emits a `new ReplaceStep(start, mappedEnd, Slice.empty, true)` to remove the `2*depth` boundary tokens.

### 5.10 `insertPoint(doc, pos, nodeType): number | null` (`structure.ts:305-322`)

If `pos` already accepts `nodeType` → return it. Else, if at the start of the parent, walk up looking for an ancestor that can accept `nodeType` *before* it. Else, if at the end, walk up looking for one that accepts *after*. Returns `null` if neither side works. Used by `replaceRangeWith` for non-inline node insertions.

### 5.11 `dropPoint(doc, pos, slice): number | null` (`structure.ts:328-349`)

Where to drop a slice when the user drops near `pos`. Two passes:

- **Pass 1** — try direct fit: `parent.canReplace(insertPos, insertPos, content)`.
- **Pass 2** (only if the slice is not closed at the start) — try with auto-wrapping: `parent.contentMatchAt(insertPos).findWrapping(content.firstChild.type)`.

For each pass, walk depth from `$pos.depth` down to 0, biasing the insert position toward whichever side of the current node `pos` is closer to.

---

## 6. The `replace.ts` core: slice fitting

Source: `replace.ts`. This is the heart of paste handling, drag-and-drop, and `Transform.replace` for any non-trivial slice. It's genuinely involved.

### 6.1 Entry points

```ts
export function replaceStep(doc, from, to, slice): Step | null  // line 12
```

- If `from == to && !slice.size` → `null` (no-op).
- Resolve both positions, check `fitsTrivially($from, $to, slice)` (`replace.ts:21-24`):
  - slice has `openStart == 0 && openEnd == 0`,
  - `$from` and `$to` share a parent (`$from.start() == $to.start()`),
  - the parent's `canReplace($from.index(), $to.index(), slice.content)` is true.
- If trivially fits → return a plain `ReplaceStep(from, to, slice)`.
- Else → `new Fitter($from, $to, slice).fit()`.

### 6.2 `Fitter` — the algorithm

The class header comment (`replace.ts:34-53`) sketches it. The state:

- **`frontier`** (`replace.ts:55`): a stack of `{type, match}` representing the **open right edge** of the result we're building. Initialized from `$from`: for each depth `0..$from.depth`, push `{type: $from.node(d).type, match: $from.node(d).contentMatchAt($from.indexAfter(d))}` (`replace.ts:63-69`). Conceptually, this is the chain of "we're building a doc that starts with the path-to-$from, and these are the content matches we still need to satisfy".
- **`placed`** (`replace.ts:56`): a `Fragment` of content already placed on the frontier. Pre-seeded by wrapping in `$from`'s ancestor spine (`replace.ts:71-72`): for each depth from `$from.depth` down to 1, `placed = Fragment.from($from.node(d).copy(placed))`. So `placed` is shaped like the doc structure leading down to `$from`.
- **`unplaced`** (`replace.ts:61`): the remaining slice we still want to insert.

The main loop (`replace.ts:77-107`):

```ts
while (this.unplaced.size) {
  let fit = this.findFittable()
  if (fit) this.placeNodes(fit)
  else this.openMore() || this.dropNode()
}
```

I.e. **try to place; if you can't, either expose more open content, or give up on a node and drop it**.

#### Step A — `findFittable()` (`replace.ts:112-154`)

Walk the *start spine* of `unplaced` (the path from outermost to innermost open-start nodes), and for each `sliceDepth` along that spine, scan the `frontier` from deepest to shallowest looking for a place where:

- **Pass 1**: the next slice node matches the frontier's content match directly, or `match.fillBefore(...)` succeeds (finds wrapping nodes the schema can auto-fill in front of `first`), or there's no `first` and the slice's parent at this depth is compatible with the frontier type. Returns `{sliceDepth, frontierDepth, parent, inject}` where `inject` is the auto-fill fragment (or null).
- **Pass 2** (only after pass 1 fails everywhere): can we *wrap* `first` in extra nodes so it fits? `match.findWrapping(first.type)` returns the wrapping recipe. Returns `{sliceDepth, frontierDepth, parent, wrap}`.

Two subtleties:

- The walk is short-circuited on isolating nodes (`replace.ts:117-121`): if we hit an isolating boundary on the slice's start spine, we won't open further (don't penetrate `<details>`-style nodes).
- `if (parent && match.matchType(parent.type)) break` (`replace.ts:150-151`) — if the *parent* of the current fragment fits at this frontier depth, prefer that and don't go shallower (avoids inserting at the wrong level).

#### Step B — `placeNodes(fit)` (`replace.ts:180-233`)

Now that we have a `{sliceDepth, frontierDepth, parent, inject?, wrap?}`:

1. **Close frontier nodes** below `frontierDepth` (`while (this.depth > frontierDepth) this.closeFrontierNode()`). `closeFrontierNode` (`replace.ts:282-286`) pops the deepest frontier and uses `match.fillBefore(Fragment.empty, true)` to fill any required content at the end.
2. **Open wrapper nodes** if `wrap` was present (pass 2): `for w of wrap: this.openFrontierNode(w)` (`replace.ts:275-280`). Each `openFrontierNode` advances the parent's match by the wrapper, appends the wrapper to `placed`, and pushes a fresh `{type, match: type.contentMatch}` onto the frontier.
3. **Possibly inject** auto-fill content (`inject`).
4. **Take as many children of the slice fragment as match the frontier's match** (`replace.ts:198-207`), one at a time, calling `match.matchType(next.type)`. Children that fit are pushed into `add` (after `closeNodeStart`-ing them — see below).
5. Append `add` to `placed` at `frontierDepth` via `addToFragment(...)` (`replace.ts:294-298` is the helper).
6. Update `this.frontier[frontierDepth].match = match`.
7. If `parent` matches the type at the *deepest* frontier and we placed the entire fragment and it isn't open at end → `closeFrontierNode()` (`replace.ts:216-217`).
8. Open new frontier nodes for the open-end depth of the placed nodes (`replace.ts:220-224`).
9. Update `unplaced`: drop the placed children from the slice via `dropFromFragment` (`replace.ts:289-292`). If we placed everything at this `sliceDepth` and we're not at top-level, also collapse one level of openStart.

`closeNodeStart(node, openStart, openEnd)` (`replace.ts:305-315`) is a recursive helper that *reattaches* schema-required leading content to a node whose left side was originally open. It's necessary because once we lift a node out of the open-start spine, we have to ensure its content is itself valid — which means `fillBefore(content)` may need to prepend mandatory content (e.g. a `bullet_list` requires at least one `list_item`).

#### Step C — `openMore()` / `dropNode()` (`replace.ts:156-175`)

If no fit is found:

- `openMore()` — increase `slice.openStart` by 1, *if* the next inner content has children and the firstChild is non-leaf. Also nudges `openEnd` if both ends would meet. Returns `false` if there's nothing more to open.
- `dropNode()` — the fallback: drop the next child at the current `openStart` depth. If we're at openStart > 0 and there's only one child at that depth, the whole open path collapses by one (`openStart -= 1`).

The combination makes the algorithm always terminate: every iteration either places content (shrinking `unplaced`), opens it (bounded by tree depth), or drops a node (also strictly shrinking).

#### Step D — close to `$to` and emit a step

Once `unplaced` is empty:

1. **`mustMoveInline()`** (`replace.ts:235-244`): if the frontier ends in inline content and so does the content directly after `$to`, we need to move that following inline content **into** the textblock at the frontier's tail. That requires a `ReplaceAroundStep` whose outer `to` extends past `$to.pos` to the end of that textblock. Returns `-1` if no inline merge is needed; otherwise returns the post-`$to` "extend to here" position.
2. **`close($to)`** (`replace.ts:261-273`):
   - Find the deepest level at which the frontier can satisfy the content immediately after `$to`. Done by `findCloseLevel($to)` (`replace.ts:246-259`), which probes each level via `contentAfterFits($to, depth, type, match, dropInner)` (`replace.ts:317-322`). `contentAfterFits` checks: at `$to.node(depth)`, does `match.fillBefore(node.content, true, index)` succeed *and* are all marks valid?
   - Above that level, every shallower level must also fit with `dropInner=true` and produce *no* fill content (otherwise a shallower close would leave content gaps).
   - On success, close frontier nodes back down to that depth, attach any required `fit` fragment, and re-open the path from there to `$to.depth` using `openFrontierNode(node.type, node.attrs, fillBefore)`.
3. **Normalize**: while the slice's content has a single child *and* both ends are open, drop the wrapping node (open both ends decrement) (`replace.ts:97-100`).
4. **Emit**: if `moveInline >= 0`, emit `new ReplaceAroundStep($from.pos, moveInline, this.$to.pos, this.$to.end(), slice, placedSize)`. Else emit a `new ReplaceStep($from.pos, $to.pos, slice)` — provided `slice.size > 0 || $from.pos != $to.pos` (no-op guard).

#### Diagram of the Fitter

```
        $from                                 $to
          │                                    │
    ┌─────▼──── existing doc ─────────────────▼─────┐
    │   <doc>                                       │
    │     <p>Hello |.....left context....]          │
    │                                                │
    │                  unplaced slice (slice)        │
    │             ┌──────────────────────────┐       │
    │             │ <openStart>              │       │
    │             │   <li><p>"item"</p></li> │       │
    │             │ </openStart>             │       │
    │             └──────────────────────────┘       │
    │                                                │
    │     [...right context.....| <p>World</p>      │
    │   </doc>                                       │
    └────────────────────────────────────────────────┘

State while running:
   frontier = [doc, p]     ← open path from $from
   placed   = <doc><p>Hello ▮</p></doc>        ← ▮ = insertion cursor
   unplaced = (the slice above)

Loop iteration 1:
   findFittable() probes:
     pass 1: at sliceDepth=0 (outer), the bullet_list/list_item doesn't
             fit in the <p> frontier match → skip
             at frontier <doc>, can a list_item fit there directly? No.
     pass 2: <doc>.contentMatchAt(...).findWrapping(li.type) → ['bullet_list']
             ⇒ fit = {sliceDepth: 0, frontierDepth: 0, wrap: [bullet_list]}

   placeNodes(fit):
     closeFrontierNode() to pop <p> off the frontier (was depth 1)
     openFrontierNode(bullet_list)
     match list_item children → place them
     update placed, frontier, unplaced=Slice.empty

Loop ends. close($to) finds depth 0 fit, emits a ReplaceStep.
```

The genuinely hard cases are when both the slice and the surrounding context have *open inline content* that wants to merge — that's where `mustMoveInline` and `contentAfterFits` earn their keep.

### 6.3 `replaceRange` (`replace.ts:334-403`)

This is the smarter sibling of `replace`, used for paste. It tries multiple `(targetDepth, sliceOpenDepth)` combinations and picks the best fit. Algorithm:

1. If the slice is empty → `deleteRange`.
2. If trivially fits → straight `ReplaceStep`.
3. Compute `coveredDepths($from, $to)` (`replace.ts:462-475`) — depths at which `[$from, $to)` covers the entire content of the node at that depth.
4. Build `targetDepths`, drop top-level (depth 0), prepend a "preferred" depth `-($from.depth + 1)` (negative = don't expand `to`).
5. Walk up from `$from.depth`; if we cross `defining`/`definingAsContext`/`isolating`, stop. Add covered depths above `$from` as preferred. Add negative depths for `$from`-anchored segments.
6. Build `leftNodes` — the start spine of the slice — and pick a `preferredDepth`. Adjust `preferredDepth` upward to cover defining textblocks above (`replace.ts:372-376`).
7. **First strategy** (`replace.ts:378-393`): for each slice `openDepth` (rotated through the preferred depth first), and each target depth, check whether `parent.canReplaceWith(index, index, leftNodes[openDepth].type, leftNodes[openDepth].marks)`. If yes → `tr.replace(...)` with a *closed* version of the slice (via `closeFragment`, `replace.ts:405-416`) and stop.
8. **Fallback** (`replace.ts:395-402`): try each target depth in reverse, doing a plain `tr.replace(from, to, slice)`. If any succeeds (added a step), stop.

This is messy because paste fundamentally has to choose: do you *open* the surrounding doc to admit the slice, or do you *close* the slice to fit it in? Different defining/definingAsContext flags push the heuristic in different directions.

### 6.4 `replaceRangeWith(tr, from, to, node)` (`replace.ts:418-424`)

If a non-inline node is being inserted at a collapsed position inside a non-empty parent, use `insertPoint` to find a valid block-boundary nearby; then call `replaceRange` with a fully-closed slice.

### 6.5 `deleteRange(tr, from, to)` (`replace.ts:426-458`)

Smart delete:

1. If the range goes from start-of-textblock to start-of-another-textblock and the shared depth has no isolating descendants → expand both ends outward by walking up while `from == $from.start(d)` (and similarly for `to`).
2. Walk `coveredDepths`: for each depth where the range covers the whole node, prefer to delete the entire node (`tr.delete($from.before(depth), $to.after(depth))`) if the parent can accept it.
3. Also try edge cases where `from`-anchored content can be expanded to include the right depth.
4. Otherwise fall back to a plain `tr.delete(from, to)`.

---

## 7. `clearIncompatible` (`mark.ts:75-106`)

Used when content from an old context gets dropped into a new context — most importantly **paste** (via `setBlockType` on retyped blocks) and **join** (when joining blocks of different types). Signature:

```ts
clearIncompatible(tr, pos, parentType, match = parentType.contentMatch, clearNewlines = true)
```

Algorithm (`mark.ts:75-106`):

1. Walk the children of `node = doc.nodeAt(pos)`. For each `child`:
   - `allowed = match.matchType(child.type)`. If null → push a `ReplaceStep(cur, end, Slice.empty)` to **delete the child**.
   - Otherwise: advance `match`. For each mark on the child not allowed by `parentType` (`!parentType.allowsMarkType(mark.type)`), emit a `RemoveMarkStep(cur, end, mark)` immediately.
   - If `clearNewlines && child.isText && parentType.whitespace != "pre"`, regex-find every `\r?\n|\r` in the text and replace each with a space (cached as a single slice).
2. After the loop: if `match.validEnd` is false, fill the missing trailing required content via `match.fillBefore(Fragment.empty, true)` and append it at `cur`.
3. Apply queued `replSteps` **in reverse** (so positions in earlier steps remain valid).

Why reversal: the `replSteps` were authored against the original `node`'s offsets, but each one shrinks the doc by `child.nodeSize`. By applying them right-to-left, the earlier (smaller-offset) steps' `from`/`to` are still valid in the (modified) doc.

This function is the reason paste typically *just works* — the steps required to coerce content into a new parent are emitted automatically, before the actual structural step that changes the parent.

---

## 8. Step compaction via `merge`

When the user types fast, `prosemirror-history` (and editor middleware) can call `step.merge(prevStep)` to compact consecutive steps into one. This shrinks the undo stack and reduces collab traffic. Steps that override `merge`:

- **`ReplaceStep.merge`** (`replace_step.ts:49-63`) — two `ReplaceStep`s combine if neither has `structure` and they're either:
  - Sequentially adjacent in result space (`this.from + this.slice.size == other.from`) with `!this.slice.openEnd && !other.slice.openStart` → e.g. typing `a` then `b` after `a`.
  - Or "backspace then continue typing" (`other.to == this.from`) with `!this.slice.openStart && !other.slice.openEnd`.

  The merged slice concatenates content (in the right order) and inherits open ends from the outer ones.

- **`AddMarkStep.merge` / `RemoveMarkStep.merge`** (`mark_step.ts:50-57`, `mark_step.ts:106-113`) — overlapping ranges with the *same* mark merge into the union range.

Other step types do not override `merge` and stay separate.

---

## 9. Failure modes

A `Step` reports failure only via `StepResult.fail(message)`. Where does failure originate?

| Step                       | Failure conditions                                                                 |
|----------------------------|------------------------------------------------------------------------------------|
| `ReplaceStep`              | `structure: true` and content-between is non-empty (`replace_step.ts:29-30`); or `Node.replace` throws `ReplaceError` (caught in `StepResult.fromReplace`). |
| `ReplaceAroundStep`        | structure-flag check fails; gap is not flat; gap doesn't fit at `insert`; underlying `Node.replace` throws. (`replace_step.ts:118-128`) |
| `AddMarkStep`/`RemoveMarkStep` | Underlying `Node.replace` throws (rare — only on schema corruption). |
| `AddNodeMarkStep`/`RemoveNodeMarkStep` | "No node at mark step's position" if `doc.nodeAt(pos)` is null (`mark_step.ts:144`, `mark_step.ts:196`). |
| `AttrStep`                 | "No node at attribute step's position" (`attr_step.ts:21`). |
| `DocAttrStep`              | Cannot fail. |

How `Transform` reports failure:

- `Transform.step(step)` throws a `TransformError` (`transform.ts:48-52`). `TransformError` is a tiny custom Error subclass (`transform.ts:11-21`) — the prototype gymnastics there are to allow `instanceof TransformError` checking under ES5-compiled code.
- `Transform.maybeStep(step)` returns the `StepResult` and never throws (`transform.ts:56-60`). On failure the doc is not mutated, no step is recorded.

The high-level helpers in `replace.ts` and `structure.ts` lean on `Transform.step` (which throws on failure). Most of their preconditions are already checked by the corresponding `canX` / `findX` helpers in `structure.ts`, which is why command authors are expected to use `canSplit` / `canJoin` / `liftTarget` / `findWrapping` / `insertPoint` *before* calling the mutation method.

---

## 10. Summary cheat sheet

```
            ┌──────────────────────┐
            │  Transform           │      .replace, .insert, .delete,
            │  (transform.ts)      │  ←── .lift, .wrap, .setBlockType,
            │                      │      .setNodeMarkup, .split,
            │  steps[]  docs[]     │      .join, .addMark, .removeMark,
            │  mapping  doc        │      .setNodeAttribute, ...
            └─────────┬────────────┘
                      │ emits
                      ▼
            ┌──────────────────────┐
            │  Step (abstract)     │    .apply(doc) → StepResult
            │  (step.ts)           │    .invert(doc) → Step
            │                      │    .map(mapping) → Step | null
            │                      │    .merge(other) → Step | null
            │                      │    .toJSON() / .fromJSON()
            │                      │    .getMap() → StepMap
            └────┬─────────────────┘
                 │
   ┌─────────────┼──────────────────┬──────────────┬─────────────────┐
   ▼             ▼                  ▼              ▼                 ▼
ReplaceStep  ReplaceAround     Add/RemoveMark  Add/RemoveNode    Attr / DocAttr
                Step              Step             MarkStep         Step
   │             │                  │              │                 │
   └────┬────────┘                  └──┬───────────┘                 │
        ▼                              ▼                             ▼
   slice fitting via                inline mark             single-node attr
   replaceStep() / Fitter           range edits             update via 1-token
   (replace.ts)                     (mark_step.ts)          replace
```

Helpers stack:

```
  structure.ts   ──→  liftTarget, findWrapping, canSplit, canJoin,
                       insertPoint, dropPoint  (advisors, no mutation)
                  ──→  lift, wrap, setBlockType, setNodeMarkup, split, join
                       (emit steps)

  replace.ts     ──→  replaceStep (Fitter algorithm)
                  ──→  replaceRange, replaceRangeWith, deleteRange
                       (paste / smart-delete heuristics)

  mark.ts        ──→  addMark, removeMark, clearIncompatible
                       (mark range edits + content sanitization)
```

Every editor command in `prosemirror-commands` and every paste-handler in `prosemirror-view` is built by composing these primitives. The contract is rigid: nothing changes the doc except by emitting a `Step`; every `Step` is invertible, mappable, and serializable. That contract is what makes the rest of the system possible.

---

## 11. Addenda — gap fills

These extend the sections above without superseding them. Citations are to `prosemirror-transform/src/*.ts` unless prefixed with `model/` (= `prosemirror-model/src/*.ts`).

### 11.1 `Transform.maybeStep` and the `StepResult` algebra

The two entry points to apply a step are deliberately different shapes:

```ts
// transform.ts:48-52
step(step) {
  let result = this.maybeStep(step)
  if (result.failed) throw new TransformError(result.failed)
  return this
}

// transform.ts:56-60
maybeStep(step) {
  let result = step.apply(this.doc)
  if (!result.failed) this.addStep(step, result.doc!)
  return result
}
```

- `step(step)` — fluent; throws `TransformError` (transform.ts:11-21) on failure. Use when failure is a logic error in the calling code.
- `maybeStep(step)` — never throws; returns the `StepResult`. Use in commands that *speculatively* try a step and want to fall back to a different strategy on failure. Typical pattern in `prosemirror-commands`:

  ```ts
  let result = tr.maybeStep(new ReplaceStep(from, to, slice))
  if (result.failed) {
    // try a different fitting
  }
  ```

`StepResult` is the algebra:

```ts
// step.ts:71-97
class StepResult {
  constructor(readonly doc: Node | null, readonly failed: string | null) {}
  static ok(doc)            { return new StepResult(doc, null) }
  static fail(message)      { return new StepResult(null, message) }
  static fromReplace(doc, from, to, slice) {
    try { return StepResult.ok(doc.replace(from, to, slice)) }
    catch (e) { if (e instanceof ReplaceError) return StepResult.fail(e.message); throw e }
  }
}
```

Three factories, one disjoint-union meaning: a successful result has a `doc` and `failed === null`; a failed result has `doc === null` and a string `failed`. There is no "partial success". `fromReplace` is the conventional bridge — most steps' `apply` is just `return StepResult.fromReplace(doc, from, to, slice)` — because `Node.replace` is the one place that throws `ReplaceError`, and step authors want to convert that into a `StepResult.fail` rather than letting it escape.

`Step.apply` *itself* should never throw a `ReplaceError`; if you write a custom step, follow the convention of using `StepResult.fromReplace` rather than calling `doc.replace` raw. Anything else (a programmer error, e.g. nodeAt returning null) is fine to throw as a normal Error.

### 11.2 `replaceStep()` — the public Fitter entry point

`replaceStep` (replace.ts:12-19) is the *function* that constructs a `Step` (a `ReplaceStep`, a `ReplaceAroundStep`, or `null`) for replacing `[from, to)` with a slice:

```ts
export function replaceStep(doc: Node, from: number, to = from, slice = Slice.empty): Step | null {
  if (from == to && !slice.size) return null
  let $from = doc.resolve(from), $to = doc.resolve(to)
  if (fitsTrivially($from, $to, slice)) return new ReplaceStep(from, to, slice)
  return new Fitter($from, $to, slice).fit()
}
```

It is exported from the package (re-exported via `transform/src/index.ts`). Use it directly when you want the *step object* without applying it to a transform — e.g. when serializing a step over the wire from a non-Transform context, or when manually constructing collab steps.

`Transform.replace` (transform.ts:98-102) is a thin wrapper:

```ts
replace(from, to = from, slice = Slice.empty) {
  let step = replaceStep(this.doc, from, to, slice)
  if (step) this.step(step)
  return this
}
```

so passing an empty slice over an empty range is a no-op (returns `null` and no step is applied), which is the primary reason the function returns `Step | null` rather than throwing.

### 11.3 `replaceOuter` / `replaceTwoWay` / `replaceThreeWay` — the model's slice surgery

Source: `prosemirror-model/src/replace.ts`, exported via `Node.replace(from, to, slice)`.

These three functions implement the *raw* algorithm that produces a new document tree from `($from, $to, slice)`. The transform-side `replaceStep`/`Fitter` (above) is a separate concern — it figures out *which* `(from, to, slice)` to pass; here we cover what happens when you *do* pass them.

Top-level `replace($from, $to, slice)` (model/replace.ts:122-128) only validates open-depth invariants and then calls `replaceOuter(_, _, _, 0)`.

```
replace
   │
   ▼
replaceOuter(depth=0)         ← walks down outer ancestors
   │
   ├── (slice.content empty)            ──▶ replaceTwoWay     ← join $from to $to, no slice
   │
   ├── (depth < $from.depth - openStart, both ends share index)
   │     recurse: replaceOuter(depth+1)  ← descend into the unique child that contains both ends
   │
   ├── (flat case: !openStart && !openEnd && both at this depth)
   │     concat:  parent.cut(0,$from.parentOffset) ⊕ slice.content ⊕ parent.cut($to.parentOffset)
   │
   └── (general open-slice case)
         prepareSliceForReplace(slice, $from)  ← wrap slice in extra ancestors above openStart so it can be re-resolved
         replaceThreeWay($from, $start, $end, $to, depth)
```

The three "way" functions describe how many *positions* are stitched together at each level:

- **`replaceTwoWay($from, $to, depth)`** (model/replace.ts:207-216) — used when there's no slice. Closes the gap between `$from` and `$to`. At each `depth`, it appends the content of `$from`'s parent up to `$from.index(depth)` (via `addRange(null, $from, depth, content)`), then if both positions go deeper, recursively builds the joined inner node, then appends the content of `$to`'s parent from `$to.index(depth)` onward (`addRange($to, null, depth, content)`).
- **`replaceThreeWay($from, $start, $end, $to, depth)`** (model/replace.ts:187-205) — used when there's a non-trivial slice with positive open ends. Stitches together *four* segments at each level: `< $from`, the slice's left-open edge joined to `$from` (`replaceTwoWay($from, $start, depth+1)`), `[$start, $end]` (the slice's body via `addRange`), the slice's right-open edge joined to `$to` (`replaceTwoWay($end, $to, depth+1)`), and `> $to`. When `$start.index(depth) === $end.index(depth)` the two `Two-Way`s collapse into a single recursive `replaceThreeWay` (the slice's content is in a single descendant at that depth).
- **`replaceOuter`** is the dispatcher that decides which of the four cases applies at the current depth.

`prepareSliceForReplace(slice, $along)` (model/replace.ts:218-225) is the trick that lets `replaceThreeWay` resolve into the slice as if it were part of the doc: it wraps `slice.content` in a copy of `$along`'s ancestors above the slice's `openStart`, then calls `resolveNoCache` to produce `$start` and `$end` resolved positions *inside that synthetic node*. Those synthetic positions can then be used identically to `$from` and `$to` in the recursion.

`addRange($start, $end, depth, target)` (model/replace.ts:165-180) is the per-level "append the children of node(depth) between `$start.index(depth)` and `$end.index(depth)`". With `$start === null` it starts at index 0; with `$end === null` it goes to the end. Two corner cases are important:

- If `$start.depth > depth`, we are not on a flat boundary — the descendant containing `$start` was already added by the recursive call above us, so skip it (`startIndex++`).
- If `$start.textOffset > 0` (we're inside a text node at this depth), include only the **after** part of that text node (`addNode($start.nodeAfter!, target)` then `startIndex++`). Symmetric handling at `$end` with `nodeBefore`.

`addNode(child, target)` (model/replace.ts:157-163) coalesces adjacent text children with `sameMarkup` — important when stitching slices over text boundaries (otherwise you'd end up with two `Text` nodes instead of one merged one, which `Fragment` does not allow at runtime).

`close(node, content)` (model/replace.ts:182-185) re-checks `node.type.checkContent(content)` — this is where a structurally invalid replacement (e.g. inserting a block into an inline-only parent) throws `ReplaceError` from deep inside the recursion; the error propagates out of `Node.replace`, gets caught by `StepResult.fromReplace`, and turns into a step failure.

When you read these functions in PM source, the recursion shape is the same in both `Two-Way` and `Three-Way`: at each level, append left segment, recurse, append right segment, return a fragment. The difference is *how many* segments are appended — and `Three-Way` has an extra "merge into single child" branch when the slice is contained in one descendant.

Why care? When you're debugging a `ReplaceError("Cannot join X onto Y")`, the function name in the stack trace tells you whether you're dealing with a slice's open edges (`replaceThreeWay` → `joinable($from, $start, depth+1)` or `joinable($end, $to, depth+1)`) or just the gap-closing for an empty slice (`replaceTwoWay`). The `joinable` check (model/replace.ts:151-155) calls `compatibleContent` on the two nodes — so the message tells you exactly which two node types refused to merge.

### 11.4 `Transform.docChanged` and `Transform.changedRange`

```ts
get docChanged() { return this.steps.length > 0 }                          // transform.ts:64-66
```

A trivial getter, but it's the canonical "did anything happen?" check used everywhere — `prosemirror-history` decides whether to record an undo entry, plugins decide whether to run their `apply`, view decides whether to redraw. Cheaper than diffing docs. **Note**: a step that produces an identity map (e.g. an `AddMarkStep` whose `getMap` is empty) still flips `docChanged` to true — *any* step counts.

```ts
changedRange() {                                                           // transform.ts:72-86
  let from = 1e9, to = -1e9
  for (let i = 0; i < this.mapping.maps.length; i++) {
    let map = this.mapping.maps[i]
    if (i) { from = map.map(from, 1); to = map.map(to, -1) }
    map.forEach((_f, _t, fromB, toB) => {
      from = Math.min(from, fromB)
      to   = Math.max(to,   toB)
    })
  }
  return from == 1e9 ? null : {from, to}
}
```

Returns the union of all changed ranges *in post-transform coordinates*, or `null` if no `getMap()` reported any range. Used by view diffing to limit DOM redraws to the affected region. Note:

- The `if (i)` skips mapping the running window through the *first* map — that map *defined* the initial window, so re-mapping would double-count.
- `forEach` callback receives `(oldStart, oldEnd, newStart, newEnd)`; this loop only uses the new-side bounds to grow the window.
- An `AddMarkStep` does *not* contribute (its `getMap` is `StepMap.empty` ⇒ `forEach` is a no-op). Hence the docstring caveat "ignores changes that add/remove marks without replacing the underlying content".

### 11.5 `TransformError`

```ts
// transform.ts:11-21
export let TransformError = class extends Error {}
TransformError = function TransformError(this: any, message: string) {
  let err = Error.call(this, message)
  ;(err as any).__proto__ = TransformError.prototype
  return err
} as any
TransformError.prototype = Object.create(Error.prototype)
TransformError.prototype.constructor = TransformError
TransformError.prototype.name = "TransformError"
```

The dance is to ensure `instanceof TransformError` works under ES5-compiled code where `class extends Error` doesn't always preserve prototype chains correctly (the so-called "Babel Error subclass bug"). Behaviour:

- `tr.step(step)` throws a `TransformError` whose `message` is the failed `StepResult`'s message.
- `tr.maybeStep(step)` does **not** throw.
- Calling code catching `TransformError` (e.g. command code that wants to fall back) should use `instanceof`, which works thanks to the manual prototype patching above.
- The class is exported (in the package's `index.ts`) — third-party code can throw it from custom step helpers if it wants to integrate with PM's failure conventions.

### 11.6 `setNodeAttribute` / `setDocAttribute` / `addNodeMark` / `removeNodeMark`

```ts
// transform.ts:203-218
setNodeAttribute(pos, attr, value) { return this.step(new AttrStep(pos, attr, value)) }
setDocAttribute(attr, value)       { return this.step(new DocAttrStep(attr, value)) }
addNodeMark(pos, mark)             { return this.step(new AddNodeMarkStep(pos, mark)) }

// transform.ts:222-236
removeNodeMark(pos, mark) {
  let node = this.doc.nodeAt(pos)
  if (!node) throw new RangeError("No node at position " + pos)
  if (mark instanceof Mark) {
    if (mark.isInSet(node.marks)) this.step(new RemoveNodeMarkStep(pos, mark))
  } else {
    let set = node.marks, found, steps = []
    while (found = mark.isInSet(set)) {
      steps.push(new RemoveNodeMarkStep(pos, found))
      set = found.removeFromSet(set)
    }
    for (let i = steps.length - 1; i >= 0; i--) this.step(steps[i])
  }
}
```

Five methods, all thin step constructors. Two notes:

- `setNodeAttribute(pos, attr, value)` requires `pos` to point at a node's open token (i.e. `doc.nodeAt(pos)` must be non-null). If you have a `ResolvedPos` `$p` and want to change attrs on `$p.parent`, use `tr.setNodeAttribute($p.before(), attr, value)`. To change the doc node itself, use `setDocAttribute` (no position — there is no position outside the doc).
- `removeNodeMark(pos, MarkType)` is the only one with control flow: it finds *all* instances of that mark type on the node and removes them one by one, applying the steps **in reverse order** (`for (let i = steps.length - 1; i >= 0; i--)`). Each `RemoveNodeMarkStep` has `getMap === StepMap.empty`, so positions don't actually shift — the reverse application is purely defensive against a future change in step semantics. (Today it would also work forward.)

### 11.7 `Transform.split`'s `typesAfter`

```ts
split(pos, depth = 1, typesAfter?) { split(this, pos, depth, typesAfter); return this }
```

`structure.ts:213-221` builds the `ReplaceStep` for a split. The interesting parameter is `typesAfter`:

- **Default (omitted)** — the new nodes opened to the *right* of the split inherit the type & attrs of the originals. E.g. splitting in the middle of `<heading level=2>foo|bar</heading>` produces `<heading level=2>foo</heading><heading level=2>bar</heading>`.
- **`typesAfter = [{type, attrs}, …]`** — override the right-side opens, outermost first. The standard "Enter at end of heading should give a paragraph" command does `tr.split(pos, 1, [{type: schema.nodes.paragraph}])`. The *left* side keeps the heading; the *right* side becomes a paragraph.
- **`typesAfter = [null, …]`** — `null` at a level means "use the original node's type" (default). Mix and match.

`canSplit(doc, pos, depth, typesAfter?)` (structure.ts:189-211) is the corresponding pre-flight check. The two functions read `typesAfter` identically — one returns a boolean, the other emits the step.

### 11.8 Worked example — `replaceRange` choosing `ReplaceStep` vs `ReplaceAroundStep`

This is the most asked-about lowering in the whole API. Let me walk through three pastes onto the same doc, watching which kind of step pops out.

Starting doc (with token positions annotated):

```
0  <doc>
0    <p>1 H 2 e 3 l 4 l 5 o 6 </p>
7    <p>8 W 9 o 10 r 11 l 12 d 13 </p> 14
   </doc>
```

So `doc.content.size === 14`; we have two paragraphs with text "Hello" (positions 1-6) and "World" (8-13).

#### Case A — pure-text paste into a single paragraph

- `from = 3`, `to = 3` (cursor between "He" and "llo")
- `slice = Slice(<p_text("X")>, 1, 1)` — a slice with openStart=1, openEnd=1, content `<p>X</p>`. (PM treats clipboard text as wrapped in a paragraph that's open on both sides.)

`replaceRange` (replace.ts:334-403):

1. Slice is non-empty → continue.
2. `fitsTrivially($from, $to, slice)` — false (slice has openStart=1).
3. `coveredDepths` returns `[]` (the range `[3, 3)` is collapsed; no covered nodes).
4. `targetDepths = [-2, /* nothing else */]` → after dropping any depth-0 entries.
5. The `for d = $from.depth; d > 0; d--` loop walks up from depth 1: doc node has no defining/isolating spec → `targetDepths.indexOf(1) === -1`, so add `targetDepths.splice(1, 0, -1)` if `$from.before(1) === 2` — but `$from.before(1) === 0` (start of p₁) and pos-1 is 2, so the condition `$from.before(d) == pos` (where `pos` decrements with `d`) does fire here for `d=1`.
6. **First strategy** loops over `(openDepth, targetDepth)` combinations. With `openDepth = 1` (the slice's `<p>` is the openable level) and target `-2` ($from.depth+1 = 2 — i.e. don't expand): try `parent.canReplaceWith($from.before(2)._index, ..., insert.type, insert.marks)`. With `target = -2 = -($from.depth + 1)` and slice depth = 1: `parent` is `p₁`, `index = 0` … `canReplaceWith` says "yes, p can hold text" → emit `tr.replace(...)`. This goes through `replaceStep`, which sees `openDepth = 1` reduces to `openStart = 0` (because the wrapper `<p>` is *closed*, i.e. drops to its content), so we end up with a `Slice(text("X"), 0, 0)` and a flat `ReplaceStep(3, 3, slice)`. **Result: `ReplaceStep`.**

#### Case B — block paste at the *end* of a paragraph

- `from = 6`, `to = 6` (cursor at end of "Hello", just before `</p>`)
- `slice = Slice(<heading><text("Big")></heading>, 0, 0)` — a fully-closed heading slice.

`replaceRange`:

1. Non-empty, not trivial.
2. `coveredDepths = []`.
3. `targetDepths = [-2]`.
4. Walk up: `$from.before(1) === 0`, `pos-1 = 5` ≠ 0; no addition. `targetDepths` stays `[-2]`.
5. **First strategy**: with `openDepth = 0` (slice is closed) and `target = -2`: `parent = p₁`, `index = $from.index(targetDepth - 1) = $from.index(0) = 0`. `p₁.canReplaceWith(0, 0, heading.type)` — false; you can't put a heading inside a paragraph. The whole inner loop gives no fit.
6. **Fallback** (`replace.ts:395-402`): try plain `tr.replace(6, 6, slice)`. This calls `replaceStep`, which calls `Fitter`; the Fitter sees `$from.depth === 1`, the slice's heading can't fit *inside* the paragraph, but if it expands the replaced range outward to include `</p>` (the paragraph's close token) and `<h>` (the heading's open token)…

Actually, the inner-loop expansion in step 6 is *targetDepths-driven*: it sets `from = $from.before(depth); to = $to.after(depth)` for each remaining depth and re-tries. With `targetDepths = [-2]`, the only retry is `depth = -2 → no expansion` — so we fall through to a plain `tr.replace(6, 6, slice)`. The `Fitter`'s `mustMoveInline()` check (`replace.ts:235-244`) determines whether the post-replacement should be a `ReplaceAroundStep` (because we need to preserve `</p>` content while inserting *around* it).

For a closed-slice paste at end-of-paragraph though, `Fitter.fit` (replace.ts:77-107) emits a plain `ReplaceStep(6, 6, slice)` if the schema allows the heading to follow the paragraph. **Result: `ReplaceStep`** (the surrounding paragraph remains untouched).

#### Case C — paste a `<li>` into the middle of `<li>` content (the wrap-around case)

This is the canonical `ReplaceAroundStep` example. Suppose:

```
<ul>
  <li><p>Hel|lo</p></li>     ← cursor at pos 5 (inside "Hello")
</ul>
```

Paste a slice `Slice(<li><p>X</p></li>, 2, 2)` (a list item open on both sides — typical from copying half of one list item).

1. `replaceRange` notices `$from.depth === 3` (doc → ul → li → p), the slice has `openStart === openEnd === 2`, and the slice's leftmost spine is `[<li>, <p>]`.
2. `coveredDepths` finds nothing (collapsed range).
3. `targetDepths` includes negative entries for `$from`-anchored ancestors — but only up to a defining barrier. `<li>` is **not** marked `defining`/`isolating` in the typical schema-list spec, but `<p>` is.
4. The first-strategy loop hits `(openDepth=2, target=-($from.depth+1)=-4)` then `(openDepth=2, target=-3)` etc. At `target=-3` ($from.depth = 3, so we're trying to fit at the `<li>` boundary), `parent = <li>`, `index = 0`. `<li>.canReplaceWith(0, 0, <p>)` → yes (the slice's leftmost child is `<p>`). Emits `tr.replace($from.before(3), $to (negative -> not expanded), closedSlice)`.
5. Inside `tr.replace` → `replaceStep` → `Fitter.fit`:
   - The Fitter sees `$from = before(<p>)`, `$to = inside-the-original-paragraph-after-the-cursor`. The slice contributes a complete `<li>` to the *left* of `$to`. But after that placement, we still have `</p>` (close of the original `<li>`'s `<p>`), `</li>` (close of the original `<li>`), and the new content placed.
   - The `mustMoveInline()` check (replace.ts:235-244) is **true**: the frontier node after fitting is a textblock (`<p>`), and the inline content right after `$to` (the `"llo"` text node) needs to move into the *new* `<p>` opened by the slice's right edge. That triggers `ReplaceAroundStep`.
6. The Fitter constructs the donut: `from = $from.before(3)`, `to = end-of-original-paragraph-after-cursor`, `gapFrom = $to.pos`, `gapTo = $to.end()`, `slice` = the list item structure with a textblock open on the right, `insert` = the position inside the slice where the gap content (`"llo"`) is re-injected. **Result: `ReplaceAroundStep`.**

The net effect on the doc: the `<li>` is split, `"Hel"` stays in the original paragraph, `"llo"` gets moved into the *new* `<li>`'s `<p>`, and the slice's `X` lives between them. This is the classic "Enter inside a list item splits the list item" outcome — `replaceRange` lowers it to one `ReplaceAroundStep`.

#### Reading the rule

Whenever the slice has open edges that need to *re-wrap existing content*, `Fitter.mustMoveInline` triggers and `ReplaceAroundStep` is emitted. Whenever the slice can be inserted as-is (closed, or open ends that join cleanly without pulling content into the slice), `ReplaceStep` suffices.

Mnemonic for inspecting `Transform.steps[0]` when debugging a paste:

- `instanceof ReplaceStep` ⇒ "slice was inserted; surrounding nodes were not split."
- `instanceof ReplaceAroundStep` ⇒ "slice was wrapped *around* preserved content; an existing block was split or restructured."

### 11.9 Why `Step.map` returns `null`

Every concrete step's `map` follows the same pattern:

```ts
map(mapping: Mappable): Step | null {
  let from = mapping.mapResult(this.from, +1)
  let to   = mapping.mapResult(this.to,   -1)
  if (from.deletedAcross && to.deletedAcross) return null   // (*)
  return new ConcreteStep(from.pos, to.pos, …)
}
```

Line `(*)` is the universal "drop the step" rule. `deletedAcross` is true when the position fell *strictly inside* a deleted range (DEL_ACROSS bit, see file 06 §2.4). If **both** ends were strictly inside deleted content, the step's range was completely engulfed — there's nothing left for the rebased step to act on, so we drop it. Specifically:

- For `ReplaceStep`: if the entire `[from, to)` is gone, the rebased replace would target an empty (or nonexistent) range; the safest thing is to skip it. (`replace_step.ts:42-47`)
- For `AddMarkStep`/`RemoveMarkStep`: if the range is fully deleted, the mark step would touch zero content. `mark_step.ts:44-48` has a slightly stronger condition: also drops if `from.pos >= to.pos` (the range collapsed to empty after mapping).
- For `AddNodeMarkStep`/`RemoveNodeMarkStep`/`AttrStep`: a single position; uses `mapResult(pos, +1).deletedAfter` (the node directly after `pos` was the target; if that's deleted, drop). `mark_step.ts:163-166`, `attr_step.ts:33-37`.
- For `DocAttrStep`: never returns `null` — the doc always exists.

The dropped-step case is essential to **collab rebasing** — see file 06 §6 and §11.4 below for the full walk-through. The rule is: when remote steps land that delete everything your local step was going to touch, your local step is dropped silently.

### 11.10 `Step.merge` — coalescing across steps

```ts
// step.ts:38-40 (default)
merge(other: Step): Step | null { return null }
```

The default is "no merge". Three steps override it:

- **`ReplaceStep.merge`** (replace_step.ts:49-63) — combines two adjacent replaces when they form a contiguous typing run. Two cases:
  - Forward typing: `this.from + this.slice.size == other.from` and the touching ends are closed (`!this.slice.openEnd && !other.slice.openStart`). E.g. typing "a" then "b" → one step inserting "ab".
  - Backspace-then-type: `other.to == this.from` and `!this.slice.openStart && !other.slice.openEnd`. E.g. backspace then immediate retype.

  Returns a `ReplaceStep` with concatenated content and outer open-ends.

- **`AddMarkStep.merge`** (mark_step.ts:50-57) and **`RemoveMarkStep.merge`** (mark_step.ts:106-113) — combine two adjacent mark range edits when:
  - `this.mark.eq(other.mark)` (same mark instance — *not* mark type alone).
  - Ranges overlap or touch: `this.from <= other.to && other.from <= this.to`.

  Returns a single step over `[min(from, other.from), max(to, other.to)]`. Note "overlap or touch" is more permissive than `ReplaceStep.merge`'s "exact adjacency".

Other steps (`ReplaceAroundStep`, `AddNodeMarkStep`, `RemoveNodeMarkStep`, `AttrStep`, `DocAttrStep`) always return `null` — they are not coalesced. `prosemirror-history` calls `prevStep.merge(newStep)` when the user's typing rate is fast enough that the input rules consider them part of the same logical edit; the results compact the undo stack and keep collab traffic small.

The protocol is one-directional: `prev.merge(new)` returns the merged step or `null`. Callers do not try `new.merge(prev)` if the first attempt fails.

### 11.11 `clearIncompatible`'s `convertNewlines` parameter

Full signature (mark.ts:75-106):

```ts
clearIncompatible(tr, pos, parentType, match = parentType.contentMatch, clearNewlines = true)
```

`clearNewlines` (called `convertNewlines` in some external docs) controls one specific behaviour: whether literal `\n` / `\r\n` / `\r` characters in text children are replaced with single spaces:

```ts
if (clearNewlines && child.isText && parentType.whitespace != "pre") {
  // regex-finds /\r?\n|\r/g and emits ReplaceSteps to convert each to " "
}
```

Why have a flag? Because the *only* parent that wants to keep literal newlines is a `code_block` (or any node with `whitespace: "pre"` — see `mark.ts:97`). When you're typing into a code block, you do *not* want `\n` collapsed to `" "`. So `prosemirror-keymap`'s `code_block` Enter handler passes `clearNewlines: false` to preserve the user's intentional line break. For anything else (paragraph, heading, blockquote content, …), the default `true` ensures pasted text doesn't introduce visible line breaks where the schema doesn't allow them.

Note the additional guard `parentType.whitespace != "pre"` inside the `if`: even with `clearNewlines = true`, if the parent is a pre-whitespace node, no conversion happens. So the flag is really "skip conversion *even for non-pre nodes*" (rare) vs the schema-driven default (common).

### 11.12 `Transform` vs `Transaction` — the inheritance line

`Transform` lives in `prosemirror-transform`; `Transaction` lives in `prosemirror-state` and `extends Transform`. The split is:

- `Transform` — knows about: `doc`, `steps`, `docs`, `mapping`. Pure document transformation builder. No selection, no metadata, no scrolling.
- `Transaction` — adds: `selection: Selection`, `storedMarks: Mark[] | null`, `time: number`, `setMeta(key, value)`, `getMeta(key)`, `scrollIntoView()`, `setSelection(s)`, `replaceSelection(slice)`, `insertText(text, from?, to?)`, `addToHistory` meta key, and so on.

What "lives where" decoder ring:

| Method                            | Defined on   | Notes                                                         |
|-----------------------------------|--------------|---------------------------------------------------------------|
| `replace`, `delete`, `insert`     | `Transform`  | Doc-only; no selection consequence.                          |
| `replaceWith`, `replaceRange`     | `Transform`  | Same.                                                         |
| `setNodeMarkup`, `setBlockType`   | `Transform`  | Same.                                                         |
| `addMark`, `removeMark`           | `Transform`  | Same.                                                         |
| `setNodeAttribute`, `setDocAttribute` | `Transform`  | Same.                                                         |
| `lift`, `wrap`, `split`, `join`   | `Transform`  | Same.                                                         |
| `replaceSelection(slice)`         | `Transaction` | Replaces the *current selection* with a slice; updates selection. |
| `replaceSelectionWith(node, inheritMarks?)` | `Transaction` | Like `replaceSelection` but takes a single node.              |
| `deleteSelection`                 | `Transaction` | `replaceSelection(Slice.empty)`.                              |
| `insertText(text, from?, to?)`    | `Transaction` | Resolves marks at `from`, builds `Slice`, calls `replace`.    |
| `setSelection(selection)`         | `Transaction` | Replaces `tr.selection`; selection must be valid in *current* `tr.doc`. |
| `setStoredMarks(marks)` / `ensureMarks(marks)` | `Transaction` | Inline mark "memory" for the next typed character.            |
| `scrollIntoView()`                | `Transaction` | Increments a counter (`tr.scrolledIntoView`); view notices.   |
| `setMeta(key, value)` / `getMeta(key)` | `Transaction` | Plugin-readable metadata; not persisted.                      |
| `addStoredMark` / `removeStoredMark` | `Transaction` | Plugin sugar over `setStoredMarks`.                           |

When you read PM source, expect: anything that looks like "selection-aware" or "scroll-aware" or "meta-aware" lives in `prosemirror-state/src/transaction.ts`. Anything that just produces steps lives in `prosemirror-transform`. A `Transaction` is a `Transform` with selection plumbing on top.

### 11.13 Quick reference — the gap-filled additions

| API / concept                        | Where                                  | Behaviour                                                    |
|--------------------------------------|----------------------------------------|--------------------------------------------------------------|
| `Transform.maybeStep(step)`          | transform.ts:56                        | apply or no-op; never throws; returns `StepResult`           |
| `StepResult.fromReplace`             | step.ts:89                             | wraps `Node.replace`, catching `ReplaceError`                |
| `StepResult.ok`/`fail`               | step.ts:81/84                          | success/failure factories                                    |
| `replaceStep(doc, from, to, slice)`  | replace.ts:12                          | builds a `ReplaceStep` or `ReplaceAroundStep` (or null)      |
| `replaceOuter` / `Two` / `ThreeWay`  | model/replace.ts:130/207/187           | model-level slice surgery                                    |
| `Transform.docChanged`               | transform.ts:64                        | `steps.length > 0`                                           |
| `Transform.changedRange()`           | transform.ts:72                        | union of new-side change bounds; null if pure mark/attr      |
| `TransformError`                     | transform.ts:11                        | thrown by `step`; caught by callers; ES5-safe `instanceof`   |
| `setNodeAttribute(pos, attr, value)` | transform.ts:203                       | `AttrStep` wrapper                                           |
| `setDocAttribute(attr, value)`       | transform.ts:209                       | `DocAttrStep` wrapper                                        |
| `addNodeMark(pos, mark)`             | transform.ts:215                       | `AddNodeMarkStep` wrapper                                    |
| `removeNodeMark(pos, markOrType)`    | transform.ts:222                       | many `RemoveNodeMarkStep`s, applied in reverse               |
| `split(pos, depth, typesAfter)`      | structure.ts:213                       | `typesAfter` overrides right-side opens                      |
| `Step.merge(other)`                  | step.ts:40 default; replace_step.ts:49; mark_step.ts:50/106 | adjacency-based coalescing                  |
| `Step.map → null`                    | replace_step.ts:42; mark_step.ts:44/100/163/207; attr_step.ts:33 | both ends in deleted content              |
| `clearIncompatible(..., clearNewlines)` | mark.ts:75                          | false for code_block; true elsewhere                         |
| `Transform` vs `Transaction`         | (inheritance)                          | doc-only vs doc-plus-selection-plus-meta                     |
