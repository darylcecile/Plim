# 10 — Decorations

> Source: `prosemirror-view/src/decoration.ts`. Cross-references: `viewdesc.ts` (consumer), `index.ts` (`viewDecorations`).

Decorations are the **out-of-band rendering channel**: they let plugins influence how the document is drawn without modifying the document. Because they live alongside the doc rather than in it, they cost no transactions to update and are perfectly suited for ephemeral UI — selection highlights, search hits, lint underlines, collab cursors, autocomplete popovers, drag previews.

Decorations never affect the *document content* (the immutable `state.doc`). They can change the *rendered DOM* — `node`-decorations set attributes on the wrapper, `inline`-decorations split text runs and add wrapping spans, `widget`-decorations splice extra DOM nodes in. So "out-of-band" is precisely about the doc tree, not the DOM tree.

The view treats decorations as **first-class inputs to reconciliation**: `NodeViewDesc.matchesNode` includes them in its equality check (`viewdesc.ts:754-757`), so changing a decoration triggers exactly the right amount of redraw.

---

## 1. Three flavours of `Decoration`

```ts
class Decoration {
  constructor(readonly from: number, readonly to: number, readonly type: DecorationType)
}
```
(`decoration.ts:108-118`)

The static factories return a `Decoration` whose `type` is one of `WidgetType` / `InlineType` / `NodeType`. The `type` carries the rendering intent and the comparison logic.

### 1.1 `Decoration.widget(pos, toDOM, spec?)` (`decoration.ts:141-203`)

Inserts a **detached DOM node at a single position**. Zero size in document terms (`from == to == pos`).

`toDOM` may be either a DOM node directly or a function `(view, getPos) => DOMNode` — the lazy form is preferred so the DOM is built only when actually mounted, and `getPos()` reflects the live position of the widget after mapping.

`spec` fields (`decoration.ts:141-201`):

| Field | Default | Meaning |
|---|---|---|
| `side` | `0` | Bias: negative = "before" the position; non-negative = "after". Determines (a) **mapping** when content is inserted at `pos` (the widget moves to one side), (b) **draw order** when multiple widgets share a position (lower side first), (c) which marks wrap the widget when `marks` is null (marks of node before vs after). |
| `relaxedSide` | `false` | Without this, the cursor at `pos` is forced onto the side specified by `side`. With it, the DOM selection may stay on the other side. Triggers `WidgetViewDesc.ignoreForSelection` (`viewdesc.ts:581`). |
| `marks` | derived from neighbours | Explicit set of marks to wrap the widget in. |
| `stopEvent(event)` | `false` | Like `NodeView.stopEvent`. |
| `ignoreSelection` | `false` | If true, selection changes inside the widget are ignored (`viewdesc.ts:570-572`). |
| `key` | identity of `toDOM` | Reuse key. Two widgets with the same `key` are considered interchangeable (`WidgetType.eq`, `decoration.ts:39-44`) — without it, the widget's DOM is compared by **reference**, which means generating widgets fresh each tick will defeat reuse. |
| `destroy(node)` | none | Called when the widget desc is destroyed (`decoration.ts:46-48`, `viewdesc.ts:574-577`). |
| `raw: true` | — (undocumented escape) | Skip the auto-wrapping in a `<span contenteditable=false>` (`viewdesc.ts:545-553`). Used internally for the cursor wrapper. |

`WidgetType.map` (`decoration.ts:32-35`) keeps the widget alive across mappings unless its position is fully deleted; bias direction comes from `side`.

### 1.2 `Decoration.inline(from, to, attrs, spec?)` (`decoration.ts:207-224`)

Adds DOM attributes (or wraps in `nodeName`) on **every inline piece** between `from` and `to`. Text spans are split as needed by `iterDeco` (`viewdesc.ts:1510-1520`) so that each resulting view-desc is wholly inside or wholly outside the decoration.

`attrs: DecorationAttrs` (`decoration.ts:247-261`):

* `nodeName?` — wrap in this tag (e.g. `"span"`, `"mark"`).
* `class?` — added to existing classes.
* `style?` — appended to existing inline style.
* anything else — set as a regular DOM attribute.

`spec`:

* `inclusiveStart` — when content is inserted exactly at `from`, does the decoration grow to cover it? Default false. (`decoration.ts:58-60`.)
* `inclusiveEnd` — same at `to`.

`InlineType.valid` (`decoration.ts:64`) requires `from < to`; an inline deco that gets mapped to zero width is dropped.

**Important constraint**: inline decorations **don't cross node boundaries** in their drawn form. `DecorationSet.forChild` (`decoration.ts:431-453`) clips them to the child node's content range when descending, and `iterDeco` only emits them within a single inline run. If you create one with `from`/`to` spanning multiple paragraphs, each paragraph receives its own clipped slice.

### 1.3 `Decoration.node(from, to, attrs, spec?)` (`decoration.ts:229-231`)

Adds attrs/wrapping to the **single node** that occupies positions `from..to`. `from` must be exactly before the node and `to` exactly after (`NodeType.valid`, `decoration.ts:91-94`); if the doc no longer has a node there after mapping, the decoration is dropped.

These appear in the view as **outer decorations** of a `NodeViewDesc` (`viewdesc.ts:670, 690-722, 871-883`) and are applied via `applyOuterDeco` / `patchOuterDeco` / `computeOuterDeco` (`viewdesc.ts:1069-1150`). Multiple node decorations stack into nested wrapper levels; each `nodeName` introduces one extra wrapper.

`NodeType.map` (`decoration.ts:83-89`) requires both endpoints to survive (mapping bias `+1` at start, `-1` at end) and `to > from`.

### 1.4 The `DecorationType` polymorphism

```ts
interface DecorationType {
  spec: any
  map(mapping, span, offset, oldOffset): Decoration | null
  valid(node, span): boolean
  eq(other: DecorationType): boolean
  destroy(dom): void
}
```
(`decoration.ts:13-19`)

Every concrete type implements its own mapping, validity, equality, and destruction. The `Decoration` wrapper is a dumb data carrier; the type owns the behaviour.

---

## 2. `DecorationSet` — a tree mirroring the doc

```ts
class DecorationSet implements DecorationSource {
  local:    readonly Decoration[]                        // decos fully inside this level
  children: readonly (number | DecorationSet)[]          // [from, to, subset, from, to, subset, ...]
}
```
(`decoration.ts:286-296`)

The set is **persistent** (immutable) — every mutation returns a new value. The tree shape *parallels* the doc tree: each child entry covers one node's interior, indexed by its offset within the parent. `local` holds anything that is not strictly inside a single child.

### 2.1 Construction — `DecorationSet.create(doc, decorations)` (`decoration.ts:301-303`)

Calls `buildTree(spans, doc, 0, options)` (`decoration.ts:713-735`). For each child in the doc, `takeSpansForNode` (`decoration.ts:690-700`) consumes any spans **strictly inside** that child (`from > offset && to < end`). Those go recursively into the child's subtree. Whatever remains (spans touching the boundary, widget decos at boundaries, node decos covering the child exactly) stays at this level in `local`, sorted by `byPos` (`decoration.ts:740-742`).

### 2.2 `add(doc, decorations)` (`decoration.ts:365-391`)

Re-uses the existing tree as much as possible. For each child, only that child's subtree is rebuilt, the rest of `children` is preserved. `local` is concatenated with anything the children rejected and re-sorted. If the set was empty, falls through to `create`.

The argument array is **consumed** (mutated) — callers must clone if they want to keep it.

### 2.3 `remove(decorations)` (`decoration.ts:395-429`)

Walks the tree; for each child whose range fully contains a decoration, recurses. For each `local` slot, removes by `eq` match. Returns the same set object if nothing changed (referential equality is preserved as a fast path for `eq` and reconciliation).

### 2.4 `find(start?, end?, predicate?)` (`decoration.ts:311-330`)

Recursive scan that returns decorations *touching* the range (boundary inclusive). Predicate filters on spec. Returned decos are reified at absolute positions (`copy(from + offset, to + offset)`).

### 2.5 `map(mapping, doc, options?)` — `mapInner` + `mapChildren` walkthrough (`decoration.ts:334-359`, 568-653)

The clever bit. `mapInner` does the per-set work; `mapChildren` is the algorithm that decides which subtrees to keep, recurse into, or rebuild.

#### The `-1` / `-2` sentinel codes (the core algorithm)

`children` is a flat triple-array `[fromA, toA, setA, fromB, toB, setB, ...]` sorted by `from`. During mapping, the `to` slot is **temporarily repurposed as a sentinel** to mark each child's status:

* **untouched** — `to` keeps a real positive number; nothing in the mapping overlapped this child's range.
* **`-1` ("touched in interior")** — at least one mapping step touched this child's range, but the child's covering node *might* still survive in the new doc. Recurse with `mapInner` and decide.
* **`-2` ("touched at boundary, must rebuild")** — the touched range crosses or starts at the child's boundary. The child's covering node cannot be assumed to still exist; we must throw away this subtree and rebuild it from gathered decorations.

Phase 1 — flag the children (lines 581-599):

```ts
for (let i = 0, baseOffset = oldOffset; i < mapping.maps.length; i++) {
  let moved = 0
  mapping.maps[i].forEach((oldStart, oldEnd, newStart, newEnd) => {
    let dSize = (newEnd - newStart) - (oldEnd - oldStart)
    for (let i = 0; i < children.length; i += 3) {
      let end = children[i + 1] as number
      if (end < 0 || oldStart > end + baseOffset - moved) continue   // already flagged or strictly before
      let start = (children[i] as number) + baseOffset - moved
      if (oldEnd >= start) {
        children[i + 1] = oldStart <= start ? -2 : -1                // 590 — boundary vs interior
      } else if (oldStart >= baseOffset && dSize) {
        ;(children[i] as number) += dSize                            // 592 — shift unchanged child
        ;(children[i + 1] as number) += dSize
      }
    }
    moved += dSize
  })
  baseOffset = mapping.maps[i].map(baseOffset, -1)
}
```

Per step, per child: if the step touched the child *at or before its start* → `-2`; if the step touched it only inside → `-1`; if the step is strictly before the child but had a size delta → shift `from`/`to` to the new positions.

Phase 2 — recurse touched-but-maybe-alive children (lines 604-633):

```ts
for (let i = 0; i < children.length; i += 3) if (children[i + 1] < 0) {
  if (children[i + 1] == -2) { mustRebuild = true; children[i + 1] = -1; continue }
  // -1: try mapInner on the corresponding new-doc child
  let from = mapping.map(oldChildren[i] + oldOffset), fromLocal = from - offset
  if (fromLocal < 0 || fromLocal >= node.content.size) { mustRebuild = true; continue }
  let to = mapping.map(oldChildren[i + 1] + oldOffset, -1), toLocal = to - offset
  let {index, offset: childOffset} = node.content.findIndex(fromLocal)
  let childNode = node.maybeChild(index)
  if (childNode && childOffset == fromLocal && childOffset + childNode.nodeSize == toLocal) {
    let mapped = (children[i + 2] as DecorationSet).mapInner(...)
    if (mapped != empty) { children[i] = fromLocal; children[i+1] = toLocal; children[i+2] = mapped }
    else { children[i + 1] = -2; mustRebuild = true }                 // promote to rebuild
  } else { mustRebuild = true }
}
```

If the new-doc child at the mapped position has the same shape and the recursive `mapInner` returned a non-empty set, keep it (overwriting the sentinel back to real `from`/`to`). Otherwise promote to `-2` and trigger rebuild.

Phase 3 — rebuild (lines 636-650):

```ts
if (mustRebuild) {
  let decorations = mapAndGatherRemainingDecorations(children, oldChildren, newLocal, mapping, ...)
  let built = buildTree(decorations, node, 0, options)
  newLocal = built.local
  // Remove all still-flagged-as-rebuild children
  for (let i = 0; i < children.length; i += 3) if (children[i + 1] < 0) { children.splice(i, 3); i -= 3 }
  // Splice in the newly built children at sorted positions
  for (let i = 0, j = 0; i < built.children.length; i += 3) {
    let from = built.children[i]
    while (j < children.length && children[j] < from) j += 3
    children.splice(j, 0, built.children[i], built.children[i + 1], built.children[i + 2])
  }
}
```

Gather every decoration from the rebuild-flagged children, map them, hand them to `buildTree` along with the newLocal pile, then merge the result back into the surviving sibling children.

#### Worked transaction trace — splitting a paragraph

Initial doc: `doc(p("Hello world"))`. Decoration set has one inline deco on `[2..7]` (covering "ello "). Tree:

```
DecorationSet {
  local: [],
  children: [1, 12, DecorationSet { local: [Inline(1..6, "search-hit")], children: [] }]
  //         ^from ^to ^child set covers paragraph interior
}
```

User runs `tr.split(6)` — splits the paragraph at position 6 ("Hello |world"). After the transaction, the doc is `doc(p("Hello"), p("world"))`. The mapping has one step: `replace(6, 6, slice([..., p()], 1, 1))` with `dSize = 2` (open + close tokens of the new paragraph).

Walk the algorithm:

1. **Phase 1.** Loop over the mapping's single step. Step touches `[6, 6]`, dSize = 2.
   - Child `[1, 12, ...]`. `end = 12`, `oldStart = 6 ≤ 12 + 0 - 0`. `start = 1`. `oldEnd (6) ≥ start (1)`: flag.
   - `oldStart (6) <= start (1)`? **No** (6 > 1). So flag = **`-1`** (interior touch).
   - Children now: `[1, -1, <subset>]`.
2. **Phase 2.** Children index 0 has `to = -1`.
   - `from = mapping.map(1 + 0) = 1`. `fromLocal = 1`.
   - `to = mapping.map(12 + 0, -1) = ?` — actually after split, the original closing position 12 maps to 7 (end of first `<p>`) at bias `-1`. Hmm but real position depends on details — for the example assume `to maps to 7`. `toLocal = 7`.
   - `node.content.findIndex(1) = {index: 0, childOffset: 0}`. `childNode = first <p>` (size 7 — `<p>Hello</p>`).
   - Check `childOffset (0) == fromLocal (1)` — **false** (0 ≠ 1). The new doc's first child no longer covers the same offset range.
   - Set `mustRebuild = true`.
3. **Phase 3.** Gather: walk the subset's `local = [Inline(1..6)]`, map each — Inline's `map` calls `mapping.map(from, ...)` and `mapping.map(to, ...)`. The deco at `[2..7]` (after adding back its parent's offset) maps to `[2..7]` in the new doc — but now position 7 is *between* the two paragraphs. `buildTree` re-runs with this gathered list against the new doc:
   - First paragraph `<p>Hello</p>` (range `[1..6]`). `takeSpansForNode` looks for spans **strictly inside** (`from > offset && to < end`, i.e. `from > 1 && to < 6`). The mapped deco `[2..7]` has `to == 7`, not `< 6` — not strictly inside. Stays in `local` at this level.
   - Second paragraph `<p>world</p>` (range `[7..14]`). Span's `from == 2`, not `> 7` — not strictly inside. Stays in `local`.
   - Result: the deco ends up at the **top level** `local` of the new tree, no longer inside any child. (In effect: the inline deco that used to fit inside one paragraph now spans both, and at this level it's stored as a top-level inline span.)

This trace shows two key points: **the `-2`/`-1` flagging defines a budget of work** (only flagged children get rebuilt), and **a single-paragraph deco can "leak" to a higher level** when its containing node is split. The `forChild` clipping in §2.6 is what prevents this from causing visual chaos at render time.

#### Untouched-children optimisation

The phase-1 `else if (oldStart >= baseOffset && dSize)` branch (line 591) is what makes mapping cheap for the common case of a small edit in a large doc. Children whose range is strictly before the touched region keep their sentinel-free `to` and just get their `from`/`to` shifted by `dSize`. No recursion, no rebuild — and crucially, **the same `DecorationSet` object reference** stays in `children[i + 2]`, preserving the persistence guarantee.

Net effect: **O(touched-region)** rather than O(doc) — only the parts of the tree affected by the transaction are rebuilt.

### 2.6 `forChild(offset, node)` — descending the deco tree (`decoration.ts:431-453`)

Used by `iterDeco` and `NodeViewDesc.update` on every reconciliation step to descend one level. Returns the subset of decorations applicable to `node`'s **content** (not the node itself):

```ts
forChild(offset, node) {
  if (this == empty) return this
  if (node.isLeaf) return DecorationSet.empty                       // leaves can't have inner decos

  // 1. Find a child subset at this exact offset
  let child, local
  for (let i = 0; i < this.children.length; i += 3)
    if (this.children[i] >= offset) {
      if (this.children[i] == offset) child = this.children[i + 2]
      break                                                         // children sorted by from; stop early
    }

  // 2. Local inline decos that touch this child's content range get clipped in
  let start = offset + 1, end = start + node.content.size
  for (let i = 0; i < this.local.length; i++) {
    let dec = this.local[i]
    if (dec.from < end && dec.to > start && (dec.type instanceof InlineType)) {
      let from = Math.max(start, dec.from) - start
      let to   = Math.min(end, dec.to) - start
      if (from < to) (local || (local = [])).push(dec.copy(from, to))
    }
  }

  // 3. Combine: child set, clipped-locals set, or both via DecorationGroup
  if (local) {
    let localSet = new DecorationSet(local.sort(byPos), none)
    return child ? new DecorationGroup([localSet, child]) : localSet
  }
  return child || empty
}
```

Three return shapes:

* **`empty`** — for leaf nodes, or when neither a child subset nor any clipped local applies. Cheap signaling that there's nothing to do at this level.
* **A `DecorationSet`** — either the matching child subset alone, or a freshly built singleton containing only clipped inline locals.
* **A `DecorationGroup` of two members** — when both a child subset and clipped locals exist. The reconciler treats it as a single source via the `DecorationSource` interface.

Why InlineType-only clipping (line 443)? Because node decorations and widgets at this level apply to *this* node, not its children — they're part of the parent's `outerDeco`, not the child's content decorations. Only `InlineType` spans that overlap a child's content can survive descent (clipped to the child's extent).

### 2.7 `DecorationGroup` — combining sets (named here for the first time) (`decoration.ts:502-565`)

When multiple plugins each contribute a `DecorationSet`, the view doesn't merge them into a single set — it bundles them in a `DecorationGroup` that **forwards every operation to each member**. This preserves each plugin's independent persistent identity (so plugin A re-running cheaply when plugin B's set is unchanged):

* `map(mapping, doc)` maps each member, returns a new group.
* `forChild(offset, child)` recurses into each, drops `empty`s, flattens any nested groups (`decoration.ts:518`).
* `locals(node)` concatenates each member's locals, then sorts and de-overlaps via `removeOverlap`.
* `eq` requires same member count and pointwise equality.
* `DecorationGroup.from(members)` collapses to `empty` for length 0, the singleton for length 1, otherwise a group; flattens nested groups (`decoration.ts:552-561`).

The view assembles the group via `viewDecorations(view)` (`decoration.ts:784-793`):

```ts
let found: DecorationSource[] = []
view.someProp("decorations", f => {
  let result = f(view.state)
  if (result && result != empty) found.push(result)
})
if (view.cursorWrapper)
  found.push(DecorationSet.create(view.state.doc, [view.cursorWrapper.deco]))
return DecorationGroup.from(found)
```

(See file 09 §1.8 for the canonical `someProp` definition.) So decorations are gathered from **every direct/state plugin's `decorations` prop in `someProp` order**, plus the editor's internal mark-cursor wrapper. Plugin ordering is defined as: view's own props first, then `directPlugins` in array order, then `state.plugins` in array order. The mark-cursor widget (created by `updateCursorWrapper` for an empty selection that needs marks-bag inheritance) is appended last so it draws on top of any plugin decorations at the same position.

**Why a tree of sets rather than a flat sorted list?** Two reasons:

1. **`forChild` is O(1) per level.** With a flat sorted list, each NodeViewDesc.update would do a linear scan (or binary search) of every decoration to find the subset that applies to its content — O(n × decorations) total. With a tree paralleling the doc, descending costs one array lookup per level. Total work for a full render: O(n) where n is doc size.
2. **Map-time locality.** Mapping a flat list re-maps every decoration on every transaction. With a tree, untouched subtrees are reused by reference and only the touched region is rebuilt (§2.5).

The pathological case — many decorations at the same level (e.g. lint marks on a single paragraph) — degrades to a flat list at that level. In practice plugins distribute decos across the doc and the tree shape pays off.

### 2.8 `removeOverlap` — the inline-deco split pass (`decoration.ts:492` static export, 748-776 implementation)

The renderer wants to wrap each text run in a fully-nested set of decoration spans (no partially overlapping pairs). `removeOverlap(spans)` takes an array of inline decorations sorted by `byPos` and returns an array where any two spans either nest (one wholly contains the other) or are disjoint:

```ts
function removeOverlap(spans) {
  let working = spans
  for (let i = 0; i < working.length - 1; i++) {
    let span = working[i]
    if (span.from != span.to) for (let j = i + 1; j < working.length; j++) {
      let next = working[j]
      if (next.from == span.from) {
        if (next.to != span.to) {
          if (working == spans) working = spans.slice()
          // Split the larger overlapping sibling into [from..span.to] + [span.to..next.to]
          working[j] = next.copy(next.from, span.to)
          insertAhead(working, j + 1, next.copy(span.to, next.to))
        }
        continue
      } else if (next.from < span.to) {
        if (working == spans) working = spans.slice()
        // Split this one into [span.from..next.from] + [next.from..span.to]
        working[i] = span.copy(span.from, next.from)
        insertAhead(working, j, span.copy(next.from, span.to))
      }
      break
    }
  }
  return working
}
```

The two cases:

* **Same-start** — `[A..C]` and `[A..D]` (D > C). Split the longer one: keep `[A..C]` as the inner shorter span, push `[C..D]` as a tail. Both pieces sit inside an enclosing run that the consumer can render as nested spans.
* **Overlapping ends** — `[A..C]` and `[B..D]` with A < B < C < D. Split the first: `[A..B]` + `[B..C]`. Now `[A..B]` is disjoint from the second, and `[B..C]` is inside `[B..D]`.

Worked example (Inline-Plugin-A produces `class="search-hit"` over `[5..10]`; Inline-Plugin-B produces `class="lint-warn"` over `[7..12]`, mapped through `viewDecorations` and then locals via `DecorationGroup.locals`):

```
input:  [(5..10, "search-hit"), (7..12, "lint-warn")]
                            │   │
                            │   └─ overlap at [7..10]
                            └─ disjoint at [5..7]

output: [(5..7,  "search-hit"),
         (7..10, "search-hit"),
         (7..10, "lint-warn"),
         (10..12, "lint-warn")]
```

Now the renderer can emit `<span class="search-hit">[5..7]</span><span class="search-hit"><span class="lint-warn">[7..10]</span></span><span class="lint-warn">[10..12]</span>` (or similar nested form) without producing partially overlapping siblings, which DOM cannot represent without additional splits.

The function preserves referential equality when no overlap is found (`working = spans`, never copied). That's a hot-path optimisation: most paragraphs have decoration sets that don't overlap.

### 2.9 `takeSpansForNode` — the strict-containment rule (`decoration.ts:690-700`)

```ts
function takeSpansForNode(spans, node, offset) {
  if (node.isLeaf) return null
  let end = offset + node.nodeSize, found = null
  for (let i = 0, span; i < spans.length; i++) {
    if ((span = spans[i]) && span.from > offset && span.to < end) {
      ;(found || (found = [])).push(span)
      spans[i] = null
    }
  }
  return found
}
```

Used during `buildTree` to decide which spans descend into a child. Rule: **strict containment** (`from > offset && to < end`), not boundary-inclusive. A span that ends *at* `end` does not descend — it stays in the parent's `local`. This is the rule that controls "leaking": an inline deco whose `to` exactly matches a paragraph's closing position (very common when a plugin computes `Decoration.inline(start, paragraph.endPos, ...)`) **stays at the parent level** rather than descending into the paragraph. At render time, `forChild` re-clips it in. The cost: the plugin's intuition of "this deco is inside the paragraph" doesn't match the storage layout.

`spans[i] = null` mutates the input array — the caller (`buildTree`) iterates again later and skips nulls via `withoutNulls` (`decoration.ts:702-707`). This is an in-place "consumed" marker so the same array can be passed down through multiple `takeSpansForNode` calls without copies.

### 2.10 `moveSpans` and `withoutNulls` — internals (`decoration.ts:655-663`, 702-707)

`moveSpans(spans, offset)` returns a new array of decorations with each span's `from`/`to` shifted by `offset`. Used when remapping spans into a child's coordinate frame after `mapAndGatherRemainingDecorations`. Returns the input unchanged if `offset == 0` or the input is empty (a fast-path optimisation).

`withoutNulls` filters out null slots from a `(T | null)[]` array — the companion to `takeSpansForNode`'s in-place null-marking.

These two functions explain the warning in `add(doc, decorations)` (line 365 comment): *"Consumes the `decorations` array"*. Internally `add` calls `addInner`, which uses `takeSpansForNode` to strip spans into children. Callers who need the input intact must clone first.

### 2.11 `locals(node)` and `localsInner` (`decoration.ts:472-486`)

Returns `local` decorations relevant to drawing *this* node — for a node with inline content, all locals; for a non-inline node, only widget/node decos (inline ones don't apply at this level since they live inside text runs). When called from `DecorationGroup.locals`, the results from each member are concatenated, sorted by position, and run through `removeOverlap`.

### 2.12 Why `find` walks children in position order (not insertion order)

Because `children` is **sorted by position** (`from` field), enforced by `byPos` (`decoration.ts:740`) and the splice-with-binary-search in `addInner`. The tree structure is essentially a sorted segment tree. `find(start, end)` does an early-bail recursive scan that benefits from sorted traversal — once a child's `from` exceeds `end`, we can stop. Insertion order is not preserved (and is irrelevant to rendering, which is also position-driven).

### 2.13 `eq` (`decoration.ts:456-469`)

Structural — same `local` length, same children layout, recursive. Cheap when the same set is reused unchanged across transactions, because two `DecorationSet`s referring to identical persistent structure short-circuit on `this == other`.

### 2.14 `DecorationSet.empty` (`decoration.ts:489`)

Singleton for "no decorations". Used heavily as a sentinel — `forChild` returns it for leaves (`decoration.ts:433`), `add`/`remove` short-circuit on it (`decoration.ts:367, 396`), and the view's reconciler treats `empty.eq(empty)` as the trivial-true case.

---

## 3. Why-questions

### Why does `WidgetType.map` use `mapResult` and check `deleted`, but `InlineType.map` does not?

`WidgetType.map` (`decoration.ts:32-35`):
```ts
let {pos, deleted} = mapping.mapResult(span.from + oldOffset, this.side < 0 ? -1 : 1)
return deleted ? null : new Decoration(pos - offset, pos - offset, this)
```

`InlineType.map` (`decoration.ts:58-61`):
```ts
let from = mapping.map(span.from + oldOffset, this.spec.inclusiveStart ? -1 : 1) - offset
let to   = mapping.map(span.to + oldOffset, this.spec.inclusiveEnd ? 1 : -1) - offset
return from >= to ? null : new Decoration(from, to, this)
```

A widget has zero width — it lives at a single position. If that position is deleted, the widget vanishes — there's no fallback "near" position that means the same thing. `mapResult.deleted` returns true exactly when `pos` was inside a deleted range and there's no semantic survivor, so the widget is dropped.

An inline range, by contrast, can survive partial deletion. If `Decoration.inline(5, 20)` overlaps a deletion of `[7, 15]`, the surviving range `[5, 12]` (after mapping; positions collapsed) is still meaningful — the deco shrinks. Only when the mapped `from >= to` (the range was entirely consumed) does the deco get dropped (line 61). `mapping.map(..., bias)` is enough; `mapResult.deleted` is too aggressive — it would drop decos whose endpoints survived but happened to sit inside a replaced span.

### Why is `DecorationSet.remove` keyed on `eq` rather than identity?

So plugins that recompute decorations on every transaction (returning fresh `Decoration` objects each time) can still incrementally remove old ones using a freshly-built equal copy. Identity matching would force plugins to retain references to every previous-tick decoration. Equality matching lets a plugin store only the *spec* and rebuild matching decorations on demand to call `remove`.

The key implementation: `local[j].eq(span, offset)` (`decoration.ts:422`) compares both type-equality (shared spec/attrs) and position equality (after offsetting). Two `Decoration`s with the same `from`, `to`, and `type.eq(other.type)` are considered the same decoration even though they're different JS objects.

### Why a tree of sets rather than a flat sorted list?

Two reasons (covered in §2.7): O(1) `forChild` per descent vs O(decorations) per descent for a flat list, and per-transaction map locality (untouched subtrees are reused by reference). For a doc of n inline positions and d decorations, a flat-list renderer is O(n × d); a tree renderer is O(n log n) for balanced trees or O(n + d) when decos are evenly distributed.

---

## 4. How decorations affect rendering

### 4.1 Inline decorations

In `iterDeco` (`viewdesc.ts:1458-1529`), inline decorations become an `active` array tracked across child nodes. Text nodes are **cut at decoration boundaries** (`viewdesc.ts:1511-1520`) so each emitted text desc covers exactly one (deco-state, mark-state) combination. The `active` set is passed as `outerDeco` to each text/inline node, where `applyOuterDeco` / `computeOuterDeco` (`viewdesc.ts:1069-1118`) wraps the text node DOM:

```
text "hello"  with one inline deco {class: "search-hit"}
  →  <span class="search-hit">hello</span>      (wrap level)
```

For non-inline children (e.g. a paragraph that has an inline deco passing through it), inline decos are **not propagated** — `viewdesc.ts:1525` filters them out:
```ts
let outerDeco = child.isInline && !child.isLeaf ? active.filter(d => !d.inline) : active.slice()
```

### 4.2 Node decorations

For each node, `iterDeco` calls `onNode(child, outerDeco, innerDeco, i)`. The outer decos here include any node-typed deco at this level. `NodeViewDesc.create` calls `applyOuterDeco(dom, outerDeco, node)` (`viewdesc.ts:714`) which wraps with extra elements / sets attributes / merges class & style via `patchOuterDeco`. `nodeDOM` stays pointing at the inner element so positions still resolve correctly.

On update, `updateOuterDeco` (`viewdesc.ts:871-883`) diffs `prev` against `cur` computed levels and patches in place — adding/removing wrappers as needed but trying to preserve the same DOM.

### 4.3 Widget decorations

`iterDeco` calls `onWidget(widget, index, insideNode)`. The view places it via `ViewTreeUpdater.placeWidget` (`viewdesc.ts:1352-1362`):

* If the next existing child is a `WidgetViewDesc` whose `matchesWidget(widget)` is true, **reuse it** (advance index).
* Otherwise instantiate `new WidgetViewDesc(...)` (`viewdesc.ts:538-557`):
  * If `toDOM` is a function, call it now (`viewdesc.ts:541-544`).
  * If not raw, ensure it's an element (wrap text nodes in `<span>`), set `contentEditable="false"`, add class `ProseMirror-widget` (`viewdesc.ts:545-553`).
  * Store as a zero-children desc with `null` contentDOM.

`WidgetViewDesc.parseRule()` returns `{ignore: true}` (`viewdesc.ts:563`) — when the DOM-change parser scans content, widget DOM is invisible. That's how widgets coexist with `contenteditable` parsing.

`WidgetViewDesc.ignoreMutation` returns true except for selection changes that don't have `ignoreSelection` set (`viewdesc.ts:570-572`).

`WidgetViewDesc.destroy` calls `widget.type.destroy(this.dom)` then super (`viewdesc.ts:574-577`), which routes to `WidgetType.destroy` (`decoration.ts:46-48`) calling the user's `spec.destroy`.

`get domAtom()` returns true (`viewdesc.ts:579`): position math treats widgets as opaque — `posFromDOM` won't descend into a widget's DOM.

---

## 5. Mapping through transactions

When a transaction is applied, plugins typically update their decoration set in their state field's `apply`:

```ts
return state.set.map(tr.mapping, tr.doc)
```

`DecorationSet.map` walks the tree with `mapping` (`decoration.ts:334-359`), preserves untouched subtrees by reference, and only rebuilds touched subtrees. Decorations whose mapping returns `null` (`InlineType.map` returns null for collapsed range, `NodeType.map` returns null when endpoints don't survive, `WidgetType.map` returns null when its position is deleted) are dropped — and `options.onRemove(spec)` is called if provided so the plugin can clean up resources tied to the dropped decoration.

This is the "automatic" mapping referred to in user docs: plugins don't have to track positions themselves.

---

## 6. Performance characteristics

| Property | Reason |
|---|---|
| **Locality** — touching pos `p` only rebuilds subtrees whose range contains `p` | `mapChildren` marks only children whose range is overlapped by mapping steps (`decoration.ts:581-599`). |
| **Sharing** — unchanged subtrees are reused by reference | `DecorationSet` is persistent; `mapChildren` returns the same subtree object when not touched (`decoration.ts:610-625`). |
| **Bulk add/remove** — pass arrays | `add` / `remove` traverse the tree once with the whole array, not once per decoration. |
| **Cheap `eq`** | Reference-equal sets short-circuit; deep `eq` is O(structure) not O(decorations). This drives reuse in `NodeViewDesc.matchesNode`. |
| **Cheap `forChild`** | The tree shape mirrors the doc shape, so descending is O(1) per level. |
| **No coordination across plugins** | `DecorationGroup` keeps them independent; no merge cost when only one plugin's set changes. |

The pathological case is many decorations targeting the *same* high-level node (they all pile into one `local` array). The mitigation is simply that decorations don't usually number in the thousands at one level.

---

## 7. Edge cases

### 7.1 Widgets between text nodes (selection placement)

A widget at position `p` between two text characters can confuse cursor placement. `NodeViewDesc.domFromPos` (`viewdesc.ts:308-339`) handles this by:

* **Skipping zero-size widgets with `side >= 0` before the position** (`viewdesc.ts:319-320`) when computing the DOM position — so a cursor at `p` lands *before* a positive-side widget.
* For `side <= 0`, scanning back through children that are not directly in `contentDOM` (mark wrappers etc.) until a usable anchor is found (`viewdesc.ts:322-329`).

`relaxedSide` widgets relax this: `WidgetViewDesc.ignoreForSelection` returns true (`viewdesc.ts:581`), and `domobserver.ts` will tolerate the browser placing the selection on the "wrong" side without forcing a re-sync.

### 7.2 `side` semantics in detail

For `Decoration.widget(p, dom, {side: s})`:

* **Mapping at `p`**: when content is inserted exactly at `p`, the widget moves to the side indicated by `s`. `WidgetType.map` passes `s < 0 ? -1 : 1` as the bias to `mapping.mapResult` (`decoration.ts:33`).
* **Multiple widgets at `p`**: ordered by `s` ascending (`compareSide`, `viewdesc.ts:1450-1452`). Lower `s` is rendered first — i.e. closer to the content before `p`.
* **Implicit marks**: when `spec.marks` is null, the widget is wrapped in the marks of the node before `p` if `s < 0`, after if `s >= 0` (decided in `iterDeco`, `viewdesc.ts:776-777`).

#### Worked example: side -1 vs +1 mapping

Initial: `doc(p("foo"))`, position 4 is "after foo, before the closing token". Two widgets are created at position 4:

```ts
const wA = Decoration.widget(4, mkDom(), {side: -1, key: "A"})  // "before-cursor" widget
const wB = Decoration.widget(4, mkDom(), {side: +1, key: "B"})  // "after-cursor" widget
```

Render order at position 4: `wA` first (side ascending), so `<p>foo<wA><wB></p>`. A cursor at position 4 lands *between* `wA` and `wB` — `domFromPos(4)` skips zero-size widgets with `side >= 0` before the position, so `wB` is skipped, anchoring the cursor right after `wA`'s DOM.

Now the user types `X` at position 4. The transaction's mapping has one step: `replace(4, 4, "X")`, dSize = 1. After the transaction the doc is `doc(p("fooX"))`.

Mapping the widgets:

* `wA.map(mapping)`: `WidgetType.map` calls `mapping.mapResult(4 + 0, side: -1 ? -1 : 1) = mapResult(4, -1)`. With bias `-1`, an insertion at the same position maps to **the position before the insertion** — the new pos is 4. `deleted` is false. `wA` survives at position 4 — *before* the inserted "X".
* `wB.map(mapping)`: `mapResult(4, side: +1 ? -1 : 1) = mapResult(4, 1)`. With bias `+1`, the new pos is **after** the insertion — pos 5. `wB` survives at position 5 — *after* "X".

Visual result:
```
before:  <p>foo[wA][wB]</p>           cursor was between wA and wB at pos 4
after:   <p>foo[wA]X[wB]</p>          wA stayed before the inserted X, wB moved after
```

The mnemonic: **side < 0 means "I belong to what comes before the cursor"** (the widget is anchored to the trailing edge of preceding content), so insertions at this position go *after* the widget. **side >= 0 means "I belong to what comes after the cursor"** so insertions go *before* the widget. This is what makes `side` the lever for "is this a trailing badge on the previous word, or a leading badge on the next word?"

If both widgets had `side: 0`, `mapResult(4, 1)` would push them both to position 5 (after the inserted X). That's why `0` is treated as the positive-side default — the most common widget intent ("decoration at this position, gets pushed forward by edits") matches `+1` mapping behaviour.

### 7.3 Inline decos crossing node boundaries

Don't. `forChild` clips, `iterDeco` only iterates one inline level at a time, and `removeOverlap` ensures rendered spans nest. If your code paints `Decoration.inline(0, doc.size, ...)` it will be **silently split per inline run** — the renderer doesn't produce a single span across paragraphs.

### 7.4 Widget IME interactions

When the user is composing (IME active) inside the editor, widgets near the composition can break the composition if their DOM is recreated. The reconciler protects against this in two ways:

1. `WidgetViewDesc.matchesWidget` requires `dirty == NOT_DIRTY` and `widget.type.eq` (which respects `spec.key`). Pass a stable `key` so widgets generated each render still match.
2. `localCompositionInfo` / `protectLocalComposition` (`viewdesc.ts:815-852`) wrap the live composition text in a `CompositionViewDesc` so the reconciler treats it as immovable for the duration of the composition.

If a widget's `toDOM` is a fresh DOM node every call **without a key**, every transaction will tear down and rebuild it — and any focus/IME inside will be lost. Always either return the same DOM identity or set `spec.key`.

### 7.5 Inline decos and `inclusiveStart`/`inclusiveEnd`

When the user types at exactly the `from` of an inline deco with `inclusiveStart: false` (default), the new character is *outside* the deco. With `true`, it grows. This is purely a mapping-time decision (`InlineType.map`, `decoration.ts:58-60`) and has no rendering cost.

### 7.6 Node decos on text nodes

Don't. `NodeType.valid` (`decoration.ts:91-94`) requires the target child to be `!isText`. Text nodes can only carry inline decos.

### 7.7 Decoration spec mutation

Specs are stored by reference (`InlineType.spec`, etc.). Don't mutate them after construction — `compareObjs` (`decoration.ts:6-11`) is shallow, so the type may continue to compare equal even after meaningful changes, defeating reuse detection.

---

## 8. Cross-references

* `viewdesc.ts:670, 754-757, 856-869, 871-883, 1352-1362, 1458-1529` — how the view consumes decorations.
* `index.ts:516-535` — `computeDocDeco` produces the document-level node deco that carries `class="ProseMirror"` and `contenteditable`.
* `index.ts:537-548` — `updateCursorWrapper` builds the mark-cursor widget that's appended via `viewDecorations`.
* File 09 (`09-view-and-viewdesc.md`) for the reconciler that consumes these.
