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
- **`near($pos, bias)`** — `findFrom($pos, bias) || findFrom($pos, -bias) || new AllSelection(...)`. The fallback to `AllSelection` only kicks in for genuinely empty / leaf-only documents (`selection.ts:135–137`).
- **`atStart(doc)` / `atEnd(doc)`** — search inward from position 0 / `doc.content.size` for the first valid selection; fall back to `AllSelection(doc)` (`selection.ts:143–151`).
- **`jsonID(id, cls)`** — registers `cls` in a module-private `classesById` table and stamps `cls.prototype.jsonID = id`. `fromJSON` dispatches on `json.type` (`selection.ts:155–171`).

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

---

## 2. `SelectionRange`

```ts
// selection.ts:207–215
export class SelectionRange {
  constructor(readonly $from: ResolvedPos, readonly $to: ResolvedPos) {}
}
```

A pair of resolved positions. `Selection.ranges` is the canonical list; for single-range selections it's `[new SelectionRange(min, max)]`. Multi-range selections (e.g. `CellSelection`) use multiple entries.

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
- **Selectability** — `isSelectable` excludes text nodes and any node type whose spec sets `selectable: false`. Used by `findSelectionIn` (`selection.ts:446`) and `NodeBookmark.resolve` (`selection.ts:390`).
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
- **`replace` empty** — explicit `tr.delete(0, doc.content.size)` then re-cursor via `Selection.atStart`. This is required because the default `Selection.replace` would call `replaceRange` which can preserve outer structure; here we genuinely want to wipe and re-cursor.
- **`map` is identity** — the all-selection of any document version is "all of it", so mapping is just `new AllSelection(doc)`.
- **`getBookmark`** — singleton `AllBookmark` whose `map` is `() => this` (no-op) and whose `resolve(doc)` is `new AllSelection(doc)`.

---

## 6. `CellSelection` (forward note)

`CellSelection` is **not** in `prosemirror-state`. It lives in **`prosemirror-tables`** and is registered there with `Selection.jsonID("cell", CellSelection)`. Sketched:

- Multi-range: `ranges` covers each cell's content range individually.
- Two anchor cells (`$anchorCell`, `$headCell`) define a rectangular block in the table.
- Custom `replace` / `replaceWith` clear all selected cells.
- Custom `getBookmark` so tables survive history/mapping.
- Has its own decoration pass (the visible "selected cells" highlight).
- Plays with the view through standard mechanics: it is a normal `Selection` subclass, so all of `state`'s machinery (transaction selection map, `tr.setSelection`, etc.) applies unchanged.

The `prosemirror-state` package never imports it; the only seam is `Selection.jsonID` and the abstract base class.

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

Detailed mechanics — `selectionchange` debouncing, IME composition, `forceUpdate`, `Selection.scrollIntoView`, the `scrollToSelection` field counter — are covered in **file 09 (view & DOM sync)**.

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
