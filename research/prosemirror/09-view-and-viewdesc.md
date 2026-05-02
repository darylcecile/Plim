# 09 — `EditorView` and the `ViewDesc` Tree

> Source: `prosemirror-view/src/index.ts` and `prosemirror-view/src/viewdesc.ts`. Cross‑references: `domobserver.ts` (file 15), `domchange.ts`, `domcoords.ts` (file 17), `decoration.ts` (file 10).

The `EditorView` is a thin **DOM controller** over an immutable `EditorState`. Its central responsibility is not to *be* the document, but to keep a mutable DOM tree (`view.dom`) and a parallel **view-description tree** (`view.docView`) in sync with the `state.doc`. Everything else — input, decorations, selection, plugin views — is layered on top of that loop.

---

## 1. Lifecycle of an `EditorView`

### 1.1 Constructor (`index.ts:69-93`)

```ts
new EditorView(place, props: DirectEditorProps)
```

Steps performed (in order):

1. Capture props and the initial `state` (`index.ts:70-72`). `directPlugins` are validated to ensure they have **no state component** (`checkStateComponent`, `index.ts:580`) — direct plugins may only contribute props/views, not state fields.
2. Bind `this.dispatch` so it can be passed around as a free function (`index.ts:75`).
3. Resolve the **mount point**: a DOM node, a function, an object with `mount`, or `null` (`index.ts:77-82`). When `mount` is used, the view assumes ownership of an existing element rather than appending a new `<div>`.
4. Compute `editable` from the `editable` prop (`getEditable`, `index.ts:550-552`).
5. Build the cursor wrapper (mark-cursor placeholder widget) — `updateCursorWrapper` (`index.ts:537-548`).
6. Build the **node-view registry** (`buildNodeViews`, `index.ts:559-568`) merging `nodeViews` and `markViews` props from the view, direct plugins, and state plugins via `someProp` ordering.
7. Construct the initial `docView` (top-level `NodeViewDesc`) with `docViewDesc(...)` (`index.ts:87`, `viewdesc.ts:906-912`). This walks the doc and renders DOM into `view.dom`.
8. Create the `DOMObserver` and call `start()` so all subsequent native DOM mutations are intercepted and routed through `readDOMChange` (`index.ts:89-90`, see file 15).
9. `initInput(this)` (`index.ts:91`) attaches keyboard, paste, drag, focus listeners.
10. `updatePluginViews()` (`index.ts:92, 255-273`) instantiates all plugin views (direct first, then state plugins).

### 1.2 `updateState(state)` (`index.ts:149-151`)

Forwards to `updateStateInner(state, this._props)`. This is the **fast path** when only `state` changed.

### 1.3 `update(props)` (`index.ts:125-134`)

Replaces the whole `_props`. If `handleDOMEvents` changed, re-attach DOM listeners. If `plugins` changed, re-validate. Then runs `updateStateInner`.

### 1.4 `setProps(props)` (`index.ts:139-145`)

Convenience: `Object.assign({}, view.props, props)` then `update(...)`. Used most often in controlled (React/Vue) wrappers when only some props changed.

### 1.5 `updateStateInner` — the redraw orchestrator (`index.ts:153-233`)

```
prev = this.state                          // 154
if (state.storedMarks && composing)        // stop composition first   157-160
this.state = state                         // 161
if plugins/nodeViews changed → rebuild registry, redraw flag  162-169
if plugins/handleDOMEvents changed → ensureListeners          170-172
this.editable = getEditable(this); updateCursorWrapper(this)  174-175
innerDeco = viewDecorations(this)
outerDeco = computeDocDeco(this)           // class="ProseMirror" + attributes prop
scroll mode = "reset" | "to selection" | "preserve"           178-179
updateDoc = redraw || !docView.matchesNode(state.doc, outerDeco, innerDeco)  180
updateSel = updateDoc || !selection.eq(prev.selection)        181
if updateSel:
    domObserver.stop()                     // 185 — never observe our own writes
    if updateDoc:
        if !docView.update(...) → destroy + docViewDesc(...)  200-204
    selectionToDOM() / syncNodeSelection()                    211-218
    domObserver.start()                                       219
updatePluginViews(prev)                                       222
scroll handling                                               226-232
```

Key invariant: **the `DOMObserver` is paused for the entire duration of any DOM write** (`index.ts:185, 219`). Otherwise the observer would feed the editor's own writes back through `domchange.readDOMChange` and trigger spurious transactions.

### 1.6 `view.dispatch` and `dispatchTransaction` (`index.ts:494, 510-514`)

Default implementation:

```ts
EditorView.prototype.dispatch = function(tr) {
  let dispatchTransaction = this._props.dispatchTransaction
  if (dispatchTransaction) dispatchTransaction.call(this, tr)
  else this.updateState(this.state.apply(tr))
}
```

This is the seam for **controlled editors**: a host application that owns the state (Redux, React, MobX, etc.) supplies `dispatchTransaction`, intercepts every transaction, applies it to its own store, and eventually calls `view.updateState(newState)`. Without it, the view is *self-driving*.

### 1.7 `destroy()` (`index.ts:460-473`)

* `destroyInput` (removes listeners), `destroyPluginViews`.
* If the view was mounted onto an external element (`this.mounted`), it does an empty re-render to tear down node-view DOM but leaves the container; otherwise it removes its own `<div>` from the parent.
* `docView.destroy()` cascades through every `ViewDesc` (calls every custom `NodeView.destroy` and `MarkView.destroy`).
* `docView` is set to `null`; `isDestroyed` becomes true (`index.ts:478-480`).

### 1.8 Editable vs read-only

`view.editable` is a runtime boolean, recomputed every update from the `editable` prop (`getEditable`, `index.ts:550`). It is reflected into the DOM as `contenteditable="true|false"` via the document-level node decoration produced by `computeDocDeco` (`index.ts:516-535`). There is no separate "read-only mode" — read-only is just `editable: () => false`.

---

## 2. `view.docView` and the `ViewDesc` tree

```
EditorView
  └── docView: NodeViewDesc (top-level, node = state.doc, dom = view.dom)
        ├── NodeViewDesc      (paragraph)
        │     ├── MarkViewDesc      (em)
        │     │     └── TextViewDesc  ("hello ")
        │     └── TextViewDesc        ("world")
        ├── WidgetViewDesc    (decoration widget)
        ├── NodeViewDesc      (image, leaf — no contentDOM)
        └── CustomNodeViewDesc(code_block — user-supplied NodeView)
              └── (children rendered into spec.contentDOM)
```

Each `ViewDesc` is **doubly linked** (`parent`, `children`) and pinned to its DOM via `dom.pmViewDesc = this` (`viewdesc.ts:148-151`). That expando is the entry point for every `posFromDOM` / `nearestDesc` lookup.

### 2.1 Doc ↔ docView correspondence

```
state.doc (immutable)                        view.docView (mutable mirror)
─────────────────────────────────             ──────────────────────────────
doc                                           NodeViewDesc(node=doc)
└── paragraph                                 └── NodeViewDesc(node=paragraph)
     ├── text "hi"  marks=[em]                     ├── MarkViewDesc(em)
     └── text "!"   marks=[]                       │    └── TextViewDesc("hi")
                                                   └── TextViewDesc("!")
```

Crucially, **marks become wrapper view descs** — they appear in the view tree but not in the document tree. ProseMirror always nests marks in a fixed order (per `Mark.eq`/sorting), which makes them stably matchable across updates (`viewdesc.ts:608-611`). This is why `MarkViewDesc.matchesMark` (`viewdesc.ts:630`) can be used as a reuse key.

### 2.2 Hierarchy (`viewdesc.ts`)

| Class | Defined at | Represents | Has `node`? | Has `contentDOM`? |
|---|---|---|---|---|
| `ViewDesc` (base) | 136 | abstract | optional | optional |
| `WidgetViewDesc` | 538 | `Decoration.widget` (size 0) | no | no |
| `CompositionViewDesc` | 586 | DOM subtree owned by an active IME composition | no | no |
| `MarkViewDesc` | 612 | one mark wrapper | no | yes (`= dom` if no custom mark view) |
| `NodeViewDesc` | 666 | a doc node | **yes** | yes if not leaf |
| `TextViewDesc` (extends Node) | 914 | a text node | yes (`isText`) | no (uses `nodeDOM` Text node directly) |
| `TrailingHackViewDesc` | 976 | trailing `<br>` / `<img>` to fix contentEditable bugs | no | no |
| `CustomNodeViewDesc` (extends Node) | 986 | user `NodeView` from the `nodeViews` prop | yes | yes if `spec.contentDOM` |

**Shared fields** (`viewdesc.ts:140-151`):

* `parent: ViewDesc | undefined`
* `children: ViewDesc[]`
* `dom: DOMNode` — outermost DOM node (after outer decorations are applied)
* `contentDOM: HTMLElement | null` — element into which children are rendered. `null` ⇒ leaf or atom; ProseMirror will not write here.
* `dirty: 0|1|2|3` — `NOT_DIRTY | CHILD_DIRTY | CONTENT_DIRTY | NODE_DIRTY` (`viewdesc.ts:132`).

`NodeViewDesc` adds: `node: Node`, `outerDeco: readonly Decoration[]`, `innerDeco: DecorationSource`, `nodeDOM` (the inner DOM that *is* the node, distinct from `dom` if outer decorations wrapped it).

### 2.3 Sizes and positions

* `ViewDesc.size` (base): sum of children sizes (`viewdesc.ts:170-174`). For `NodeViewDesc` it's `node.nodeSize` (`viewdesc.ts:759`), for `WidgetViewDesc` it's 0, for `TextViewDesc` it's the text length, for `CompositionViewDesc` it's `text.length` (`viewdesc.ts:591`).
* `border` is 1 for non-leaf node descs (the open/close tokens) and 0 otherwise (`viewdesc.ts:178, 761`).
* `posBefore`, `posAtStart`, `posAfter`, `posAtEnd` are computed by walking parents (`viewdesc.ts:195-209`). This is the bridge between doc positions and the view tree.

---

## 3. The reconciliation algorithm

### 3.1 Top-level decision: `NodeViewDesc.update` (`viewdesc.ts:856-869`)

```ts
update(node, outerDeco, innerDeco, view) {
  if (this.dirty == NODE_DIRTY || !node.sameMarkup(this.node)) return false
  this.updateInner(node, outerDeco, innerDeco, view)
  return true
}
```

`update` returns `false` to **signal the caller it must rebuild** (destroy this desc and create a new one). The caller is `EditorView.updateStateInner` (`index.ts:200-204`):

```ts
if (!this.docView.update(state.doc, outerDeco, innerDeco, this)) {
  this.docView.updateOuterDeco(outerDeco)
  this.docView.destroy()
  this.docView = docViewDesc(state.doc, outerDeco, innerDeco, this.dom, this)
}
```

`updateInner` (`viewdesc.ts:863-869`): patch outer decorations, swap in the new `node` reference, swap `innerDeco`, recursively reconcile children via `updateChildren`.

### 3.2 Reuse keys — *the* difference from React diff

React's diff uses positional matching plus a user-supplied `key`. ProseMirror has **type-specific reuse predicates** that look at structural identity:

| Predicate | Defined | Returns true iff |
|---|---|---|
| `matchesNode(node, outerDeco, innerDeco)` | `viewdesc.ts:754-757` | `dirty==NOT_DIRTY && node.eq(this.node) && sameOuterDeco && innerDeco.eq` |
| `matchesMark(mark)` | `viewdesc.ts:630` | `dirty != NODE_DIRTY && this.mark.eq(mark)` |
| `matchesWidget(widget)` | `viewdesc.ts:559-561` | `dirty == NOT_DIRTY && widget.type.eq(this.widget.type)` |
| `matchesHack(nodeName)` | `viewdesc.ts:978` | trailing-BR/IMG hack node still right shape |

Equality goes through `Node.eq` / `Mark.eq` / `WidgetType.eq` (which respects `spec.key`). So a node desc is **reusable iff its node, decorations, and dirty bit say it can be**, irrespective of position. This is what allows the algorithm to keep the same DOM (and therefore the same focused element / IME state) even when content moves around.

### 3.3 `updateChildren` (`viewdesc.ts:767-813`)

The heart of the reconciler:

```
inline = this.node.inlineContent
composition = view.composing ? localCompositionInfo(...) : null
updater = new ViewTreeUpdater(this, lockedNode, view)

iterDeco(this.node, this.innerDeco,
  onWidget = (widget, i, insideNode) => {
    syncToMarks(... widget.spec.marks ...)
    updater.placeWidget(widget, view, off)
  },
  onNode = (child, outerDeco, innerDeco, i) => {
    syncToMarks(child.marks)                              // 783
    if (findNodeMatch(child, ...))                        // 786 — preferred
    else if (compositionInChild && updateNodeAt(...))     // 788-791
    else if (updateNextNode(child, ...))                  // 793 — patch in place
    else updater.addNode(child, ...)                      // 797 — create fresh
  })

syncToMarks([], ...)         // unwind any open mark stack
addTextblockHacks()          // trailing <br>/<img>
destroyRest()                // throw away leftover descs
if (changed || dirty==CONTENT_DIRTY) renderDescs(contentDOM, children, view)
```

The `ViewTreeUpdater` (`viewdesc.ts:1167-1404`) walks `this.children` with an `index` pointer and a small **mark stack** (`stack`). For each new child node it picks the **first viable strategy** in order:

1. **`findNodeMatch`** (`viewdesc.ts:1242-1261`) — exact reuse. First check `preMatch` (the suffix-matching pass below); otherwise scan the next ≤5 children for a `matchesNode` hit.
2. **`updateNodeAt`** — only used when an IME composition is anchored inside a particular child; force-update that child (`viewdesc.ts:1263-1270`).
3. **`updateNextNode`** (`viewdesc.ts:1289-1325`) — try to patch the next child in place by calling its `update(node, ...)`. If `update` returns true, throw away anything skipped past. If not, try `recreateWrapper` (`viewdesc.ts:1329-1342`) which builds a new wrapper desc but moves the *children* over — useful when only outer attributes/marks change.
4. **`addNode`** (`viewdesc.ts:1345-1350`) — instantiate a new `NodeViewDesc` and splice it in.

### 3.4 `preMatch` — suffix anchoring (`viewdesc.ts:1409-1448`)

Before starting, the updater walks **from the end** of `this.node.content` and `this.children` simultaneously, matching nodes by reference identity (`node != frag.child(fI - 1)` breaks). Any descs found are reserved (`matched: Map<ViewDesc, number>`) so the prefix walker won't accidentally consume them for an earlier mismatching node.

This is essentially the same trick React Fiber does with "two pointers" matching but specialised for ProseMirror's invariant that **document nodes are persistent values** — node identity is a perfect key.

### 3.5 `syncToMarks` and the mark stack (`viewdesc.ts:1200-1238`)

Marks are **opened and closed** like XML tags. On each child the updater compares the desired mark stack (`child.marks`) with the current one:

```
keep = longest common prefix of currently-open marks and desired marks
pop  any open marks beyond keep   (destroy/close)
push any desired marks beyond keep (create or reuse MarkViewDesc)
```

When pushing, it scans up to `index + 3` children for a reusable `MarkViewDesc` whose `mark.eq` matches (`viewdesc.ts:1217-1228`). Locking (`isLocked`, `viewdesc.ts:1401`) prevents reusing or destroying a desc whose DOM contains the active composition.

### 3.6 `dirty` propagation and `markDirty`

When a DOM mutation is observed, `domchange.ts` calls `descAt(...)` and then `markDirty(from, to)` (`viewdesc.ts:498-517`):

* If the dirty range falls **entirely inside one child's content**: that child gets marked dirty recursively (`CHILD_DIRTY` on parent).
* If it crosses child boundaries: the child gets `NODE_DIRTY` (force rebuild) and parent gets `CONTENT_DIRTY` (re-run `updateChildren`).
* `markParentsDirty` (`viewdesc.ts:519-525`) propagates upward so the next `update` actually descends to the dirty subtree.

### 3.7 Rationale: "preserve DOM as much as possible"

Multiple browser features fail if DOM nodes are recreated:

* **Selection** — collapsing/extending across a freshly-created element breaks the focus ring (`index.ts:191-192` notes the Chrome/IE/Edge bug).
* **IME composition** — a `compositionupdate` in flight against a node that's been swapped out is silently discarded; the user sees their typed text vanish. `localCompositionInfo` (`viewdesc.ts:815-833`) and `protectLocalComposition` (`viewdesc.ts:835-852`) wrap the live text node in a `CompositionViewDesc` so `updateChildren` sees it as immutable.
* **Focus** — `view.dom` keeps focus only if it (or one of its descendants that was already focused) is not removed.
* **CSS animations / scroll position** — anchored to the same DOM node.

Hence the mantra: try to **mutate** the existing DOM (text content, attributes) rather than replace it.

### 3.8 `renderDescs` (`viewdesc.ts:1039-1058`)

After `updateChildren` rebuilds the desc array, this final pass syncs the actual DOM children of `contentDOM`:

```
walk descs left→right
  if desc.dom is already a child of parentDOM: remove anything before it, advance
  else: insert desc.dom at the current position
  if desc is MarkViewDesc: recurse into desc.contentDOM
remove any leftover DOM
```

This is O(n) over children and never touches a child that's already in the right place — that's what preserves selection/IME.

---

## 4. Custom `NodeView` contract (`viewdesc.ts:31-91`, `index.ts:587-588`)

Constructor signature (`NodeViewConstructor`, `index.ts:587-588`):

```ts
(node, view, getPos: () => number | undefined,
 decorations, innerDecorations) => NodeView
```

Returned `NodeView` interface fields:

| Field | Required | Meaning |
|---|---|---|
| `dom: HTMLElement` | yes | Outer DOM. The view will apply outer decorations *around* this. |
| `contentDOM?: HTMLElement \| null` | no | If present and the node isn't a leaf, ProseMirror reconciles **its own children** inside this element. If absent, the node view fully owns rendering. |
| `update?(node, decorations, innerDecorations) → boolean` | no | Decide whether to accept an incoming `node` patch. Return `true` to keep this view, `false` to force rebuild. Default: only `node.sameMarkup` matches. (`viewdesc.ts:996-1007`.) |
| `multiType?: boolean` | no | Allow `update` to be called for nodes of a *different* `node.type` (the node view handles multiple types). |
| `selectNode?()` / `deselectNode?()` | no | Visualisation for `NodeSelection`. Defaults add `ProseMirror-selectednode` class. |
| `setSelection?(anchor, head, root)` | no | Override how a selection that lands inside this node is mapped to a DOM selection. |
| `stopEvent?(event) → boolean` | no | Return true to keep ProseMirror's input handler from acting on the event. |
| `ignoreMutation?(mutation) → boolean` | no | Return true to keep the DOM observer from re-parsing on this mutation. Critical for node views with their own internal DOM that ProseMirror shouldn't re-parse. |
| `destroy?()` | no | Cleanup when removed. |

**Why `contentDOM` is special.** When present, ProseMirror calls `updateChildren` on this node view's children (the doc node's children) and writes them into `contentDOM`. The node view essentially says: *I render the node's chrome; ProseMirror, please render the body inside this hole*. Without `contentDOM`, the node is treated as opaque (atomic) — `domAtom` becomes true (`viewdesc.ts:901`) and DOM coords math will skip past it.

`CustomNodeViewDesc.update` (`viewdesc.ts:996-1007`) flow:

```
if dirty == NODE_DIRTY → rebuild
if spec.update exists and (sameType || multiType):
    let result = spec.update(node, outerDeco, innerDeco)
    if result: updateInner(...)            // continue to reconcile children inside contentDOM
    return result
else if !contentDOM && !node.isLeaf:
    return false                           // can't safely reconcile, rebuild
else:
    return super.update(...)               // default markup-equality path
```

---

## 5. DOM ↔ position bridge

These are convenience methods on the view that delegate to the view-desc tree or to `domcoords.ts` (see file 17 for the math).

| Method | Source | Delegates to |
|---|---|---|
| `view.posAtDOM(node, offset, bias?)` | `index.ts:420-424` | `docView.posFromDOM` (`viewdesc.ts:281-287`) → `localPosFromDOM` (`viewdesc.ts:211-256`) |
| `view.domAtPos(pos, side?)` | `index.ts:395-397` | `docView.domFromPos` (`viewdesc.ts:308-339`) |
| `view.nodeDOM(pos)` | `index.ts:407-410` | `docView.descAt` then `desc.nodeDOM` |
| `view.posAtCoords({left, top})` | `index.ts:373-375` | `domcoords.posAtCoords` |
| `view.coordsAtPos(pos, side?)` | `index.ts:383-385` | `domcoords.coordsAtPos` |
| `view.endOfTextblock(dir, state?)` | `index.ts:432-434` | `domcoords.endOfTextblock` |

`posFromDOM` walks **up** from a given DOM node to the first ancestor with a `pmViewDesc` and asks that desc to resolve the position. `domFromPos` walks **down** the desc tree using `child.size` running totals, then dives into the matching child.

For widgets at zero-width positions, `domFromPos` skips backwards over zero-size widgets with `side >= 0` (`viewdesc.ts:319-320`) so a cursor at the position lands *before* the widget rather than inside it.

---

## 6. Worked example — typing a character

Initial state:

```
doc = doc(p("hello"))       state.selection = TextSelection at pos 6 (end of "hello")
docView:
  NodeViewDesc(doc) [dom=view.dom, contentDOM=view.dom]
    └── NodeViewDesc(p) [dom=<p>, contentDOM=<p>]
          └── TextViewDesc("hello") [nodeDOM=#text "hello"]
```

User types `!`. The browser inserts the character; `MutationObserver` fires.

1. `DOMObserver.flush()` calls `readDOMChange(view, from, to, ...)` (file 15 / `domchange.ts`).
2. `readDOMChange` parses the changed range and produces a transaction `tr` that replaces "hello" with "hello!".
3. `view.dispatch(tr)` runs (`index.ts:510`): no `dispatchTransaction` prop, so `view.updateState(state.apply(tr))`.
4. `updateStateInner` (`index.ts:153`) computes:
   * `outerDeco` = `[Decoration.node(0, doc.size, {class: "ProseMirror", contenteditable: "true"})]`
   * `innerDeco` = (empty unless plugins contribute)
   * `updateDoc = !docView.matchesNode(newDoc, outerDeco, innerDeco)` → **true** (the text changed).
5. `domObserver.stop()` (`index.ts:185`).
6. `docView.update(newDoc, outerDeco, innerDeco, view)` (`viewdesc.ts:856`):
   * `node.sameMarkup(this.node)` ⇒ true (still a doc).
   * `updateInner` → `updateChildren(view, 0)` (`viewdesc.ts:863-869`).
7. `updateChildren` iterates the new doc's content (one paragraph). `findNodeMatch` looks for a child whose `matchesNode` is true. The new `p` is **not** `eq` to the old `p` (its text changed), so we fall through to `updateNextNode` (`viewdesc.ts:793`).
8. `updateNextNode` calls `oldP.update(newP, ...)`. `NodeViewDesc.update` accepts (same markup), `updateInner` → `updateChildren` again on the paragraph.
9. Inside the paragraph, the new text node `"hello!"` doesn't `eq` `"hello"`. `findNodeMatch` fails. `updateNextNode` calls `TextViewDesc.update` (`viewdesc.ts:926-937`): same markup, so it sets `this.nodeDOM.nodeValue = "hello!"` directly.
10. **No DOM was destroyed.** The same `<p>` and same `#text` node are still there — selection/IME survive. Only the text node's `nodeValue` was assigned.
11. `selectionToDOM(view, false)` re-syncs the DOM selection to the new state.selection (now pos 7).
12. `domObserver.start()`.

If instead the user typed inside a `<code_block>` rendered by a custom node view that returns `false` from `update`, step 8 would return false → step 6 would fall back to `destroy()` + `docViewDesc(...)` (`index.ts:200-204`) — a full rebuild.

---

## 7. Cross-references

* `domobserver.ts` (file 15) for *how* DOM mutations enter the loop.
* `domchange.ts` for the parsing path that converts mutations to a transaction.
* `domcoords.ts` (file 17) for the math behind `coordsAtPos` / `posAtCoords`.
* `decoration.ts` (file 10) for the decoration set this file repeatedly references.
