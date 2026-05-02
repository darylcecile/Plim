# 24 — Tables (`prosemirror-tables`)

Tables are ProseMirror's most architecturally interesting "real" content
type. The package shows what it costs to extend a tree-shaped document
model with a 2D grid: a custom `Selection` subclass, a cached structural
index (`TableMap`), a per-document fixer, a column-resize plugin that
pretends to be a `NodeView`, special clipboard logic, and a deliberate
choice to *not* alter the storage model — cells remain ordinary nodes
inside row nodes, and the grid is reconstructed on demand.

This chapter is a deep tour of the package, in the order needed to
understand the data flow:

1. Schema & `tableRole` annotations.
2. `TableMap` — the cached coordinate index.
3. `CellSelection` — a non-contiguous, multi-range selection.
4. Normalization & `fixTables` — the post-transaction repair pass.
5. The `tableEditing` plugin: input handling and decorations.
6. Column resizing — handles, dragging, NodeView.
7. `mergeCells` / `splitCell` — DOM-grid mutations.
8. `goToNextCell` keymap.
9. Copy/paste round-trip — `pastedCells`, `clipCells`, `insertCells`.
10. Collab implications and pitfalls.
11. ASCII architecture diagram.

Sources are all in `prosemirror-tables/src/`.

---

## 1. Schema and `tableRole`

The package does not introduce a special "grid" node kind. Tables are
modelled as plain `Block` nodes:

```
table
└── table_row+
    └── (table_cell | table_header)*
        └── <cellContent>     # author-provided content expression
```

The trick that lets generic code recognise tables is the
`tableRole` annotation on the `NodeSpec`. From `schema.ts`
(`tableNodes()`):

```ts
table:        { tableRole: 'table',       isolating: true,  ... }
table_row:    { tableRole: 'row',         ...                  }
table_cell:   { tableRole: 'cell',        isolating: true, attrs: { colspan, rowspan, colwidth }, ... }
table_header: { tableRole: 'header_cell', isolating: true, attrs: { ... }, ... }
```

`isolating: true` on table and cell prevents joins across the boundary
(see chapter 22 — without it, Backspace at the start of a cell would
merge cells). `tableRole` is read everywhere via
`type.spec.tableRole` and `tableNodeTypes(schema)` (lines 211–222) which
caches a lookup keyed by the role name.

The cell attribute set is fixed: `colspan`, `rowspan`, `colwidth` (a
`number[] | null`). `colwidth` is a per-spanned-column array; a 3-column
spanning cell with widths set has `colwidth = [w0, w1, w2]`. The DOM
serializer encodes it as `data-colwidth="100,120,80"` (lines 40–51) and
the parser re-validates it (`/^\d+(,\d+)*$/`).

Custom cell attributes plug in via `cellAttributes`; each entry
provides `getFromDOM` / `setDOMAttr` pairs so that round-tripping HTML
keeps the attribute live.

> **Why annotate rather than subclass?** PM nodes are immutable
> persistent values; subclassing `NodeType` would mean teaching the
> schema/transform layer about table-ness. The role annotation lets
> all PM core code treat them as ordinary block nodes; *only* the
> tables package interprets the annotation.

---

## 2. `TableMap` — the cached coordinate index

A table's authoritative storage is row-major: each row contains its
declared cells. But a cell with `colspan=2, rowspan=3` *occupies* six
grid slots even though it stores once. To do anything useful — find a
neighbour, validate a selection, merge cells — code needs a 2D index
from `(row, col)` to the document position of the cell that owns that
slot. Computing that for every operation is wasteful; PM caches it
per-table-node.

### The data structure

`TableMap` (`tablemap.ts:94`) is four fields:

```ts
class TableMap {
  width:    number          // column count
  height:   number          // row count
  map:      number[]        // width*height entries, each = the
                            // table-relative position of the cell
                            // that owns that slot
  problems: Problem[] | null
}
```

For a 3×2 table where the top-left cell spans 2 cols, the `map` array
is:

```
table layout:                      map array (width=3, height=2):
                                      col 0  col 1  col 2
+-----------+--------+              row 0 [  P,    P,    Q ]
|     A     |   B    |              row 1 [  R,    S,    T ]
+-----+-----+--------+
|  C  |  D  |   E    |              ...where P,Q,R,S,T are the
+-----+-----+--------+              table-relative start positions of
                                    A, B, C, D, E. Note that A appears
                                    twice (covers two slots).
```

The map stores **table-relative positions**, not document positions
(comment, lines 6–10). Callers add `$cell.start(-1)` (the start of the
table) to convert.

### Caching

```ts
let cache = new WeakMap<Node, TableMap>();
TableMap.get(table) === readFromCache(table) || addToCache(table, computeMap(table))
```

(lines 54–74, 230). The key is the immutable table `Node`. Because
nodes are persistent values, *any* edit inside the table produces a new
node and the cache miss triggers recomputation. This is the cheapest
possible cache invalidation.

A non-WeakMap fallback uses a 10-slot ring buffer.

### Building the map (`computeMap`, lines 236–315)

The algorithm walks rows, for each declared cell stamps its
table-relative starting position into every grid slot it covers
(`for (h = 0; h < rowspan)` × `for (w = 0; w < colspan)`). It also
records *problems*:

* `collision` — two cells write to the same slot (overlapping spans).
* `missing` — fewer cells than `width` declared in a row.
* `overlong_rowspan` — a `rowspan` that runs past the end of the table.
* `colwidth mismatch` — disagreement among rows about a column's width.
* `zero_sized` — `width === 0 || height === 0`.

These are picked up by `fixTables` (§4) on the next transaction.

`findWidth` (lines 317–340) walks all rows pre-pass to determine
`width` because rowspans from earlier rows can extend into later, narrower
rows.

### Map operations

The class is small; everything is a `width`/`height` arithmetic
exercise:

| Method | Purpose |
| --- | --- |
| `findCell(pos)` | scan `map` for `pos`, then expand right/down while the slot still equals `pos`, returning a `Rect` |
| `colCount(pos)` | `map.indexOf(pos) % width` |
| `nextCell(pos, axis, dir)` | from a cell's rect, jump one slot in the requested direction, return the *cell at that slot* (handles spans) |
| `rectBetween(a, b)` | bounding rect of the cells at positions `a` and `b` |
| `cellsInRect(rect)` | unique cell start positions whose **top-left corner** falls inside `rect` (lines 190–211); the `seen` set + the "skip if neighbour above/left has the same pos" check makes it dedupe spanning cells without iterating their tail slots |
| `positionAt(row, col, table)` | given a logical grid coordinate, return the doc position where that cell starts (or *would* start) |

`findCell` throws `RangeError("No cell with offset N found")` if `pos`
is not a cell start — meaning callers must hand it valid positions, not
arbitrary doc positions.

> **Why store an array, not a `Map<row*W+col, pos>`?** `width*height` is
> usually small (tens to low hundreds); a typed `number[]` is faster and
> uses less memory than a hash map.

---

## 3. `CellSelection`

`CellSelection` (`cellselection.ts:41`) is a `Selection` subclass that
represents a rectangular selection of cells. This is where PM's
"`Selection` is an interface, not a hard-coded text range" design
(chapter 8) really pays off.

### Constructor

```ts
constructor($anchorCell, $headCell = $anchorCell)
```

Both arguments resolve to positions *immediately before* a cell. The
constructor:

1. Looks up the table node (`$anchorCell.node(-1)`) and its `TableMap`.
2. Computes `rect = map.rectBetween(...)` between the two cells in
   table-relative coordinates.
3. Calls `map.cellsInRect(rect)` to enumerate every cell start in the
   rectangle.
4. Filters out the head cell, then unshifts it back at index `0` —
   "Make the head cell the first range, so that it counts as the
   primary part of the selection" (comment, lines 67–68).
5. For each cell, builds a `SelectionRange($from, $to)` covering that
   cell's *content* (i.e. `pos+1` to `pos+1+content.size`).
6. Calls `super(ranges[0].$from, ranges[0].$to, ranges)`.

So `CellSelection.ranges.length === N` (one per cell). Compare with
`TextSelection`, where `ranges.length === 1` (a single contiguous
range). The base `Selection` class supports `ranges` as an array —
that abstraction was added precisely so cell-selection could exist.

`$anchorCell` and `$headCell` are stored as extra fields beyond what
the base class tracks.

### Visibility & decoration

```ts
CellSelection.prototype.visible = false
```

The DOM selection is invisible because painting it natively would
underline only one cell at a time. Instead, `drawCellSelection`
(lines 389–398) returns a `DecorationSet` of node decorations, one per
cell, with class `selectedCell` — applied via the plugin's
`props.decorations`.

### `content()` — the rectangular slice (lines 106–181)

When the user copies, PM calls `selection.content()`. For a
`CellSelection` this is non-trivial because:

* Cells partially inside the rect (e.g. a `colspan=3` cell whose left
  edge is inside the rect but right edge isn't) must be **clipped** —
  the slice should contain a clipped cell with reduced `colspan`.
* `colspan` is an attribute, not a structural fact, so clipping means
  building a new cell with adjusted `colspan` via `removeColSpan`.
* Cells that span past the top of the rect must use `createAndFill`
  (because their content might be missing — the original is a
  rowspanning cell that started earlier).

The output is a `Slice` with `openStart=1, openEnd=1` so the rows are
"open" — they can be merged into a target table.

If the selection covers the entire table (`isColSelection() &&
isRowSelection()`) the fragment is the whole `<table>` node, otherwise
a list of `<table_row>` nodes (line 179).

### `replace(tr, content)` — cell-by-cell (lines 183–200)

`TextSelection.replace` deletes one range and inserts. `CellSelection`
must replace **each cell's content independently**:

```ts
for each range in this.ranges:
  tr.replace(mapping(range.from), mapping(range.to),
             i === 0 ? content : Slice.empty)
```

The first range gets the new content; subsequent ranges are wiped to
empty. The mapping after each step propagates position adjustments to
the next iteration. Backspace on a cell selection therefore *clears all
selected cells* (each one becomes empty), which is what spreadsheet
users expect.

`replaceWith(tr, node)` defers to `replace` with a 0-deep slice
wrapping `node` (lines 202–204).

### `isRowSelection` / `isColSelection`

Both check whether the selection's bounding rect spans the full table
on the relevant axis. They use `colCount`/`indexAfter`/rowspan/colspan
arithmetic; see lines 222–235 (col) and 273–285 (row).

These power the "select column / select row" UI affordances and feed
back into `map()` (line 86): when a selection is mapped through a
docChange and the table identity changes (e.g. a cell was added),
preserving the `isRowSelection` / `isColSelection` invariant requires
recomputing via `CellSelection.rowSelection` / `.colSelection`
(static helpers, lines 239–268, 297–326). Without that, mapping a
"select entire column" through "insert column" would lose the
selection's semantic.

### JSON, bookmark, `jsonID`

```ts
toJSON(): { type: 'cell', anchor: number, head: number }
Selection.jsonID('cell', CellSelection)             // line 359
```

This registers `'cell'` as a valid selection JSON tag — required for
collab and history rebases that serialize selections.

The `CellBookmark` (lines 364–387) survives transactions: it stores
just the two cell positions, maps them through `Mappable`, and on
`resolve` checks the parents are still rows of the same table; if not,
it falls back to `Selection.near`.

### Comparison with TextSelection

| | `TextSelection` | `CellSelection` |
| --- | --- | --- |
| `ranges.length` | 1 | N (one per cell) |
| `visible` | true | false (decorations draw it) |
| Content | one inline slice | an open-1 slice of rows |
| `replace` | one `tr.replace` | N replaces, content goes to first range only |
| Bookmark | `TextBookmark(anchor, head)` | `CellBookmark(anchor, head)` (cell positions) |
| jsonID | `'text'` | `'cell'` |
| Mapping | maps endpoints | maps anchor + head, may switch to `TextSelection.between` if no longer in a table (line 101) |

---

## 4. Normalization (`normalizeSelection`) and `fixTables`

After every transaction the `tableEditing` plugin runs
`appendTransaction` (`index.ts:139–145`):

```ts
appendTransaction(_, oldState, state) {
  return normalizeSelection(state, fixTables(state, oldState),
                            allowTableNodeSelection);
}
```

### `fixTables` (`fixtables.ts:62`)

Walks every table in the doc (or, when `oldState` is given, only
descendants that changed — `changedDescendants` does a shallow diff,
lines 28–60). For each table it asks `TableMap.get(table)` — if the
map has any `problems`, `fixTable` (line 79) appends repair steps:

* `collision`: shrink the offending cell's `colspan` (`removeColSpan`)
  and remember to add `n` cells to row `prob.row + j` (one per spanned
  row, j = 0..rowspan).
* `missing`: schedule `n` cells to be added to row `prob.row`.
* `overlong_rowspan`: clamp `rowspan`.
* `colwidth mismatch`: rewrite the cell with the canonical `colwidth`.
* `zero_sized`: `tr.delete(table)` outright.

Then for each row that needs `mustAdd[i]` cells, it picks a side
(roughly: insert at the *start* of the row only if it looks like a
"bite" was taken out of the upper-left corner, otherwise at the end;
heuristic on line 151) and calls `createAndFill` to build empty cells.

Marks the resulting transaction with `setMeta(fixTablesKey, { fixTables: true })`
so callers can recognise repair-only transactions (e.g., to suppress
them in undo history).

### `normalizeSelection` (`cellselection.ts:444`)

After fixing, the selection might be in a weird state. This function:

* If `NodeSelection` wraps a `cell`/`header_cell` → convert to a
  single-cell `CellSelection`.
* If it wraps a `row` → convert to a row `CellSelection`.
* If it wraps a `table` (and `allowTableNodeSelection !== true`) →
  expand to a `CellSelection` over all cells.
* If `TextSelection` straddles a cell boundary
  (`isCellBoundarySelection`, `isTextSelectionAcrossCells`) →
  collapse / clamp inside one cell.

This is the layer that turns user gestures (e.g. native triple-click
selecting `<td>` as a node) into the correct PM selection.

---

## 5. The `tableEditing` plugin

`index.ts:97–147`. Wires:

* `state` — a `pluginState: number | null` tracking the anchor of an
  in-progress mouse-drag cell selection across transactions (so the
  drag survives doc changes that move the anchor).
* `props.decorations` — `drawCellSelection` (the `selectedCell`
  highlight).
* `props.handleDOMEvents.mousedown` — `handleMouseDown` from
  `input.ts:173` (drag-to-create CellSelection).
* `props.createSelectionBetween` — while a drag is active, returns the
  current selection unchanged so that the PM core doesn't reset it.
* `props.handleTripleClick` — convert a triple-click on a cell into a
  `CellSelection` of that cell (`input.ts:118–124`).
* `props.handleKeyDown` — arrow / shift-arrow / Backspace / Delete
  inside tables (see `input.ts:32–47`).
* `props.handlePaste` — see §9.
* `appendTransaction` — `fixTables` + `normalizeSelection` (above).

The `index.ts` doc-comment recommends putting this plugin **near the
end** of the plugin list, because it broadly captures arrow keys and
mousedown — earlier plugins (gap cursor, column resize) get a shot
first.

### Arrow keys (`input.ts:62–93`)

```
arrow(axis, dir) =>
  (state, dispatch, view) => {
    if selection is CellSelection:
      collapse to TextSelection near $headCell in dir
    else if vertical and selection not empty: false
    else if !atEndOfCell(view, axis, dir): false
    else for horiz: setSelection at sel.head + dir
    else for vert: jump to nextCell or out of the table
  }
```

`atEndOfCell` (line 253) consults the *DOM* via
`view.endOfTextblock(dir)` to decide whether the caret is visually at
the cell edge — important for wrapped lines where caret position
doesn't match logical block index.

---

## 6. Column resizing

`columnresizing.ts`. Two visible affordances:

1. A 5px-wide invisible "handle" along the right edge of every column
   (the cursor turns into `col-resize`).
2. While dragging, a `column-resize-handle` decoration line and a
   `column-resize-dragging` class on the affected cells.

### Plugin state (`ResizeState`, line 116)

```ts
class ResizeState {
  activeHandle: number          // doc pos of the cell whose handle is hovered, or -1
  dragging:    { startX, startWidth } | false
}
```

`apply(tr)` (lines 122–138) takes `setHandle` / `setDragging` metas. If
nothing was set but the doc changed and a handle was active, it maps
the handle position; if mapping no longer points at a cell
(`pointsAtCell`), drops to `-1`.

### Pointer flow

```
mousemove (no drag) --> handleMouseMove (l. 141)
   findCell under pointer (domCellAround)
   if pointer is in left/right 5px:
     compute the pos of that cell's edge
     if changed:
       dispatch setMeta(setHandle: pos)

mousedown on hovered handle --> handleMouseDown (l. 192)
   record startX, startWidth in plugin state via setMeta
   add window.mousemove + window.mouseup
   mousemove during drag:
     displayColumnWidth (visual only — manipulates the <col> DOM
     directly via updateColumnsOnResize, no transaction)
   mouseup:
     updateColumnWidth — issues a real transaction setNodeMarkup on
     every cell in the column, writing the new colwidth into the
     attrs.
```

Note the **two-phase** approach: live drag uses imperative DOM
mutation on the `<col>` elements (no doc change, no
transaction), and only on `mouseup` does it commit a transaction
that rewrites all cells' `colwidth`. This avoids dispatching dozens
of transactions per second during a drag, which would be brutal for
collab and undo history.

### `handleDecorations` (line 388)

For the cell whose handle is active, walks the column top-to-bottom
and emits a `Decoration.widget(pos, <div class=column-resize-handle>)`
at each cell boundary that isn't covered by a rowspan continuation
(condition lines 408–409: only if the slot to the right has a
different cell *and* the slot above has a different cell).

### NodeView (`tableview.ts`)

`columnResizing()` registers a `nodeView` for the `table` type
(`TableView`) which:

* Renders `<table><colgroup><col>...<tbody>` with explicit `<col>`
  widths derived from cell `colwidth` attributes.
* `update(node)` patches `<col>` widths in place rather than rebuilding
  the DOM (cheap visual updates during drag).

`updateColumnsOnResize` is the function the drag code calls during
`mousemove` to update widths without a transaction.

### Pitfall: editing a cell during column resize

Because `mousemove` doesn't dispatch a transaction, in-progress drags
don't conflict with typing. But: an `appendTransaction` from
`tableEditing` (e.g. fix-tables) *can* fire while the drag is open. The
plugin guards by mapping `activeHandle` through `tr.mapping` in
`apply()` (lines 130–135). If the cell is gone, `activeHandle` is
reset, but the drag is still alive in `mousemove` closures — clicks
release will read `pluginState.activeHandle === -1` in `finish()` and
no-op. Edge cases (mouseup raced with a remote insertion that
removed the cell) result in a dropped commit, not corruption.

---

## 7. `mergeCells` and `splitCell`

### `mergeCells` (`commands.ts:401–459`)

Given a non-degenerate `CellSelection` whose rect doesn't contain
overlapping spans:

```
1. Find the top-left cell in the rect (mergedPos, mergedCell).
2. For every other cell in the rect:
     - if non-empty, append its content to a Fragment
     - tr.delete(cellPos, cellPos + nodeSize)
   (positions remapped via tr.mapping each time)
3. tr.setNodeMarkup(mergedPos, null, {
     ...addColSpan(mergedCell.attrs,
                   mergedCell.attrs.colspan,
                   rect.right - rect.left - mergedCell.attrs.colspan),
     rowspan: rect.bottom - rect.top
   })
4. If we collected content:
     replaceWith(start, end, content)   // append into the merged cell
5. setSelection(new CellSelection(merged))
```

Implementation note: although the comment in the package title
mentions `ReplaceAroundStep`, the actual implementation uses a
sequence of `tr.delete` + `tr.setNodeMarkup` + `tr.replaceWith` rather
than constructing a single step. This is simpler and lets the mapping
handle position adjustments automatically. The end result is the same:
a single transaction, atomic in undo, with all positions remapped
correctly.

### `splitCell` / `splitCellWithType` (lines 467–566)

Reverse direction: take a single cell with `colspan>1` or `rowspan>1`
and break it into 1×1 cells using `tableNodeTypes(schema)[role]` (or
the user-supplied `getCellType`). The split distributes existing
content into the **top-left** of the new cells and creates the rest as
empties.

Subtle: the original cell's attributes are inherited by all new cells,
*except* `colspan`/`rowspan`/`colwidth` which are reset to 1.

### Undo of split-cell pitfall

Because `splitCell` produces a transaction that deletes the original
cell and inserts N new cells, undo restores all the original
positions. But if a remote collaborator typed in one of the new cells
between the local split and the local undo, undo's mapped positions
might point inside cells that no longer exist as the user expects
them. The merged-back cell will have all the typed content as a single
flat content, possibly out of order. There's no good fix; the
resolution is "split cells are a structural edit, treat them like
moving paragraphs around".

---

## 8. `goToNextCell` (Tab keymap)

`commands.ts:822–837`:

```ts
goToNextCell(direction: 1 | -1): Command =
  (state, dispatch) => {
    if (!isInTable(state)) return false;
    let cell = findNextCell(selectionCell(state), direction);
    if (cell == null) return false;
    if (dispatch) {
      let $cell = state.doc.resolve(cell);
      dispatch(state.tr
        .setSelection(TextSelection.between($cell, moveCellForward($cell)))
        .scrollIntoView());
    }
    return true;
  };
```

`findNextCell` (line 782) walks:

* For `dir = -1`: previous sibling cell if any; else previous row's
  last cell (loop scanning rows).
* For `dir = +1`: next sibling cell; else next row's first cell.

Returns `null` if there is no further cell in the table — `Tab` in the
last cell of the last row falls through to the next keymap, where the
common pattern is to call `addRowAfter` to grow the table.

The selection produced is a `TextSelection` at the cell's content edge
(via `moveCellForward`), not a `CellSelection` — so the user can
immediately type.

---

## 9. Copy / paste round-trip

Tables are special on the clipboard:

### Copy

`CellSelection.content()` returns a `Slice` whose top-level fragment
is *either* a `<table>` (if the selection is the whole table) or a list
of `<table_row>` nodes. `prosemirror-view`'s clipboard serializer
(chapter 16) already wraps a slice's fragment in a context wrapper so
that `<tr>` becomes a parseable HTML fragment — typically the
fragment is wrapped in `<table><tbody>...</tbody></table>` because
`<tr>` outside `<table>` is not valid.

### Paste — `handlePaste` (`input.ts:129–171`)

```ts
1. If not in a table, bail (let the default paste run).
2. cells = pastedCells(slice)        // try to parse as table content
3. If selection is a CellSelection:
     If cells == null: wrap whole slice as one cell.
     Compute target rect from the CellSelection.
     cells = clipCells(cells, rectW, rectH)       // tile/clip to rect
     insertCells(state, dispatch, start, rect, cells)
4. Else if cells != null:
     Insert the rectangular block at the current cell's position,
     growing the table down/right to fit.
```

### `pastedCells` (`copypaste.ts:38`)

Tries to coerce a clipboard slice into a rectangular block of rows.
Walks down through wrapping nodes (`while content.childCount==1 &&
((openStart>0 && openEnd>0) || child0.tableRole=='table')`), then:

* If inner role is `'row'`: take each row, refit its open ends.
* If inner role is `'cell'/'header_cell'`: wrap it as a single row.
* Otherwise: return `null` (not a table-shaped paste).

`ensureRectangular` (line 83) pads short rows with empty cells so the
output is a clean grid.

### `clipCells` and `insertCells`

* `clipCells(cells, w, h)` (line 122): tile `cells` to fill a `w×h`
  rect — repeats the source pattern (so pasting a 2×2 block into a
  4×4 selection fills the whole 4×4) and clips edge cells with
  `removeColSpan` / adjusted rowspan.
* `insertCells` (line 324): writes the prepared rows into the doc,
  growing the destination table with `growTable` if needed and
  isolating affected rows / columns (`isolateHorizontal`,
  `isolateVertical`) by splitting any existing cells whose spans
  overlap the insert boundary.

The combined effect is spreadsheet-like paste: rectangular regions
copy-paste cleanly, and pasted shapes can be arbitrarily wider/taller
than the target (the target table grows).

### Fallback parser

The schema's `parseDOM` rules for `table` / `tr` / `td` / `th` are
default HTML tags, so a paste from Excel / Google Sheets — which
arrives as `<table>...</table>` — flows through the standard DOM
parser (`prosemirror-model`), then `pastedCells` recognises the
shape.

---

## 10. Collab implications

### Rebase splits inside a cell

The collab module (`prosemirror-collab`, chapter 20) rebases local
unconfirmed steps over remote steps. If a remote user changes a
cell's structure (`mergeCells`, `splitCell`, `addColumn`), the local
unconfirmed steps' positions get re-mapped through the inverse of
those structural changes.

For pure text edits inside a cell, this is fine — `Mapping` handles
it. The trouble cases:

* **Local merge + remote insert into one of the merged cells**:
  rebasing the local merge over the remote insert is fine (the merge
  step maps and now also subsumes the remote content). But the
  remote's selection (a `CellSelection` or `TextSelection`) gets
  mapped through the merge — its `head`/`anchor` may end up pointing
  at the merged cell. The mapped position is *inside* that cell, so
  it works, but the user's caret has visibly moved.
* **Local split + remote merge**: the local split's
  `setNodeMarkup` no longer makes sense (the cell it targeted is
  gone). The step's mapping deletes it. End result: split is a no-op
  on rebase. Often the right answer.
* **Two simultaneous `addColumn` ops**: each step uses absolute
  positions; rebasing the second through the first shifts its column
  insertion point. If both wanted "after column 2" you end up with
  *two* columns added at slightly different positions — convergent
  but possibly not what either user expected.

### `TableMap` recompute

After every applied transaction on either side, `TableMap.get(table)`
on the new table node misses cache and recomputes. This is correct but
inefficient on large tables; for a `1000-cell` table, recompute is
~1ms but happens many times during a rapid sequence of remote ops.
There is no "incremental TableMap" — the assumption is tables are not
huge.

### Selection serialization

`CellSelection.toJSON()` writes only the two cell positions; over the
wire (collab does *not* automatically send selections, but
collaborative-cursor packages do) the positions are mapped through
the rebased steps. `Selection.jsonID('cell', CellSelection)`
(line 359) is what makes `Selection.fromJSON` round-trip a cell
selection received from a peer.

---

## 11. Pitfalls round-up

* **Editing a cell during column resize**: the live drag is DOM-only,
  so a remote insertion into the cell will redraw via NodeView
  `update()` mid-drag. The drag's `startX/startWidth` are still valid
  (they're plugin state), but the NodeView replacing the table DOM
  *does* re-render the `<col>` elements at the committed widths,
  visually snapping back. The next `mousemove` re-applies the drag
  delta. End-user effect: a flicker, but no corruption.

* **Undo of split-cell** when collab interleaves: see §7 above.

* **Dragging Tab onto an empty table cell**: the drop-cursor plugin
  may compute a drop position at `pos = cell.start + 1` (inside the
  cell). On drop, the dragged content replaces the cell content. This
  is fine, but the `disableDropCursor` spec hook (chapter 36) lets
  authors opt cells out.

* **`isolating` cells**: prevents `joinBackward` across cells; that's
  why Backspace at the start of a non-empty cell does nothing instead
  of merging cells. Users sometimes expect it to merge with the
  previous cell — that's not a bug, that's `isolating: true`.

* **`fixTables` running on every transaction** is cheap if no table
  changed (`changedDescendants` short-circuits) but still walks the
  set of changed table nodes. For pathological cases (a transaction
  that rewrites every table) it becomes O(total cells).

* **Zero-width tables**: `TableMap` flags `zero_sized` and
  `fixTable` deletes them. If you somehow construct a 0×N or N×0
  table programmatically and don't run the fixer, every other table
  helper will throw `RangeError("No cell with offset N found")`.

---

## 12. Architecture diagram

```
                    ┌────────────────────────────────────────┐
                    │            EditorState                 │
                    │   doc (immutable Node tree)            │
                    │   selection (Text/Node/Cell/Gap)       │
                    │   plugins state (resize, tableEditing) │
                    └──────────────┬─────────────────────────┘
                                   │ transaction
                                   ▼
   ┌────────────────────────────────────────────────────────────┐
   │  appendTransaction (tableEditing plugin)                   │
   │   ├── fixTables(state, oldState)        ← repairs spans    │
   │   │     └── TableMap.get(table).problems ← detected during │
   │   │                                       computeMap       │
   │   └── normalizeSelection                                   │
   │         ├── NodeSelection(cell/row/table) → CellSelection  │
   │         └── TextSelection across cells   → clamp           │
   └──────────────┬─────────────────────────────────────────────┘
                  │ new state
                  ▼
   ┌────────────────────────────────────────────────────────────┐
   │  EditorView                                                │
   │   ├── DOM tree                                             │
   │   │     └── TableView (NodeView)                           │
   │   │           ├── <colgroup><col width=...>                │
   │   │           └── <tbody>...                               │
   │   ├── decorations:                                         │
   │   │     ├── drawCellSelection      (selectedCell class)    │
   │   │     └── handleDecorations      (column-resize-handle)  │
   │   └── DOM event handlers:                                  │
   │         ├── mousedown  → handleMouseDown (drag selection)  │
   │         ├── mousemove  → resize handle hover/drag          │
   │         ├── triple-click → CellSelection of cell           │
   │         ├── keydown    → arrow/shiftArrow/Backspace        │
   │         └── paste      → handlePaste → pastedCells         │
   └────────────────────────────────────────────────────────────┘

       ┌─────────────────────────────────────────────────┐
       │  TableMap cache                                 │
       │   WeakMap<Node, TableMap>                       │
       │   recomputed on first access after table edit   │
       └─────────────────────────────────────────────────┘

       ┌─────────────────────────────────────────────────┐
       │  Commands (commands.ts)                         │
       │   addColumnBefore/After  removeColumn           │
       │   addRowBefore/After     removeRow              │
       │   mergeCells   splitCell   splitCellWithType    │
       │   setCellAttr  toggleHeaderRow/Column/Cell      │
       │   goToNextCell(±1)  deleteTable                 │
       │   moveTableRow  moveTableColumn                 │
       │  All read TableMap, write via setNodeMarkup +   │
       │  delete + insert + replaceWith.                 │
       └─────────────────────────────────────────────────┘
```

### Key file map

| File | Role |
| --- | --- |
| `index.ts` | public exports + `tableEditing()` plugin factory |
| `schema.ts` | `tableNodes()`, `tableNodeTypes()`, `tableRole` |
| `tablemap.ts` | `TableMap` class + `computeMap` + cache |
| `cellselection.ts` | `CellSelection`, `CellBookmark`, `drawCellSelection`, `normalizeSelection` |
| `fixtables.ts` | `fixTables`, `fixTable` repair pass |
| `columnresizing.ts` | resize plugin, `ResizeState`, decorations, drag handlers |
| `tableview.ts` | `TableView` NodeView, `<col>` updates |
| `commands.ts` | all editing commands; `selectedRect` helper |
| `input.ts` | keymap, mousedown drag, paste, triple-click |
| `copypaste.ts` | `pastedCells`, `clipCells`, `insertCells`, `growTable`, `isolateHorizontal/Vertical` |
| `util.ts` | `cellAround`, `inSameTable`, `pointsAtCell`, `addColSpan`, `removeColSpan`, `tableEditingKey` |

The package is ~3800 LOC, of which `commands.ts` (990) and
`cellselection.ts` (472) carry the bulk of the editing semantics. The
real intellectual content is in `tablemap.ts` (the cache and the
problem-detection algorithm) and the `CellSelection.replace` /
`content` methods.
