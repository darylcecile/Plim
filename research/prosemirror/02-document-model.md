# ProseMirror Document Model — In Depth

> Source: `prosemirror-model/src/{node,mark,fragment,replace,resolvedpos,diff,comparedeep}.ts`.
> All citations below use the form `prosemirror-model/src/<file>:<line>`.

This document is a high-resolution dissection of the ProseMirror **document model**: the immutable tree of `Node` / `Fragment` / `Mark` / `Slice` values that makes up every ProseMirror document. The companion file `03-schema-and-content-expressions.md` covers the schema layer (types, content expressions, and the NFA/DFA used for content matching).

---

## 1. The Tree Shape

A ProseMirror document is a strictly typed tree. The shape is, informally:

```
Doc (block, the schema's `topNode`, usually "doc")
 ├── Block node (e.g. paragraph, heading, blockquote, list_item)
 │    ├── Block node              ← only if this block's content allows blocks
 │    │    └── ...
 │    └── Inline node             ← only if this block's content allows inline
 │         ├── Text node (carries text + marks)
 │         └── Inline leaf (e.g. image, hard_break, with marks)
 └── ...
```

Every `Node` has exactly one **type** (a `NodeType` from the schema). The type knows whether its content is **inline** or **block** — those two universes never mix in a single parent. This is enforced both at construction time (`createChecked`) and structurally by the content expression compiler, which refuses to mix inline and block content within one expression (`prosemirror-model/src/content.ts:266`):

```ts
if (stream.inline == null) stream.inline = type.isInline
else if (stream.inline != type.isInline) stream.err("Mixing inline and block content")
```

So the document looks like a tree where:

* The **root** is the `topNode` (usually `doc`), which has block content (e.g. `block+`).
* **Block nodes** either have `block`/group content (like `blockquote: "block+"`), inline content (a *textblock* like `paragraph: "inline*"`), or no content at all (a *block leaf* like `horizontal_rule`).
* **Inline nodes** are either text nodes (`TextNode`) or inline leaves (e.g. `image`, `hard_break`). Both kinds carry a `marks` array.

Marks are *not* tree nodes — they are metadata attached to inline leaves (and, in principle, to any node, though only inline leaves use them in practice). This is the central asymmetry of the model.

### 1.1 Position semantics (positions vs sizes)

A node’s `nodeSize` is defined by the integer-based indexing scheme described in the guide and implemented in `prosemirror-model/src/node.ts:54`:

```ts
get nodeSize(): number { return this.isLeaf ? 1 : 2 + this.content.size }
```

* Leaf nodes have size **1** (one token).
* Non-leaf nodes have size **2 + childrenSize** (one token at the start, one at the end — these are the “open/close tokens” you step over when navigating).
* Text nodes are special: `TextNode.nodeSize` is `text.length` (`prosemirror-model/src/node.ts:372`):

  ```ts
  get nodeSize() { return this.text.length }
  ```

`Fragment.size` is the sum of child `nodeSize`s (`prosemirror-model/src/fragment.ts:21`).

This token-based indexing is what makes positions stable under structural sharing: a position is an integer, and it identifies a location even if the underlying objects change.

---

## 2. The `Node` Class

### 2.1 Shape

`Node` is a plain JS class with five intrinsic, **immutable** fields (`prosemirror-model/src/node.ts:22`):

```ts
constructor(
  readonly type: NodeType,
  readonly attrs: Attrs,
  content?: Fragment | null,
  readonly marks = Mark.none
) {
  this.content = content || Fragment.empty
}
readonly content: Fragment
readonly text: string | undefined        // only for TextNode
```

Note three things:

1. `content` is always a `Fragment` (never `null` after the constructor — empty content uses the singleton `Fragment.empty`, see `prosemirror-model/src/fragment.ts:260`). This avoids null checks everywhere.
2. `marks` defaults to the shared empty array `Mark.none` (`prosemirror-model/src/mark.ts:110`). Same singleton trick — every unmarked node points to the same array.
3. `text` is declared on the prototype as `undefined` (`prosemirror-model/src/node.ts:351`):

   ```ts
   ;(Node.prototype as any).text = undefined
   ```

   `TextNode` overrides it. This makes `node.text` cheap to read without an `instanceof` check.

The class’s own contract begins with a forceful comment (`prosemirror-model/src/node.ts:14-21`):

> Nodes are persistent data structures. Instead of changing them, you create new ones with the content you want. Old ones keep pointing at the old document shape. This is made cheaper by sharing structure between the old and new data as much as possible, which a tree shape like this (without back pointers) makes easy.
>
> **Do not** directly mutate the properties of a `Node` object.

There are no parent pointers. The tree is purely top-down. Parent context for a position is reconstructed on demand by `ResolvedPos` (see §8).

### 2.2 Inline vs Block, Leaf, Atom, Isolating

These are all delegated to the `NodeType` (`prosemirror-model/src/node.ts:227-252`):

```ts
get isBlock()      { return this.type.isBlock }
get isTextblock()  { return this.type.isTextblock }
get inlineContent(){ return this.type.inlineContent }
get isInline()     { return this.type.isInline }
get isText()       { return this.type.isText }
get isLeaf()       { return this.type.isLeaf }
get isAtom()       { return this.type.isAtom }
```

The corresponding `NodeType` definitions (`prosemirror-model/src/schema.ts:85-108`):

```ts
this.isBlock = !(spec.inline || name == "text")
this.isText = name == "text"
get isInline()    { return !this.isBlock }
get isTextblock() { return this.isBlock && this.inlineContent }
get isLeaf()      { return this.contentMatch == ContentMatch.empty }
get isAtom()      { return this.isLeaf || !!this.spec.atom }
```

Worth absorbing:

* **Block** vs **inline** is set by spec (or implied for `text`).
* **Textblock** = block whose content is inline (a paragraph, heading, code block).
* **Leaf** is *derived* from the content expression: a node is a leaf iff its compiled `contentMatch` is the empty `ContentMatch` (no possible content). So `horizontal_rule` (no `content`) is a leaf, but `paragraph` (`content: "inline*"`) is not.
* **Atom** is leaf-or-explicitly-marked. Atoms do not have directly editable inner content — typically used for a node view that owns its rendering.
* **Isolating** is on the spec (`isolating: true`), and is honored by `Slice.maxOpen` to refuse to open through (`prosemirror-model/src/replace.ts:90-94`):

  ```ts
  static maxOpen(fragment: Fragment, openIsolating = true) {
    let openStart = 0, openEnd = 0
    for (let n = fragment.firstChild; n && !n.isLeaf && (openIsolating || !n.type.spec.isolating); n = n.firstChild) openStart++
    for (let n = fragment.lastChild; n && !n.isLeaf && (openIsolating || !n.type.spec.isolating); n = n.lastChild) openEnd++
    return new Slice(fragment, openStart, openEnd)
  }
  ```

  Isolating nodes are also boundaries for many editing operations (e.g. table cells); the model itself only honors them via `maxOpen`, but `prosemirror-state`/`prosemirror-transform` consult the spec flag.

### 2.3 Content + Children Access

The basic accessors (`prosemirror-model/src/node.ts:44-115`) are pure delegations to `Fragment`:

```ts
get children()     { return this.content.content }
get childCount()   { return this.content.childCount }
child(index)       { return this.content.child(index) }
maybeChild(index)  { return this.content.maybeChild(index) }
get firstChild()   { return this.content.firstChild }
get lastChild()    { return this.content.lastChild }
forEach(f)         { this.content.forEach(f) }
```

`nodesBetween` walks descendant nodes overlapping a position range, and `descendants` is `nodesBetween(0, content.size)`:

```ts
nodesBetween(from, to, f, startPos = 0) {
  this.content.nodesBetween(from, to, f, startPos, this)
}
descendants(f) {
  this.nodesBetween(0, this.content.size, f)
}
```

The actual recursion lives in `Fragment.nodesBetween` (`prosemirror-model/src/fragment.ts:29-43`) and accounts for the +1 token that bounds each non-leaf child.

### 2.4 Persistent Mutators (Copy-on-write)

Every “mutator” returns a new `Node`, sharing structure where possible. The pattern is consistent: if nothing changed, return `this`. (`prosemirror-model/src/node.ts:138-167`)

```ts
copy(content: Fragment | null = null): Node {
  if (content == this.content) return this
  return new Node(this.type, this.attrs, content, this.marks)
}

mark(marks: readonly Mark[]): Node {
  return marks == this.marks ? this : new Node(this.type, this.attrs, this.content, marks)
}

cut(from: number, to: number = this.content.size): Node {
  if (from == 0 && to == this.content.size) return this
  return this.copy(this.content.cut(from, to))
}

slice(from: number, to: number = this.content.size, includeParents = false) {
  if (from == to) return Slice.empty
  let $from = this.resolve(from), $to = this.resolve(to)
  let depth = includeParents ? 0 : $from.sharedDepth(to)
  let start = $from.start(depth), node = $from.node(depth)
  let content = node.content.cut($from.pos - start, $to.pos - start)
  return new Slice(content, $from.depth - depth, $to.depth - depth)
}

replace(from: number, to: number, slice: Slice) {
  return replace(this.resolve(from), this.resolve(to), slice)
}
```

`copy` is the workhorse used by `Fragment.replaceChild` (which itself returns a new `Fragment`), by `replaceOuter` during `replace`, and by `cut`. Note how `cut` returns the same node when the range is the whole content — this is a structural-sharing optimization that propagates upward.

### 2.5 Replacement Validity

Two helpers ask the schema whether a structural edit is legal (`prosemirror-model/src/node.ts:276-300`):

```ts
canReplace(from, to, replacement = Fragment.empty, start = 0, end = replacement.childCount) {
  let one = this.contentMatchAt(from).matchFragment(replacement, start, end)
  let two = one && one.matchFragment(this.content, to)
  if (!two || !two.validEnd) return false
  for (let i = start; i < end; i++)
    if (!this.type.allowsMarks(replacement.child(i).marks)) return false
  return true
}

canReplaceWith(from, to, type, marks?) {
  if (marks && !this.type.allowsMarks(marks)) return false
  let start = this.contentMatchAt(from).matchType(type)
  let end = start && start.matchFragment(this.content, to)
  return end ? end.validEnd : false
}

canAppend(other) {
  if (other.content.size) return this.canReplace(this.childCount, this.childCount, other.content)
  else return this.type.compatibleContent(other.type)
}
```

`contentMatchAt(index)` walks the node’s `ContentMatch` over the existing children up to `index`, then returns the partial match (`prosemirror-model/src/node.ts:265-269`). `canReplace` essentially says: "match `[0..from]` of existing content, then the replacement, then `[to..]` of existing content, and ensure we end on a valid end state."

This is the foundation `prosemirror-transform` uses for every structural transform (lift, wrap, setBlockType, replace, etc.) — **the model decides legality, the transform layer just searches for valid moves.**

### 2.6 `Node.eq` — Structural Equality

`prosemirror-model/src/node.ts:118-134`:

```ts
eq(other: Node) {
  return this == other || (this.sameMarkup(other) && this.content.eq(other.content))
}

sameMarkup(other: Node) {
  return this.hasMarkup(other.type, other.attrs, other.marks)
}

hasMarkup(type: NodeType, attrs?: Attrs | null, marks?: readonly Mark[]): boolean {
  return this.type == type &&
    compareDeep(this.attrs, attrs || type.defaultAttrs || emptyAttrs) &&
    Mark.sameSet(this.marks, marks || Mark.none)
}
```

Equality is:

1. **Identity-fast-path** (`this == other`) — by far the most common case for unchanged subtrees, thanks to structural sharing.
2. **Same markup** — type identity (`==`, not deep compare), `compareDeep` on attrs (`prosemirror-model/src/comparedeep.ts:1-15`), and `Mark.sameSet` on marks.
3. **Recursive** `Fragment.eq` (`prosemirror-model/src/fragment.ts:137-142`):

   ```ts
   eq(other: Fragment): boolean {
     if (this.content.length != other.content.length) return false
     for (let i = 0; i < this.content.length; i++)
       if (!this.content[i].eq(other.content[i])) return false
     return true
   }
   ```

`compareDeep` is a small recursive deep-equality (`prosemirror-model/src/comparedeep.ts`). It handles plain objects and arrays — sufficient because attrs are JSON-shaped values.

`TextNode.eq` overrides to compare text directly (`prosemirror-model/src/node.ts:388-390`):

```ts
eq(other: Node) {
  return this.sameMarkup(other) && this.text == other.text
}
```

### 2.7 `Node.check` — Schema Conformance

`prosemirror-model/src/node.ts:303-316`:

```ts
check() {
  this.type.checkContent(this.content)
  this.type.checkAttrs(this.attrs)
  let copy = Mark.none
  for (let i = 0; i < this.marks.length; i++) {
    let mark = this.marks[i]
    mark.type.checkAttrs(mark.attrs)
    copy = mark.addToSet(copy)
  }
  if (!Mark.sameSet(copy, this.marks))
    throw new RangeError(`Invalid collection of marks for node ${this.type.name}: ${this.marks.map(m => m.type.name)}`)
  this.content.forEach(node => node.check())
}
```

Three layers of validation:

1. **Content**: the children must form a fragment that matches the type’s content expression (`NodeType.checkContent` runs `validContent` then throws — see `prosemirror-model/src/schema.ts:188-202`).
2. **Attrs**: every required attr present, every attr name known, every `validate` passes (`prosemirror-model/src/schema.ts:41-48`).
3. **Marks**: each mark’s attrs are valid, AND when re-built using `addToSet` the same set is produced (i.e. marks are properly sorted and don’t violate exclusion rules).

`check` recurses, so calling it on the root validates the whole document. It is intended as a debugging assertion — it’s relatively expensive.

---

## 3. The `Fragment` Class

### 3.1 Why `Fragment` is separate from `Node`

`Fragment` (`prosemirror-model/src/fragment.ts:10-261`) is a thin immutable wrapper around `readonly Node[]` plus a precomputed `size`:

```ts
constructor(readonly content: readonly Node[], size?: number) {
  this.size = size || 0
  if (size == null) for (let i = 0; i < content.length; i++)
    this.size += content[i].nodeSize
}
```

Why isn’t this just an array on `Node`?

1. **A fragment can exist without a parent.** Every structural operation produces a "loose" sequence of nodes that has no enclosing node yet — e.g. the result of `cut`, the body of a `Slice`, the output of `Fragment.append`. Having a first-class type for "ordered list of sibling nodes" lets these flow through the API cleanly.
2. **Cached size.** `size` is the integer position-space size of the fragment. It’s computed once and reused, avoiding O(n) recomputation when navigating with positions.
3. **Adjacency invariants.** `Fragment.fromArray` (`prosemirror-model/src/fragment.ts:227-242`) enforces that adjacent text nodes with identical markup are merged:

   ```ts
   static fromArray(array: readonly Node[]) {
     if (!array.length) return Fragment.empty
     let joined: Node[] | undefined, size = 0
     for (let i = 0; i < array.length; i++) {
       let node = array[i]
       size += node.nodeSize
       if (i && node.isText && array[i - 1].sameMarkup(node)) {
         if (!joined) joined = array.slice(0, i)
         joined[joined.length - 1] = (node as TextNode)
                                     .withText((joined[joined.length - 1] as TextNode).text + (node as TextNode).text)
       } else if (joined) {
         joined.push(node)
       }
     }
     return new Fragment(joined || array, size)
   }
   ```

   `Fragment.append` (line 73) does the same boundary-merge. This is how the canonical text-merging invariant of the document is maintained: **two adjacent `TextNode`s in a single fragment never share the same set of marks; if they would, they’re merged.**
4. **Singleton empty.** `Fragment.empty` (line 260) is shared by all empty content (every leaf, every `copy(null)`).

### 3.2 Structural-sharing patterns

`Fragment` is built around copy-on-write of the underlying array. Common patterns (`prosemirror-model/src/fragment.ts:107-134`):

```ts
cutByIndex(from, to) {
  if (from == to) return Fragment.empty
  if (from == 0 && to == this.content.length) return this
  return new Fragment(this.content.slice(from, to))
}

replaceChild(index, node) {
  let current = this.content[index]
  if (current == node) return this              // identity short-circuit
  let copy = this.content.slice()               // shallow array copy
  let size = this.size + node.nodeSize - current.nodeSize
  copy[index] = node
  return new Fragment(copy, size)
}

addToStart(node) { return new Fragment([node].concat(this.content), this.size + node.nodeSize) }
addToEnd(node)   { return new Fragment(this.content.concat(node),    this.size + node.nodeSize) }
```

Note the `if (current == node) return this` pattern: it propagates upward. If you call `node.copy(node.content.replaceChild(i, oldChild))`, the inner `replaceChild` returns the same fragment, and `node.copy` then returns the same node. A no-op edit anywhere in the tree therefore yields the original root pointer — `eq`’s identity fast-path then makes equality comparisons O(1).

The size delta is computed incrementally instead of re-summing `nodeSize` over all children — important for fragments with many children.

### 3.3 `Fragment.cut` — sub-range extraction

`prosemirror-model/src/fragment.ts:86-104` handles cutting a sub-range out of a fragment, including descending into a child whose range is partial:

```ts
cut(from, to = this.size) {
  if (from == 0 && to == this.size) return this
  let result: Node[] = [], size = 0
  if (to > from) for (let i = 0, pos = 0; pos < to; i++) {
    let child = this.content[i], end = pos + child.nodeSize
    if (end > from) {
      if (pos < from || end > to) {
        if (child.isText)
          child = child.cut(Math.max(0, from - pos), Math.min(child.text!.length, to - pos))
        else
          child = child.cut(Math.max(0, from - pos - 1), Math.min(child.content.size, to - pos - 1))
      }
      result.push(child)
      size += child.nodeSize
    }
    pos = end
  }
  return new Fragment(result, size)
}
```

The `- 1` correction for non-text children is the open token at the start of that child. Text nodes index by character; non-text nodes index by content-position.

---

## 4. The `Mark` Class

### 4.1 Shape and equality

A `Mark` is just `{type: MarkType, attrs: Attrs}` (`prosemirror-model/src/mark.ts:10-17`):

```ts
constructor(readonly type: MarkType, readonly attrs: Attrs) {}
```

Equality (`prosemirror-model/src/mark.ts:65-68`):

```ts
eq(other: Mark) {
  return this == other ||
    (this.type == other.type && compareDeep(this.attrs, other.attrs))
}
```

### 4.2 Ordering rules — `addToSet`

This is where ProseMirror’s mark semantics live (`prosemirror-model/src/mark.ts:24-45`):

```ts
addToSet(set: readonly Mark[]): readonly Mark[] {
  let copy, placed = false
  for (let i = 0; i < set.length; i++) {
    let other = set[i]
    if (this.eq(other)) return set
    if (this.type.excludes(other.type)) {
      if (!copy) copy = set.slice(0, i)
    } else if (other.type.excludes(this.type)) {
      return set
    } else {
      if (!placed && other.type.rank > this.type.rank) {
        if (!copy) copy = set.slice(0, i)
        copy.push(this)
        placed = true
      }
      if (copy) copy.push(other)
    }
  }
  if (!copy) copy = set.slice()
  if (!placed) copy.push(this)
  return copy
}
```

Walk through:

* If the same mark (same type + attrs) is already there, return the existing set unchanged. **Identity preservation** — important for structural sharing.
* If `this.type.excludes(other.type)`: drop `other`. Skip it from `copy`.
* If `other.type.excludes(this.type)` (and not the reverse): the existing mark wins; return the original set.
* Otherwise: insert `this` in the position determined by `MarkType.rank` (the order marks were declared in the schema, `prosemirror-model/src/schema.ts:316-319`).

The result is a *sorted* (by `rank`), *exclusion-respecting* set of marks. This canonical ordering is what makes `Mark.sameSet` (line 91) cheap — same length, pairwise `eq`.

### 4.3 `removeFromSet`, `isInSet`, `setFrom`

`prosemirror-model/src/mark.ts:49-107`:

```ts
removeFromSet(set) {
  for (let i = 0; i < set.length; i++)
    if (this.eq(set[i])) return set.slice(0, i).concat(set.slice(i + 1))
  return set
}

isInSet(set) {
  for (let i = 0; i < set.length; i++) if (this.eq(set[i])) return true
  return false
}

static sameSet(a, b) {
  if (a == b) return true
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i].eq(b[i])) return false
  return true
}

static setFrom(marks?: Mark | readonly Mark[] | null): readonly Mark[] {
  if (!marks || Array.isArray(marks) && marks.length == 0) return Mark.none
  if (marks instanceof Mark) return [marks]
  let copy = marks.slice()
  copy.sort((a, b) => a.type.rank - b.type.rank)
  return copy
}

static none: readonly Mark[] = []
```

Two things to note:

* `setFrom` does *not* enforce exclusions. It just sorts. The exclusion rules apply only at `addToSet` boundaries; once a set is built, it’s assumed canonical.
* `Mark.none` is a frozen-by-convention shared empty array. Every "no marks" reference points to this.

### 4.4 Inclusive vs exclusive at boundaries

`MarkSpec.inclusive` (`prosemirror-model/src/schema.ts:498-501`) governs editor *behaviour at the cursor edge* — whether typing past the end of a marked range continues the mark. The model itself doesn’t branch on this; it’s consulted by `prosemirror-state`/`prosemirror-view` when building `storedMarks`. The default is `true`.

`MarkSpec.excludes` (`prosemirror-model/src/schema.ts:503-516`) controls structural exclusion. The schema compiles `excludes` once into `MarkType.excluded` (`prosemirror-model/src/schema.ts:622-625`):

```ts
for (let prop in this.marks) {
  let type = this.marks[prop], excl = type.spec.excludes
  type.excluded = excl == null ? [type] : excl == "" ? [] : gatherMarks(this, excl.split(" "))
}
```

* Default (`null`): a mark excludes other marks of the same type. So you can’t have two `link` marks with different `href`s on the same text.
* `""`: nothing excluded — multiple marks of the same type may coexist.
* `"_"`: excludes all marks (sentinel handled by `gatherMarks`, line 698).
* Any space-separated list of mark names or group names.

`MarkType.excludes(other)` is a simple `indexOf` check (`prosemirror-model/src/schema.ts:344-346`).

### 4.5 JSON

`prosemirror-model/src/mark.ts:71-87`:

```ts
toJSON(): any {
  let obj: any = {type: this.type.name}
  for (let _ in this.attrs) { obj.attrs = this.attrs; break }
  return obj
}

static fromJSON(schema: Schema, json: any) {
  if (!json) throw new RangeError("Invalid input for Mark.fromJSON")
  let type = schema.marks[json.type]
  if (!type) throw new RangeError(`There is no mark type ${json.type} in this schema`)
  let mark = type.create(json.attrs)
  type.checkAttrs(mark.attrs)
  return mark
}
```

Note: `attrs` are only emitted if the object has at least one own property — saves bytes in the common "no attrs" case.

---

## 5. The `Slice` Class

### 5.1 Why slicing has `openStart`/`openEnd`

A piece of document cut out across block boundaries cannot be represented as a `Fragment` alone, because the boundary nodes are *partial*. Consider cutting from inside `<p>foo` to inside `<p>bar` in:

```
<doc>
  <p>foo|bar</p>            ← cursor inside foo (single block)
  <p>baz|qux</p>            ← cursor inside qux
</doc>
```

If we cut "fo|obar...baz|qu" we get something like:

```
Fragment:
  <p>obar</p>
  <p>baz</p>
openStart = 1, openEnd = 1
```

The two `<p>` nodes at the edges are **open** — they’re half a paragraph. Their content doesn’t need to be schema-valid (a paragraph is `inline*` so it’s valid here, but in general open nodes are mid-construction). When this slice is reinserted, the opening side is *joined* to the surrounding paragraph; the closing side is joined to the surrounding paragraph on the other side.

`prosemirror-model/src/replace.ts:21-42`:

```ts
constructor(
  readonly content: Fragment,
  readonly openStart: number,
  readonly openEnd: number
) {}

get size(): number {
  return this.content.size - this.openStart - this.openEnd
}
```

Comment from the source (lines 30-34):

> It is not necessary for the content of open nodes to conform to the schema's content constraints, though it should be a valid start/end/middle for such a node, depending on which sides are open.

### 5.2 How `Node.slice` produces a `Slice`

`prosemirror-model/src/node.ts:159-167`:

```ts
slice(from, to = this.content.size, includeParents = false) {
  if (from == to) return Slice.empty
  let $from = this.resolve(from), $to = this.resolve(to)
  let depth = includeParents ? 0 : $from.sharedDepth(to)
  let start = $from.start(depth), node = $from.node(depth)
  let content = node.content.cut($from.pos - start, $to.pos - start)
  return new Slice(content, $from.depth - depth, $to.depth - depth)
}
```

* `sharedDepth` finds the deepest common ancestor of `from` and `to`.
* `content` is the raw cut from that ancestor’s content.
* `openStart = $from.depth - depth`: how much deeper than the shared ancestor the start position was.
* `openEnd = $to.depth - depth`: same for end.

So slicing within a single textblock produces `openStart = openEnd = 0` (a "flat" slice). Slicing across paragraphs (depth 1 each, shared at depth 0) produces `openStart = openEnd = 1`.

### 5.3 How `replace` uses open depths

`prosemirror-model/src/replace.ts:122-128`:

```ts
export function replace($from, $to, slice: Slice) {
  if (slice.openStart > $from.depth)
    throw new ReplaceError("Inserted content deeper than insertion position")
  if ($from.depth - slice.openStart != $to.depth - slice.openEnd)
    throw new ReplaceError("Inconsistent open depths")
  return replaceOuter($from, $to, slice, 0)
}
```

The two checks enforce:

1. The slice can’t be "deeper" than the insertion site (you can’t paste two-paragraphs-deep into a position that isn’t inside two paragraphs).
2. The slice’s open sides must match: the depth at which the slice connects on the left must equal the depth at which it connects on the right (otherwise the surrounding tree wouldn’t close).

`replaceOuter` (lines 130-144) recursively descends until it reaches the depth at which the actual splicing happens, then either `replaceTwoWay` (`slice.content` empty) or `replaceThreeWay` (slice has content) builds the new fragment by joining:

* the ancestor content **before** the cut on the left side,
* the (possibly recursively merged) slice middle,
* and the ancestor content **after** the cut on the right side.

`joinable` (line 151) checks `compatibleContent` between the two nodes being merged — if a `<blockquote>` open-start meets a `<paragraph>` open-end at the same depth, joining is rejected with `ReplaceError`. This is the mechanism by which paste/replace either succeeds or throws.

### 5.4 `Slice.maxOpen`, JSON, equality

`prosemirror-model/src/replace.ts:60-86`:

```ts
eq(other: Slice): boolean {
  return this.content.eq(other.content) && this.openStart == other.openStart && this.openEnd == other.openEnd
}

toJSON(): any {
  if (!this.content.size) return null
  let json: any = {content: this.content.toJSON()}
  if (this.openStart > 0) json.openStart = this.openStart
  if (this.openEnd > 0) json.openEnd = this.openEnd
  return json
}

static fromJSON(schema, json): Slice {
  if (!json) return Slice.empty
  let openStart = json.openStart || 0, openEnd = json.openEnd || 0
  if (typeof openStart != "number" || typeof openEnd != "number")
    throw new RangeError("Invalid input for Slice.fromJSON")
  return new Slice(Fragment.fromJSON(schema, json.content), openStart, openEnd)
}
```

`Slice.maxOpen` (line 90) is used by the clipboard: when given a fragment with no positional context, "open up" the edges as much as possible (down to leaves or isolating boundaries) so it’ll join naturally on insertion.

### 5.5 Clipboard usage pattern

When the user copies content, `prosemirror-view`’s clipboard module asks the document for `doc.slice(from, to)` — yielding the canonical `Slice` with appropriate open depths. When pasting, `EditorView` calls `tr.replaceSelection(slice)`, which goes through `replace()`. The open depths preserve the *paragraph-spanning intent* of the original selection: copy-pasting "the end of paragraph A and the start of paragraph B" inserts content that joins paragraphs at the destination, not literal `<p>` boundaries.

---

## 6. Text Nodes — Sharing, Splitting, Merging

`TextNode` extends `Node` (`prosemirror-model/src/node.ts:353-397`):

```ts
export class TextNode extends Node {
  readonly text: string

  constructor(type: NodeType, attrs: Attrs, content: string, marks?: readonly Mark[]) {
    super(type, attrs, null, marks)
    if (!content) throw new RangeError("Empty text nodes are not allowed")
    this.text = content
  }

  get nodeSize() { return this.text.length }
  get textContent() { return this.text }
  textBetween(from, to) { return this.text.slice(from, to) }

  mark(marks)   { return marks == this.marks ? this : new TextNode(this.type, this.attrs, this.text, marks) }
  withText(t)   { return t == this.text ? this : new TextNode(this.type, this.attrs, t, this.marks) }
  cut(from = 0, to = this.text.length) {
    if (from == 0 && to == this.text.length) return this
    return this.withText(this.text.slice(from, to))
  }
  eq(other)     { return this.sameMarkup(other) && this.text == other.text }
}
```

### 6.1 Invariants

1. **No empty text nodes.** The constructor throws on `""`. This is critical: the empty string would have `nodeSize == 0`, which would break the position model (positions wouldn’t advance past it).
2. **Adjacent same-mark merging.** Enforced in `Fragment.fromArray` and `Fragment.append` (see §3.1). After any structural change, `Fragment` rebuilds with merging.
3. **Splitting.** Splitting a text node is just `child.cut(0, k)` and `child.cut(k, len)`, both producing fresh `TextNode`s via `withText`. The original is left untouched.

### 6.2 Why text isn’t represented as one character per node

* Memory: a 1000-char paragraph would be 1000 nodes.
* Mark coalescing: a contiguous run of identically-marked text is one node — cheaper to compare, cheaper to render, and the obvious unit for diffing.
* The position model already handles intra-text positions (offsets within a `TextNode`), so "fine-grained" text manipulation needs no per-character nodes.

### 6.3 Implications

* Splitting a `TextNode` always yields two `TextNode`s with the same marks — they will be re-merged unless something between them changes.
* Adding a mark over a sub-range first splits the text node at the range boundaries, then `mark()` is called on the inner part with the new mark set, then `Fragment.fromArray` may *re-merge* the outer pieces if their marks coincide with neighbors.

---

## 7. JSON Round-Trip

### 7.1 `Node.toJSON`

`prosemirror-model/src/node.ts:319-330`:

```ts
toJSON(): any {
  let obj: any = {type: this.type.name}
  for (let _ in this.attrs) { obj.attrs = this.attrs; break }
  if (this.content.size) obj.content = this.content.toJSON()
  if (this.marks.length) obj.marks = this.marks.map(n => n.toJSON())
  return obj
}
```

`TextNode` adds `text` (line 392):

```ts
toJSON() {
  let base = super.toJSON()
  base.text = this.text
  return base
}
```

`Fragment.toJSON` returns either an array of children or `null` if empty (`prosemirror-model/src/fragment.ts:214-216`):

```ts
toJSON(): any {
  return this.content.length ? this.content.map(n => n.toJSON()) : null
}
```

### 7.2 `Node.fromJSON`

`prosemirror-model/src/node.ts:333-348`:

```ts
static fromJSON(schema: Schema, json: any): Node {
  if (!json) throw new RangeError("Invalid input for Node.fromJSON")
  let marks: Mark[] | undefined = undefined
  if (json.marks) {
    if (!Array.isArray(json.marks)) throw new RangeError("Invalid mark data for Node.fromJSON")
    marks = json.marks.map(schema.markFromJSON)
  }
  if (json.type == "text") {
    if (typeof json.text != "string") throw new RangeError("Invalid text node in JSON")
    return schema.text(json.text, marks)
  }
  let content = Fragment.fromJSON(schema, json.content)
  let node = schema.nodeType(json.type).create(json.attrs, content, marks)
  node.type.checkAttrs(node.attrs)
  return node
}
```

Notes:

* The schema is required to deserialize. Unknown types throw.
* `schema.text(text, marks)` produces a `TextNode` directly (`prosemirror-model/src/schema.ts:662-665`).
* `create` (not `createChecked`) is used here — but `checkAttrs` is called explicitly.
* `Fragment.fromJSON` calls `Fragment.fromArray`, so adjacent same-mark text nodes are re-merged on the way in.

### 7.3 Round-trip guarantees

`fromJSON(toJSON(node))` produces a structurally-equal node (`node.eq(...)` is `true`) — modulo:

* Object identity is *not* preserved (each round-trip allocates fresh objects).
* `Mark` order in JSON is the canonical sorted order (because `setFrom`/`addToSet` sort by rank).
* If the schema differs between encoder and decoder (e.g. an attribute is added with a default), the decoded node may end up with extra attrs filled in by `computeAttrs`.

---

## 8. Equality Semantics, Summarized

| Comparison | API | Code | Strategy |
|---|---|---|---|
| Node identity | `a == b` | n/a | Pointer identity; structural sharing makes this common |
| Node value | `a.eq(b)` | `node.ts:118` | identity ∨ (sameMarkup ∧ content.eq) |
| Markup only | `a.sameMarkup(b)` / `a.hasMarkup(t,a,m)` | `node.ts:124,130` | type-identity ∧ compareDeep(attrs) ∧ Mark.sameSet |
| Fragment | `f.eq(g)` | `fragment.ts:137` | length-equal ∧ pairwise node.eq |
| Mark | `m.eq(n)` | `mark.ts:65` | identity ∨ (type-identity ∧ compareDeep(attrs)) |
| Mark set | `Mark.sameSet(a,b)` | `mark.ts:91` | length-equal ∧ pairwise mark.eq (relies on canonical order) |
| Slice | `s.eq(t)` | `replace.ts:61` | content.eq ∧ openStart= ∧ openEnd= |
| Attrs | `compareDeep(a,b)` | `comparedeep.ts:1` | Recursive object/array deep-equality |

Notes:

* **Type identity** uses `==`, never name comparison. Two `NodeType`s are equal iff they’re the same JS object — which is true iff they came from the same schema. Cross-schema comparisons therefore always fail at this stage.
* **Identity short-circuit** is everywhere: `Node.eq`, `Fragment.cut`, `Fragment.replaceChild`, `Node.copy`, `TextNode.cut`, `TextNode.withText`, `Node.mark`, `Mark.sameSet`. This makes equality on partly-shared trees fast in practice.

---

## 9. Diff: Finding Where Two Documents Differ

`prosemirror-model/src/diff.ts:3-24`:

```ts
export function findDiffStart(a: Fragment, b: Fragment, pos: number): number | null {
  for (let i = 0;; i++) {
    if (i == a.childCount || i == b.childCount)
      return a.childCount == b.childCount ? null : pos

    let childA = a.child(i), childB = b.child(i)
    if (childA == childB) { pos += childA.nodeSize; continue }   // identity skip!

    if (!childA.sameMarkup(childB)) return pos
    if (childA.isText && childA.text != childB.text) {
      for (let j = 0; childA.text![j] == childB.text![j]; j++) pos++
      return pos
    }
    if (childA.content.size || childB.content.size) {
      let inner = findDiffStart(childA.content, childB.content, pos + 1)
      if (inner != null) return inner
    }
    pos += childA.nodeSize
  }
}
```

Key insight: **identity-equal subtrees are skipped wholesale** (`childA == childB`). This is what makes diff cheap on a freshly-edited document — the unchanged parts are still pointer-identical to the previous root, so the diff walk runs in time proportional to the *changed* region, not the document size.

`findDiffEnd` does the symmetric walk from the right (`prosemirror-model/src/diff.ts:26-52`).

These functions feed `prosemirror-view`’s incremental DOM updater: it computes diff start/end, leaves the unchanged prefix and suffix alone, and only rerenders the middle.

---

## 10. ResolvedPos — The Bridge Between Positions and the Tree

The model has no parent pointers, but most operations need to know "what node am I inside?". `ResolvedPos` precomputes this on demand (`prosemirror-model/src/resolvedpos.ts:12-73`):

```ts
constructor(
  readonly pos: number,
  readonly path: any[],
  readonly parentOffset: number
) {
  this.depth = path.length / 3 - 1
}

get parent() { return this.node(this.depth) }
get doc()    { return this.node(0) }

node(depth)        { return this.path[this.resolveDepth(depth) * 3] }
index(depth)       { return this.path[this.resolveDepth(depth) * 3 + 1] }
start(depth)       { return depth == 0 ? 0 : this.path[depth * 3 - 1] + 1 }
end(depth)         { return this.start(depth) + this.node(depth).content.size }
```

The `path` array is a flattened triple `[nodeAtDepth0, indexAtDepth0, posBeforeDepth1, nodeAtDepth1, indexAtDepth1, posBeforeDepth2, …]`. Each level costs three slots. The `parentOffset` is the position relative to the parent’s content.

`resolveCached` (used by `Node.resolve`) memoizes recent resolutions. This matters because `slice`, `replace`, and many transforms call `resolve` repeatedly on the same positions — the cache turns repeated lookups into O(1).

For the model proper, the most important consumers are:

* `Node.slice` (computes shared depth, builds open slice)
* `Node.replace` → `replace($from, $to, slice)` (drives `replaceOuter` recursion)
* `nodesBetween`, `rangeHasMark` (when called via positions)

---

## 11. Putting It Together — A Complete Example

Given:

```ts
let p = schema.node("paragraph", null, [
  schema.text("Hello "),
  schema.text("world", [schema.mark("strong")])
])
let doc = schema.node("doc", null, [p])
```

The constructed tree:

```
doc (Node, type=doc, content=Fragment[size=10])
 └── paragraph (Node, type=paragraph, content=Fragment[size=11])
      ├── TextNode "Hello " (size=6, marks=[])
      └── TextNode "world"  (size=5, marks=[strong])
```

* `doc.nodeSize` = 2 + 11 = 13.
* `doc.content.size` = 11 (paragraph.nodeSize) — wait: `paragraph.nodeSize` = 2 + 11 = 13? No: paragraph’s *content* is 6 + 5 = 11; paragraph.nodeSize = 2 + 11 = 13; doc.content.size = 13.

Now:

```ts
let p2 = p.replace(6, 6, Slice.empty)   // no-op
p2 == p                                 // false — replace always builds; but p2.eq(p) === true
let p3 = p.copy(p.content)              // copy with same fragment ref
p3 === p                                // true (early-out in copy)
```

And serialization:

```ts
JSON.stringify(doc.toJSON())
// {"type":"doc","content":[
//   {"type":"paragraph","content":[
//     {"type":"text","text":"Hello "},
//     {"type":"text","marks":[{"type":"strong"}],"text":"world"}
//   ]}
// ]}
```

`Node.fromJSON(schema, json)` reconstructs an equal tree.

---

## 12. Cheat-Sheet

| Concern | API |
|---|---|
| Build a node | `nodeType.create(attrs, content, marks)` / `schema.node(name, attrs, content, marks)` |
| Build a node, validate | `nodeType.createChecked(...)` |
| Build a node, fill required content | `nodeType.createAndFill(...)` |
| Build a text node | `schema.text(string, marks)` |
| Replace by content | `node.copy(newFragment)` |
| Replace by range | `node.replace(from, to, slice)` |
| Cut a sub-range as `Node` | `node.cut(from, to)` |
| Cut a sub-range as `Slice` | `node.slice(from, to, includeParents?)` |
| Test legality | `node.canReplace(...)` / `canReplaceWith(...)` / `canAppend(other)` |
| Walk descendants | `node.descendants(f)` / `node.nodesBetween(from, to, f)` |
| Find a node at pos | `node.nodeAt(pos)` / `node.childAfter(pos)` / `childBefore(pos)` |
| Resolve a position | `node.resolve(pos)` → `ResolvedPos` |
| Add/remove marks (set ops) | `mark.addToSet(set)` / `mark.removeFromSet(set)` / `Mark.sameSet(a,b)` |
| Validate against schema | `node.check()` |
| Serialize | `node.toJSON()` / `Node.fromJSON(schema, json)` |
| Equality | `a.eq(b)`, `Fragment#eq`, `Mark#eq`, `Slice#eq` |
| Find diff range | `Fragment.findDiffStart` / `Fragment.findDiffEnd` |

---

## 13. Why this design matters for a next-gen editor

A few principles worth carrying forward:

1. **Persistent immutable trees + identity short-circuits everywhere.** Diff, equality, undo, collaborative rebasing, incremental rendering — all of them get cheap because unchanged subtrees are *literally the same object*.
2. **Positions are integers, not pointers.** Decoupling positions from object identity means selections, transforms, and remote operations can be expressed and rebased without holding references to the (already-replaced) nodes they refer to.
3. **`Fragment` as a first-class type.** Letting "list of sibling nodes" exist independently of a parent unlocks slice/clipboard semantics, simplifies the public API, and makes the text-merging invariant centralisable.
4. **Open depths on slices.** This is the single non-obvious idea that makes paragraph-spanning copy-paste *actually work* without losing structure. Any next-gen editor that supports rich block structure needs the equivalent.
5. **Marks as canonical sorted sets, not flags.** Storing marks as a sorted, exclusion-respecting `readonly Mark[]` means `sameSet` is O(n) and structural sharing of mark arrays is easy.
6. **Schema-checked content via a compiled NFA/DFA.** See companion file. The split between "what the model can express" and "what the schema permits" is what allows transforms to remain general while documents remain valid.
