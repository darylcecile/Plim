# ProseMirror — Position Mapping

> Sources:
> - `prosemirror-transform/src/map.ts` (entire file: `Mappable`, `MapResult`, `StepMap`, `Mapping`)
> - `prosemirror-transform/src/transform.ts` (`Transform.mapping`, `addStep`, `changedRange`)
> - `prosemirror-transform/src/step.ts` (`Step.getMap`, `Step.map`)

When a step changes a document, every absolute position computed against the old document is potentially invalid against the new one. Mapping is the abstraction that translates positions across that change. ProseMirror gives you three layers of it:

1. **`StepMap`** — describes the deletions and insertions of *one* step, as a list of `[start, oldSize, newSize]` triples.
2. **`Mapping`** — a pipeline of `StepMap`s, with bounds and *mirror* relationships (so an inverted step can be skipped over losslessly when rebasing).
3. **`Transform.mapping`** — a `Mapping` that grows as steps are applied; selections, decorations, and downstream code use it to keep coordinates consistent.

This file is exhaustive. All citations refer to `prosemirror-transform/src/map.ts` unless otherwise noted.

---

## 1. Why mapping exists

Every step rewrites a range of the document. After the step:

- Positions before the changed range are unchanged.
- Positions after it are shifted by `newSize − oldSize`.
- Positions *inside* the replaced range are problematic — that content no longer exists, so any answer is an approximation: snap to the start, snap to the end, or report the position as deleted.

You also need this mapping to:

- Translate a `Selection` from the pre‑step doc to the post‑step doc.
- Map decorations attached to old positions onto the new doc.
- **Rebase** steps in collaborative editing: when a remote step lands, your locally‑pending steps must be re‑expressed against the new shared doc, which means mapping each step's positions through the remote step's map.
- Map a position back: e.g. for *inverting* a transform, undo, or computing what a remote position now refers to locally.

The `Mappable` interface (lines 3–17) captures this contract:

```ts
export interface Mappable {
  map: (pos: number, assoc?: number) => number
  mapResult: (pos: number, assoc?: number) => MapResult
}
```

`assoc` defaults to `1` and must be `-1` or `1`. It tells the mapping which side of the position to associate with — see §3.3.

---

## 2. `StepMap` — the change description for one step

### 2.1 Representation

```ts
// map.ts:72-83
export class StepMap implements Mappable {
  constructor(
    readonly ranges: readonly number[],
    readonly inverted = false
  ) {
    if (!ranges.length && StepMap.empty) return StepMap.empty
  }
}
```

`ranges` is a flat array; every consecutive triple is `[start, oldSize, newSize]`:

```
ranges = [s₀, oldSize₀, newSize₀,
          s₁, oldSize₁, newSize₁,
          ...]
```

- `s_i` is a position **in the original document** (when `inverted === false`). It is the start of the *i*th changed region.
- `oldSize_i` is how many tokens of the old doc are replaced.
- `newSize_i` is how many tokens of the new doc take their place.

The `start` values are stored in the *un‑shifted* coordinate system: each one points into the old doc directly. To find a region's location in the *new* doc you accumulate `Σ (newSize_j − oldSize_j)` for `j < i` and add to `s_i`.

`StepMap.empty` (line 163) is the identity map (no ranges).
`StepMap.offset(n)` (lines 158–160) builds a single‑range map that shifts everything by `n`:

```ts
// map.ts:158-160
static offset(n: number) {
  return n == 0 ? StepMap.empty : new StepMap(n < 0 ? [0, -n, 0] : [0, 0, n])
}
```

— pure deletion (`[0, n, 0]`) or pure insertion at 0 (`[0, 0, n]`).

### 2.2 Worked examples — range table

#### Example A: replace `"foo"` (3 chars) at pos 1 with `"hello"` (5 chars)

Old doc: `<p>foo</p>` (size 5 inside p, total 7 with doc bounds).
Replace from 1 to 4 (the whole "foo") with text "hello".

```
ranges = [1, 3, 5]            ← start=1, oldSize=3, newSize=5
inverted = false
```

| start | oldSize | newSize | meaning                                            |
|-------|---------|---------|----------------------------------------------------|
| 1     | 3       | 5       | tokens [1,4) in old doc become [1,6) in new doc    |

Cumulative shift after this range: `+2`.

#### Example B: insert `"X"` at pos 3 *and* delete `"yz"` at pos 7 in one step

```
ranges = [3, 0, 1,   7, 2, 0]
```

| start | oldSize | newSize | shift after | new range start |
|-------|---------|---------|-------------|-----------------|
| 3     | 0       | 1       | +1          | 3               |
| 7     | 2       | 0       | −1 (cum 0)  | 7+1 = 8         |

The new‑doc start of region 2 is `7 + 1 = 8` (the previous range added 1 token).

#### Example C: pure inversion

The same map with `inverted = true` reuses the *same* `ranges` array:

```ts
// map.ts:146-148
invert() { return new StepMap(this.ranges, !this.inverted) }
```

Now `ranges[i*3]` is interpreted as a position in the **new** doc (the inverted map's "old" doc), `oldIndex = 2` (newSize plays the role of "old"), `newIndex = 1`. See `_map`.

### 2.3 The `_map` algorithm

```ts
// map.ts:97-116
_map(pos: number, assoc: number, simple: boolean) {
  let diff = 0, oldIndex = this.inverted ? 2 : 1, newIndex = this.inverted ? 1 : 2
  for (let i = 0; i < this.ranges.length; i += 3) {
    let start = this.ranges[i] - (this.inverted ? diff : 0)
    if (start > pos) break
    let oldSize = this.ranges[i + oldIndex], newSize = this.ranges[i + newIndex], end = start + oldSize
    if (pos <= end) {
      let side = !oldSize ? assoc : pos == start ? -1 : pos == end ? 1 : assoc
      let result = start + diff + (side < 0 ? 0 : newSize)
      if (simple) return result
      let recover = pos == (assoc < 0 ? start : end) ? null : makeRecover(i / 3, pos - start)
      let del = pos == start ? DEL_AFTER : pos == end ? DEL_BEFORE : DEL_ACROSS
      if (assoc < 0 ? pos != start : pos != end) del |= DEL_SIDE
      return new MapResult(result, del, recover)
    }
    diff += newSize - oldSize
  }
  return simple ? pos + diff : new MapResult(pos + diff, 0, null)
}
```

Walk through:

1. We iterate over each range `i`, accumulating `diff` (`Σ newSize − oldSize` so far).
2. `start` is the range start in the *old* coordinate system (or shifted back if we're inverted, since for inverted maps `ranges[i*3]` is in *new* coords).
3. If the range starts past `pos`, we've gone too far — fall through to the "after all ranges" case at the bottom: `pos + diff`. (Pos is shifted by the total accumulated diff up to this range.)
4. If `pos <= end` of this range, `pos` is *inside* (or at the edge of) the range. Decide which side to land on (`side`):
   - If the range deletes nothing (`oldSize === 0`), respect `assoc`.
   - If `pos === start`, snap to the *left* (side = −1).
   - If `pos === end`, snap to the *right* (side = +1).
   - Otherwise (strictly inside), respect `assoc`.
5. Compute the result: `start + diff + (side < 0 ? 0 : newSize)`. So a position landing on the left edge maps to the start of the range in the new doc; landing on the right edge maps to *after* the new replacement (`start + newSize` in new coords, plus the cumulative diff that applied **before** this range).
6. For `mapResult` (not simple) we also build:
   - `recover`: a packed `(rangeIndex, offsetIntoOldRange)` value, used by `Mapping._map` when a mirrored map can losslessly invert this mapping. `null` when `pos` is exactly on the relevant edge — there's nothing to recover.
   - `delInfo`: a bitfield (see §2.4).

### 2.4 `MapResult` and the deletion bitmask

```ts
// map.ts:36
const DEL_BEFORE = 1, DEL_AFTER = 2, DEL_ACROSS = 4, DEL_SIDE = 8
```

```ts
// map.ts:40-66
export class MapResult {
  constructor(readonly pos: number,
              readonly delInfo: number,
              readonly recover: number | null) {}
  get deleted()        { return (this.delInfo & DEL_SIDE) > 0 }
  get deletedBefore()  { return (this.delInfo & (DEL_BEFORE | DEL_ACROSS)) > 0 }
  get deletedAfter()   { return (this.delInfo & (DEL_AFTER  | DEL_ACROSS)) > 0 }
  get deletedAcross()  { return (this.delInfo & DEL_ACROSS) > 0 }
}
```

Setting (in `_map`):

- `pos === start` (touched the left edge of the range): set `DEL_AFTER` — what was *after* this position got deleted.
- `pos === end`: set `DEL_BEFORE` — what was *before* this position got deleted.
- Strictly inside: set `DEL_ACROSS` — both sides got deleted.
- Then `DEL_SIDE` is set if `pos` is on the *opposite* side from `assoc`:
  - With `assoc < 0`: set `DEL_SIDE` if `pos != start` (we wanted left, but we are not at the left edge).
  - With `assoc >= 0`: set `DEL_SIDE` if `pos != end` (we wanted right, but we are not at the right edge).

Semantically:

| Getter            | True iff …                                                                        |
|-------------------|-----------------------------------------------------------------------------------|
| `deleted`         | The token *on the side `assoc` points to* was removed by some step in the chain.  |
| `deletedBefore`   | The token *immediately before* this position was removed.                         |
| `deletedAfter`    | The token *immediately after* this position was removed.                          |
| `deletedAcross`   | A range crossed this position (both sides deleted).                               |

`deleted` is conservative — it cares about the side you're "looking at". If you set `assoc = 1`, you're saying "I want the position that follows what's after me"; if that token got deleted, `deleted` is true.

### 2.5 `recover` and mirror inversion

```ts
// map.ts:32-34
function makeRecover(index, offset) { return index + offset * factor16 }
function recoverIndex(value)  { return value & lower16 }
function recoverOffset(value) { return (value - (value & lower16)) / factor16 }
```

`recover` packs `(rangeIndex, offsetWithinOldRange)` into one number using the lower 16 bits for the index and the upper bits for the offset. The comment (lines 19–27) explains:

> Recovery values encode a range index and an offset. They are represented as numbers, because tons of them will be created when mapping, for example, a large number of decorations. The number's lower 16 bits provide the index, the remaining bits the offset.
>
> Note: We intentionally don't use bit shift operators to en- and decode these, since those clip to 32 bits, which we might in rare cases want to overflow. A 64-bit float can represent 48-bit integers precisely.

Used by `StepMap.recover(value)` (lines 86–91):

```ts
recover(value) {
  let diff = 0, index = recoverIndex(value)
  if (!this.inverted) for (let i = 0; i < index; i++)
    diff += this.ranges[i*3 + 2] - this.ranges[i*3 + 1]
  return this.ranges[index*3] + diff + recoverOffset(value)
}
```

Given a recover token produced by some step map M, `M.invert().recover(token)` (or, with how mirror works in `Mapping`, jumping ahead to the mirrored map and calling `recover`) returns the **original** position inside that range. That is the lossless trick that makes collaborative rebasing work — see §4.2.

### 2.6 `touches`, `forEach`

```ts
// map.ts:118-130
touches(pos, recover) { … }
```

Returns whether `pos` lies inside the range identified by `recover`. Used internally by mappings.

```ts
// map.ts:132-142
forEach(f: (oldStart, oldEnd, newStart, newEnd) => void) { … }
```

Iterates the changes in convenient form, computing `newStart` lazily by accumulating `diff`. Honours `inverted`.

---

## 3. Mapping a position — semantics

### 3.1 Pure shift (position before all ranges)

If `pos` is to the left of every range, no range matched in the loop; the function returns `pos + diff` where `diff = 0`. The position is unchanged. (Or, after the first range whose `start > pos`, the loop breaks early — the position still falls through with whatever `diff` is.)

### 3.2 Pure shift (position after all ranges)

The loop completes; `diff = Σ (newSize − oldSize)` over all ranges. Return `pos + diff`.

### 3.3 Position inside a deleted range

#### Map of `[1, 3, 5]` (replace 3 chars at 1 with 5 chars)

```
old:        <p> f o o </p>      pos 0..6
ranges:     [1, 3, 5]
new:        <p> h e l l o </p>  pos 0..8
```

- `map(0, *)`     → `0`        (before range)
- `map(1, +1)`    → `1`        (== start, snap left, but +newSize? side = `pos==start ? -1 : ...` so side=−1, result `1 + 0 + 0 = 1`)
- `map(1, -1)`    → `1`        (same, side=−1)
- `map(2, +1)`    → `1 + 0 + 5 = 6` (strictly inside, assoc>=0 → side=+1, lands *after* the replacement)
- `map(2, -1)`    → `1 + 0 + 0 = 1` (strictly inside, assoc<0 → side=−1, lands *before*)
- `map(3, +1)`    → `6`        (still inside; same as pos 2)
- `map(4, +1)`    → `4 + 2 = 6` (== end, side=+1, result `1 + 0 + 5 = 6`)
- `map(4, -1)`    → `1 + 0 + 5 = 6` (== end, special case `pos==end ? 1 : assoc` so side=+1 even with assoc=−1; the rule "position on edge always sticks to that edge" wins over `assoc`)
- `map(5, +1)`    → `5 + 2 = 7` (after range, simple shift)
- `map(6, +1)`    → `6 + 2 = 8` (end of doc)

Note in particular: at the **left edge** (pos=1) the result is the same regardless of `assoc` — both go to `1`. At the **right edge** (pos=4) both go to `6`. `assoc` matters only **strictly inside**.

`mapResult` for these:

| pos | assoc | result | delInfo flags                                  | meaning |
|-----|-------|--------|------------------------------------------------|---------|
| 1   | +1    | 1      | DEL_AFTER (and DEL_SIDE because pos≠end and assoc=+1) | something to my right got deleted, and my chosen side (right) is gone |
| 1   | −1    | 1      | DEL_AFTER (no DEL_SIDE because assoc<0 and pos==start) | left side intact; my chosen side (left) survived |
| 2   | +1    | 6      | DEL_ACROSS, DEL_SIDE                           | crossed; my side is gone |
| 2   | −1    | 1      | DEL_ACROSS, DEL_SIDE                           | crossed; my side is gone |
| 4   | +1    | 6      | DEL_BEFORE                                     | left got deleted, but my chosen side (right) is fine |
| 4   | −1    | 6      | DEL_BEFORE, DEL_SIDE                           | left (my side) is gone |

### 3.4 The `assoc` choice for cursor preservation

A textbook example: user has a cursor *just after* "foo" (pos 4 in the example above) and someone deletes "foo". With `assoc = -1` ("stick with what's before me") `mapResult` reports `deleted: true` because the token to the left disappeared. With `assoc = +1` ("stick with what's after me") it reports `deleted: false` and the cursor cleanly jumps to position 6, just before whatever now follows.

ProseMirror's selection mapping uses both biases — `Selection.between($anchor, $head)` resolves with the appropriate side per endpoint. As a rule of thumb:

- For the **start** of a range: `assoc = +1` (extend along with content inserted after the original start).
- For the **end** of a range: `assoc = -1` (shrink to end before content inserted at the original end).
- For a **single cursor**: usually `+1`, unless you're at the right edge of an inserted range and want to *stay* at that edge.

When `oldSize === 0` (a pure insertion), `assoc` is the only signal — position == start == end, so `side = assoc` and the cursor either lands before the insertion (`-1`) or after it (`+1`). No edge ambiguity.

---

## 4. `Mapping` — a pipeline of `StepMap`s

```ts
// map.ts:172-198
export class Mapping implements Mappable {
  constructor(maps?: readonly StepMap[],
              public mirror?: number[],
              public from = 0,
              public to = maps ? maps.length : 0) { … }

  get maps(): readonly StepMap[] { return this._maps }
  slice(from = 0, to = this.maps.length) {
    return new Mapping(this._maps, this.mirror, from, to)
  }
}
```

Fields:

- `_maps` — the underlying `StepMap[]`.
- `mirror` — a flat array of *pairs* `[a, b, c, d, …]` indicating "map at index `a` is the mirror image of map at index `b`" (and `c` ↔ `d`, etc.).
- `from`, `to` — half‑open window over `_maps` used when calling `map`/`mapResult`. Allows `slice()` to produce a sub‑mapping cheaply, sharing storage.
- `ownData` — whether `_maps`/`mirror` are exclusively owned (so we can mutate them on `appendMap`).

### 4.1 Composition: `appendMap`, `appendMapping`, `setMirror`, `getMirror`

```ts
// map.ts:203-211
appendMap(map: StepMap, mirrors?: number) {
  if (!this.ownData) {
    this._maps  = this._maps.slice()
    this.mirror = this.mirror && this.mirror.slice()
    this.ownData = true
  }
  this.to = this._maps.push(map)
  if (mirrors != null) this.setMirror(this._maps.length - 1, mirrors)
}

// 215-220
appendMapping(mapping: Mapping) {
  for (let i = 0, startSize = this._maps.length; i < mapping._maps.length; i++) {
    let mirr = mapping.getMirror(i)
    this.appendMap(mapping._maps[i],
                   mirr != null && mirr < i ? startSize + mirr : undefined)
  }
}
```

Copy‑on‑write: a `Mapping` constructed by `slice` shares its arrays; the first append clones them. `appendMapping` preserves mirror relationships *within* the appended mapping by remapping indices to the new positions.

```ts
// map.ts:225-234
getMirror(n) {
  if (this.mirror) for (let i = 0; i < this.mirror.length; i++)
    if (this.mirror[i] == n) return this.mirror[i + (i % 2 ? -1 : 1)]
}
setMirror(n, m) {
  if (!this.mirror) this.mirror = []
  this.mirror.push(n, m)
}
```

`setMirror(n, m)` declares "map `n` and map `m` cancel each other out". `getMirror(n)` finds the partner. The encoding stores both `[n, m]` and is searched bidirectionally — `i % 2 ? -1 : 1` returns the *other* element of the pair given index `i`.

### 4.2 The lossless inversion trick

```ts
// map.ts:264-283
_map(pos, assoc, simple) {
  let delInfo = 0
  for (let i = this.from; i < this.to; i++) {
    let map = this._maps[i], result = map.mapResult(pos, assoc)
    if (result.recover != null) {
      let corr = this.getMirror(i)
      if (corr != null && corr > i && corr < this.to) {
        i = corr
        pos = this._maps[corr].recover(result.recover)
        continue
      }
    }
    delInfo |= result.delInfo
    pos = result.pos
  }
  return simple ? pos : new MapResult(pos, delInfo, null)
}
```

Reading carefully:

- For each step's map we compute `mapResult`.
- If the result has a `recover` token (i.e. the position landed strictly inside a replaced range, *not* on an edge), and there is a *later* mirror map (`corr > i && corr < this.to`), we **skip ahead** to that mirror and use its `recover()` to compute the position the original would have had after the mirrored step *un‑applied* the change.
- Then continue the loop after the mirror.
- The `delInfo` is **only** OR'd in on the path that did *not* take the mirror short‑circuit. So if a deletion is undone later in the same `Mapping`, the position lands somewhere reasonable and is *not* marked deleted.

This is what makes rebasing in collaborative editing exact: when local steps are mirrored by their inverses inside a rebase mapping, positions inside the inverted ranges are recovered to their original locations rather than being "snapped to an edge".

If `mirror` is unset (the common, simple case), `Mapping.map` (line 252) takes a fast path:

```ts
// map.ts:252-257
map(pos, assoc = 1) {
  if (this.mirror) return this._map(pos, assoc, true) as number
  for (let i = this.from; i < this.to; i++)
    pos = this._maps[i].map(pos, assoc)
  return pos
}
```

— just chain the per‑map `map`, no recovery.

### 4.3 `invert`, `appendMappingInverted`, `slice`

```ts
// map.ts:237-249
appendMappingInverted(mapping) {
  for (let i = mapping.maps.length - 1, totalSize = this._maps.length + mapping._maps.length; i >= 0; i--) {
    let mirr = mapping.getMirror(i)
    this.appendMap(mapping._maps[i].invert(),
                   mirr != null && mirr > i ? totalSize - mirr - 1 : undefined)
  }
}

invert() {
  let inverse = new Mapping
  inverse.appendMappingInverted(this)
  return inverse
}
```

Inverts every step map *and* reverses the order, while preserving mirror pairs: the mirror partner of position `i` (counting in the original) becomes `totalSize - mirr - 1` in the new (reversed) array.

`slice(from, to)` (lines 196–198) produces a window over the same `_maps`/`mirror`. Cheap; the slice shares storage until first `appendMap`.

---

## 5. How `Transform` accumulates maps

```ts
// transform.ts:33-34
readonly mapping: Mapping = new Mapping
```

```ts
// transform.ts:88-94
addStep(step: Step, doc: Node) {
  this.docs.push(this.doc)
  this.steps.push(step)
  this.mapping.appendMap(step.getMap())
  this.doc = doc
}
```

Every applied step contributes its `getMap()` to `Transform.mapping`. `step.ts:23-26`:

```ts
getMap(): StepMap { return StepMap.empty }
```

— the default is empty (e.g. mark steps that don't affect positions). `ReplaceStep`, `ReplaceAroundStep`, etc., override this.

Consequence: at any point during a transform you can call `tr.mapping.map(oldPos)` to find where `oldPos` ended up after the steps applied so far. This is *not* automatic — selections are mapped explicitly when the transform is dispatched.

`Transform.changedRange` (transform.ts:72–86) demonstrates the typical "fold over maps" pattern:

```ts
changedRange() {
  let from = 1e9, to = -1e9
  for (let i = 0; i < this.mapping.maps.length; i++) {
    let map = this.mapping.maps[i]
    if (i) {
      from = map.map(from, 1)
      to = map.map(to, -1)
    }
    map.forEach((_f, _t, fromB, toB) => {
      from = Math.min(from, fromB)
      to = Math.max(to, toB)
    })
  }
  return from == 1e9 ? null : {from, to}
}
```

The pattern: fold an evolving range through each subsequent map (skip the first because that's where the range came from), then for each map widen the range with that map's *new‑side* changed bounds (`fromB`/`toB`).

---

## 6. Collaborative editing & `Step.map`

```ts
// step.ts:32-35
abstract map(mapping: Mappable): Step | null
```

When rebasing: you have local steps L₁…Lₙ, the server tells you remote steps R₁…Rₘ landed. To rebase L over R:

1. Build a `Mapping` `m` consisting of R's step maps in order: `m = appendMap(R₁.getMap()); appendMap(R₂.getMap())…`.
2. For each Lᵢ, compute `Lᵢ' = Lᵢ.map(m)`. If a step is entirely inside content R deleted, `map` returns `null` and that step is dropped.
3. Apply L₁'…Lₙ' to the new doc.

If you also want the **selection** to survive, use the rebase mapping (which interleaves `R` step maps with **inverted** local maps and uses `setMirror`) so positions inside originally‑deleted‑then‑restored regions are recovered instead of snapped. The collab module builds these mappings; `_map`'s recovery path (§4.2) is exactly what's needed.

---

## 7. Pitfalls

1. **`assoc` is not an option for "inside a deletion".** When a position is strictly inside a deleted range, `assoc` chooses *which edge* the result lands on, but `deleted` will still be true (DEL_SIDE is set). Don't expect `+1` to magically save a cursor inside content that no longer exists.

2. **Edge positions ignore `assoc`.** At `pos === start` or `pos === end` of a range, `side` is forced to −1 / +1 respectively. A common bug: passing `assoc = -1` to keep a cursor "at the end of the just‑inserted text" — but if your `pos` *is* the end of the inserted range, it sticks anyway; if it's strictly inside the resulting new content, your `assoc` matters.

3. **`pure insertion` (`oldSize === 0`).** `pos == start == end`, so `side = !oldSize ? assoc : ...` falls through to `assoc`. This is the *one* case where `assoc` decides on an edge: do you sit before the insertion (`-1`) or after it (`+1`)?

4. **`Mapping.from`/`to` are mutable.** `slice()` returns a Mapping that shares storage *and* may have `from`/`to` ≠ `[0, _maps.length]`. Don't copy `_maps.length` and assume that's the iteration window.

5. **`appendMap` triggers copy‑on‑write.** The first `appendMap` after a `slice()` clones `_maps` and `mirror`. If you held onto the old `Mapping`'s `_maps` reference for inspection, that reference is now decoupled from later appends. (This is the intent — but it's a thing to know.)

6. **Mirror indices are absolute within the Mapping, not relative.** `appendMapping` therefore offsets them by `startSize`. Don't try to copy `mirror` across mappings yourself.

7. **`StepMap.empty` short‑circuit.** `new StepMap([])` returns `StepMap.empty` (line 82). Don't rely on identity for "did I create this map?" — comparing `=== StepMap.empty` is fine, but constructing two `new StepMap([])` calls returns the same singleton.

8. **`StepMap` `start`s are in the *current* (un‑shifted) coords for that range.** When reading `ranges`, you cannot reorder triples; later ones depend on accumulated `diff` from earlier ones (in `_map`'s loop). You also can't trivially merge two `StepMap`s into one — that's why `Mapping` exists.

9. **`StepMap.offset(0)` returns `StepMap.empty`** (line 159). A "shift by zero" is the identity, not a degenerate single‑range map. If you build maps mechanically, check for this.

10. **Recover tokens are tied to a specific `StepMap` instance.** A recover value from map M is meaningful only when fed back to M (or its inverse). The `mirror` mechanism in `Mapping` is what threads them through correctly during a multi‑step pipeline — don't try to pass them around outside of that context.

---

## 8. Diagram summary — one map, one position

```
old doc:      ─────────────[─────────────]──────────────
                            ▲       ▲
                            │       │
                          start    end = start + oldSize
                            │       │
                            │  pos? │
                            │       │
new doc:      ─────────────[───────────────────]────────
                            ▲                   ▲
                            │                   │
                          start (in old)      start + newSize  (then + diff_before_this_range)
                            │
                          + Σ_{j<i}(newSizeⱼ − oldSizeⱼ)
                            =  shifted start in new coords
```

For `pos` outside `[start, end]`: result = `pos + diff` (cumulative shift up to *its* range).
For `pos == start`: result = `start + diff_before` (snap left).
For `pos == end`: result = `start + diff_before + newSize` (snap right).
For `start < pos < end`: result = depends on `assoc`; flag `DEL_ACROSS | DEL_SIDE`.

---

## 9. Quick reference

| API                                        | Purpose                                                                |
|--------------------------------------------|------------------------------------------------------------------------|
| `new StepMap([s, oldN, newN, …])`          | Build a position map for one step.                                     |
| `StepMap.offset(n)`                        | Shift everything by `n`.                                               |
| `StepMap.empty`                            | Identity.                                                              |
| `m.map(pos, assoc=1)`                      | Map; return number.                                                    |
| `m.mapResult(pos, assoc=1)`                | Map; return `MapResult` with `pos`, `deleted*`, `recover`.            |
| `m.invert()`                               | Reverse the direction (shares `ranges`).                               |
| `m.forEach(f)`                             | Iterate `(oldStart, oldEnd, newStart, newEnd)` per range.              |
| `new Mapping([maps], mirror?, from?, to?)` | Build a pipeline; can be sub‑windowed.                                 |
| `mapping.appendMap(m, mirrors?)`           | Add a step map; optionally declare its mirror.                         |
| `mapping.appendMapping(other)`             | Concat, preserving mirrors.                                            |
| `mapping.appendMappingInverted(other)`     | Concat the inverse (reverse order, invert each).                       |
| `mapping.invert()`                         | New mapping that maps post → pre.                                      |
| `mapping.slice(from, to)`                  | Cheap sub‑window.                                                      |
| `mapping.setMirror(a, b)` / `getMirror(n)` | Mirror declarations for lossless inversion.                            |
| `mapping.map(pos, assoc=1)`                | Map through the active window.                                         |
| `mapping.mapResult(pos, assoc=1)`          | Same, with `MapResult` (no `recover`).                                 |
| `Transform.mapping`                        | Aggregated mapping over all applied steps.                             |
| `Step.getMap()`                            | The map for a single step.                                             |
| `Step.map(mapping)`                        | Rebase the step itself; may return `null` (step deleted).              |

---

## 10. Addenda — gap fills

These extend §1-§9 without superseding them. Citations are to `prosemirror-transform/src/map.ts` unless otherwise marked.

### 10.1 `Mappable` implementers

`Mappable` is an interface (lines 3-17) and any object with `map(pos, assoc?)` and `mapResult(pos, assoc?)` is one. The implementations shipped in PM:

| Class / value                         | File                            | Provided by                                      |
|---------------------------------------|---------------------------------|--------------------------------------------------|
| `StepMap`                             | map.ts:72                       | `prosemirror-transform`                          |
| `Mapping`                             | map.ts:172                      | `prosemirror-transform`                          |
| `StepMap.empty`                       | map.ts:163                      | identity-mapping singleton                       |

These are the only first-party implementers — but the interface is *deliberately* broad so any consumer can pass a synthetic mappable. Notable real-world uses:

- **`Selection.map(doc, mapping: Mappable)`** (state/selection.ts:63 abstract, :241 `TextSelection`, :338 `NodeSelection`) — accepts any `Mappable`, not just `Mapping`. So a plugin can produce a one-off mapping (e.g. `StepMap.offset(5)` to shift by 5) and pass it directly. Selection types use `mapResult` to inspect `deleted`/`deletedAcross` and decide whether to collapse.
- **`Decoration.map`** / **`DecorationSet.map`** — same pattern; used heavily for keeping inline/widget decorations alive across transactions.
- **`Plugin.spec.appendTransaction(transactions, oldState, newState)`** — a plugin author often constructs an `accumulated = new Mapping()` to chain step maps from `transactions[i].mapping` and pass that to selection/decoration mappers.

If you write a custom `Mappable`, the contract is:

- `map(pos, assoc?) === mapResult(pos, assoc?).pos` for any inputs.
- `mapResult` returns a `MapResult` whose `delInfo` truthfully reflects whether the position's neighbours were deleted (so `deleted`/`deletedBefore`/`deletedAfter`/`deletedAcross` are accurate).
- `assoc` defaults to `1`, must be `-1` or `1`, and biases edge cases as described in §3.

Custom mappables show up in the wild in (a) test helpers that simulate a sequence of operations, (b) the `prosemirror-tables` cell-resize plugin which builds a mapping that ignores width-only attribute changes, and (c) collab implementations that need to interleave received-step maps with locally-inverted ones.

### 10.2 `MapResult.deleted*` and selection collapsing

The `delInfo` flags are deeply intertwined with how selections survive transactions. The two relevant `Selection.map` implementations:

```ts
// state/selection.ts:241-246  TextSelection.map
map(doc, mapping) {
  let $head = doc.resolve(mapping.map(this.head))
  if (!$head.parent.inlineContent) return Selection.near($head)
  let $anchor = doc.resolve(mapping.map(this.anchor))
  return new TextSelection($anchor.parent.inlineContent ? $anchor : $head, $head)
}
```

```ts
// state/selection.ts:338-343  NodeSelection.map
map(doc, mapping) {
  let {deleted, pos} = mapping.mapResult(this.anchor)
  let $pos = doc.resolve(pos)
  if (deleted) return Selection.near($pos)
  return new NodeSelection($pos)
}
```

Reading these against §2.4:

- **`TextSelection.map`** uses **`map`**, not `mapResult`. It does not inspect `deleted` flags. Why? Because a text selection is *bidirectional* (anchor + head); its endpoints can move independently and lose their "selected" status without the selection being invalidated — it just becomes shorter, or collapses. So `TextSelection` only checks `parent.inlineContent` to decide whether the selection still makes sense, falling back to `Selection.near` (jump to the nearest valid selection) otherwise.
- **`NodeSelection.map`** uses **`mapResult`** and inspects `deleted`. If the *exact* node that was selected is gone (its anchor token, mapped with default `assoc = +1`, has its `deletedAfter` bit set ⇒ `deleted` is true), the node selection cannot survive — fall back to `Selection.near`. Otherwise the node is still there at the new `pos`.

Plugin authors mapping custom selections (e.g. the gap-cursor) follow the same convention: use `mapResult` and inspect `deleted` when "this exact thing" needs to still exist; use `map` (just position) when "approximately this place" is enough.

The other `deleted*` flags are used by `prosemirror-history` and `prosemirror-collab`:

- `deletedBefore` — "the token *before* my position is gone": used when deciding whether a backspace cursor anchor can stay where it is.
- `deletedAfter` — symmetric, for delete/forward-delete.
- `deletedAcross` — "a range crossed me": used in `Step.map` (`from.deletedAcross && to.deletedAcross ⇒ return null`) to drop steps whose range is entirely engulfed by remote changes.

### 10.3 `StepMap.touches(pos, recover)`

Full body:

```ts
// map.ts:118-130
touches(pos, recover) {
  let diff = 0, index = recoverIndex(recover)
  let oldIndex = this.inverted ? 2 : 1, newIndex = this.inverted ? 1 : 2
  for (let i = 0; i < this.ranges.length; i += 3) {
    let start = this.ranges[i] - (this.inverted ? diff : 0)
    if (start > pos) break
    let oldSize = this.ranges[i + oldIndex], end = start + oldSize
    if (pos <= end && i == index * 3) return true
    diff += this.ranges[i + newIndex] - oldSize
  }
  return false
}
```

`touches(pos, recover)` returns `true` iff `pos` lies within the same range that `recover` was generated for. Internally used by `Mapping._map` only when something tries to recover a position that may no longer be a valid recovery point.

In practice **you do not call this from application code**. The `recover` token is private internals (`MapResult.recover` is `@internal`). It is mentioned in the public source mostly because it is exposed via the `forEach` callback and via `recover()` itself. If you find yourself reading code that uses `touches`, you are inside the `Mapping`/collab machinery — see §4.2 of this file and §11.4 of file 05 for the full picture.

The most important contract: a recover value computed by `StepMap` **M** is meaningful only when fed back to `M` (via `M.recover(value)`) or to `M.invert()` via the mirror mechanism. Calling `M2.touches(pos, recover)` with a recover from `M1` is meaningless; the function only happens to exist because `Mapping._map` needs to ask "is this old recover still valid for the *current* mapping window?" when re-mapping.

### 10.4 `Mapping.maps` (getter) vs `_maps` (private)

```ts
// map.ts:188-191
get maps(): readonly StepMap[] { return this._maps }
private _maps: StepMap[]
```

The getter exposes the underlying step-map array as `readonly`. **Public API** is `mapping.maps`; **internal source** uses `mapping._maps` to do mutating work like `appendMap`, `appendMapping`, `appendMappingInverted`. Distinction:

- `mapping.maps` — safe to iterate. The returned array shares storage with internals; do not mutate. Good for `forEach`-style introspection (`for (let m of mapping.maps) …`).
- `mapping._maps` — `private`. Some older docs and internal source show `_maps`; treat any reference to `_maps` outside `prosemirror-transform` as a leaky implementation detail.

The getter exists *because* of copy-on-write: when a `Mapping` is constructed from a slice of another (`new Mapping(maps, mirror, from, to)`), `_maps` and `mirror` are *shared* with the parent until a mutation happens (`appendMap` triggers `if (!this.ownData) { this._maps = this._maps.slice(); … }`). The getter ensures readers get the right view regardless of whether ownership has been claimed. Don't copy `_maps.length` and pass it around — use `mapping.maps.length` (or `mapping.to`, see §10.5).

### 10.5 `Mapping.from` and `Mapping.to`

```ts
// map.ts:178-186
constructor(
  maps?: readonly StepMap[],
  public mirror?: number[],
  public from = 0,
  public to = maps ? maps.length : 0
) { … }
```

Both are `public` and *mutable* fields. Their meaning:

- `from` — first map index considered when calling `map`/`mapResult`/`_map` (line 254, 267).
- `to` — exclusive upper bound for the same.
- Together they form a half-open window `[from, to)` over `_maps`.

`appendMap` updates `this.to = this._maps.push(map)` (line 209). So in normal use:

- A fresh `Mapping` has `from = 0`, `to = _maps.length`, and grows linearly.
- A `mapping.slice(a, b)` (line 197) returns a `Mapping` with the same `_maps` and `mirror` but `from = a`, `to = b`. **Storage is shared** until mutation.

Pitfalls:

- After `slice()`, `from` and `to` may not match the storage bounds. Code like `for (let i = 0; i < mapping.maps.length; i++) …` will iterate beyond the active window if the mapping was sliced. Use `for (let i = mapping.from; i < mapping.to; i++) …` instead, *or* call `slice().maps` (which is still the full array, but you know the window).
- `from`/`to` can be reassigned freely by client code (they are `public` non-readonly fields). Some collab code does this to reuse a `Mapping` instance across windows. If you reassign, ensure you don't mutate via `appendMap` afterward — the bounds will jump.
- They are safe to read at any time. The "mutable" pitfall is about *writing* them and then continuing to call `map` — make sure your mental model agrees with the values.

### 10.6 The `mirror` array — a small diagram

```ts
// map.ts:225-234
getMirror(n) {
  if (this.mirror) for (let i = 0; i < this.mirror.length; i++)
    if (this.mirror[i] == n) return this.mirror[i + (i % 2 ? -1 : 1)]
}
setMirror(n, m) {
  if (!this.mirror) this.mirror = []
  this.mirror.push(n, m)
}
```

`mirror` is a flat `number[]` of even length. Logical pairs `(a, b)` are stored as consecutive entries `[a, b]`. The lookup `getMirror(n)` is bidirectional — it scans every slot, and given index `i`, returns the *other* element of the pair via `i + (i % 2 ? -1 : 1)`:

- `i` is even (slot 0 of pair) ⇒ partner at `i + 1`.
- `i` is odd  (slot 1 of pair) ⇒ partner at `i - 1`.

So `setMirror(3, 5)` and `setMirror(5, 3)` are equivalent — both result in the lookup `getMirror(3) === 5` and `getMirror(5) === 3`.

ASCII picture:

```
mirror = [ a, b,   c, d,   e, f ]    (3 pairs, 6 entries)
           │  │    │  │    │  │
           └─┬┘    └─┬┘    └─┬┘
             pair    pair    pair
            (a↔b)   (c↔d)   (e↔f)

getMirror(b) walks the array, finds mirror[1] === b at i=1 (odd),
returns mirror[1 - 1] === a.

getMirror(c) walks, finds mirror[2] === c at i=2 (even),
returns mirror[2 + 1] === d.

getMirror(z) — z not in array — returns undefined.
```

When you see `mapping.setMirror(localStepIndex, invertedLocalStepIndex)` in collab code, the diagram above is what's getting populated. The pair `(localStepIndex, invertedLocalStepIndex)` declares "these two maps cancel each other out — when mapping a position through both, recover the original lossly".

In `appendMappingInverted` (lines 237-242), the offset arithmetic `totalSize - mirr - 1` is the index that the original map at index `mirr` will land at *in the reversed inverted appendment*. Because the loop iterates `i = mapping.maps.length - 1` down to 0, and we have `totalSize = this._maps.length + mapping._maps.length`, the *new* index of the map originally at `mirr` is `totalSize - mirr - 1`.

### 10.7 `appendMappingInverted` — worked example

Setup: a `Mapping` `M = appendMap(A); appendMap(B); appendMap(C)` of three step maps, no mirrors. `M._maps = [A, B, C]`, `M.mirror = undefined`.

We want to build the *inverse* mapping `M⁻¹` such that mapping a position through `M` then through `M⁻¹` returns to the original. Calling `M.invert()` does:

```ts
// map.ts:245-249
invert() {
  let inverse = new Mapping
  inverse.appendMappingInverted(this)
  return inverse
}
```

— start with an empty `Mapping`, then append the inverted versions of `M`'s maps in reverse order:

```ts
// map.ts:237-242, with M passed in
appendMappingInverted(mapping = M) {
  for (let i = mapping.maps.length - 1, totalSize = this._maps.length + mapping._maps.length; i >= 0; i--) {
    // i goes 2, 1, 0
    let mirr = mapping.getMirror(i)        // undefined for all i (no mirrors)
    this.appendMap(mapping._maps[i].invert(),
                   mirr != null && mirr > i ? totalSize - mirr - 1 : undefined)
  }
}
```

Step-by-step on our example:

| `i` | `_maps[i]` | `_maps[i].invert()` | Action                                |
|-----|------------|---------------------|---------------------------------------|
| 2   | C          | C⁻¹                 | `appendMap(C⁻¹)` ⇒ `_maps = [C⁻¹]`    |
| 1   | B          | B⁻¹                 | `appendMap(B⁻¹)` ⇒ `_maps = [C⁻¹, B⁻¹]` |
| 0   | A          | A⁻¹                 | `appendMap(A⁻¹)` ⇒ `_maps = [C⁻¹, B⁻¹, A⁻¹]` |

So `M⁻¹._maps = [C⁻¹, B⁻¹, A⁻¹]`. Mapping a post-step position through `M⁻¹` walks the changes in reverse and applies the inverse of each — exactly what's needed.

#### Now with mirrors — a rebase-style example

Suppose we built the mapping `R = appendMap(A); appendMap(B_inv); appendMap(C); setMirror(2, 1)` where:
- `A` is a remote step's map.
- `B_inv` is the inverse of a *local* step `B`'s map (we are about to rebase, so we pre-invert).
- `C` is the remote step that needs `B_inv` to map cleanly through `A`.
- `setMirror(2, 1)` declares "map at index 2 (`C`) is the mirror of map at index 1 (`B_inv`)".

`R._maps = [A, B_inv, C]`, `R.mirror = [2, 1]`.

Now `R.invert()` calls `appendMappingInverted(R)` on a fresh `Mapping`. Iteration:

`totalSize = 0 + 3 = 3`. Loop `i = 2, 1, 0`.

| `i` | `_maps[i]` | `mirr = getMirror(i)` | Condition `mirr > i` | New mirror argument                          | `_maps` after        |
|-----|------------|-----------------------|----------------------|----------------------------------------------|----------------------|
| 2   | C          | `1` (mirror of 2 is 1) | `1 > 2` is false    | `undefined`                                  | `[C⁻¹]`              |
| 1   | B_inv      | `2` (mirror of 1 is 2) | `2 > 1` is true     | `totalSize - mirr - 1 = 3 - 2 - 1 = 0`      | `[C⁻¹, B_inv⁻¹]`     |
| 0   | A          | `undefined`           | n/a                  | `undefined`                                  | `[C⁻¹, B_inv⁻¹, A⁻¹]` |

Here the second `appendMap` call passes `mirrors = 0`, so `setMirror(currentLength - 1, 0)` runs: the current length is 2, so `setMirror(1, 0)` — i.e. map index 1 (`B_inv⁻¹`) is the mirror of map index 0 (`C⁻¹`).

Result: `R⁻¹._maps = [C⁻¹, B_inv⁻¹, A⁻¹]`, `R⁻¹.mirror = [1, 0]`.

The mirror has been *preserved* and *re-anchored* into the inverted layout. A position mapped through `R⁻¹` will use the recovery short-circuit (via `_map`'s `getMirror` branch, lines 269-275) to skip from `C⁻¹` to `B_inv⁻¹` losslessly when applicable.

### 10.8 `mapResult` vs `map` — when to use each

A common question. Decision rule:

- Use **`map(pos, assoc?)`** when you only need the new position. The result is a number; the function never reports failure.
- Use **`mapResult(pos, assoc?)`** when you need to know *whether the original position survived*. The result is a `MapResult`; query `result.deleted` (and the more specific `deletedBefore`/`deletedAfter`/`deletedAcross`) to drive control flow.

Concrete situations:

| Situation                                                | Use         | Why                                                             |
|----------------------------------------------------------|-------------|-----------------------------------------------------------------|
| Shift a decoration by one transaction                    | `map`       | Decoration just moves; if the range disappears, the next map will collapse it. |
| Collab: rebase a step's `from`/`to`                      | `mapResult` | Need to drop the step if both ends are `deletedAcross`.         |
| Move a `NodeSelection` anchor                            | `mapResult` | If the node is gone, fall back to `Selection.near`.             |
| Update a saved cursor pos for "restore on undo"          | `mapResult` | Want to know if the cursor's reference token vanished.          |
| Build a `changedRange` over a transform                  | `map`       | Just folds positions; doesn't care about deletion.              |
| Plugin that highlights "recently changed" content        | `mapResult` | `deletedBefore`/`deletedAfter` indicate which side to highlight. |

`map` is implementable in terms of `mapResult` (`mapResult(pos, assoc).pos`), but `map` has a fast path in `Mapping` (lines 252-257) when there's no `mirror` array — chains the per-map `map` calls without allocating `MapResult` objects. So `map` is meaningfully cheaper for hot loops.

### 10.9 §3.3-§3.4 cross-link — edge sticks

§3.3 (the `[1, 3, 5]` example) produces this bullet:

> `map(4, -1) → 6` (== end, special case `pos == end ? 1 : assoc` so side=+1 even with assoc=−1; the rule "position on edge always sticks to that edge" wins over `assoc`)

Practical consequence for §3.4 cursor preservation: **a `-1` cursor at the right edge of a deletion still moves forward.** That is:

```
old:    "<p>foo[CURSOR]bar</p>"        (cursor at pos 4, immediately after "foo")
delete: "foo"                          (replace [1, 4) with empty)
new:    "<p>[CURSOR?]bar</p>"          (where does cursor land?)
```

If we map `cursor.pos = 4` with `assoc = -1` ("stick to what's before me"), the *intent* is "stay glued to whatever was the right side of 'foo' — i.e. the original position of the 'b' in 'bar'". But because pos 4 is the **right edge** of the deleted range `[1, 4]`, the `_map` formula says `side = pos == end ? 1 : assoc`, so `side = +1` regardless. The cursor lands at `1 + 0 + 0 = 1` (before "bar"). The `MapResult` reports `deletedBefore = true` (DEL_BEFORE bit) and `deletedAfter = false`, with `deleted = true` because `assoc < 0` and `pos != start`.

**Translation**: the cursor follows the right edge forward to where the deletion ended (now position 1, since "foo" is gone). It is *not* placed at "the position of the imaginary 'b'" in some idealised post-state; it sticks to the edge of the deletion. If you want "stay in the original byte sequence as long as it exists", you need a different strategy — typically, query `mapResult` and if `deleted`, decide manually (often: prefer the position that has *non-deleted* neighbours, by re-trying with the opposite assoc).

Cross-link to §3.4: when documenting "use `assoc = -1` for end-of-range" — the rule has an exception: **only `assoc` strictly inside a deletion is honoured. On either edge, the snap is forced.** This is by design (so that "right edge of a range" has a single, deterministic answer), but a common gotcha. If you are debugging a "why didn't my cursor stay where I said?" issue and your cursor is at exactly the end of a deletion, this is why.

### 10.10 End-to-end collab rebase walk-through

This is the worked example for `appendMappingInverted` and `Step.map → null` referenced in §6 and in file 05 §11.9.

Setup. Two clients editing the same doc:

```
Initial doc:  "<p>The fox jumps</p>"
Token positions: 0 <p> 1 T 2 h 3 e 4 ' ' 5 f 6 o 7 x 8 ' ' 9 j 10 u 11 m 12 p 13 s 14 </p> 15
```

**Client A** (us) makes a local step `L`:

- `L = ReplaceStep(5, 8, Slice(text("dog"), 0, 0))` — replace "fox" with "dog".
- After `L`, doc is `"<p>The dog jumps</p>"`.
- `L.getMap() = StepMap([5, 3, 3])`.
- We have *not* shipped `L` to the server yet; it's "pending".

Meanwhile, **Client B** ships a remote step `R` that the server has now broadcast:

- `R = ReplaceStep(0, 4, Slice.empty)` — delete "The " from the original doc.
- The server sees client B's doc was `"<p>The fox jumps</p>"` (the same as ours pre-L), so the step is valid against that doc.
- `R.getMap() = StepMap([0, 4, 0])`.

#### The rebase task

We need to:

1. Roll back our local `L` (so we're back at the pre-L doc).
2. Apply the remote `R` to that doc.
3. Map our local `L` through `R`'s mapping to produce `L'` — a rebased version that's correct against the post-R doc.
4. Apply `L'` to the post-R doc.

The naive way:

```ts
// 1. roll back: invert L
let unL = L.invert(originalDoc)        // ReplaceStep(5, 8, Slice(text("fox"), 0, 0))
let preDoc = unL.apply(myDoc).doc!     // "<p>The fox jumps</p>"
// 2. apply R
let postRDoc = R.apply(preDoc).doc!    // "<p>fox jumps</p>"
// 3. rebase L through R's map
let mapping = new Mapping([R.getMap()])
let Lprime = L.map(mapping)
// 4. apply L'
let finalDoc = Lprime!.apply(postRDoc).doc!
```

Inside step 3, `L.map(mapping)` (replace_step.ts:42-47):

```ts
let to   = mapping.mapResult(8, -1)    // pos 8 → 8 - 4 = 4, no delInfo (after the deletion)
let from = mapping.mapResult(5, +1)    // pos 5 → 5 - 4 = 1, no delInfo
// neither deletedAcross
return new ReplaceStep(1, 4, Slice(text("dog"), 0, 0))
```

So `L' = ReplaceStep(1, 4, Slice(text("dog"), 0, 0))`. Apply to `"<p>fox jumps</p>"` → `"<p>dog jumps</p>"`. Correct.

#### What if `R` engulfs `L`?

Suppose remote `R` was instead `ReplaceStep(0, 15, Slice.empty)` — delete the whole paragraph content. Then:

```ts
let to   = mapping.mapResult(8, -1)    // pos 8 inside [0, 15], side=-1, assoc=-1, pos != start
                                       //   → DEL_ACROSS | DEL_SIDE; deletedAcross = true
let from = mapping.mapResult(5, +1)    // pos 5 inside [0, 15], side=+1, assoc=+1, pos != end
                                       //   → DEL_ACROSS | DEL_SIDE; deletedAcross = true
if (from.deletedAcross && to.deletedAcross) return null     // ← drop the step
```

Both ends are inside `R`'s deleted range with `DEL_ACROSS` set, so `L.map(mapping)` returns `null`. The local step is dropped — we don't attempt to apply it because there's nothing to act on. The user's intended edit ("change fox to dog") had its target deleted by remote; ProseMirror's collab module just silently discards `L` and continues. (Sophisticated apps can detect this and surface a "your change was lost" notice.)

#### What about the *selection*?

Selection mapping is harder than step mapping because selections want to **survive** the round-trip if at all possible. The collab module does not just use `R`'s mapping; it uses a *rebase mapping*:

```
M_rebase = appendMap(L⁻¹.getMap())     // undo our local
           appendMap(R.getMap())        // apply remote
           appendMap(L'.getMap())       // redo our rebased local
           setMirror(0, 2)              // L⁻¹ and L' are mirror images
```

So `M_rebase = [L_inv, R_map, L'_map]` with `mirror = [0, 2]`.

When the *selection* is mapped through `M_rebase`, the lossless inversion trick (§4.2) kicks in. Suppose the user's cursor was at pos 7 (inside "fox") before. Mapping pos 7 through `M_rebase`:

- Step 0 (`L⁻¹.getMap() = StepMap([5, 3, 3])` inverted = also `[5, 3, 3]`): pos 7 inside `[5, 8]`; `recover != null` (it's strictly inside). The mirror of step 0 is step 2 (`L'.getMap()`); `corr = 2 > 0 && < 3`, so we **skip ahead** to step 2 and call `_maps[2].recover(recoverToken)`. But wait — the recover token from step 0's StepMap encodes the offset *into the original "fox" range*. In step 2's StepMap (which is `[1, 3, 3]` for `L' = ReplaceStep(1, 4, "dog")`), `recover(token)` reconstructs `1 + 0 + offset = 1 + 2 = 3` (since pos 7 was offset 2 into "fox"). So pos 7 → pos 3 — which is inside the new "dog" at the corresponding offset! The cursor "tracks" the user's intended position even though the underlying content is now different.
- Continue from step 3 onward. None left, return `pos = 3`, `delInfo = 0` (no flags OR'd in along the recovery path).

If we had used a *plain* `Mapping([R.getMap()])` (no mirror), pos 7 would map through `R` (which deletes [0, 4]) to `7 - 4 = 3`, which happens to be the right answer here. But consider a case where the user's cursor was at pos 5 (start of "fox"):

- With plain `R` mapping: pos 5 → 5 - 4 = 1 (since pos 5 is *outside* `[0, 4]`). Cursor lands before "fox" (now "dog"). Reasonable.
- With rebase mapping: pos 5 inside `[5, 8]` of `L⁻¹`'s map (DEL_AFTER bit, recover present). Mirror to step 2; recover gives `1 + 0 + 0 = 1`. Same answer.

Now consider pos 6 (inside "fox", after "f"):

- With plain `R` mapping: pos 6 outside `[0, 4]` → 6 - 4 = 2. But position 2 in the post-R doc is inside what *was* "x jumps" — the user's "I'm one char into 'fox'" intent is lost.
- With rebase mapping: pos 6 inside `[5, 8]` of step 0; recover token gives offset 1; mirror step 2's recover gives `1 + 0 + 1 = 2`. Same answer in this case — the mirror trick degenerates because the rebased step has the same relative offsets.

The rebase mapping wins clearly when `L` and `L'` have *different* slice content — e.g. if `L` was "replace 'fox' with 'dog'" but the rebase produced `L' = ReplaceStep(1, 4, Slice(text("wolf"), 0, 0))` (e.g. because the slice was further transformed in transit). Then mirror recovery puts the cursor correctly inside "wolf" instead of arbitrarily at `1 + offset` of whatever the new content happens to be.

In the real `prosemirror-collab` implementation, the rebase mapping is built piece by piece as remote steps arrive and local steps are re-derived; `setMirror` calls keep the inversion lossless across the entire rebase chain, even when there are *multiple* local steps to invert and re-apply. The pattern is:

```ts
let mapping = new Mapping
for (let local of locals.slice().reverse()) mapping.appendMap(local.getMap().invert())
let invertedSize = mapping.maps.length
for (let remote of remotes) mapping.appendMap(remote.getMap())
let rebased = []
for (let i = 0; i < locals.length; i++) {
  let mapped = locals[i].map(mapping.slice(invertedSize - i - 1))
  if (!mapped) continue                                  // step dropped
  rebased.push(mapped)
  mapping.appendMap(mapped.getMap(), invertedSize - i - 1)  // declare mirror
}
```

Each rebased step is mirror-paired with its inverse-of-original. Selection mapping through this `mapping` recovers losslessly.

#### Summary for collab rebase

- Local steps are inverted, remote steps applied, local steps re-derived.
- `Step.map(mapping)` returns the rebased step or `null` (entire range engulfed).
- Selection (and decorations) are mapped through the **rebase mapping** with declared mirrors, so positions inside engulfed-then-restored ranges are recovered.
- `MapResult.deleted` signals "the side I asked about was lost"; selection/decoration code uses this to fall back to `Selection.near` or to drop the decoration.

### 10.11 Quick reference — additions

| API / concept                  | Where                               | Behaviour                                                       |
|--------------------------------|-------------------------------------|-----------------------------------------------------------------|
| `Mappable` implementers        | map.ts:3                            | `StepMap`, `Mapping`; consumed by `Selection.map`, decorations  |
| `MapResult.deleted` in selection | state/selection.ts:241/338        | `TextSelection` ignores it, `NodeSelection` uses it             |
| `StepMap.touches(pos, recover)`| map.ts:118                          | internal-only; "is `pos` in the same range as `recover`?"       |
| `Mapping.maps` getter          | map.ts:189                          | public readonly; `_maps` is private                             |
| `Mapping.from`/`to`            | map.ts:180-186                      | mutable window over `_maps`; respect after `slice()`            |
| `mirror` array layout          | map.ts:225-234                      | flat pairs `[a,b,c,d,…]`; `getMirror` searches both directions  |
| `appendMappingInverted`        | map.ts:237                          | reverses order, inverts each, re-anchors mirrors                |
| `mapResult` vs `map`           | (decision)                          | `mapResult` when "did it survive?" matters; `map` otherwise     |
| Edge-stick rule                | map.ts:105                          | `pos == start | end` ignores `assoc`                            |
| Collab rebase pattern          | (worked example)                    | invert locals, append remotes, re-derive locals with mirror     |
