# 10 — Decorations

> Source: `prosemirror-view/src/decoration.ts`. Cross-references: `viewdesc.ts` (consumer), `index.ts` (`viewDecorations`).

Decorations are the **out-of-band rendering channel**: they let plugins influence how the document is drawn without modifying the document. Because they live alongside the doc rather than in it, they cost no transactions to update and are perfectly suited for ephemeral UI — selection highlights, search hits, lint underlines, collab cursors, autocomplete popovers, drag previews.

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

### 2.5 `map(mapping, doc, options?)` (`decoration.ts:334-359`, `mapInner` 345-359, `mapChildren` 568-653)

The clever bit. Each child range is checked against the `Mapping`:

1. Mark every child whose range is **touched** by any of the mapping steps. Use `-1`/`-2` sentinel codes in the children array to track "touched but maybe still alive" vs "must rebuild". Untouched children are simply shifted by the size delta. (`decoration.ts:581-599`.)
2. For touched-but-alive children, recursively `mapInner` against the new doc's child at the corresponding position. (`decoration.ts:610-633`.)
3. For children whose covering node has changed shape (`mustRebuild`), gather all their decorations and the local ones into a flat list, then `buildTree` again from scratch, splicing the rebuilt subtrees back in. (`decoration.ts:636-650`.)

Net effect: **O(touched-region)** rather than O(doc) — only the parts of the tree affected by the transaction are rebuilt.

### 2.6 `forChild(offset, node)` (`decoration.ts:431-453`)

Used by `iterDeco` and `NodeViewDesc.update` to descend. Returns the subset of decorations applicable to `node`'s **content** (not the node itself):

* The matching child subset (if any).
* Plus any local **inline** decorations clipped to the child's content range (so a decoration that touches a child's boundary still applies to the inline runs inside).

If both exist, returns a `DecorationGroup`; otherwise returns the singleton.

### 2.7 `locals(node)` and `localsInner` (`decoration.ts:472-486`)

Returns `local` decorations relevant to drawing *this* node — for a node with inline content, all locals; for a non-inline node, only widget/node decos (inline ones don't apply at this level). `removeOverlap` (`decoration.ts:748-776`) splits any partially-overlapping inline spans so the renderer only sees fully-nested ones.

### 2.8 `eq` (`decoration.ts:456-469`)

Structural — same `local` length, same children layout, recursive. Cheap when the same set is reused unchanged across transactions, because two `DecorationSet`s referring to identical persistent structure short-circuit on `this == other`.

### 2.9 `DecorationSet.empty` (`decoration.ts:489`)

Singleton for "no decorations". Used heavily as a sentinel — `forChild` returns it for leaves (`decoration.ts:433`), `add`/`remove` short-circuit on it (`decoration.ts:367, 396`), and the view's reconciler treats `empty.eq(empty)` as the trivial-true case.

---

## 3. `DecorationGroup` — combining sets

```ts
class DecorationGroup implements DecorationSource {
  constructor(readonly members: readonly DecorationSet[])
}
```
(`decoration.ts:502-566`)

When multiple plugins each contribute a `DecorationSet`, the view doesn't merge them into one — it bundles them in a group that **forwards every operation to each member** and concatenates results. This preserves each plugin's independent persistent identity (so plugin A re-running is cheap when plugin B's set is unchanged).

* `map(mapping, doc)` maps each member, returns a new group.
* `forChild(offset, child)` recurses into each, drops `empty`s, flattens nested groups.
* `locals(node)` concatenates each member's locals, then sorts and de-overlaps.
* `eq` requires same member count and pointwise equality.
* `DecorationGroup.from(members)` collapses to `empty` for length 0, the singleton for length 1, otherwise a group; flattens nested groups (`decoration.ts:552-561`).

The view assembles the group via `viewDecorations(view)` (`decoration.ts:784-793`):

```ts
view.someProp("decorations", f => { let r = f(view.state); if (r && r != empty) found.push(r) })
if (view.cursorWrapper) found.push(DecorationSet.create(doc, [view.cursorWrapper.deco]))
return DecorationGroup.from(found)
```

So decorations are gathered from every direct/state plugin's `decorations` prop in `someProp` order, plus the editor's internal mark-cursor wrapper.

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
