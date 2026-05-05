# 36 — Cursor plugins: drop cursor, gap cursor, multi-cursor

ProseMirror ships two small companion plugins that solve the cursor
problems the core can't:

* **`prosemirror-dropcursor`** — paints an insertion line at the
  position where a drag-and-drop will land.
* **`prosemirror-gapcursor`** — defines a *new kind of selection*
  (`GapCursor`) for positions where a `TextSelection` cannot legally
  exist (between two block-level atoms, between a table and the next
  paragraph, etc.).

This chapter walks both, then discusses why PM has no built-in
multi-cursor and what implementing one entails.

Cross-references: chapter 8 (Selection model), chapter 13 (input
pipeline), chapter 17 (coordinates / hit testing), chapter 24 (tables —
which is one of the main places gap cursor matters).

---

## 1. Drop cursor (`prosemirror-dropcursor`)

Source: `prosemirror-dropcursor/src/dropcursor.ts` (170 lines, single
file).

### What problem it solves

When the user drags content over the editor, the browser's native
caret-during-drag behaviour is inconsistent and often invisible
(especially over block boundaries — Chrome shows nothing between
`<figure>` and the next `<p>`). The drop cursor plugin paints a thin
line (default 1px black) at the *exact* position PM will use for the
drop, computed via `posAtCoords` + `dropPoint`.

### Plugin shape

```ts
export function dropCursor(options: DropCursorOptions = {}): Plugin {
  return new Plugin({
    view(editorView) { return new DropCursorView(editorView, options) }
  });
}
```

This is a *view-only* plugin: no `state`, no `props`, no `appendTransaction`.
All work happens in the `DropCursorView` lifecycle object.

### `DropCursorView` lifecycle

Constructor (lines 46–56):

```ts
this.handlers = ['dragover','dragend','drop','dragleave']
  .map(name => {
    let handler = e => this[name](e);
    editorView.dom.addEventListener(name, handler);
    return { name, handler };
  });
```

It hangs DOM listeners directly on `view.dom`, *not* via
`props.handleDOMEvents`. Two reasons: (a) drag events are noisy and
the plugin doesn't want PM core to dispatch them through its
normal handler pipeline; (b) `dragend`/`drop` need to fire even if PM
has decided to ignore the event.

`destroy()` (line 58) removes them — important: leaking these would
leak the view via the closure.

`update(view, prevState)` (lines 62–67) runs on every state change.
If the cursor is showing (`cursorPos != null`) and the doc changed,
either re-anchor (`updateOverlay`) or hide (if `cursorPos` is now past
end of doc).

### `dragover` handler — computing the drop position

This is the meat (lines 137–156):

```ts
dragover(event) {
  if (!this.editorView.editable) return;
  let pos = this.editorView.posAtCoords({
    left: event.clientX, top: event.clientY
  });

  // Per-node opt-out via NodeSpec.disableDropCursor
  let node = pos && pos.inside >= 0 &&
             this.editorView.state.doc.nodeAt(pos.inside);
  let disableDropCursor = node && node.type.spec.disableDropCursor;
  let disabled = typeof disableDropCursor == 'function'
    ? disableDropCursor(this.editorView, pos!, event)
    : disableDropCursor;

  if (pos && !disabled) {
    let target = pos.pos;
    if (this.editorView.dragging && this.editorView.dragging.slice) {
      let point = dropPoint(this.editorView.state.doc, target,
                            this.editorView.dragging.slice);
      if (point != null) target = point;
    }
    this.setCursor(target);
    this.scheduleRemoval(5000);
  }
}
```

Two-step position resolution:

1. **`posAtCoords({clientX, clientY})`** — converts viewport pixels to
   a doc position (chapter 17). Returns `{ pos, inside }`.
2. **`dropPoint(doc, target, slice)`** — from `prosemirror-transform`.
   Adjusts `target` to a position where the dragged slice can actually
   be inserted: walks up parent nodes asking each whether its content
   match would accept the slice; if not, climbs out and tries the
   next valid boundary. This is what makes the drop cursor "snap"
   between paragraphs rather than appearing inside an unbreakable
   atom.

When `view.dragging?.slice` is unavailable (drags from outside the
editor — files, browser-native drags) `dropPoint` is skipped and the
raw `pos` is used.

### `disableDropCursor` schema hook

Augments `prosemirror-model`'s `NodeSpec` (lines 31–35):

```ts
declare module 'prosemirror-model' {
  interface NodeSpec {
    disableDropCursor?: boolean | ((view, pos, event) => boolean)
  }
}
```

Authors set this to `true` (or a function) on nodes that own their own
drop UI — e.g. a column layout node that internally handles drops to
choose a column.

### `setCursor` & `updateOverlay`

`setCursor(pos)` (l. 69) is the state mutator: if the new pos differs,
either remove the old element (when `pos === null`) or call
`updateOverlay`.

`updateOverlay` (l. 80) is the geometry computation:

```
If parent is a block container (!parent.inlineContent):
  Find DOM node before/after the position, compute their bounding rects,
  draw a horizontal line at the boundary (top edge of nodeAfter, bottom
  edge of nodeBefore, midpoint if both exist).
Else:
  Use coordsAtPos(pos) — a single point — and draw a thin vertical
  caret-like line.
```

The element is appended to `editorView.dom.offsetParent` (not into the
editor itself — important so the cursor doesn't end up inside a
contenteditable region).

The element styles are imperative: `position: absolute; z-index: 50;
pointer-events: none;`. The plugin scales coordinates against the
editor's CSS transform via `getBoundingClientRect().width /
offsetWidth` to handle zoomed/transformed editors.

### Cleanup

`scheduleRemoval(timeout)` (l. 132) sets a 5-second timeout to hide
the cursor. Reset on every `dragover`. `dragend`/`drop` shorten it to
20ms (so the line vanishes near-instantly on drop, but only after the
drop transaction has had a tick to land). `dragleave` removes
immediately if the related target is outside the editor.

---

## 2. Gap cursor (`prosemirror-gapcursor`)

Source: `prosemirror-gapcursor/src/{gapcursor,index}.ts` (~230 lines).

### What problem it solves

`TextSelection` requires a position with an inline parent (so a caret
can sit between characters). But PM allows blocks whose content is not
inline — e.g. a `figure` containing only an `image`, a `table` (whose
content is rows), `code_block` with `isolating: true`. Between two
such blocks, or at the very top/bottom of the doc with such blocks,
there is *no valid TextSelection position*. Without a special
selection, the user literally cannot place a caret there to start
typing — they're stuck.

`GapCursor` is a `Selection` subclass that represents a caret in such
a "gap". The keymap creates one when arrow keys hit the edge of a
block-level leaf, and the plugin renders it as a thin vertical bar.

### `GapCursor` class

```ts
class GapCursor extends Selection {
  constructor($pos: ResolvedPos) { super($pos, $pos) }
  content() { return Slice.empty }
  eq(other) { return other instanceof GapCursor && other.head == this.head }
  toJSON() { return { type: 'gapcursor', pos: this.head } }
  static fromJSON(doc, json) { ... }
  getBookmark() { return new GapBookmark(this.anchor) }
  static valid($pos): boolean { /* see below */ }
  static findGapCursorFrom($pos, dir, mustMove): ResolvedPos | null
}
GapCursor.prototype.visible = false   // l. 88
Selection.jsonID('gapcursor', GapCursor)
```

It is *empty* — `$anchor === $head === $pos`, and `content()` returns
`Slice.empty`. Replacing a gap cursor inserts at `$pos.pos` with no
deletion (the base `Selection.replace` handles it).

`visible = false` because the DOM selection cannot represent this
position — instead `drawGapCursor` (`index.ts:86`) emits a
`Decoration.widget` at `selection.head` with class
`ProseMirror-gapcursor`. The supplied stylesheet (`style/gapcursor.css`)
renders that element as a `::after` pseudo-element with a blinking
border.

### `GapCursor.valid($pos)` — when can a gap cursor live here?

`gapcursor.ts:38–45`:

```ts
static valid($pos: ResolvedPos) {
  let parent = $pos.parent;
  if (parent.inlineContent || !closedBefore($pos) || !closedAfter($pos))
    return false;
  let override = parent.type.spec.allowGapCursor;
  if (override != null) return override;
  let deflt = parent.contentMatchAt($pos.index()).defaultType;
  return deflt && deflt.isTextblock;
}
```

Three filters:

1. **Parent must not be `inlineContent`.** Inline content already
   accepts a `TextSelection`; a gap cursor would be redundant.
2. **`closedBefore($pos)` and `closedAfter($pos)` must both be true.**
   Helpers at lines 110–141: a side is "closed" if the immediately
   adjacent node (or its first/last descendant) is a leaf,
   atomic, or `isolating` — i.e. not a textblock the caret could enter.
3. **`spec.allowGapCursor` override** — explicitly opt in or out. If
   unset, the default is "yes if the schema's default child here is a
   textblock", which captures the typical case (gap cursor between
   blocks, where typing would create a paragraph).

`needsGap(type)` (l. 106):

```
type.isAtom || type.spec.isolating || type.spec.createGapCursor
```

`createGapCursor` is a less-known schema flag (e.g. set on
`horizontal_rule` to force gap cursors before/after).

### `findGapCursorFrom($pos, dir, mustMove)` (lines 48–85)

Search algorithm to find the next valid gap cursor position from
`$pos` in direction `dir`:

```
search:
  if (!mustMove && valid($pos)) return $pos
  loop:
    // 1. Scan up to find a parent with a sibling on the requested side
    for d = depth ... 0:
       if parent has a child on that side at index/indexAfter:
         next = that child; break
       elif d == 0:
         return null            // ran out of doc
       pos += dir
       if valid(doc.resolve(pos)) return that
    // 2. Descend into 'next' to find its first/last leaf, with gap
    //    cursors checked at each level
    loop:
      inside = first/lastChild of next
      if !inside:
         if next is an atom (and not text, not selectable):
           skip past it (pos += next.nodeSize * dir) and restart search
         else
           break
      next = inside; pos += dir
      if valid(doc.resolve(pos)) return that
```

The `mustMove` flag distinguishes "find a gap cursor here, even if
that's exactly where I am" (used when the selection is non-empty
collapsed) from "I need to *move*" (arrow key on an empty cursor at
edge). The latter forces the search past the current position.

### Visual placement

```
... before a horizontal rule ...

  +----+----+
  | A  | B  |
  +----+----+      <-- Last row of a table

|<---- gap cursor lives here, between table and next paragraph
                                         (parent = doc, index points
                                          between the two blocks)

  Some paragraph text...
```

The widget decoration is rendered at `selection.head`. CSS:

```css
.ProseMirror-gapcursor {
  display: none;
  pointer-events: none;
  position: absolute;
}
.ProseMirror-gapcursor::after {
  content: "";
  display: block;
  position: absolute;
  top: -2px;
  width: 20px;
  border-top: 1px solid black;
  animation: ProseMirror-cursor-blink 1.1s steps(2, start) infinite;
}
.ProseMirror-focused .ProseMirror-gapcursor { display: block; }
```

(Rendering details from the package's `style/gapcursor.css`.) The bar
sits *above* the next block's top edge or *below* the previous block's
bottom edge depending on context.

### The plugin (`index.ts`)

```ts
export function gapCursor(): Plugin {
  return new Plugin({
    props: {
      decorations: drawGapCursor,
      createSelectionBetween(_view, $anchor, $head) {
        return $anchor.pos == $head.pos && GapCursor.valid($head)
               ? new GapCursor($head) : null;
      },
      handleClick,
      handleKeyDown,
      handleDOMEvents: { beforeinput }
    }
  });
}
```

* **`createSelectionBetween`** (l. 20) — when PM is asked for a
  selection between two equal positions and the gap cursor is valid
  there, return one. This kicks in for clicks the browser can't map
  to text positions (clicks "between" blocks).

* **`handleClick`** (l. 57) — when a click lands on a position where
  `GapCursor.valid` and the click is *not* on a `NodeSelection`-able
  node (i.e. the user wasn't trying to select an atom), set a gap
  cursor. This catches clicks in margins/gaps that the browser can't
  resolve to text.

* **`handleKeyDown`** — arrow keys at the edge of a textblock. The
  `arrow(axis, dir)` factory (l. 40):

  ```
  if selection is TextSelection:
    if !view.endOfTextblock(dir): return false      // not at edge
    $start = doc.resolve(dir > 0 ? $start.after() : $start.before())
  $found = GapCursor.findGapCursorFrom($start, dir, mustMove)
  if !$found: return false
  dispatch setSelection(new GapCursor($found))
  ```

  Defers to `view.endOfTextblock` (browser-aware visual edge check —
  chapter 17) so it works correctly with wrapped lines.

* **`beforeinput`** (l. 71) — IME composition hack. If a composition
  starts while the gap cursor is active, PM can't host the
  composition (the parent isn't inline content). The handler
  pre-emptively inserts an empty wrapping (e.g. an empty paragraph)
  at the gap, moves the selection inside, and lets composition
  continue there. Without this, the composition would be cancelled by
  the DOM selection moving.

### `Selection.jsonID('gapcursor', GapCursor)`

Registers the JSON tag. Required for:

* `EditorState.fromJSON` to round-trip a serialized state with a gap cursor;
* collab cursor packages (e.g. y-prosemirror) that ship selections over the wire.

### `GapBookmark` (lines 94–104)

```ts
class GapBookmark {
  constructor(readonly pos: number) {}
  map(mapping) { return new GapBookmark(mapping.map(this.pos)) }
  resolve(doc) {
    let $pos = doc.resolve(this.pos);
    return GapCursor.valid($pos) ? new GapCursor($pos) : Selection.near($pos);
  }
}
```

A bookmark survives across transactions; on `resolve` it falls back
to `Selection.near` if the position is no longer a valid gap.

---

## 3. Cross-link to chapter 8

The `Selection` base class has three knobs that subclasses use:

| | `TextSelection` | `NodeSelection` | `CellSelection` (24) | `GapCursor` |
| --- | --- | --- | --- | --- |
| `visible` | `true` | `false` | `false` | `false` |
| `ranges` | 1 | 1 | N (one per cell) | 1 |
| `content()` | inline slice | the node | rectangular open-1 slice | `Slice.empty` |
| `replace()` default works? | yes | yes (replaces the node) | overridden (cell-by-cell) | yes (insert at $pos) |
| `jsonID` | `'text'` | `'node'` | `'cell'` | `'gapcursor'` |

The pattern: subclass `Selection`, override `content` / `replace` /
`map` / `eq` / `toJSON` / `getBookmark`, register a `jsonID`. That's
the entire extension surface.

---

## 4. Multi-cursor: what PM does and doesn't do

### The design choice

`EditorState.selection` is a single `Selection`. Period. There is no
list, no array, no "primary + secondary" cursor. This is a deliberate
choice; the two foundational reasons are:

1. **History semantics.** Undo restores `state.selection` from a
   previous `EditorState`. With one cursor, undo is "go back in
   time". With N cursors that may have been merged, split, or
   recreated by partial edits, undo becomes a tree of branchings —
   the user has to figure out which cursor's history they're undoing.
   Sublime/VSCode answer this with strict ordering and ban-list
   heuristics; PM avoids the question entirely.

2. **Collab serialization.** A single `Selection` has a finite set of
   `jsonID`s and a clean `map(doc, mapping)` semantics. A list-typed
   selection means every collab message that reports a cursor
   position becomes a list, and rebasing N cursors over remote steps
   means N independent map calls — fine in principle, but each one
   can split or collapse (e.g. two cursors merge into one when
   surrounding text deletes the gap between them). The serialization
   format must encode "the state was N cursors but rebased into N-1"
   uniformly. PM's authors decided the complexity wasn't worth the
   feature.

### What can be simulated

You can *visually* simulate multiple cursors with `Decoration.widget`
or `Decoration.inline` — paint a fake caret at every "secondary" cursor
position. This is purely cosmetic: typing only goes to the real
selection. Most "multi-cursor" extensions in PM-based editors are
either:

* **Find-and-replace simultaneous edits**: drive a single transaction
  that performs N replaces in different positions, with the *active*
  selection at one of them and decorations marking the rest. After
  the transaction, recompute decorations.

* **Macro-style**: record a sequence of commands, then replay them
  programmatically over each "cursor" in turn. Each replay is its own
  transaction; undo collapses them via `addToHistory: false` /
  history grouping.

Neither is a true multi-cursor — neither survives an arbitrary user
keypress.

### What a real implementation would have to change

If you wanted to add real multi-cursor to PM:

1. **`Selection` becomes a list.** Either a new `MultiSelection`
   subclass that contains a `Selection[]`, or the base class grows a
   `selections: Selection[]` and the existing `anchor`/`head`/`from`/
   `to` proxy to the *primary* one.

2. **All commands fan out.** Every command in `prosemirror-commands`
   (and your custom ones) currently reads `state.selection` and
   builds a single transaction. They'd need to iterate the selection
   list, build N independent edits, and combine them into one
   transaction such that the mapping between edits is correct (each
   subsequent edit's positions are mapped through the prior edits).

3. **History coalescing.** The history plugin currently groups
   transactions by time and selection identity. Multi-cursor edits
   produce many tightly-related changes; the grouping rules need to
   know "these N transactions together form one logical edit".

4. **Collab serialization.** `Selection.jsonID` works for a single
   class; a list type needs an envelope. Acceptable, but every
   selection-aware peer (cursor sharing, presence) must update.

5. **DOM rendering.** The browser draws *one* selection. Secondary
   cursors must be widget decorations (already true today). Native
   selection ops (Shift-arrow, mouse-drag) extend the *primary*
   only — extending all cursors in lock-step requires intercepting
   keydown/mousemove and synthesising N selections.

6. **IME composition.** Compositions write to the focused selection.
   A multi-cursor composition either replicates input across all
   cursors (after composition completes) or is single-cursor only
   during composition. The former is what VSCode does and is fiddly:
   a Japanese IME inserting `あ` at four cursors must apply at each
   *after* commit; pre-commit IME state is in the DOM, not in PM.

7. **Selection geometry helpers.** `coordsAtPos`, `endOfTextblock`,
   etc. take a single position. Most callers can fan out, but
   visual-line motion (Up/Down) must compute "next visual position"
   for *each* cursor independently and merge if two converge to the
   same spot.

### Third-party references

* **y-prosemirror** (Yjs binding) sends `Selection` as `awareness`
  state — currently only one selection per peer. A peer's "remote
  cursors" are widget decorations; they're *not* multi-cursor
  semantically.
* **prosemirror-multipoint-selection** and similar (community
  projects) typically take the "decorations + scripted commands"
  approach. None I'm aware of has shipped a fully-correct
  multi-cursor with undo/collab interop.
* **CodeMirror 6** supports multi-cursor natively via `EditorSelection`
  with `ranges: SelectionRange[]` and a `mainIndex`. Worth comparing
  if you're building a code-style editor on PM — note CM6's commands
  uniformly consume the list, and its history and collab were
  designed around it from the start. PM's commands and history were
  not.

### Bottom line

The shortest accurate description is: **PM's selection model is
single-cursor by design, and adding multi-cursor is a cross-cutting
project that touches the selection model, every command, the history
plugin, and any collab/presence integration.** Decorative simulations
are cheap and often sufficient; semantic multi-cursor is a fork-level
undertaking.

---

## 5. Summary

* **Drop cursor**: a view-only plugin, paints `posAtCoords + dropPoint`
  as a 1px line. Author opt-out via `NodeSpec.disableDropCursor`.
* **Gap cursor**: a real `Selection` subclass for positions where
  `TextSelection` is illegal. Validation is parent-aware
  (`closedBefore` / `closedAfter`). `findGapCursorFrom` powers the
  arrow-key keymap. Renders as a widget decoration (CSS `::after`).
  Has a `beforeinput` shim to host IME composition.
* **Multi-cursor**: not in PM. State holds one `Selection`. You can
  decorate-paint multiple cursors but cannot make them edit
  semantically without rewriting the selection/history/collab/command
  layers.
