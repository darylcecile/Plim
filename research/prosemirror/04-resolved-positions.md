# ProseMirror — Resolved Positions

> Sources:
> - `prosemirror-model/src/resolvedpos.ts` (entire file)
> - `prosemirror-model/src/node.ts` (`resolve`, `resolveNoCache`, `nodeAt`, `descendants`)
> - `website/markdown/guide/doc.md` (§"Indexing")

ProseMirror represents every position in a document as a single non‑negative integer. That integer is *not* a character offset and *not* a DOM offset — it is an offset into a flat token stream that conceptually walks the document tree. This file documents that token model, the `Node.resolve` walk that converts an integer into a structured `ResolvedPos`, the full `ResolvedPos` API, and `NodeRange`.

---

## 1. The integer position model

Quoting `doc.md` (lines 264–277) verbatim:

> * The start of the document, right before the first content, is position 0.
> * Entering or leaving a node that is not a leaf node (i.e. supports content) counts as one token. So if the document starts with a paragraph, the start of that paragraph counts as position 1.
> * Each character in text nodes counts as one token. So if the paragraph at the start of the document contains the word "hi", position 2 is after the "h", position 3 after the "i", and position 4 after the whole paragraph.
> * Leaf nodes that do not allow content (such as images) also count as a single token.

There are therefore **four kinds of token**:

| Kind                                | Counts as          | Example                |
|-------------------------------------|--------------------|------------------------|
| Open token of a non‑leaf node       | 1                  | `<p>`, `<blockquote>`  |
| Close token of a non‑leaf node      | 1                  | `</p>`, `</blockquote>`|
| Each Unicode codepoint in a text node (well, JS char) | 1     | `h`, `i`               |
| Whole atomic leaf node              | 1                  | `<img>`, `<hr>`        |

The **outer** `doc` node is special: its open/close tokens are *not* counted. Hence `doc.content.size` (not `doc.nodeSize`) is the maximal valid position. From `doc.md` lines 295–301:

> Note that for the outer document node, the open and close tokens are not considered part of the document (because you can't put your cursor outside of the document), so the size of a document is `doc.content.size`, **not** `doc.nodeSize`.

### 1.1 Worked example: `<p>foo</p><p>bar</p>`

```
   doc
   ├── paragraph "foo"
   └── paragraph "bar"
```

Token stream:

```
pos:    0   1   2   3   4   5   6   7   8   9  10
        |   |   |   |   |   |   |   |   |   |   |
        <p>  f   o   o  </p> <p>  b   a   r  </p>
        ^                ^   ^                 ^
        |                |   |                 |
   start of doc    end p1   start p2     end of doc
```

Reading the diagram:

- `0` — *before* the first paragraph (a.k.a. start of `doc.content`). `$pos.parent === doc`, `parentOffset === 0`.
- `1` — *inside* paragraph 1, before the "f". `$pos.parent === p1`, `parentOffset === 0`.
- `2` — between "f" and "o". `parent === p1`, `parentOffset === 1`, `textOffset === 1`.
- `3` — between "o" and "o". `parentOffset === 2`, `textOffset === 2`.
- `4` — *after* "foo", still inside p1. `parent === p1`, `parentOffset === 3`, `textOffset === 0` (we are at the boundary between text node and end of paragraph).
- `5` — *between* the two paragraphs, in the doc. `parent === doc`, `parentOffset === 5`, `index(0) === 1`. This single integer simultaneously represents "right after `</p>` of p1" and "right before `<p>` of p2".
- `6` — inside paragraph 2, before "b". Mirror image of pos 1.
- `7,8,9` — between/after b/a/r in p2.
- `10` — end of doc. `pos === doc.content.size`.

`p1.nodeSize` is `5` (`<p>` + 3 chars + `</p>`), `p2.nodeSize` is `5`, total `doc.content.size` is `10`. The constraint enforced by `ResolvedPos.resolve` is `0 <= pos <= doc.content.size` (resolvedpos.ts:219).

### 1.2 Why "before X" and "after X" both count

ProseMirror needs distinct integer positions to express:

- A cursor *before* node X (caret blinks on X's left edge).
- A cursor *after* node X (caret blinks on X's right edge).
- A cursor inside X but at offset 0 of its content.

For a non‑leaf node the open and close tokens are *necessary boundary positions*. Consider `<p>foo</p><p>bar</p>` again — without separate before/after tokens, pos `5` ("between paragraphs") would have to coincide with pos `4` (end of p1) or pos `6` (start of p2), losing the distinction between "cursor at end of p1" and "cursor in document gap" and "cursor at start of p2". Three semantically different cursor states collapse into one.

The same idea applies inside a `<blockquote><p>Two<img></p></blockquote>` document (`doc.md` lines 282–293):

```
0            1   2 3 4   5   6           7
<blockquote> <p> T w o <img> </p> </blockquote>
```

`<img>` is a content‑less leaf: it occupies exactly **one** token (position 5 → 6 spans the image). You cannot "enter" it — `resolve(5)` and `resolve(6)` both place the parent as the `<p>`, with `nodeAfter`/`nodeBefore` being the image.

### 1.3 Token positions for atomic leaves

```
... <p> T w o <img> </p> ...
        ^   ^   ^   ^
       T1  T3  T4  T5    ← token positions inside p
```

Crucially: positions *inside* a leaf are not addressable. `resolve(pos)` will *never* descend into a non‑text leaf. The walk stops because the leaf is consumed as a single child of its parent, advancing `parentOffset` by `nodeSize === 1`.

### 1.4 Inside text vs. at text boundary

For text nodes the situation is the opposite — the walk **does** descend into text but stops there because text has no `content`:

```
parent: paragraph "hello"  (nodeSize 7: <p> h e l l o </p>)

absolute pos:     1  2  3  4  5  6
                  |  |  |  |  |  |
in p:           [<p>] h  e  l  l  o [</p>]
                  ^  ^  ^  ^  ^  ^
   parent=doc    parent=p, textOffset=0..4    parent=p, textOffset=0
   index(0)=0     (inside text node)         (between text and </p>)
```

- At pos 1 the position is *between* `<p>` and the start of the text node; `textOffset === 0`, `nodeAfter === text("hello")`, `nodeBefore === null`.
- At pos 2 the position is *inside* the text node; `textOffset === 1`, `nodeAfter === text("ello")`, `nodeBefore === text("h")` (cut copies — see §3.5).
- At pos 6 the position is *between* the text node and `</p>`; `textOffset === 0`, `nodeAfter === null`, `nodeBefore === text("hello")`.

The boundary case (`textOffset === 0`) is what differentiates "I am at the seam between two text nodes" from "I am inside this text node at offset 0/N". It matters for marks (a typed character at a boundary needs to know which set of marks to inherit — see `marks()`).

---

## 2. The `resolve` algorithm

`ResolvedPos.resolve(doc, pos)` (resolvedpos.ts:217–233) walks the tree top‑down, recording an entry for each ancestor in a single flat `path` array:

```ts
// resolvedpos.ts:217-233
static resolve(doc: Node, pos: number): ResolvedPos {
  if (!(pos >= 0 && pos <= doc.content.size)) throw new RangeError("Position " + pos + " out of range")
  let path: Array<Node | number> = []
  let start = 0, parentOffset = pos
  for (let node = doc;;) {
    let {index, offset} = node.content.findIndex(parentOffset)
    let rem = parentOffset - offset
    path.push(node, index, start + offset)
    if (!rem) break
    node = node.child(index)
    if (node.isText) break
    parentOffset = rem - 1
    start += offset + 1
  }
  return new ResolvedPos(pos, path, parentOffset)
}
```

### 2.1 Path encoding

`path` is a flat array packed as triples — `[node, index, posBeforeNode, node, index, posBeforeNode, ...]`. So `path.length / 3 - 1` is the depth (resolvedpos.ts:27):

```
path = [doc,    idx0, startBefore0,
        ancestor1, idx1, startBefore1,
        ...
        parent,  idxN, startBeforeN]
                                       ↑ depth = N
```

Element at offset `d*3` is `node(d)`. Offset `d*3 + 1` is `index(d)`. Offset `d*3 + 2` is the *absolute position right before the start of `node(d+1)`* — i.e. the position of the open token of `node(d+1)` (or, for `d == depth`, the position of the start of the parent's *child* at `index(depth)`).

### 2.2 Loop semantics, step by step

For each iteration:

1. `node` is the current ancestor we are walking through.
2. `parentOffset` is the offset *into `node.content`* that we still need to reach. Initially this equals the absolute `pos`, because the doc's start is absolute 0.
3. `node.content.findIndex(parentOffset)` returns `{index, offset}` where:
   - `index` is the child index that contains or starts at `parentOffset`,
   - `offset` is the local content offset of that child's start (`offset <= parentOffset`).
4. `rem = parentOffset - offset` is the remaining offset *inside* the child at `index`. If `rem === 0`, the position is exactly between two children of `node` — we stop, and `node` becomes the parent.
5. Otherwise we descend: `node = node.child(index)`. If that child is text we also stop (text is opaque to descent). Otherwise we subtract `offset + 1` from `parentOffset` (the `+1` is the open token of the child we just descended into), and add `offset + 1` to the absolute `start` we're tracking, then loop.

When the loop exits, `parentOffset` is the offset within the current `node`'s content (= `path[depth*3].content`). `parent` is `path[depth*3]`.

### 2.3 Walk trace: `<p>foo</p><p>bar</p>`, resolve(7)

```
Iter 0:  node = doc,  parentOffset = 7, start = 0
         findIndex(7) on doc.content (children of size 5,5)
            → {index: 1, offset: 5}     // p2 starts at content offset 5
         rem = 7 - 5 = 2
         path push: [doc, 1, 0+5=5]
         descend into doc.child(1) = p2
         p2.isText? no
         parentOffset = 2 - 1 = 1       // skip <p> open token
         start = 0 + 5 + 1 = 6

Iter 1:  node = p2,  parentOffset = 1, start = 6
         findIndex(1) on p2.content (one text "bar", size 3)
            → {index: 0, offset: 0}
         rem = 1 - 0 = 1
         path push: [p2, 0, 6+0=6]
         descend into p2.child(0) = text("bar")
         text.isText? yes → break

Result: path = [doc, 1, 5,  p2, 0, 6]
        parentOffset = 1
        depth = 6/3 - 1 = 1
        pos = 7
```

So `$7.depth === 1`, `$7.parent === p2`, `$7.parentOffset === 1`, `$7.textOffset === 7 - 6 === 1`, `$7.nodeBefore === text("b")`, `$7.nodeAfter === text("ar")`.

### 2.4 Walk trace: resolve(5) on the same doc (between paragraphs)

```
Iter 0:  node = doc, parentOffset = 5, start = 0
         findIndex(5) → {index: 1, offset: 5}   // exactly at start of p2
         rem = 5 - 5 = 0
         path push: [doc, 1, 5]
         rem === 0 → break

Result: path = [doc, 1, 5]
        depth = 0,  parent = doc,  parentOffset = 5,  textOffset = 5 - 5 = 0
        nodeBefore = doc.child(0) = p1
        nodeAfter  = doc.child(1) = p2
```

This is a **boundary** position: depth stayed at 0, no descent. The cursor sits *between* children of `doc`.

### 2.5 Walk trace: resolve(0) and resolve(doc.content.size)

`resolve(0)` on any non‑empty doc:

```
findIndex(0) → {index: 0, offset: 0}, rem = 0 → break
path = [doc, 0, 0],  depth = 0,  parentOffset = 0
nodeBefore = null, nodeAfter = doc.firstChild
```

`resolve(doc.content.size)` (= 10 in our example):

```
Iter 0: parentOffset = 10
        findIndex(10) → {index: 2, offset: 10}    // past last child
        rem = 0 → break
path = [doc, 2, 10], depth = 0, parentOffset = 10
nodeBefore = doc.child(1) = p2, nodeAfter = null
```

### 2.6 Empty doc

For `doc` with empty content (`doc.content.size === 0`), only `resolve(0)` is valid:

```
findIndex(0) on empty content → {index: 0, offset: 0}, rem = 0
path = [doc, 0, 0], depth = 0, parentOffset = 0
parent = doc, nodeBefore = null, nodeAfter = null
marks() → Mark.none (resolvedpos.ts:134: "In an empty parent, return the empty array")
```

---

## 3. The `ResolvedPos` API

All citations refer to `prosemirror-model/src/resolvedpos.ts`.

### 3.1 Core fields

| Field            | Source            | Meaning                                                                                |
|------------------|-------------------|----------------------------------------------------------------------------------------|
| `pos`            | line 21           | The original integer position.                                                         |
| `path`           | line 23           | Flat triples `[node, index, startBefore]` per ancestor.                                |
| `parentOffset`   | line 25           | Offset into `parent.content`.                                                          |
| `depth`          | line 27           | `path.length / 3 - 1`. 0 == directly in root; 1 == in top‑level block; etc.            |

`resolveDepth(val)` (lines 31–35) normalises the optional `depth` arg: `null/undefined → this.depth`, negative → counted from `this.depth`, positive → as given.

### 3.2 Tree access: `node`, `index`, `indexAfter`

```ts
node(depth?)       → path[d*3]                                  // line 47
index(depth?)      → path[d*3 + 1]                              // line 52
indexAfter(depth?) → index(d) + (d == depth && !textOffset ? 0 : 1)  // line 56-59
```

`indexAfter` is subtle: at the deepest level (`d === this.depth`), if we are *exactly* between children (`textOffset === 0`), then "after" is the same index — there is no child to skip. Otherwise (or at any shallower depth) it is `index(d) + 1`.

Convenience getters:

- `parent` → `node(depth)` (line 40).
- `doc` → `node(0)` (line 43).

### 3.3 Absolute positions: `start`, `end`, `before`, `after`

```ts
start(d)  = d == 0 ? 0 : path[d*3 - 1] + 1                              // line 63-66
end(d)    = start(d) + node(d).content.size                             // line 70-73
before(d) = d == this.depth + 1 ? this.pos : path[d*3 - 1]              // line 78-82
after(d)  = d == this.depth + 1 ? this.pos
                                : path[d*3 - 1] + path[d*3].nodeSize    // line 86-90
```

- `start(d)` is the absolute position **just inside** `node(d)` (right after its open token). For the doc this is `0`.
- `end(d)` is the position **just inside the close token** of `node(d)`.
- `before(d)` is the position of `node(d)`'s open token (i.e. *outside* the node, on its left).
- `after(d)` is the position immediately past `node(d)`'s close token.
- `before(0)` and `after(0)` throw — there is no position outside the doc.
- `before(this.depth + 1)` / `after(this.depth + 1)` return `this.pos` — a convenience for "the imaginary node at this position".

For `<p>foo</p><p>bar</p>` resolve(7):

```
depth = 1,  path = [doc, 1, 5, p2, 0, 6]
start(0) = 0           start(1) = path[2] + 1 = 6
end(0)   = 10          end(1)   = 6 + p2.content.size = 6 + 3 = 9
before(0) throws       before(1) = path[2] = 5
after(0)  throws       after(1)  = 5 + p2.nodeSize = 5 + 5 = 10
before(2) = pos = 7    after(2)  = pos = 7
```

### 3.4 Text vs. boundary helpers

```ts
get textOffset() { return this.pos - this.path[this.path.length - 1] }   // line 95
```

`path[path.length - 1]` is the absolute position right before the deepest child the walk landed on — for text descents, that is the start of the text node. So `textOffset` is `0` when the position sits *between* children of `parent` and `> 0` when *inside* a text node.

### 3.5 `nodeBefore` / `nodeAfter`

```ts
get nodeAfter() {                                                        // line 100-105
  let parent = this.parent, index = this.index(this.depth)
  if (index == parent.childCount) return null
  let dOff = this.pos - this.path[this.path.length - 1], child = parent.child(index)
  return dOff ? parent.child(index).cut(dOff) : child
}

get nodeBefore() {                                                       // line 110-115
  let index = this.index(this.depth)
  let dOff = this.pos - this.path[this.path.length - 1]
  if (dOff) return this.parent.child(index).cut(0, dOff)
  return index == 0 ? null : this.parent.child(index - 1)
}
```

Important detail: when inside a text node, both `nodeBefore` and `nodeAfter` return *cuts* of the same text node (a fresh `Text` node, since nodes are persistent values). At a non‑text boundary they return distinct child nodes (or `null` at the edges).

### 3.6 `posAtIndex`

```ts
posAtIndex(index, depth?) {                                              // line 119-124
  depth = this.resolveDepth(depth)
  let node = this.path[depth*3], pos = depth == 0 ? 0 : this.path[depth*3 - 1] + 1
  for (let i = 0; i < index; i++) pos += node.child(i).nodeSize
  return pos
}
```

Converts a child *index* of `node(depth)` to the absolute position of that child's open token. O(index) — if you need many, prefer iterating manually.

### 3.7 `marks()` and `marksAcross($end)`

`marks()` (resolvedpos.ts:130–152) returns the marks that newly typed text at this position should inherit. It distinguishes:

- **Inside a text node** (`textOffset > 0`): just return the text node's marks. Trivial — you are inside a marked run.
- **At a boundary**: pick a *main* reference (the node before this position; if none, the node after) and start with its marks. Then strip any mark whose spec has `inclusive === false` *unless* that mark is also present on the *other* (next) node. This implements the standard rule "non‑inclusive marks (e.g. links) do not extend past their endpoint".

```ts
// resolvedpos.ts:139-149
let main = parent.maybeChild(index - 1), other = parent.maybeChild(index)
if (!main) { let tmp = main; main = other; other = tmp }
let marks = main!.marks
for (var i = 0; i < marks.length; i++)
  if (marks[i].type.spec.inclusive === false && (!other || !marks[i].isInSet(other.marks)))
    marks = marks[i--].removeFromSet(marks)
```

(Note: the `tmp` swap is dead code when `!main` — it just sets `main = other; other = undefined`. The behaviour is "use the only available side".)

`marksAcross($end)` (lines 160–169) is used after a deletion: returns the marks of the inline node at `this.index()` minus any non‑inclusive marks that would not also be present at `$end`. Returns `null` if `this` is at the end of its parent or the parent is not inline content — i.e. "no marks should be preserved for a deletion that crossed block boundaries".

### 3.8 `sharedDepth`

```ts
sharedDepth(pos) {                                                        // line 173-177
  for (let depth = this.depth; depth > 0; depth--)
    if (this.start(depth) <= pos && this.end(depth) >= pos) return depth
  return 0
}
```

Returns the deepest depth at which `this` and the *raw* (unresolved) `pos` share an ancestor. Used by `Node.slice` (node.ts:163) to decide how deep to copy.

### 3.9 `blockRange(other?, pred?)` → `NodeRange | null`

```ts
// resolvedpos.ts:186-192
blockRange(other = this, pred?) {
  if (other.pos < this.pos) return other.blockRange(this)
  for (let d = this.depth - (this.parent.inlineContent || this.pos == other.pos ? 1 : 0); d >= 0; d--)
    if (other.pos <= this.end(d) && (!pred || pred(this.node(d))))
      return new NodeRange(this, other, d)
  return null
}
```

Computes the smallest enclosing depth `d` such that:

1. `other.pos <= this.end(d)` — both ends fall inside `node(d)`.
2. The optional `pred` accepts `node(d)` (e.g. only allow blockquotes).

The starting depth subtracts 1 if `this.parent` is inline (e.g. textblock content) or if `this === other` (a single point) — we don't want to wrap *inside* a textblock; we want the textblock itself. The result is the natural "wrap target" for commands like `wrapInList`, `lift`, etc.

### 3.10 `sameParent`, `min`, `max`, `toString`

```ts
sameParent(other) { return this.pos - this.parentOffset == other.pos - other.parentOffset } // 195
max(other) { return other.pos > this.pos ? other : this }                                    // 200
min(other) { return other.pos < this.pos ? other : this }                                    // 205
toString() { /* "paragraph_0/text_0:3" style */ }                                            // 210-215
```

`sameParent` works because `pos - parentOffset === start(depth)` (the position of the open token of `parent`), and two positions inside the same parent share that anchor.

---

## 4. `NodeRange` and `blockRange`

```ts
// resolvedpos.ts:259-289
export class NodeRange {
  constructor(readonly $from: ResolvedPos,
              readonly $to:   ResolvedPos,
              readonly depth: number) {}

  get start()      { return this.$from.before(this.depth + 1) }
  get end()        { return this.$to.after(this.depth + 1) }
  get parent()     { return this.$from.node(this.depth) }
  get startIndex() { return this.$from.index(this.depth) }
  get endIndex()   { return this.$to.indexAfter(this.depth) }
}
```

A `NodeRange` is a **flat range**: a contiguous span of children inside a single parent at the given `depth`. `start`/`end` are absolute positions that bracket those children. `startIndex`/`endIndex` are child indices (half‑open) into `parent`.

### 4.1 ASCII picture

```
   parent = node(depth)
   ┌────────────────────────────────────────────────────────────┐
   │  child[0]   child[1]   child[2]   child[3]   child[4]      │
   │             ▲                     ▲                        │
   │             │                     │                        │
   │           start                  end                       │
   │           startIndex=1     endIndex=3                      │
   └────────────────────────────────────────────────────────────┘
```

`blockRange` walks up from `$from.depth` (or one less, see §3.9) until it finds a depth that contains `$to`. The result is the natural wrap target for commands such as wrapping in a list, lifting out of a parent, etc.

Note the constructor warning (resolvedpos.ts:266–269): `$from` and `$to` are *the original* resolved positions, which may have a depth greater than `range.depth`. Their depth at the range's level is what matters; do not assume `$from.depth === range.depth`.

---

## 5. Caching: `resolveCache`

```ts
// resolvedpos.ts:236-249, 252-257
static resolveCached(doc, pos) {
  let cache = resolveCache.get(doc)
  if (cache) {
    for (let i = 0; i < cache.elts.length; i++) {
      let elt = cache.elts[i]
      if (elt.pos == pos) return elt
    }
  } else {
    resolveCache.set(doc, cache = new ResolveCache)
  }
  let result = cache.elts[cache.i] = ResolvedPos.resolve(doc, pos)
  cache.i = (cache.i + 1) % resolveCacheSize
  return result
}

class ResolveCache { elts: ResolvedPos[] = []; i = 0 }
const resolveCacheSize = 12, resolveCache = new WeakMap<Node, ResolveCache>()
```

Properties:

- **Per‑doc** — keyed by the `Node` instance itself in a `WeakMap`. Because nodes are persistent values, replacing the doc invalidates nothing — the new doc just gets its own cache, and the old entry is GC‑able.
- **Bounded** — 12 entries, ring‑buffered by `cache.i`. Cheap, lossy, optimised for the hot pattern of "resolve a small set of related positions repeatedly during one event" (e.g. `selection.from` and `selection.to`).
- **Linear scan** — the cache lookup is O(12). Faster than re‑walking even a moderately deep doc.
- **Public entry** is `Node.resolve(pos)` (node.ts:211). `Node.resolveNoCache(pos)` (node.ts:214) skips the cache for fresh objects (used when you explicitly need an uncached instance, e.g. tests, or when you have just mutated something you shouldn't have).

---

## 6. Edge cases

- **`pos === 0` and `pos === doc.content.size`** — always valid (resolvedpos.ts:219). depth is 0; `nodeBefore`/`nodeAfter` may be `null`.
- **Position exactly between blocks** (e.g. pos 5 in the worked example) — depth stays at 0 even though the cursor visually sits "between" two paragraphs. To get a position *inside* a block, increment by 1.
- **Position at end of textblock, before close token** (pos 4 in `<p>foo</p>`) — depth is 1, parent is `p1`, `parentOffset === 3 === p1.content.size`, `textOffset === 0`. `nodeAfter === null`, `nodeBefore === text("foo")`.
- **Position inside text** (pos 2) — depth is 1, `textOffset > 0`. `nodeBefore`/`nodeAfter` are `cut`s of the same text node.
- **Atomic leaves** — you cannot resolve *into* a leaf. `resolve(5)` on a doc whose first child is `<hr>` returns depth 0 with `nodeBefore = null` (not yet past it) and `nodeAfter = hr` (no, wait): actually `<hr>` has nodeSize 1, so positions 0 and 1 both have depth 0. `resolve(0).nodeAfter === hr`, `resolve(1).nodeBefore === hr`. There is no position "inside" the `<hr>`.
- **Out‑of‑range** — `pos < 0` or `pos > doc.content.size` throws `RangeError("Position N out of range")` (resolvedpos.ts:219).
- **Empty doc** — `doc.content.size === 0`; only `resolve(0)` works, depth 0, `parent === doc`, both neighbours null.

### 6.1 Position relationships at a glance

For a resolved position `$p`:

```
                                    pos
                                     │
        ┌─────────────parent─────────┼─────────────────────┐
        │                            ▼                     │
        │      …  childA  childB  ●  childC  childD  …     │
        │                       ↑                          │
        │                  parentOffset                    │
        │                                                  │
        ▲                                                  ▲
       start(depth)                                      end(depth)
       = pos - parentOffset                              = start + parent.content.size

       before(depth) = start(depth) - 1   (open token of parent)
       after(depth)  = end(depth) + 1     (close token of parent)

       nodeBefore = childB    nodeAfter = childC
       index(depth) = childIndex(B)+1  (i.e. points to childC's slot)
```

When *inside* a text node, the picture telescopes:

```
       parent (textblock)
       │
       │   text("hello world")
       │   │ h e l l o   w o r l d │
       │             ↑
       │           pos
       │   textOffset = 4 (between "hell" and "o…")
       │
       index(depth) = (text node's index)
       nodeBefore = text("hell")   nodeAfter = text("o world")
```

---

## 7. Summary cheatsheet

| Question                                          | API                                          |
|---------------------------------------------------|----------------------------------------------|
| What's at this depth?                             | `$p.node(d)`                                 |
| Which child of `node(d)` are we in?               | `$p.index(d)`                                |
| Position of the open token of `node(d)`           | `$p.before(d)`                               |
| Position right after `node(d)`'s close token      | `$p.after(d)`                                |
| First valid pos inside `node(d)`                  | `$p.start(d)`                                |
| Last valid pos inside `node(d)`                   | `$p.end(d)`                                  |
| Are we inside a text node, and where?             | `$p.textOffset > 0`                          |
| Node literally on the left/right                  | `$p.nodeBefore` / `$p.nodeAfter`             |
| Marks for newly typed text                        | `$p.marks()`                                 |
| Marks to preserve after deletion to `$q`          | `$p.marksAcross($q)`                         |
| Smallest block range covering `$p` and `$q`       | `$p.blockRange($q, pred?)`                   |
| Common ancestor depth with another (raw) pos      | `$p.sharedDepth(pos)`                        |

`Node.resolve(pos)` is the only entry point you need; the cache is an internal optimisation. For raw lookups without a `ResolvedPos`, `Node.nodeAt(pos)` (node.ts:180–188) walks the tree similarly but only returns the leaf node directly after `pos` (or `null`).
