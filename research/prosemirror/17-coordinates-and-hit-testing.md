# 17 — Coordinates & Hit Testing

ProseMirror exposes two geometric primitives on `EditorView` —
`coordsAtPos(pos, side)` and `posAtCoords({left, top})` — and a third
keyboard-oriented predicate `endOfTextblock(dir)`. They live in
[`prosemirror-view/src/domcoords.ts`](https://github.com/ProseMirror/prosemirror-view/blob/master/src/domcoords.ts)
and are routed through `EditorView` in
[`prosemirror-view/src/index.ts`](https://github.com/ProseMirror/prosemirror-view/blob/master/src/index.ts).
Every coordinate operation is built on top of `Range.getClientRects()` /
`getBoundingClientRect()` plus `caretPositionFromPoint` /
`caretRangeFromPoint`, with browser-specific fallbacks layered on top.

This document is the reference for how PM converts between
**document position ↔ DOM node/offset ↔ viewport pixels**, plus how it
scrolls things into view.

---

## 1. The public API surface

`EditorView.coordsAtPos(pos, side = 1)`
— `index.ts:383-385`. Delegates to `coordsAtPos(this, pos, side)`
(`domcoords.ts:348`). Returns `{left, right, top, bottom}` where
`left == right` for a flat caret-style rect.

`EditorView.posAtCoords(coords)`
— `index.ts:373-375`. Delegates to `posAtCoords(this, coords)`
(`domcoords.ts:275`). Returns `{pos, inside} | null`. `inside` is the
position of the inner node the click fell inside, or `-1` at the
top level.

`EditorView.endOfTextblock(dir, state?)`
— `index.ts:432-434`. Delegates to `endOfTextblock(this, state, dir)`
(`domcoords.ts:509`). Returns `true` when motion in `dir` (one of
`"up" | "down" | "left" | "right" | "forward" | "backward"`) would
leave the current textblock.

`EditorView.domAtPos(pos, side = 0)` and `EditorView.posAtDOM(node, off, bias)`
— `index.ts:395-397`, `420-424`. Direct passthroughs to
`docView.domFromPos` / `docView.posFromDOM` in
`viewdesc.ts:281-339`. These are the underlying primitive both
coord functions stand on.

---

## 2. `coordsAtPos(pos, side)` — position → rect

Source: `domcoords.ts:348-411`.

### 2.1 Step 1: Resolve to a DOM node/offset

```ts
let {node, offset, atom} = view.docView.domFromPos(pos, side < 0 ? -1 : 1)
```
`domcoords.ts:349`. `side` is normalised: any negative number → `-1`,
`0` and positive → `1`. The `-1` bias asks `domFromPos` to prefer the
position **after** the previous content (i.e. end of the prior text node)
and `1` asks for the position **before** the next content.

`docView.domFromPos` (`viewdesc.ts:308-339`):
- If the desc has no `contentDOM` (atomic node), returns
  `{node: this.dom, offset: 0, atom: pos + 1}` — the `atom` value is
  what later branches use to detect "I’m inside an opaque leaf".
- For composite descs it walks `children`, recurses with
  `prev.domFromPos(prev.size, side)` if `side` is set and the previous
  child is a permeable wrapper (`!prev.border && !prev.domAtom`).
- Special-cased for `WidgetViewDesc` zero-width siblings: it walks back
  past zero-width widgets with `side >= 0`
  (`viewdesc.ts:319-321`).
- `TextViewDesc.domFromPos`: `{node: this.textDOM, offset: pos}` (`viewdesc.ts:598`).
- `NodeViewDesc.domFromPos` for atom: `{node: this.nodeDOM, offset: pos}` (`viewdesc.ts:945`).

### 2.2 Step 2: Text node — `Range.getClientRects()`

`domcoords.ts:351-376`. Two strategies:

**A. Empty range (preferred for bidi or end-of-text):**

```ts
let supportEmptyRange = browser.webkit || browser.gecko
if (node.nodeType == 3) {
  if (supportEmptyRange &&
      (BIDI.test(node.nodeValue) ||
       (side < 0 ? !offset : offset == node.nodeValue.length))) {
    let rect = singleRect(textRange(node, offset, offset), side)
    ...
  }
}
```

`BIDI = /[\u0590-\u05f4\u0600-\u06ff\u0700-\u08ac]/` (`domcoords.ts:344`)
covers Hebrew/Arabic/Syriac. Empty ranges return correct caret positions
inside bidi runs, so PM uses them whenever the text contains an RTL
character or when the position is at the very start/end of the text node.
Chrome doesn’t reliably support empty ranges, hence the gate on
`webkit || gecko` — Chrome (which is webkit-derived enough for
`browser.webkit` to be true via the Chromium WebKit fork detection in
`browser.ts:23`) still satisfies the `browser.webkit` predicate, but
only the gecko/safari branches actually trip the empty-range path in
practice.

**Firefox whitespace bug — `domcoords.ts:357-367`:**

> Firefox returns bad results (the position before the space) when
> querying a position directly after line-broken whitespace. Detect this
> situation and kludge around it.

```ts
if (browser.gecko && offset && /\s/.test(node.nodeValue[offset - 1]) &&
    offset < node.nodeValue.length) {
  let rectBefore = singleRect(textRange(node, offset - 1, offset - 1), -1)
  if (rectBefore.top == rect.top) {
    let rectAfter = singleRect(textRange(node, offset, offset + 1), -1)
    if (rectAfter.top != rect.top)
      return flattenV(rectAfter, rectAfter.left < rectBefore.left)
  }
}
```

If the requested caret rect lines up with the rect of the character
before (i.e. Gecko snapped to the wrong soft-wrap line), retry with the
character after to find the real visual column.

**B. Non-empty range fallback (`domcoords.ts:370-375`):**

```ts
let from = offset, to = offset, takeSide = side < 0 ? 1 : -1
if (side < 0 && !offset) { to++; takeSide = -1 }
else if (side >= 0 && offset == node.nodeValue.length) { from--; takeSide = 1 }
else if (side < 0) { from-- }
else { to++ }
return flattenV(singleRect(textRange(node, from, to), takeSide), takeSide < 0)
```

When empty ranges are unsupported (Chrome on LTR text), PM measures the
**adjacent character**’s rect and then flattens it to a vertical line
(`flattenV`, `domcoords.ts:413-417`) on the requested side.

`singleRect` (`domcoords.ts:335-342`): picks first/last `getClientRects()`
entry depending on bias and falls back to `getBoundingClientRect()` if
the rects have zero size.

### 2.3 Step 3: Block context — `flattenH`

`domcoords.ts:380-391`. If the parent isn’t inline content, return a
**horizontal** line at the top or bottom of the chosen child element:

```ts
if (!$dom.parent.inlineContent) {
  if (atom == null && offset && (side < 0 || offset == nodeSize(node))) {
    let before = node.childNodes[offset - 1]
    if (before.nodeType == 1) return flattenH(before.getBoundingClientRect(), false)
  }
  if (atom == null && offset < nodeSize(node)) {
    let after = node.childNodes[offset]
    if (after.nodeType == 1) return flattenH(after.getBoundingClientRect(), true)
  }
  return flattenH(node.getBoundingClientRect(), side >= 0)
}
```

`flattenH(rect, top)` collapses the vertical extent so `top == bottom`
(`domcoords.ts:419-423`). In a block context, `coordsAtPos` therefore
returns a horizontal sliver — useful for things like cursor placement
between two block nodes.

### 2.4 Step 4: Inline-not-text fallback

`domcoords.ts:393-410`. Triggered when the resolved DOM is an element
inside inline content (e.g. an `<img>` or a node view). PM picks the
sibling on the requested side. Special cases:

- `BR` nodes only return the rect of the line **before** them, so PM
  refuses to use a `BR` unless it is the last element in the parent
  (`domcoords.ts:399`):
  > BR nodes tend to only return the rectangle before them. Only use
  > them if they are the last element in their parent.
- Children whose viewdesc has `ignoreForCoords` are skipped:
  ```ts
  while (after.pmViewDesc && after.pmViewDesc.ignoreForCoords)
    after = after.nextSibling!
  ```
  `domcoords.ts:404`. The flag is set on `ImageViewDesc`
  (`viewdesc.ts:980`: `get ignoreForCoords() { return this.dom.nodeName == "IMG" }`)
  because measuring a wrapping image during inline-content coord lookup
  drags the cursor onto the image.

The function is **not bidi-safe** in the inline-non-text branch — the
empty-range bidi path only fires for `nodeType == 3`. The block branch
explicitly notes this (`domcoords.ts:393`):
`// Inline, not in text node (this is not Bidi-safe)`.

### 2.5 The `side` parameter

> When the position is between two things that aren’t directly
> adjacent, `side` determines which element is used. When `< 0`, the
> element before the position is used, otherwise the element after.
> — `index.ts:380-382`

Concrete effects:

| Path                      | `side < 0` behaviour                                   | `side ≥ 0` behaviour                                |
| ------------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| `domFromPos`              | bias `-1` (prefer end of prior child)                  | bias `1` (prefer start of next child)               |
| Text empty-range          | rect taken at `singleRect(..., -1)` (first rect)       | rect taken at `singleRect(..., 1)` (last rect)      |
| Text non-empty fallback   | measures `[offset-1, offset]`, flattens to right edge  | measures `[offset, offset+1]`, flattens to left edge |
| Block flatten             | `flattenH(rect, false)` → bottom edge                  | `flattenH(rect, true)` → top edge                   |
| Inline non-text           | use child at `offset - 1`                              | use child at `offset`                               |

---

## 3. `posAtCoords({left, top})` — pixel → position

Source: `domcoords.ts:275-329`.

### 3.1 Browser primitive: `caretFromPoint`

`dom.ts:145-159`:

```ts
export function caretFromPoint(doc, x, y) {
  if (doc.caretPositionFromPoint) {
    try {
      let pos = doc.caretPositionFromPoint(x, y)
      if (pos) return {node: pos.offsetNode,
                       offset: Math.min(nodeSize(pos.offsetNode), pos.offset)}
    } catch (_) {} // Firefox throws in hard-to-predict circumstances (#994)
  }
  if (doc.caretRangeFromPoint) {
    let range = doc.caretRangeFromPoint(x, y)
    if (range) return {node: range.startContainer,
                       offset: Math.min(nodeSize(range.startContainer), range.startOffset)}
  }
}
```

- Firefox / Standard: `caretPositionFromPoint` (returns `{offsetNode, offset}`).
- WebKit / Blink: `caretRangeFromPoint` (returns a `Range`).
- Both are wrapped in `Math.min(nodeSize(...), ...)` because **Chrome
  returns a text offset into `<input>` nodes** even though `<input>`
  has zero `childNodes` length, which would later confuse PM
  (`dom.ts:149-151`).
- Firefox throw is silently caught (referenced as issue #994).

### 3.2 Outer flow

```ts
export function posAtCoords(view, coords) {
  let doc = view.dom.ownerDocument, node, offset = 0
  let caret = caretFromPoint(doc, coords.left, coords.top)
  if (caret) ({node, offset} = caret)

  let elt = ((view.root as any).elementFromPoint ? view.root : doc)
              .elementFromPoint(coords.left, coords.top)
  let pos
  if (!elt || !view.dom.contains(elt.nodeType != 1 ? elt.parentNode : elt)) {
    let box = view.dom.getBoundingClientRect()
    if (!inRect(coords, box)) return null
    elt = elementFromPoint(view.dom, coords, box)
    if (!elt) return null
  }
```
`domcoords.ts:275-288`.

`view.root` is either `document` or the `ShadowRoot` containing the
editor; `(view.root as any).elementFromPoint` is preferred so that
shadow-DOM hosts hit-test internally.

### 3.3 Fallback element search — `elementFromPoint` (PM’s)

`domcoords.ts:256-272`. When the native `elementFromPoint` returns
something outside the editor (because of overlapping fixed elements,
or an iframe boundary), PM does a manual scan:

```ts
function elementFromPoint(element, coords, box) {
  let len = element.childNodes.length
  if (len && box.top < box.bottom) {
    for (let startI = Math.max(0, Math.min(len - 1,
            Math.floor(len * (coords.top - box.top) / (box.bottom - box.top)) - 2)),
         i = startI;;) {
      let child = element.childNodes[i]
      if (child.nodeType == 1) {
        let rects = (child as HTMLElement).getClientRects()
        for (let j = 0; j < rects.length; j++) {
          let rect = rects[j]
          if (inRect(coords, rect)) return elementFromPoint(child, coords, rect)
        }
      }
      if ((i = (i + 1) % len) == startI) break
    }
  }
  return element
}
```

Notes:
- It picks a **starting index** proportional to the vertical position
  inside `box` to avoid linearly scanning huge documents.
- It iterates circularly from that start through every child once.
- Recurses into the deepest element whose rect contains the coords.

### 3.4 Safari draggable kludge

`domcoords.ts:289-293`:
```ts
// Safari's caretRangeFromPoint returns nonsense when on a draggable element
if (browser.safari) {
  for (let p = elt; node && p; p = parentNode(p))
    if (p.draggable) node = undefined
}
```
If the click is anywhere inside a draggable element, throw away the
caret hint and rely on `posFromElement` (which scans children with
`findOffsetInNode`). This is the dual to the
`mightDrag`/`addAttr`/`setUneditable` dance in `input.ts:336-369`.

### 3.5 `targetKludge`

`domcoords.ts:207-212`:
```ts
function targetKludge(dom, coords) {
  let parent = dom.parentNode
  if (parent && /^li$/i.test(parent.nodeName) &&
      coords.left < dom.getBoundingClientRect().left)
    return parent
  return dom
}
```
When the user clicks **left of a list-item bullet**, browsers return
the `<p>` inside the `<li>` even though the click is over the bullet
gutter. PM walks up to the `<li>` so that the resulting `inside`
position is the list item, not its child paragraph.

### 3.6 Firefox caret normalisation patches

`domcoords.ts:296-308`:
```ts
if (browser.gecko && node.nodeType == 1) {
  // Firefox will sometimes return offsets into <input> nodes, which
  // have no actual children, from caretPositionFromPoint (#953)
  offset = Math.min(offset, node.childNodes.length)
  // It'll also move the returned position before image nodes,
  // even if those are behind it.
  if (offset < node.childNodes.length) {
    let next = node.childNodes[offset], box
    if (next.nodeName == "IMG" &&
        (box = next.getBoundingClientRect()).right <= coords.left &&
        box.bottom > coords.top)
      offset++
  }
}
```

Two Gecko bugs in one block:
1. `caretPositionFromPoint` reports text offsets into `<input>` even
   though the node has no child nodes — clamp with `Math.min`.
2. When the click is to the right of an `<img>` Gecko reports the
   position **before** the image — bump the offset by 1 if the IMG’s
   bounding rect is left of the coords.

### 3.7 WebKit uneditable-after-click fix

`domcoords.ts:310-313`:
```ts
// When clicking above the right side of an uneditable node,
// Chrome will report a cursor position after that node.
if (browser.webkit && offset && node.nodeType == 1 &&
    (prev = node.childNodes[offset - 1]).nodeType == 1 &&
    prev.contentEditable == "false" &&
    prev.getBoundingClientRect().top >= coords.top)
  offset--
```

### 3.8 End-of-document kludge

`domcoords.ts:316-318`:
```ts
// Suspiciously specific kludge to work around caret*FromPoint
// never returning a position at the end of the document
if (node == view.dom && offset == node.childNodes.length - 1 &&
    node.lastChild.nodeType == 1 &&
    coords.top > node.lastChild.getBoundingClientRect().bottom)
  pos = view.state.doc.content.size
```

### 3.9 BR avoidance

`domcoords.ts:319-323`:
```ts
// Ignore positions directly after a BR, since caret*FromPoint
// 'round up' positions that would be more accurately placed
// before the BR node.
else if (offset == 0 || node.nodeType != 1 ||
         node.childNodes[offset - 1].nodeName != "BR")
  pos = posFromCaret(view, node, offset, coords)
```

### 3.10 `posFromCaret` — verifying via block-rect walk

`domcoords.ts:223-254`. Once the browser has handed us a DOM
node/offset, the browser has aggressively snapped to the nearest inline
content. PM walks the ancestor chain to see if the click is **outside
any block** in that chain:

```ts
function posFromCaret(view, node, offset, coords) {
  let outsideBlock = -1
  for (let cur = node, sawBlock = false;;) {
    if (cur == view.dom) break
    let desc = view.docView.nearestDesc(cur, true), rect
    if (!desc) return null
    if (desc.dom.nodeType == 1 &&
        (desc.node.isBlock && desc.parent || !desc.contentDOM) &&
        ((rect = desc.dom.getBoundingClientRect()).width || rect.height)) {
      if (desc.node.isBlock && desc.parent &&
          !/^T(R|BODY|HEAD|FOOT)$/.test(desc.dom.nodeName)) {
        // Only apply the horizontal test to the innermost block.
        // Vertical for any parent.
        if (!sawBlock && rect.left > coords.left || rect.top > coords.top)
          outsideBlock = desc.posBefore
        else if (!sawBlock && rect.right < coords.left || rect.bottom < coords.top)
          outsideBlock = desc.posAfter
        sawBlock = true
      }
      if (!desc.contentDOM && outsideBlock < 0 && !desc.node.isText) {
        // If we are inside a leaf, return the side of the leaf
        // closer to the coords
        let before = desc.node.isBlock
          ? coords.top < (rect.top + rect.bottom) / 2
          : coords.left < (rect.left + rect.right) / 2
        return before ? desc.posBefore : desc.posAfter
      }
    }
    cur = desc.dom.parentNode!
  }
  return outsideBlock > -1 ? outsideBlock : view.docView.posFromDOM(node, offset, -1)
}
```

Key behaviours:
- For block descs, both the **horizontal extent of the innermost block**
  (`!sawBlock`) and the **vertical extent of every block ancestor** are
  tested, so a click far below a paragraph yields a position after the
  paragraph rather than inside it.
- `T(R|BODY|HEAD|FOOT)` is excluded because table-section block-level
  rectangles overlap and would always trip the test.
- For leaves (`!desc.contentDOM`) it uses the centre of the leaf to pick
  before/after — vertical centre for block leaves, horizontal centre
  for inline leaves.
- Falls back to `posFromDOM(node, offset, -1)` (`viewdesc.ts:281-290`)
  when the browser caret is in a normal place.

### 3.11 `posFromElement` fallback

`domcoords.ts:214-221`. Used when `caretFromPoint` returned nothing
or PM threw away the result (Safari draggable case). Calls
`findOffsetInNode` (`domcoords.ts:142-183`) to scan child rects and
recursively narrow down, then `findOffsetInText` (`domcoords.ts:185-200`)
to walk character-by-character through the text node:

```ts
function findOffsetInText(node, coords) {
  let len = node.nodeValue.length
  let range = document.createRange(), result
  for (let i = 0; i < len; i++) {
    range.setEnd(node, i + 1)
    range.setStart(node, i)
    let rect = singleRect(range, 1)
    if (rect.top == rect.bottom) continue
    if (inRect(coords, rect)) {
      result = {node, offset: i + (coords.left >= (rect.left + rect.right) / 2 ? 1 : 0)}
      break
    }
  }
  range.detach()
  return result || {node, offset: 0}
}
```

`findOffsetInNode` does the same logic across element children and
recurses; it tracks `firstBelow` so a click that falls **between lines**
gets attributed to the next line below
(`domcoords.ts:170-179`). This is the iteration-across-visible-blocks
fallback.

### 3.12 Final result — `inside`

`domcoords.ts:327-328`:
```ts
let desc = view.docView.nearestDesc(elt, true)
return {pos, inside: desc ? desc.posAtStart - desc.border : -1}
```

`inside` is consumed by mouse handling in `input.ts:290-301`, where it
is used to look up `view.state.doc.nodeAt(pos.inside)` for triple-click,
double-click, and single-click handling.

---

## 4. `endOfTextblock(dir)` — keyboard caret-edge detection

Source: `domcoords.ts:469-515`. Used by `capturekeys.ts` to decide when
keyboard motion should jump to a sibling block (`selectVertically`,
`selectHorizontally`, `stopNativeHorizontalDelete`).

### 4.1 Public entry + cache

```ts
let cachedState = null, cachedDir = null, cachedResult = false
export function endOfTextblock(view, state, dir) {
  if (cachedState == state && cachedDir == dir) return cachedResult
  cachedState = state; cachedDir = dir
  return cachedResult = dir == "up" || dir == "down"
    ? endOfTextblockVertical(view, state, dir)
    : endOfTextblockHorizontal(view, state, dir)
}
```
`domcoords.ts:506-515`. The cache is invalidated by any state change,
which covers the typical "press arrow → state changes → key released"
pattern. Because keyboard handlers (`captureKeyDown`, `selectHorizontally`,
`stopNativeHorizontalDelete`) often consult `endOfTextblock` two or
three times per keystroke, this cache matters for perf.

### 4.2 Vertical motion

`domcoords.ts:439-466`:

```ts
function endOfTextblockVertical(view, state, dir) {
  let sel = state.selection
  let $pos = dir == "up" ? sel.$from : sel.$to
  return withFlushedState(view, state, () => {
    let {node: dom} = view.docView.domFromPos($pos.pos, dir == "up" ? -1 : 1)
    for (;;) {
      let nearest = view.docView.nearestDesc(dom, true)
      if (!nearest) break
      if (nearest.node.isBlock) { dom = nearest.contentDOM || nearest.dom; break }
      dom = nearest.dom.parentNode!
    }
    let coords = coordsAtPos(view, $pos.pos, 1)
    for (let child = dom.firstChild; child; child = child.nextSibling) {
      let boxes
      if (child.nodeType == 1) boxes = child.getClientRects()
      else if (child.nodeType == 3) boxes = textRange(child, 0, child.nodeValue.length).getClientRects()
      else continue
      for (let i = 0; i < boxes.length; i++) {
        let box = boxes[i]
        if (box.bottom > box.top + 1 &&
            (dir == "up"
              ? coords.top - box.top > (box.bottom - coords.top) * 2
              : box.bottom - coords.bottom > (coords.bottom - box.top) * 2))
          return false
      }
    }
    return true
  })
}
```

The geometric test "is there any visible line *above*/*below* the
caret’s current line whose half-height-distance dominates the local
half-height" is a heuristic for "is there another line in the same
textblock that the caret could move into?". If there isn’t, motion
should leave the block.

### 4.3 Horizontal motion — the `Selection.modify` hack

`domcoords.ts:470-502`:

```ts
function endOfTextblockHorizontal(view, state, dir) {
  let {$head} = state.selection
  if (!$head.parent.isTextblock) return false
  let offset = $head.parentOffset, atStart = !offset, atEnd = offset == $head.parent.content.size
  let sel = view.domSelection()
  if (!sel) return $head.pos == $head.start() || $head.pos == $head.end()
  // If the textblock is all LTR, or the browser doesn't support
  // Selection.modify (Edge), fall back to a primitive approach
  if (!maybeRTL.test($head.parent.textContent) || !sel.modify)
    return dir == "left" || dir == "backward" ? atStart : atEnd

  return withFlushedState(view, state, () => {
    // This is a huge hack, but appears to be the best we can
    // currently do: use `Selection.modify` to move the selection by
    // one character, and see if that moves the cursor out of the
    // textblock (or doesn't move it at all, when at the start/end of
    // the document).
    let {focusNode: oldNode, focusOffset: oldOff, anchorNode, anchorOffset} = view.domSelectionRange()
    let oldBidiLevel = sel.caretBidiLevel // Only for Firefox
    sel.modify("move", dir, "character")
    let parentDOM = $head.depth ? view.docView.domAfterPos($head.before()) : view.dom
    let {focusNode: newNode, focusOffset: newOff} = view.domSelectionRange()
    let result = newNode && !parentDOM.contains(newNode.nodeType == 1 ? newNode : newNode.parentNode) ||
        (oldNode == newNode && oldOff == newOff)
    try {
      sel.collapse(anchorNode, anchorOffset)
      if (oldNode && (oldNode != anchorNode || oldOff != anchorOffset) && sel.extend)
        sel.extend(oldNode, oldOff)
    } catch (_) {}
    if (oldBidiLevel != null) sel.caretBidiLevel = oldBidiLevel
    return result
  })
}
```

Salient points:
- **LTR shortcut**: when the parent contains no character matched by
  `maybeRTL = /[\u0590-\u08ac]/` (`domcoords.ts:468`), or when
  `Selection.modify` is unavailable (legacy Edge), trust `parentOffset`
  alone. This is the "primitive approach".
- **The hack**: temporarily move the DOM selection by one character with
  `Selection.modify("move", dir, "character")`, then check whether the
  new focus is still inside the textblock’s DOM. If not (or the
  selection didn’t move at all, meaning we’re at the doc edge), the
  caret is at the edge.
- **Firefox `caretBidiLevel`**: Gecko exposes a non-standard
  `caretBidiLevel` property that determines on which side of a bidi
  boundary the caret renders. PM saves and restores it so the visual
  caret position survives the probe.
- **Selection restoration**: wrapped in `try` because `extend` can throw
  in unfocused / detached scenarios.
- `withFlushedState` (`domcoords.ts:425-435`) refocuses `view.dom` for
  the duration of the test and restores the previous active element on
  exit, so this works mid-keystroke even if state has been mutated
  between the user’s press and the probe.

### 4.4 Consumers in `capturekeys.ts`

| Site                                        | Direction args        | Purpose                                             |
| ------------------------------------------- | --------------------- | --------------------------------------------------- |
| `selectHorizontally` `capturekeys.ts:29`    | `forward` / `backward`| Detect that arrow-right would leave the textblock — if so try a node selection |
| `selectVertically` `capturekeys.ts:253`     | `up` / `down`         | Decide whether to do a node-selection jump          |
| `stopNativeHorizontalDelete` `:271`         | `forward` / `backward`| Stop the browser deleting across textblock boundary |

Note `findDirection` (`capturekeys.ts:223-242`) decides LTR vs RTL by
calling `view.coordsAtPos(pos)` and `view.coordsAtPos(pos ± 1)` and
comparing `left` values, except on Chrome and Windows where the
double-rect technique is unreliable so it falls back to the computed
CSS `direction`.

---

## 5. `withinTextNode` — not present

`grep "withinTextNode"` across `prosemirror-view/src/` returns no
matches. The closest analogues are:

- `findOffsetInText` (`domcoords.ts:185-200`): char-by-char rect search
  inside a text node.
- `textNodeBefore` / `textNodeAfter` in `dom.ts:75-105`, used by
  `setSelFocus` (`capturekeys.ts:192-221`) and
  `findCompositionNode` (`input.ts:528-545`) to find the nearest
  editable text node when the DOM selection landed on an element.
- `isOnEdge` in `dom.ts:107-116`, used by
  `selectionFromDOM` (`selection.ts:21`) to detect "cursor at the
  visible edge of a node-view container".

If our spec uses the term "withinTextNode" it should map to either
`findOffsetInText` or `textNodeBefore/textNodeAfter`.

---

## 6. RTL handling

The two RTL-aware sites are:

1. `coordsAtPos` text node, empty-range branch — gated by
   `BIDI = /[\u0590-\u05f4\u0600-\u06ff\u0700-\u08ac]/`
   (`domcoords.ts:344, :355`). Hebrew, Arabic, Syriac trigger
   empty-range queries because non-empty range rects don’t correspond
   to caret position inside bidi runs.
2. `endOfTextblockHorizontal` — gated by
   `maybeRTL = /[\u0590-\u08ac]/` (`domcoords.ts:468, :478`). When the
   parent textContent has any RTL-range character, fall back to the
   `Selection.modify` probe. Otherwise, trust `parentOffset` direction.
3. `findDirection` (`capturekeys.ts:223-242`) — geometric LTR/RTL
   detection by comparing rects of adjacent positions, used by left/right
   arrow handling (`capturekeys.ts:330-335`).
4. The block-context `coordsAtPos` branch (`domcoords.ts:393-410`) is
   explicitly **not bidi-safe**, per the source comment — there is no
   plan to fix it because it’s only reached for inline-non-text
   positions, where the rect is the element rect itself.

The non-bidi `coordsAtPos` text fallback (`domcoords.ts:370-375`) uses
`flattenV(rect, takeSide < 0)`. Within a bidi run that path could lie,
which is exactly why the empty-range branch tries to engage in any
RTL-containing string.

---

## 7. Scrolling

### 7.1 `tr.scrollIntoView()` propagation

ProseMirror state transactions carry a `scrollIntoView` flag. The view
respects three scroll modes from `updateState`/`updateStateInner`:

```ts
if (scroll == "reset") {
  this.dom.scrollTop = 0
} else if (scroll == "to selection") {
  this.scrollToSelection()
} else if (oldScrollPos) {
  resetScrollPos(oldScrollPos)
}
```
`index.ts:226-232`. The `scroll` value is computed from
`tr.scrolledIntoView` upstream in `dispatchTransaction`.

`scrollToSelection` (`index.ts:236-248`):

```ts
scrollToSelection() {
  let startDOM = this.domSelectionRange().focusNode
  if (!startDOM || !this.dom.contains(startDOM.nodeType == 1 ? startDOM : startDOM.parentNode)) {
    // Ignore selections outside the editor
  } else if (this.someProp("handleScrollToSelection", f => f(this))) {
    // Handled
  } else if (this.state.selection instanceof NodeSelection) {
    let target = this.docView.domAfterPos(this.state.selection.from)
    if (target.nodeType == 1) scrollRectIntoView(this, target.getBoundingClientRect(), startDOM)
  } else {
    scrollRectIntoView(this, this.coordsAtPos(this.state.selection.head, 1), startDOM)
  }
}
```

So the public surface is:
- `tr.scrollIntoView()` (set by capture keys, paste, cut, etc.)
- `handleScrollToSelection` prop (custom override)
- `scrollMargin` / `scrollThreshold` props (geometric tuning)

Sites that call `.scrollIntoView()` on transactions:
- `capturekeys.ts:15` (`apply`)
- `domchange.ts:95, :240` (key-origin selection updates, dispatched changes)
- `input.ts:155` (text input default)
- `input.ts:611` (cut)
- `input.ts:643` (paste)
- `input.ts:824` (Android backspace fallback)

### 7.2 `scrollRectIntoView`

`domcoords.ts:32-67`:

```ts
export function scrollRectIntoView(view, rect, startDOM) {
  let scrollThreshold = view.someProp("scrollThreshold") || 0
  let scrollMargin   = view.someProp("scrollMargin")    || 5
  let doc = view.dom.ownerDocument
  for (let parent = startDOM || view.dom;;) {
    if (!parent) break
    if (parent.nodeType != 1) { parent = parentNode(parent); continue }
    let elt = parent
    let atTop = elt == doc.body
    let bounding = atTop ? windowRect(doc) : clientRect(elt)
    let moveX = 0, moveY = 0
    if (rect.top < bounding.top + getSide(scrollThreshold, "top"))
      moveY = -(bounding.top - rect.top + getSide(scrollMargin, "top"))
    else if (rect.bottom > bounding.bottom - getSide(scrollThreshold, "bottom"))
      moveY = rect.bottom - rect.top > bounding.bottom - bounding.top
        ? rect.top + getSide(scrollMargin, "top") - bounding.top
        : rect.bottom - bounding.bottom + getSide(scrollMargin, "bottom")
    if (rect.left < bounding.left + getSide(scrollThreshold, "left"))
      moveX = -(bounding.left - rect.left + getSide(scrollMargin, "left"))
    else if (rect.right > bounding.right - getSide(scrollThreshold, "right"))
      moveX = rect.right - bounding.right + getSide(scrollMargin, "right")
    if (moveX || moveY) {
      if (atTop) doc.defaultView.scrollBy(moveX, moveY)
      else {
        let startX = elt.scrollLeft, startY = elt.scrollTop
        if (moveY) elt.scrollTop  += moveY
        if (moveX) elt.scrollLeft += moveX
        let dX = elt.scrollLeft - startX, dY = elt.scrollTop - startY
        rect = {left: rect.left - dX, top: rect.top - dY,
                right: rect.right - dX, bottom: rect.bottom - dY}
      }
    }
    let pos = atTop ? "fixed" : getComputedStyle(parent).position
    if (/^(fixed|sticky)$/.test(pos)) break
    parent = pos == "absolute" ? parent.offsetParent : parentNode(parent)
  }
}
```

Walks **every scroll container** from the selected DOM upward through
ancestors, scrolling each the minimum amount required to bring the rect
into view (after subtracting the threshold and adding the margin).
Uses `visualViewport` (`windowRect`, `domcoords.ts:8-16`) when
available for the document viewport so virtual-keyboard-occluded
regions are respected on mobile.

Subtleties:
- `clientRect` (`domcoords.ts:22-30`) handles `transform: scale()`
  parents by computing `scaleX/scaleY = rect.width/offsetWidth` and
  uses `clientWidth * scale` to exclude scrollbar gutter.
- Stops at `position: fixed` or `position: sticky` ancestors so we
  don’t scroll the wrong outer container.
- Crosses `position: absolute` boundaries via `offsetParent`, otherwise
  `parentNode` (which honours shadow-DOM via `parentNode` in
  `dom.ts:15-18`).

### 7.3 Props

`index.ts:792-799`:

```ts
/// Determines the distance (in pixels) between the cursor and the
/// end of the visible viewport at which point, when scrolling the
/// cursor into view, scrolling takes place. Defaults to 0.
scrollThreshold?: number | {top, right, bottom, left}

/// Determines the extra space (in pixels) that is left above or
/// below the cursor when it is scrolled into view. Defaults to 5.
scrollMargin?: number | {top, right, bottom, left}
```

Both props are read via `view.someProp(...)` which collates plugin
contributions and direct props.

### 7.4 `storeScrollPos` / `resetScrollPos` — preserve mode

`domcoords.ts:73-120`. When state updates without a
`scrollIntoView` flag and `dom.style.overflowAnchor == null`, PM
captures the scroll positions of every ancestor scroll container plus
a reference DOM node near the top of the editor, then restores them
after the update so visible content doesn’t jump:

```ts
let oldScrollPos = scroll == "preserve" && updateSel &&
                   this.dom.style.overflowAnchor == null && storeScrollPos(this)
...
} else if (oldScrollPos) {
  resetScrollPos(oldScrollPos)
}
```
`index.ts:182, :230`.

The reference node is found by
`view.root.elementFromPoint(x, y)` walking down 5px steps from the top
of the editor (`domcoords.ts:78-91`).

### 7.5 `focusPreventScroll`

`domcoords.ts:122-140`. Feature-detects `dom.focus({preventScroll})` by
defining a getter on the options object that flips
`preventScrollSupported` when the browser reads it. On IE it uses the
non-standard `setActive()`. On no-support browsers it falls back to
restoring scroll state via `restoreScrollStack`. This is what `view.focus()`
calls (`index.ts:339`) so focusing the editor never moves the page.

---

## 8. Reference table

| Concept                          | File:Line                                         |
| -------------------------------- | ------------------------------------------------- |
| `coordsAtPos`                    | `domcoords.ts:348-411`                            |
| `posAtCoords`                    | `domcoords.ts:275-329`                            |
| `posFromCaret`                   | `domcoords.ts:223-254`                            |
| `posFromElement`                 | `domcoords.ts:214-221`                            |
| `findOffsetInNode`               | `domcoords.ts:142-183`                            |
| `findOffsetInText`               | `domcoords.ts:185-200`                            |
| `targetKludge`                   | `domcoords.ts:207-212`                            |
| `elementFromPoint` (PM)          | `domcoords.ts:256-272`                            |
| `endOfTextblock`                 | `domcoords.ts:506-515`                            |
| `endOfTextblockVertical`         | `domcoords.ts:439-466`                            |
| `endOfTextblockHorizontal`       | `domcoords.ts:470-502`                            |
| `withFlushedState`               | `domcoords.ts:425-435`                            |
| `singleRect`, `flattenV/H`       | `domcoords.ts:335-342, 413-423`                   |
| `scrollRectIntoView`             | `domcoords.ts:32-67`                              |
| `storeScrollPos`/`resetScrollPos`| `domcoords.ts:73-120`                             |
| `focusPreventScroll`             | `domcoords.ts:122-140`                            |
| `caretFromPoint`                 | `dom.ts:145-159`                                  |
| `domFromPos` (composite)         | `viewdesc.ts:308-339`                             |
| `domFromPos` (text/atom)         | `viewdesc.ts:598-600, 945-947`                    |
| `posFromDOM`                     | `viewdesc.ts:281-290`                             |
| `ignoreForCoords`                | `viewdesc.ts:529, 980`                            |
| Scroll prop declarations         | `index.ts:792-799`                                |
| `scrollToSelection`              | `index.ts:236-248`                                |
| Public coord methods             | `index.ts:373-434`                                |
| `tr.scrollIntoView` callers      | `capturekeys.ts:15`, `domchange.ts:95, 240`, `input.ts:155, 611, 643, 824` |
| `endOfTextblock` callers         | `capturekeys.ts:29, 253, 271`, `index.ts:432`     |
| `posAtCoords` callers            | `input.ts:290, 381, 687, 730`                     |
| RTL detection sites              | `domcoords.ts:344, 468`, `capturekeys.ts:223-242` |
