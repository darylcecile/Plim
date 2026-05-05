# 08 — Selection

> Source: `prosemirror-state/src/selection.ts`
> Cross-ref: `prosemirror-state/src/transaction.ts` (selection-on-tr), `prosemirror-state/src/state.ts` (the `selection` field), `prosemirror-model` (`ResolvedPos`, `Slice`, `Node`), `prosemirror-transform` (`Mappable`).

Selection is its own little type hierarchy. It's the *only* part of the state where polymorphism does real work — `replace`/`replaceWith`/`map`/`getBookmark` all dispatch on the concrete selection class.

---

## 1. The abstract `Selection` class

```ts
// selection.ts:9–23
export abstract class Selection {
  constructor(
    readonly $anchor: ResolvedPos,
    readonly $head: ResolvedPos,
    ranges?: readonly SelectionRange[]
  ) {
    this.ranges = ranges || [new SelectionRange($anchor.min($head), $anchor.max($head))]
  }
  ranges: readonly SelectionRange[]
  ...
}
```

The contract:

| Member | Kind | Meaning | Source |
|---|---|---|---|
| `$anchor: ResolvedPos` | field | "Stays put" side of the selection. | `selection.ts:16` |
| `$head: ResolvedPos` | field | "Moves" side. | `selection.ts:19` |
| `ranges: readonly SelectionRange[]` | field | One or more (`$from, $to`) pairs. Default: a single range covering `[$anchor.min($head), $anchor.max($head)]`. | `selection.ts:22, 207–215` |
| `anchor`, `head` | getters | Unresolved versions of `$anchor.pos`, `$head.pos`. | `selection.ts:29–32` |
| `from`, `to`, `$from`, `$to` | getters | Bounds of `ranges[0]` (the *main* range). | `selection.ts:35–48` |
| `empty: boolean` | getter | True iff every range is collapsed. | `selection.ts:51–56` |
| `eq(other): boolean` | abstract | Structural equality. | `selection.ts:59` |
| `map(doc, mapping): Selection` | abstract | Map through a `Mappable` to land in a new doc. | `selection.ts:63` |
| `content(): Slice` | concrete | `$from.doc.slice(this.from, this.to, true)` (with open sides). | `selection.ts:66–68` |
| `replace(tr, content?)` | concrete | Append steps to `tr` that replace every range with `content` (only first range gets content; rest get `Slice.empty`). | `selection.ts:72–89` |
| `replaceWith(tr, node)` | concrete | Like `replace` but inserts a single node. | `selection.ts:93–105` |
| `toJSON(): any` | abstract | With a `type` discriminator string. | `selection.ts:111` |
| `getBookmark(): SelectionBookmark` | concrete (overridable) | Document-independent persistence handle. Default: convert to `TextSelection.between` and bookmark that. | `selection.ts:180–182` |
| `visible: boolean` | proto field | Whether the browser should render the native selection. Default `true`; `NodeSelection` sets it `false`. | `selection.ts:187, 190, 378` |

### Statics

```ts
// selection.ts:118–171
static findFrom($pos, dir, textOnly = false): Selection | null
static near($pos, bias = 1): Selection
static atStart(doc: Node): Selection
static atEnd(doc: Node): Selection
static fromJSON(doc: Node, json: any): Selection
static jsonID(id: string, cls: { fromJSON(doc, json): Selection })
```

- **`findFrom($pos, dir, textOnly)`** — search for a valid cursor or selectable leaf. If `$pos.parent.inlineContent`, returns a `TextSelection` *at* `$pos`. Otherwise it walks `findSelectionIn` outward through ancestor depths (`selection.ts:118–130`).

  The `textOnly` parameter, when `true`, tells `findSelectionIn` to **skip atom nodes that would otherwise be selectable as `NodeSelection`** (`selection.ts:439–452`, the `!text && NodeSelection.isSelectable(child)` branch). This is what makes `Mod-A` produce a clean text-only selection that walks past atom widgets like `horizontal_rule`, image atoms, or any custom node with `selectable: true` — without `textOnly`, those would be matched as a `NodeSelection` first. The "select all" implementation in `prosemirror-commands` uses `textOnly` to keep the selection inline.

- **`near($pos, bias)`** — `findFrom($pos, bias) || findFrom($pos, -bias) || new AllSelection(...)` (`selection.ts:135–137`). The fallback to `AllSelection` only kicks in for genuinely empty / leaf-only documents.
- **`atStart(doc)` / `atEnd(doc)`** — search inward from position 0 / `doc.content.size` for the first valid selection; fall back to `AllSelection(doc)` (`selection.ts:143–151`). Used everywhere a "default" selection is needed: `EditorState.create` defaults the `selection` field to `Selection.atStart(doc)` (`state.ts:28`), `AllSelection.replace` re-cursors via `Selection.atStart(tr.doc)` after wiping the doc (`selection.ts:408`), and command-style "select all" implementations are built on top.
- **`between($anchor, $head, bias?)`** is technically on `TextSelection`, not `Selection`, but functions as the *dispatcher* used by view-side `selectionBetween` / pointer-selection logic. It tries to produce a `TextSelection` whose endpoints both land in `inlineContent`; if either endpoint is in non-inline content, it walks outwards via `findFrom($head, bias, /*textOnly*/true)` to find the nearest inline position, and falls back to `Selection.near($head, bias)` if no inline neighbourhood exists (`selection.ts:287–304`). The optional `bias` defaults to the sign of `$anchor.pos - $head.pos` so that empty/equal positions get a deterministic search direction.
- **`jsonID(id, cls)`** — registers `cls` in a module-private `classesById` table and stamps `cls.prototype.jsonID = id`. `fromJSON` dispatches on `json.type` (`selection.ts:155–171`). **Throws** on duplicate `id` (`selection.ts:167`), so each selection class can register only once per process.

### Multi-range default `replace`

```ts
// selection.ts:72–89
replace(tr: Transaction, content = Slice.empty) {
  let lastNode = content.content.lastChild, lastParent = null
  for (let i = 0; i < content.openEnd; i++) {
    lastParent = lastNode!
    lastNode = lastNode!.lastChild
  }

  let mapFrom = tr.steps.length, ranges = this.ranges
  for (let i = 0; i < ranges.length; i++) {
    let {$from, $to} = ranges[i], mapping = tr.mapping.slice(mapFrom)
    tr.replaceRange(mapping.map($from.pos), mapping.map($to.pos), i ? Slice.empty : content)
    if (i == 0)
      selectionToInsertionEnd(tr, mapFrom, (lastNode ? lastNode.isInline : lastParent && lastParent.isTextblock) ? -1 : 1)
  }
}
```

Notes:
- Only the *first* range gets `content`; subsequent ranges are deleted (`Slice.empty`). This is what cell-selection-like multi-range selections rely on.
- After replacing range 0, `selectionToInsertionEnd` re-points the transaction's selection to a `Selection.near` of the last new position. `bias = -1` if the last replaced thing was inline (cursor sits *after* the inline), `+1` otherwise. (`selection.ts:454–462`.)
- **Open-end accounting.** The loop walks `content.openEnd` levels into `content.content.lastChild` to find the *deepest last node* of the slice — this is what the bias decision uses (`lastNode ? lastNode.isInline : lastParent && lastParent.isTextblock`). `tr.replaceRange` itself does the heavy `fitLeft`/`fitRight` work in `prosemirror-transform` to make the slice fit at both edges of the deletion (closing as many open levels as needed and inserting the rest as new content); see `04-transforms.md` for that machinery. The reason `replace` is polymorphic: subclasses (`AllSelection`, `CellSelection`) override it precisely because the default's "replace each range with the slice (or empty)" doesn't match their structural semantics.

---

## 2. `SelectionRange`

```ts
// selection.ts:207–215
export class SelectionRange {
  constructor(readonly $from: ResolvedPos, readonly $to: ResolvedPos) {}
}
```

A pair of resolved positions. `Selection.ranges` is the canonical list; for single-range selections it's `[new SelectionRange(min, max)]`. Multi-range selections (e.g. `CellSelection`) use multiple entries.

### Invariants

- **Order:** `$from.pos <= $to.pos` for every range. The default range constructed by the abstract `Selection` constructor uses `$anchor.min($head)` / `$anchor.max($head)` (`selection.ts:22`), which guarantees this regardless of whether `$anchor` is before or after `$head`. Subclasses that build ranges manually (e.g. `CellSelection`) must respect this themselves.
- **Same document:** Both `$from.doc` and `$to.doc` must point at the same `Node` (the document the selection lives in). The `setSelection` runtime check (`transaction.ts:83–84`) validates this against `tr.doc`.
- **Non-overlap (multi-range only):** for selections with multiple ranges, ranges must not overlap. Selection's abstract constructor doesn't enforce this — it's the responsibility of the subclass. `CellSelection` constructs ranges from disjoint cell content positions, so overlap is naturally avoided.
- **Resolved positions are immutable, but bound to a doc.** A `SelectionRange` is only meaningful for `range.$from.doc`; mapping it to a different doc requires going through `Selection.map` or a bookmark.

These invariants are *load-bearing*. The mark-handling code in `TextSelection.replace` (`selection.ts:248–254`) calls `this.$from.marksAcross(this.$to)`, which assumes `$from <= $to`. The `selection.ranges[0]` shortcut everywhere (`from`/`to`/`$from`/`$to` getters at `selection.ts:35–48`) assumes range[0] exists.

---

## 3. `TextSelection`

```ts
// selection.ts:229–305
export class TextSelection extends Selection {
  constructor($anchor: ResolvedPos, $head = $anchor) {
    checkTextSelection($anchor); checkTextSelection($head)
    super($anchor, $head)
  }

  get $cursor() { return this.$anchor.pos == this.$head.pos ? this.$head : null }

  map(doc, mapping): Selection {
    let $head = doc.resolve(mapping.map(this.head))
    if (!$head.parent.inlineContent) return Selection.near($head)
    let $anchor = doc.resolve(mapping.map(this.anchor))
    return new TextSelection($anchor.parent.inlineContent ? $anchor : $head, $head)
  }

  replace(tr, content = Slice.empty) {
    super.replace(tr, content)
    if (content == Slice.empty) {
      let marks = this.$from.marksAcross(this.$to)
      if (marks) tr.ensureMarks(marks)
    }
  }

  eq(other) { return other instanceof TextSelection && other.anchor == this.anchor && other.head == this.head }
  getBookmark() { return new TextBookmark(this.anchor, this.head) }
  toJSON() { return {type: "text", anchor: this.anchor, head: this.head} }

  static fromJSON(doc, json) { ... }
  static create(doc, anchor, head = anchor) { ... }
  static between($anchor, $head, bias?): Selection { ... }
}
Selection.jsonID("text", TextSelection)
```

Highlights:
- **`$cursor`** — non-null only when `anchor === head`. This is *the* idiom to detect "user has a caret, not a range". Used by the built-in `storedMarks.apply` (state.ts:34).
- **Construction guard** — `checkTextSelection` warns once (`warnedAboutTextSelection` global flag, `selection.ts:217–223`) if either endpoint is not in inline-content; it does not throw.
- **Mapping** — if the mapped head lands outside inline content, falls back to `Selection.near($head)` (which can produce a `NodeSelection` or `AllSelection`). Anchor is allowed to be in non-inline parent only by collapsing onto `$head`.
- **`replace` empty case** — when deleting (no replacement content), `marksAcross($from, $to)` is used to compute the marks that span the deletion; if any, they're transferred to `tr.storedMarks` via `ensureMarks`. This is why deleting selected styled text and typing produces text with the same marks.
- **`between($anchor, $head, bias?)`** — searches for valid inline endpoints near non-inline positions, used heavily by mapping fallback paths.

### `TextBookmark`

```ts
// selection.ts:309–318
class TextBookmark {
  constructor(readonly anchor: number, readonly head: number) {}
  map(mapping) { return new TextBookmark(mapping.map(this.anchor), mapping.map(this.head)) }
  resolve(doc) { return TextSelection.between(doc.resolve(this.anchor), doc.resolve(this.head)) }
}
```

Two raw integer positions. Mapping is just two `mapping.map` calls; resolution goes through `between` so it tolerates positions that have drifted to non-inline locations.

> **Mapping bias.** `mapping.map(pos)` without an explicit `assoc` argument uses the default bias of **`1`** (forward). Both `anchor` and `head` get the same `+1` bias, which means: when a deletion happens *exactly at* the cursor, the resulting bookmark position is pushed *forward* past the deletion — never stuck inside the deleted range. This is deterministic on purpose: plugin authors who store a bookmark and later resolve it know the cursor will end up just after a coincident deletion, never before. If you need the opposite ("stick before deletions at this point") you can't use `TextBookmark` directly; either build a custom bookmark type that stores `(pos, assoc)` and calls `mapping.map(pos, -1)`, or pre-bias the anchor by `-1` before constructing the bookmark.
>
> Note that `TextBookmark` does **not** have an `eq` method. Comparing two bookmarks for equality is application-level: typically `a.anchor === b.anchor && a.head === b.head`. `Selection.eq` (the resolved form, `selection.ts:256–258`) is what plugin state minimisation actually uses; bookmarks are an intermediate form that resolves back to a `Selection` before equality matters.

---

## 4. `NodeSelection`

```ts
// selection.ts:325–376
export class NodeSelection extends Selection {
  constructor($pos: ResolvedPos) {
    let node = $pos.nodeAfter!
    let $end = $pos.node(0).resolve($pos.pos + node.nodeSize)
    super($pos, $end)
    this.node = node
  }

  node: Node

  map(doc, mapping): Selection {
    let {deleted, pos} = mapping.mapResult(this.anchor)
    let $pos = doc.resolve(pos)
    if (deleted) return Selection.near($pos)
    return new NodeSelection($pos)
  }

  content() { return new Slice(Fragment.from(this.node), 0, 0) }
  eq(other) { return other instanceof NodeSelection && other.anchor == this.anchor }
  toJSON() { return {type: "node", anchor: this.anchor} }
  getBookmark() { return new NodeBookmark(this.anchor) }

  static fromJSON(doc, json) { ... }
  static create(doc, from) { return new NodeSelection(doc.resolve(from)) }

  static isSelectable(node: Node) {
    return !node.isText && node.type.spec.selectable !== false
  }
}
NodeSelection.prototype.visible = false
Selection.jsonID("node", NodeSelection)
```

Highlights:
- `from === anchor`, `to === anchor + node.nodeSize`, `head === to`. The selection literally brackets the single node.
- **`isSelectable(node)` static** (`selection.ts:373–375`) — returns `!node.isText && node.type.spec.selectable !== false`. The opt-in default is "every non-text node is selectable"; opt out by setting `selectable: false` in the node spec. Used by `findSelectionIn` (`selection.ts:446`) and `NodeBookmark.resolve` (`selection.ts:390`). Constructing a `NodeSelection` over a non-selectable node still *works* (the constructor doesn't check), but `findFrom`/`atStart`/etc. won't ever produce one, and the view's pointer logic respects the spec opt-out.
- **`content()`** — returns the node wrapped in a closed `Slice` (open depths both `0`). This differs from the default `Selection.content()` which uses `$from.doc.slice(...)` and would include open boundaries.
- **`visible = false`** — the browser's native selection isn't shown for node selections; `prosemirror-view` instead renders a `.ProseMirror-selectednode` class on the node's DOM (covered in file 09).
- **Mapping** — if the original position was deleted (`mapResult.deleted`), fall back to `Selection.near($pos)`. Otherwise re-construct around `nodeAfter` at the mapped position.

### `NodeBookmark`

```ts
// selection.ts:382–393
class NodeBookmark {
  constructor(readonly anchor: number) {}
  map(mapping) {
    let {deleted, pos} = mapping.mapResult(this.anchor)
    return deleted ? new TextBookmark(pos, pos) : new NodeBookmark(pos)
  }
  resolve(doc) {
    let $pos = doc.resolve(this.anchor), node = $pos.nodeAfter
    if (node && NodeSelection.isSelectable(node)) return new NodeSelection($pos)
    return Selection.near($pos)
  }
}
```

If the underlying node was deleted, the bookmark *demotes itself to a `TextBookmark`* during mapping. On resolve, if the position no longer points at a selectable node, it falls back to `Selection.near($pos)`. This is what lets the history plugin restore a sensible selection even after the originally-selected node is gone.

---

## 5. `AllSelection`

```ts
// selection.ts:399–425
export class AllSelection extends Selection {
  constructor(doc: Node) {
    super(doc.resolve(0), doc.resolve(doc.content.size))
  }

  replace(tr, content = Slice.empty) {
    if (content == Slice.empty) {
      tr.delete(0, tr.doc.content.size)
      let sel = Selection.atStart(tr.doc)
      if (!sel.eq(tr.selection)) tr.setSelection(sel)
    } else {
      super.replace(tr, content)
    }
  }

  toJSON() { return {type: "all"} }
  static fromJSON(doc) { return new AllSelection(doc) }
  map(doc) { return new AllSelection(doc) }
  eq(other) { return other instanceof AllSelection }
  getBookmark() { return AllBookmark }
}
Selection.jsonID("all", AllSelection)

const AllBookmark = {
  map() { return this },
  resolve(doc) { return new AllSelection(doc) }
}
```

Highlights:
- Spans the whole top node — useful when leaf blocks at the document's edges prevent a `TextSelection` from covering the entire document.
- **`$anchor` and `$head` are *placeholders*, not user-meaningful endpoints.** The constructor sets `$anchor = doc.resolve(0)` and `$head = doc.resolve(doc.content.size)` (`selection.ts:401–402`) just to satisfy the abstract base class's invariants. Code that reads `selection.$anchor` or `selection.$head` for an `AllSelection` will get those edge positions; this is correct as a "selection bounds" query but **not** as a "where did the user start dragging" query (which has no answer for `AllSelection`). When you need to branch on this, prefer `selection instanceof AllSelection` over inspecting `$anchor`/`$head`.
- **`replace` empty case — special-cased path.** When `content === Slice.empty`, the override **does not** delegate to `super.replace`; it does `tr.delete(0, tr.doc.content.size)` and then re-cursors via `Selection.atStart(tr.doc)` (`selection.ts:405–410`). The reason: the default `Selection.replace` runs each range through `tr.replaceRange`, which calls `Transform.replaceRange` — that method tries to *preserve outer structure* by closing slices smartly. For an all-selection emptying, that produces a "minimum-replacement" delete that may leave wrapping nodes intact. Here we want a true wipe-to-empty, which `tr.delete(0, doc.content.size)` does directly.
- **`replace` non-empty case** delegates to `super.replace(tr, content)`, which loops over `this.ranges` (one range, covering the whole doc) and runs `tr.replaceRange(0, doc.content.size, content)`. The slice's open ends are honoured via `replaceRange`'s `fitLeft`/`fitRight` machinery, so e.g. pasting an open paragraph slice over `AllSelection` works.
- **`map` is identity** — the all-selection of any document version is "all of it", so mapping is just `new AllSelection(doc)`.
- **`getBookmark`** — singleton `AllBookmark` whose `map` is `() => this` (no-op) and whose `resolve(doc)` is `new AllSelection(doc)`.

---

## 6. `CellSelection` (forward note) and writing your own subclass

`CellSelection` is **not** in `prosemirror-state`. It lives in **`prosemirror-tables`** and is registered there with `Selection.jsonID("cell", CellSelection)`. Sketched:

- Multi-range: `ranges` covers each cell's content range individually.
- Two anchor cells (`$anchorCell`, `$headCell`) define a rectangular block in the table.
- Custom `replace` / `replaceWith` clear all selected cells.
- Custom `getBookmark` so tables survive history/mapping.
- Has its own decoration pass (the visible "selected cells" highlight).
- Plays with the view through standard mechanics: it is a normal `Selection` subclass, so all of `state`'s machinery (transaction selection map, `tr.setSelection`, etc.) applies unchanged.

The `prosemirror-state` package never imports it; the only seam is `Selection.jsonID` and the abstract base class.

### Worked example — minimal custom `Selection` subclass

A toy `LineSelection` that selects a whole textblock by its position. The contract a custom selection must satisfy:

```ts
import { Selection, SelectionBookmark, TextSelection } from "prosemirror-state"
import { Node, ResolvedPos, Slice, Fragment } from "prosemirror-model"
import { Mappable } from "prosemirror-transform"

class LineBookmark implements SelectionBookmark {
  constructor(readonly pos: number) {}
  map(mapping: Mappable) {
    const { deleted, pos } = mapping.mapResult(this.pos)
    // If the line was deleted, demote to a text bookmark at the mapped pos
    return deleted ? new (require("prosemirror-state") as any).TextBookmark(pos, pos)
                   : new LineBookmark(pos)
  }
  resolve(doc: Node) {
    const $pos = doc.resolve(Math.min(this.pos, doc.content.size))
    return LineSelection.fromResolved($pos) || Selection.near($pos)
  }
}

export class LineSelection extends Selection {
  constructor(readonly $pos: ResolvedPos) {
    // Bracket the parent textblock: anchor at start of parent, head at end
    const start = $pos.start($pos.depth)
    const end   = $pos.end($pos.depth)
    super($pos.doc.resolve(start), $pos.doc.resolve(end))
  }

  // Required overrides:
  eq(other: Selection): boolean {
    return other instanceof LineSelection && other.$anchor.pos === this.$anchor.pos
  }
  map(doc: Node, mapping: Mappable): Selection {
    const { deleted, pos } = mapping.mapResult(this.$anchor.pos)
    if (deleted) return Selection.near(doc.resolve(pos))
    const $pos = doc.resolve(pos)
    return $pos.parent.isTextblock ? new LineSelection($pos) : Selection.near($pos)
  }
  toJSON(): any { return { type: "line", pos: this.$anchor.pos } }
  getBookmark(): SelectionBookmark { return new LineBookmark(this.$anchor.pos) }

  // Recommended overrides:
  content() {
    const start = this.$anchor.pos, end = this.$head.pos
    return new Slice(Fragment.from(this.$anchor.parent), 0, 0)
  }

  // Required for fromJSON dispatch via Selection.jsonID:
  static fromJSON(doc: Node, json: any): LineSelection {
    return new LineSelection(doc.resolve(json.pos))
  }
  static fromResolved($pos: ResolvedPos): LineSelection | null {
    return $pos.parent.isTextblock ? new LineSelection($pos) : null
  }
}

// Register exactly once. Throws on duplicate id.
Selection.jsonID("line", LineSelection)
```

Checklist for any `Selection` subclass:

| Method | Required? | Purpose |
|---|---|---|
| `eq(other)` | yes | Used by `applyInner`'s no-op detection and by view-side diffing. |
| `map(doc, mapping)` | yes | Called by `tr.selection` getter when steps land. |
| `toJSON()` | yes | Symmetric with `fromJSON`. Always include `type: <jsonID>` so `Selection.fromJSON` dispatches. |
| `static fromJSON(doc, json)` | yes (for `jsonID`) | Reverse of `toJSON`. |
| `getBookmark()` | recommended | Custom bookmark survives mapping without a doc; default falls back to `TextSelection.between(...).getBookmark()` which is wrong for non-textual selections. |
| `replace(tr, content)` / `replaceWith(tr, node)` | optional | Override when default range-by-range replacement doesn't match your semantics (e.g. `AllSelection`'s wipe, `CellSelection`'s clear-all-cells). |
| `content()` | optional | Default uses `$from.doc.slice(from, to, true)` with open boundaries; override to return a closed slice or a custom shape. |
| `Selection.jsonID(id, cls)` | yes (one-shot) | Module-init registration. **Throws** on duplicate id, so don't call it inside a function that may run twice. |
| `cls.prototype.visible = false` | optional | Set when the browser shouldn't paint the native selection (e.g. you'll render your own decoration). |

Common pitfalls when writing a custom selection:
- Forgetting `jsonID` → `state.toJSON()` produces `{type: undefined}`, `fromJSON` throws on round-trip.
- Returning `this` from `map` when the doc has changed → stale `ResolvedPos`, downstream crashes.
- Not handling `mapResult.deleted` in `map`/`getBookmark.map` → selection points into a hole.

`prosemirror-tables`' `CellSelection` is the reference implementation for a non-trivial multi-range subclass — read its source for the patterns around custom decorations and view integration.

---

## 7. Static helpers, expanded

### `findSelectionIn`

```ts
// selection.ts:439–452
function findSelectionIn(doc, node, pos, index, dir, text = false): Selection | null {
  if (node.inlineContent) return TextSelection.create(doc, pos)
  for (let i = index - (dir > 0 ? 0 : 1); dir > 0 ? i < node.childCount : i >= 0; i += dir) {
    let child = node.child(i)
    if (!child.isAtom) {
      let inner = findSelectionIn(doc, child, pos + dir, dir < 0 ? child.childCount : 0, dir, text)
      if (inner) return inner
    } else if (!text && NodeSelection.isSelectable(child)) {
      return NodeSelection.create(doc, pos - (dir < 0 ? child.nodeSize : 0))
    }
    pos += child.nodeSize * dir
  }
  return null
}
```

- If the node has inline content → emit a `TextSelection` immediately at `pos`.
- Otherwise iterate children in `dir`. Recurse into non-atomic children. For atomic children, if `text` is false and the child is selectable, emit a `NodeSelection`.
- Position bookkeeping: stepping into a child costs `+dir` (the open token), then accumulating `child.nodeSize * dir` per skipped child.

### `Selection.near` and `findFrom` interplay

`findFrom` first tries the parent of `$pos`; if that yields nothing, it walks ancestors:
```ts
// selection.ts:118–130
let inner = $pos.parent.inlineContent ? new TextSelection($pos)
    : findSelectionIn($pos.node(0), $pos.parent, $pos.pos, $pos.index(), dir, textOnly)
if (inner) return inner
for (let depth = $pos.depth - 1; depth >= 0; depth--) {
  let found = dir < 0
      ? findSelectionIn($pos.node(0), $pos.node(depth), $pos.before(depth + 1), $pos.index(depth), dir, textOnly)
      : findSelectionIn($pos.node(0), $pos.node(depth), $pos.after(depth + 1), $pos.index(depth) + 1, dir, textOnly)
  if (found) return found
}
return null
```

Then `near` ORs both directions and falls back to `AllSelection`. This is the universal "give me any reasonable selection at/around this point" function.

---

## 8. `SelectionBookmark` interface

```ts
// selection.ts:195–204
export interface SelectionBookmark {
  map: (mapping: Mappable) => SelectionBookmark
  resolve: (doc: Node) => Selection
}
```

A bookmark is a *document-independent* representation of a selection — just enough to:
1. be **mapped** through a sequence of changes without needing the doc; and
2. be **resolved** back to a real `Selection` against any compatible doc.

Why bookmarks vs raw resolution:
- Holding a `Selection` keeps `ResolvedPos` objects alive; those reference the *old* doc and become stale instantly.
- Mapping a `Selection` requires a `doc` (the new one) — can't be done while batching mappings without docs.
- Bookmarks store *only* the data needed (a couple of ints, or a discriminator for `AllBookmark`), can be mapped through any `Mappable`, and lazily resolve to a real selection only when you actually need one.

This is exactly what **`prosemirror-history`** uses to remember "the selection before the user typed" across many intervening transactions, then re-resolve it on undo.

Implementations seen in this file:
- `TextBookmark` — `(anchor, head)` ints. (`selection.ts:309`)
- `NodeBookmark` — `anchor` int; demotes to `TextBookmark` if deleted. (`selection.ts:382`)
- `AllBookmark` — singleton, identity map, `new AllSelection(doc)` on resolve. (`selection.ts:429`)
- `CellSelection` (in `prosemirror-tables`) supplies its own.

---

## 9. How transactions update selection

### Implicit (default) update

Every `Transform.addStep` extends the mapping. The `Transaction.selection` getter lazily re-maps the original selection through the new portion of the mapping:

```ts
// transaction.ts:71–77
get selection(): Selection {
  if (this.curSelectionFor < this.steps.length) {
    this.curSelection = this.curSelection.map(this.doc, this.mapping.slice(this.curSelectionFor))
    this.curSelectionFor = this.steps.length
  }
  return this.curSelection
}
```

- `curSelection.map(doc, mapping.slice(from))` is a polymorphic call: `TextSelection.map`, `NodeSelection.map`, `AllSelection.map`, etc.
- `mapping.slice(this.curSelectionFor)` builds a sub-mapping of only steps not yet applied to `curSelection`.
- After `addStep`, the selection has *not* yet been re-mapped — it only is when somebody reads `tr.selection`. This avoids redundant work mid-batch.

### Explicit update via `setSelection`

```ts
// transaction.ts:81–89
setSelection(selection: Selection): this {
  if (selection.$from.doc != this.doc)
    throw new RangeError("Selection passed to setSelection must point at the current document")
  this.curSelection = selection
  this.curSelectionFor = this.steps.length
  this.updated = (this.updated | UPDATED_SEL) & ~UPDATED_MARKS
  this.storedMarks = null
  return this
}
```

Side effects:
- The `UPDATED_SEL` bit is set → `tr.selectionSet === true`.
- The `UPDATED_MARKS` bit is *cleared* → `storedMarksSet` becomes false.
- `storedMarks` is reset to `null`.

So an explicit selection move always discards stored marks (they apply to the *old* cursor; the new cursor inherits its parent's marks instead).

### `selectionToInsertionEnd`

```ts
// selection.ts:454–462
function selectionToInsertionEnd(tr, startLen, bias) {
  let last = tr.steps.length - 1
  if (last < startLen) return
  let step = tr.steps[last]
  if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) return
  let map = tr.mapping.maps[last], end
  map.forEach((_from, _to, _newFrom, newTo) => { if (end == null) end = newTo })
  tr.setSelection(Selection.near(tr.doc.resolve(end!), bias))
}
```

Used by `Selection.replace` / `replaceWith` to re-place the cursor at the end of the just-inserted content. The `bias` is `-1` when the inserted thing was inline (cursor sits after the inline run, biased back) and `+1` when it was a block (cursor sits before the next thing). It only re-selects if the last step actually made content (it bails if the last step isn't a replace).

### Selection field in `EditorState`

```ts
// state.ts:27–30
new FieldDesc<Selection>("selection", {
  init(config, instance) { return config.selection || Selection.atStart(instance.doc) },
  apply(tr) { return tr.selection }
})
```

So the new state's selection is always `tr.selection` — the lazily-mapped or explicitly-set one. There is no "validate against new doc" step because `tr.selection` was already computed from `tr.doc`, which is the new doc.

---

## 10. `storedMarks` — typing-time mark inheritance

`storedMarks` is the answer to: *"if I move my caret here and start typing, which marks will the new characters carry?"*

### Field

```ts
// state.ts:32–35
new FieldDesc<readonly Mark[] | null>("storedMarks", {
  init(config) { return config.storedMarks || null },
  apply(tr, _marks, _old, state) {
    return (state.selection as TextSelection).$cursor ? tr.storedMarks : null
  }
})
```

Read this carefully. After every transaction:

- If the new selection is a **caret** (i.e. `TextSelection` with `$cursor !== null`), keep whatever `tr.storedMarks` is.
- Otherwise (range, node, or all selection), **drop** stored marks to `null`.

Implications:
- A range selection has no stored-marks notion — typing replaces the range, and the marks come from the inserted text.
- Moving the caret (without `setStoredMarks`) clears stored marks, because `tr.storedMarks` was reset by `setSelection` (transaction.ts:87) and nothing re-populated it.

### How `tr.storedMarks` evolves

```ts
constructor(state)            // copies state.storedMarks
setStoredMarks(marks)         // sets, marks UPDATED_MARKS
ensureMarks(marks)            // setStoredMarks if different from current/effective
addStoredMark(mark)           // ensureMarks(mark.addToSet(...))
removeStoredMark(markOrType)  // ensureMarks(mark.removeFromSet(...))
addStep(step, doc)            // CLEARS storedMarks → null, clears UPDATED_MARKS
setSelection(selection)       // CLEARS storedMarks → null, clears UPDATED_MARKS, sets UPDATED_SEL
```

So the canonical pattern for "next typed char will be bold":

```ts
view.dispatch(view.state.tr.addStoredMark(schema.marks.strong.create()))
```

The plain `tr` has no steps and no selection change → `addStep` doesn't fire → `storedMarks` is set → field's `apply` retains it (caret), so the next `insertText` (which uses `tr.storedMarks ?? $from.marks()`) picks up `strong`.

### `insertText` mark resolution

```ts
// transaction.ts:165–183
insertText(text, from?, to?) {
  let schema = this.doc.type.schema
  if (from == null) {
    if (!text) return this.deleteSelection()
    return this.replaceSelectionWith(schema.text(text), true)
  } else {
    if (to == null) to = from
    if (!text) return this.deleteRange(from, to)
    let marks = this.storedMarks
    if (!marks) {
      let $from = this.doc.resolve(from)
      marks = to == from ? $from.marks() : $from.marksAcross(this.doc.resolve(to))
    }
    this.replaceRangeWith(from, to, schema.text(text, marks))
    if (!this.selection.empty && this.selection.to == from + text.length)
      this.setSelection(Selection.near(this.selection.$to))
    return this
  }
}
```

Priority: `tr.storedMarks` → else `$from.marks()` (caret case) or `$from.marksAcross($to)` (range case). The latter, `marksAcross`, returns the marks present at *both* endpoints — i.e. the marks that "span" the range and should be preserved.

Also note: after `replaceRangeWith`, the transaction's mapped selection may now span the inserted text; the code re-cursors at the end via `Selection.near(this.selection.$to)`.

---

## 11. View-side selection sync (forward link → file 09)

The view reads `state.selection` to drive the browser's native selection:

- `TextSelection` (`visible: true`) → set the DOM selection so that the browser shows a caret/range. The view watches `selectionchange` events and dispatches a tr with `setSelection(...).setMeta("pointer", true)` when the user moves the caret with the mouse.
- `NodeSelection` (`visible: false`) → the view collapses the DOM selection to the node's boundary and adds a `ProseMirror-selectednode` class to its DOM rendering. There is no browser highlight.
- `AllSelection` → DOM selection is set to span the whole editable content.
- `CellSelection` (tables) → custom decorations render the highlight; native DOM selection is collapsed somewhere safe.

Detailed mechanics — `selectionchange` debouncing, IME composition, `forceUpdate`, `Selection.scrollIntoView`, the `scrollToSelection` field counter — are covered in **file 09 (view & DOM sync)**. The `scrollToSelection` mechanism specifically is documented in `07-state-and-plugins.md` §1 (it's a counter, not a flag).

---

## 11.5 Design notes (whys) and API clarifications

### Why is `storedMarks` on `EditorState` and not on `Selection`?

A naive design would attach pending marks to the cursor itself: "marks the cursor is ready to apply on next typing". But two requirements break that:

1. **Stored marks must survive transactions whose selection didn't move.** When the user clicks the bold button without typing first, the resulting tr has no steps and no `setSelection`. If marks lived on `Selection`, you'd need to construct a *new* `Selection` (with the same anchor/head) just to attach the marks — and either invalidate the existing `ResolvedPos` references or invent a "marks side-channel" on the same class. Both are leaky.
2. **`Selection` is content-shaped; marks aren't.** A `NodeSelection` has no concept of a cursor. An `AllSelection` has no specific point either. Stored marks only make sense for the *inline-typing* moment, which is `TextSelection.$cursor`. That's why the storedMarks field's `apply` (`state.ts:34`) explicitly drops marks unless the new selection is a caret: it's a global "next typed character takes these marks" register, gated on the selection happening to be a cursor. Lifting that gate into the selection class would mean every selection subclass needs to know about marks — a leaky abstraction that wouldn't even buy ergonomics.

The current design — a separate `storedMarks: Mark[] | null` field, gated on `selection.$cursor !== null` — is minimal *and* lets the toolbar's "make the next char bold" pattern work without ever touching `Selection`.

### Why doesn't `NodeSelection` extend `TextSelection`?

Both expose `$from` / `$to`, but:

- For `TextSelection`, `from === anchor`, `to === head` (or swapped if reverse). Both endpoints are *cursor-shaped* — they live in inline content.
- For `NodeSelection`, `from === anchor`, `to === anchor + node.nodeSize`. **`to` is computed from `from`**, not stored. The endpoint isn't a free cursor; it's structurally tied to a specific node.

Inheriting `TextSelection` would force `NodeSelection` to maintain a fictional `$head` separate from `$anchor`, with rules about keeping them consistent (`$head = $anchor + node.nodeSize`). It would also drag along irrelevant features (`$cursor`, the inline-content invariant, `marksAcross`). Composition over inheritance: both share the abstract `Selection` base but implement `from`/`to` semantics independently.

The same argument applies to `AllSelection`: its endpoints are derived from `doc.content.size`, not from anchor/head endpoints the user can move.

### Why bookmarks instead of `{ anchor, head }` literals?

The "obvious" persistence representation — store `anchor` and `head` integers, map them through the `Mapping`, resolve back — works fine for `TextSelection`. But:

1. **Different selection classes have different persistence shapes.** `NodeSelection` needs only `anchor` (the node position); `AllSelection` needs no positions at all (it's a singleton); `CellSelection` needs two cell positions plus the node-sizes context. A single-shape literal forces all selections to lossily project into `{anchor, head}` and lose information on round-trip.
2. **Mapping policy varies.** `TextBookmark` uses bias `+1` for both endpoints (`selection.ts:312`), so deletions at the cursor push forward. `NodeBookmark` *demotes* itself to a `TextBookmark` when its node is deleted (`selection.ts:382–391`) — there's no sensible way to preserve "selected node" if the node is gone, but a fallback caret position is salvageable. Hard-coding `mapping.map` calls in plugin code couldn't express that demotion without re-implementing it everywhere.
3. **Resolution policy varies.** `AllBookmark.resolve(doc)` is `new AllSelection(doc)` (a constant function of the doc). `TextBookmark.resolve(doc)` goes through `TextSelection.between` to handle endpoints that drifted into non-inline content. `NodeBookmark.resolve(doc)` checks `isSelectable` and falls back to `Selection.near`. Each class encapsulates its own "if mapping made me invalid, here's the fallback" logic.

In short: bookmarks let each selection subclass control both its mapping and its resolution policy without leaking those policies into callers. The history plugin, the only major consumer, calls `bookmark.map(mapping)` and `bookmark.resolve(doc)` polymorphically without ever needing to know which subclass it has.

### `Selection.find` does not exist

The `prosemirror-state` API surface for "find a selection at/near a position" is:

| Function | Returns | Source |
|---|---|---|
| `Selection.findFrom($pos, dir, textOnly?)` | `Selection \| null` | `selection.ts:118–130` |
| `Selection.near($pos, bias?)` | `Selection` (never null; `AllSelection` fallback) | `selection.ts:135–137` |
| `Selection.atStart(doc)` / `Selection.atEnd(doc)` | `Selection` | `selection.ts:143/149` |
| `findSelectionIn(doc, node, pos, index, dir, text?)` | `Selection \| null` (package-private) | `selection.ts:439–452` |

There is **no** `Selection.find`. If older docs or examples reference it, treat them as out-of-date — the modern entry points are `findFrom` (when you want a directional search and can handle `null`) and `near` (when you want a guaranteed result). `findSelectionIn` is internal and not exported.

### `AllSelection.$head` / `$anchor` are placeholders, not user data

Already noted in §5: `AllSelection`'s constructor stamps `$anchor = doc.resolve(0)` and `$head = doc.resolve(doc.content.size)` to satisfy the abstract base class. These positions are correct as *bounds*, but they are **not** the result of any user gesture — there's no "drag start" for an all-selection. Code that wants to know "did the user actively select all" should branch on `selection instanceof AllSelection` rather than inspect `$anchor`/`$head`. Code that wants the geometric bounds (e.g. for a decoration) is fine using them.

---

## 11.6 Worked traces

### Deleting a range that spans the selection's anchor

Setup:

```
Doc:          "Hello [bold]world[/bold]!"
              positions: 0  6                 17 18
TextSelection: anchor=4 ("Hel|lo"), head=12 ("wo|rld")
Plain bookmark: TextBookmark { anchor: 4, head: 12 }
```

Apply a transform that deletes positions `2..8` (covers anchor):

```
tr.delete(2, 8)
   ─ creates ReplaceStep deleting "llo bo"
   ─ tr.mapping has one map: positions [2..8] removed (length 6)
```

Map the bookmark:

```
TextBookmark.map(mapping):
  new anchor = mapping.map(4)
    pos 4 falls inside the deleted [2,8) range
    default bias = +1 → maps to the position *after* the deletion = 2
  new head   = mapping.map(12)
    pos 12 is after the deleted range, shifted by -6
    → 6
  → TextBookmark { anchor: 2, head: 6 }
```

Resolve back:

```
new TextBookmark(2, 6).resolve(newDoc)
  = TextSelection.between(newDoc.resolve(2), newDoc.resolve(6))
  = TextSelection with anchor=2, head=6 (assuming both land in inline content)
```

Result: the selection's anchor was inside the deleted range, but bias `+1` pushed it forward to position `2` (immediately after the deletion). The selection now covers what was previously `[8..12]` — the "rld" portion of "world", in the new coordinate system positions `[2..6]`. This is the deterministic behaviour `TextBookmark` guarantees: an anchor inside a deletion never gets stranded *inside* the deletion (which would be impossible after the delete) and never moves *backward* of where it was. If you needed the anchor to stick to the *start* of the original range instead, you'd need a custom bookmark using bias `-1`.

### `TextSelection` over deleted styled text → mark inheritance

Setup:

```
Doc:          "Hello [strong]bold[/strong] world"
TextSelection: anchor=6, head=10 (covers "bold", entirely within the strong mark)
```

Apply:

```ts
const tr = state.tr.deleteSelection().insertText("X")
```

Trace:

1. `deleteSelection` calls `this.selection.replace(this)` with `Slice.empty`.
2. `TextSelection.replace` (selection.ts:248–254) runs `super.replace(tr, Slice.empty)` — does the actual delete.
3. Then, because `content === Slice.empty`, it computes `marks = this.$from.marksAcross(this.$to)`. Both `$from` (pos 6) and `$to` (pos 10) sit inside `strong`, so `marksAcross` returns `[strongMark]`.
4. `tr.ensureMarks([strongMark])` — sets `tr.storedMarks = [strongMark]`, `UPDATED_MARKS = 1`.
5. `insertText("X")` (with no `from`/`to`) calls `replaceSelectionWith(schema.text("X"), true)`.
6. `replaceSelectionWith` reads `this.storedMarks` (which is `[strongMark]`), creates a text node carrying that mark, and replaces.
7. `addStep` fires inside the replace, *clearing* `tr.storedMarks` to `null` again — but the text was already created with the mark before that point.
8. State field's `apply` for `storedMarks`: new selection is a caret, so it returns `tr.storedMarks` (which is `null`). New state has `storedMarks = null`.

Result: the deleted "bold" was replaced with "X" carrying the `strong` mark. Subsequent typing (without intervention) inherits the natural marks at the new cursor position — which, since "X" is bold, will continue to be bold via `$from.marks()`. So the user's intuition ("I selected bold text, deleted it, typed something else, it should still be bold") is satisfied without any mark-tracking effort on their part.

### `appendTransaction` returning a tr based on `oldState` (anti-pattern)

Setup:

```ts
new Plugin({
  appendTransaction(trs, oldState, newState) {
    // BUG: building tr on oldState, not newState
    return oldState.tr.insertText("oops", 0, 0)
  }
})
```

Inside the fixpoint loop (state.ts:160):

```
trs.push(tr); newState = newState.applyInner(tr)
                                    │
                                    ▼
applyInner(tr):
  if (!tr.before.eq(this.doc)) throw new RangeError("Applying a mismatched transaction")
                                    │
                                    │  tr.before = oldState.doc  ← built from oldState
                                    │  this      = newState      ← which already incorporates rootTr
                                    │  oldState.doc !== newState.doc  (rootTr added/changed content)
                                    ▼
                          throw RangeError
```

Always build appended transactions on `newState.tr`, not on `oldState.tr` or any captured earlier state. The `oldState` parameter is supplied for *inspection* (computing the diff between then and now) — never for transaction construction.

---

## 12. Cheat sheet

| Need | Reach for | Source |
|---|---|---|
| Caret at a position | `TextSelection.create(doc, pos)` | selection.ts:276 |
| Range | `TextSelection.create(doc, anchor, head)` | selection.ts:276 |
| Whole single node | `NodeSelection.create(doc, posBeforeNode)` | selection.ts:367 |
| Whole document | `new AllSelection(doc)` | selection.ts:401 |
| Best-guess from a position | `Selection.near($pos, bias?)` | selection.ts:135 |
| Snap to first/last valid | `Selection.atStart(doc)` / `atEnd(doc)` | selection.ts:143/149 |
| Persist across edits | `selection.getBookmark()` then `bookmark.map(...).resolve(doc)` | selection.ts:180, 195 |
| Detect caret only | `(selection as TextSelection).$cursor` | selection.ts:239 |
| Replace selection in a tr | `tr.replaceSelection(slice)` / `tr.replaceSelectionWith(node)` / `tr.deleteSelection()` | transaction.ts:141, 149, 158 |
| Force-set selection in tr | `tr.setSelection(selection)` (must point at `tr.doc`) | transaction.ts:81 |
| Mark next typed char | `tr.addStoredMark(mark)` (caret only) | transaction.ts:113 |
| Clear stored marks | `tr.setStoredMarks(null)` or any `setSelection` | transaction.ts:87, 97 |
