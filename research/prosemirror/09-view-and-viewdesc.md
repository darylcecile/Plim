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

### 1.8 `view.someProp` — the canonical prop-walking primitive (`index.ts:294-314`)

Every "what should this prop return?" lookup goes through `someProp`. It is the single resolution mechanism used by the rest of the file (and by files 10, 13, 14, 15) to read props that may be supplied by *any* of three sources: the view's own `_props`, its `directPlugins`, or the plugins on `view.state.plugins`.

```ts
someProp<P>(propName, f?) {
  // 1. The view's own props
  let prop = this._props && this._props[propName], value
  if (prop != null && (value = f ? f(prop) : prop)) return value
  // 2. Direct plugins, in order
  for (let i = 0; i < this.directPlugins.length; i++) {
    let prop = this.directPlugins[i].props[propName]
    if (prop != null && (value = f ? f(prop) : prop)) return value
  }
  // 3. State plugins, in plugin order
  let plugins = this.state.plugins
  if (plugins) for (let i = 0; i < plugins.length; i++) {
    let prop = plugins[i].props[propName]
    if (prop != null && (value = f ? f(prop) : prop)) return value
  }
}
```

Two-arg form: when called with a callback `f`, `someProp` invokes `f(prop)` for each contributor in order and returns the **first truthy result** — used as a "first-handler-wins" iterator (e.g. `handleKeyDown`, where the first plugin that returns `true` consumes the event).

One-arg form: returns the first non-null prop value itself — used for unique props like `editable`, `decorations`, `attributes` where ordering still matters but the result is data, not a verdict.

Order: **view props ▸ direct plugins ▸ state plugins** — direct plugins are explicitly ordered so the host application can layer behaviour on top of plugins it doesn't own. Within plugins, ordering follows `state.plugins` (which itself preserves insertion order from `EditorState.create`).

This is the contract every other file refers to. When file 10 says "decorations from each plugin in `someProp` order", it means: walk `decorations` through this exact pipeline, ignore `null` returns, push non-empty `DecorationSet`s into a list, wrap in `DecorationGroup.from`.

### 1.9 Editable vs read-only — the `editable` prop and `view.editable` field

`view.editable` is a runtime boolean (`index.ts:100`) recomputed every update from the `editable` prop:

```ts
function getEditable(view) {
  return !view.someProp("editable", value => value(view.state) === false)  // index.ts:550-552
}
```

Note the inverted logic: the prop is `editable: (state) => boolean`. `someProp`'s callback returns `value(view.state) === false`, so the **first plugin to declare the editor read-only wins**. If no plugin sets `editable` to false, the view is editable.

The boolean is reflected into the DOM as `contenteditable="true|false"` via `computeDocDeco` (`index.ts:519`), which sets the document-level node decoration's `contenteditable` attribute. There is no separate "read-only mode" — read-only is just `editable: () => false`.

### 1.10 `view.dispatchEvent` — synthetic event injection (`index.ts:483-485`)

```ts
dispatchEvent(event: Event) { return dispatchEvent(this, event) }
```

A public method that runs an arbitrary `Event` object through the same pipeline as a real DOM event (`input.ts`'s `dispatchEvent` helper). Used for tests and for collaborative editors that want to replay key events synthetically without going through the OS keyboard layer. The event passes through `handleDOMEvents`, plugin event handlers, and ProseMirror's built-in handling exactly as if the browser had dispatched it.

### 1.11 `view.root` — shadow DOM support (`index.ts:348-358`)

```ts
get root(): Document | ShadowRoot {
  let cached = this._root
  if (cached == null) for (let search = this.dom.parentNode; search; search = search.parentNode) {
    if (search.nodeType == 9 || (search.nodeType == 11 && (search as any).host)) {
      // Patch ShadowRoot.getSelection to delegate to the owner document
      if (!(search as any).getSelection)
        Object.getPrototypeOf(search).getSelection = () => (search as DOMNode).ownerDocument!.getSelection()
      return this._root = search as Document | ShadowRoot
    }
  }
  return cached || document
}
```

Walks up `parentNode` looking for the first `Document` (`nodeType == 9`) or `ShadowRoot` (`nodeType == 11` with a `host`). Cached in `_root`; reset by `view.updateRoot()` when the view is re-parented across documents.

The patch on line 353 is critical: `ShadowRoot.getSelection` doesn't exist on most browsers, but ProseMirror's selection writer (`setSelection` below, `domSelection`, `domSelectionRange`) treats `view.root` as a `Document` and calls `getSelection()` on it. The patch installs a delegating method on the prototype so the rest of the code can stay agnostic about whether the root is a real document or a shadow root. Required for editors mounted inside web components.

### 1.12 `view.requiresGeckoHackNode` (`index.ts:59`)

A boolean flag flipped to `true` by `domobserver.ts:312` when running under Firefox if a layout test detects the "trailing space gets eaten" bug (issue #651). Read by `addTextblockHacks` (`viewdesc.ts:1376`): when set, ProseMirror inserts a trailing `<br>` even after text that ends in a space, not just text that ends in `\n`. Without it, Firefox's renderer sometimes collapses the trailing space and the cursor cannot land after it.

### 1.13 Editable vs read-only

(See §1.9.) There is no separate read-only mode — read-only is just `editable: () => false`.

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

**Why a separate `MarkViewDesc` rather than stacking marks as attributes on the inner text desc?** Three reasons:

1. Marks are renderable DOM elements (`<em>`, `<a>`, `<code>`) with their own attributes — they need real DOM nodes, not just classes on a text node.
2. A single mark spans multiple text nodes (e.g. `<em>foo<br>bar</em>` after a hard-break). The wrapper has to be reusable across updates so the `<em>` element isn't re-created when one of its children changes.
3. Marks can have user-supplied `MarkView` specs with `contentDOM` and `destroy` hooks — they are first-class views with their own lifecycle, not metadata.

`MarkViewDesc.matchesMark` is the reuse predicate (`viewdesc.ts:630`):
```ts
matchesMark(mark: Mark) { return this.dirty != NODE_DIRTY && this.mark.eq(mark) }
```
But `syncToMarks` adds an extra check (`viewdesc.ts:1205`): `marks[keep].type.spec.spanning !== false`. A mark type can opt out of spanning across child boundaries by declaring `spec.spanning = false` (built-in `code` mark uses this). The effect: when iterating consecutive children that *both* carry the same `code` mark, the existing wrapper is **not** kept across the boundary — each adjacent text run gets its own `<code>` element rather than being merged. Visually identical, but semantically two separate elements. Used when the marked element should not exceed a single inline run (e.g. typographic conventions, screen-reader hints, or to avoid splitting bugs). Cost: more DOM churn when typing inside a `code` span — but also more predictable behaviour around boundary edits.

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
destroyRest()                // throw away leftover descs (807-810)
addTextblockHacks()          // trailing <br>/<img> (807-812)
if (changed || dirty==CONTENT_DIRTY) renderDescs(contentDOM, children, view)
```

The `ViewTreeUpdater` (`viewdesc.ts:1167-1404`) walks `this.children` with an `index` pointer and a small **mark stack** (`stack`). For each new child node it picks the **first viable strategy** in order:

1. **`findNodeMatch`** (`viewdesc.ts:1242-1261`) — exact reuse. First check `preMatch` (the suffix-matching pass below); otherwise scan the next ≤5 children for a `matchesNode` hit.
2. **`updateNodeAt`** — only used when an IME composition is anchored inside a particular child; force-update that child (`viewdesc.ts:1263-1270`).
3. **`updateNextNode`** (`viewdesc.ts:1289-1325`) — try to patch the next child in place by calling its `update(node, ...)`. If `update` returns true, throw away anything skipped past. If not, try `recreateWrapper` (`viewdesc.ts:1329-1342`) which builds a new wrapper desc but moves the *children* over — useful when only outer attributes/marks change.
4. **`addNode`** (`viewdesc.ts:1345-1350`) — instantiate a new `NodeViewDesc` and splice it in.

#### `ViewTreeUpdater` housekeeping methods

* **`destroyBetween(start, end)`** (`viewdesc.ts:1184-1191`) — calls `destroy()` on every desc in the half-open range `[start, end)`, then `splice`s them out of `this.top.children`. This is the **only** path that destroys a desc during reconciliation; every "skip past N children" decision in the strategies above eventually hits this.
* **`destroyRest()`** (`viewdesc.ts:1193-1196`) — convenience wrapper: `destroyBetween(this.index, this.top.children.length)`. Called once at the end of `updateChildren` to throw away anything the new content didn't claim, and again from inside `syncToMarks` when popping mark levels (`viewdesc.ts:1209`).
* **`findIndexWithChild(domNode)`** (`viewdesc.ts:1272-1285`) — a recovery walk used when a custom NodeView has *re-parented* a DOM node out of `contentDOM` and back. Walks up `domNode.parentNode` until it finds `this.top.contentDOM`, then asks `domNode.pmViewDesc` what desc it belongs to and locates its index in `this.top.children`. Returns `-1` if the DOM has been moved entirely outside the desc tree. Currently called from `domchange.ts` to map a DOM mutation back to a desc index when the simple "matching child" lookup fails.

#### `addTextblockHacks` and `addHackNode` (`viewdesc.ts:1366-1399`)

Empty textblocks and textblocks ending in a newline or trailing whitespace need a synthetic trailing element so the browser will draw a cursor caret at the end. The hack node is a `<br class="ProseMirror-trailingBreak">` (or `<img class="ProseMirror-separator">` in some Safari/Chrome combinations).

```ts
addTextblockHacks() {
  let lastChild = this.top.children[this.index - 1], parent = this.top
  while (lastChild instanceof MarkViewDesc) { parent = lastChild; lastChild = parent.children[...] }

  if (!lastChild ||                                    // empty textblock
      !(lastChild instanceof TextViewDesc) ||
      /\n$/.test(lastChild.node.text!) ||              // trailing newline
      (this.view.requiresGeckoHackNode && /\s$/.test(lastChild.node.text!))) {
    // Safari #1165 / Chrome #1152: a trailing contenteditable=false child
    // confuses cursor / mouse selection. Add an extra IMG before the BR.
    if ((browser.safari || browser.chrome) && lastChild && (lastChild.dom).contentEditable == "false")
      this.addHackNode("IMG", parent)
    this.addHackNode("BR", this.top)
  }
}
```

Why each branch matters:

* **Empty textblock** (`!lastChild`) — `<p></p>` has no content, no caret target. The `<br>` gives the browser a place to render the cursor.
* **Trailing `\n`** — a literal `\n` in the text is rendered, but the cursor cannot land *after* it without a following element.
* **Firefox + trailing whitespace** — when `requiresGeckoHackNode` is set (detected by a layout test in `domobserver.ts:312`), Firefox eats the trailing space; the BR keeps it visible.
* **Safari/Chrome + last child is `contenteditable=false`** — both browsers misplace the cursor when you click after a `contenteditable=false` element at the end of a textblock. The IMG (a regular content node from the browser's POV) absorbs the click, and the BR after it gives the cursor a landing spot.

The `class="ProseMirror-trailingBreak"` is critical: ProseMirror's CSS sets `.ProseMirror-trailingBreak { display: none }` for the visible-text case but keeps it in the DOM for cursor purposes. Without the class, every empty paragraph would render an extra blank line. The `addHackNode` path also re-uses an existing `TrailingHackViewDesc` if one is present (`matchesHack(nodeName)`, `viewdesc.ts:1385`), so repeated updates don't churn the BR.

### 3.4 `preMatch` — suffix anchoring (`viewdesc.ts:1409-1448`)

Before starting, the updater walks **from the end** of `this.node.content` and `this.children` simultaneously, matching nodes by reference identity (`node != frag.child(fI - 1)` breaks). Any descs found are reserved (`matched: Map<ViewDesc, number>`) so the prefix walker won't accidentally consume them for an earlier mismatching node.

This is essentially the same trick React Fiber does with "two pointers" matching but specialised for ProseMirror's invariant that **document nodes are persistent values** — node identity is a perfect key.

**Why suffix-only?** Because the forward pass (`findNodeMatch` → `updateNextNode`) is greedy: when it finds a reusable match for the *first* new child, it consumes it. If three nodes were inserted at the **start** of the parent and the original three nodes are still there at the end, the greedy forward pass would match each new node to the first old node, succeed, advance, and end up destroying the surviving suffix. The suffix walk reserves the surviving tail so the forward pass *cannot* see those reserved descs as candidates for earlier positions, forcing it to fall through to `addNode` for the prefix and meet the reserved suffix at the end.

**Why reverse `matches.reverse()` on line 1447?** The suffix walk pushes matches in *reverse* document order (from the end backwards). The consumer in `findNodeMatch` (`viewdesc.ts:1245`) indexes by `index - this.preMatch.index`, which is the position **in document order**. Reversing once at the end lets the reverse-walk producer and the forward-walk consumer share the same array.

### 3.5 `syncToMarks` and the mark stack (`viewdesc.ts:1200-1238`)

Marks are **opened and closed** like XML tags. On each child the updater compares the desired mark stack (`child.marks`) with the current one:

```
keep = longest common prefix of currently-open marks and desired marks
       AND for each kept mark, mark.type.spec.spanning !== false
pop  any open marks beyond keep   (destroy/close)
push any desired marks beyond keep (create or reuse MarkViewDesc)
```

The `spec.spanning !== false` clause (`viewdesc.ts:1205`) is what lets `code` and similar marks force a fresh wrapper at every inline boundary instead of reusing one across two adjacent children.

When pushing, it scans up to `index + 3` children for a reusable `MarkViewDesc` whose `mark.eq` matches (`viewdesc.ts:1217-1228`). Locking (`isLocked`, `viewdesc.ts:1401`) prevents reusing or destroying a desc whose DOM contains the active composition.

### 3.6 `dirty` propagation and `markDirty` — the three-way decision (`viewdesc.ts:498-517`)

When a DOM mutation is observed, `domchange.ts` calls `descAt(...)` and then `markDirty(from, to)`. The method picks **one of three** outcomes per child interval:

```ts
markDirty(from, to) {
  for (let offset = 0, i = 0; i < this.children.length; i++) {
    let child = this.children[i], end = offset + child.size
    if (/* range overlaps this child */) {
      let startInside = offset + child.border, endInside = end - child.border
      if (from >= startInside && to <= endInside) {
        // (A) Range is entirely inside this child's content.
        this.dirty = (from == offset || to == end) ? CONTENT_DIRTY : CHILD_DIRTY
        if (from == startInside && to == endInside &&
            (child.contentLost || child.dom.parentNode != this.contentDOM))
          // (A1) Range covers exactly the child's interior AND child's DOM was lost
          //      → child must be fully recreated
          child.dirty = NODE_DIRTY
        else
          // (A2) Recurse: only some interior of the child is dirty
          child.markDirty(from - startInside, to - startInside)
        return
      } else {
        // (B) Range crosses the child's boundary — child can't be patched in place
        child.dirty = (child.dom == child.contentDOM &&
                       child.dom.parentNode == this.contentDOM &&
                       !child.children.length)
          ? CONTENT_DIRTY : NODE_DIRTY
      }
    }
    offset = end
  }
  // (C) No child interval matched at all → parent itself is dirty
  this.dirty = CONTENT_DIRTY
}
```

The three outcomes:

* **(A1) `child.dirty = NODE_DIRTY`** — the dirty range covers the child's full interior AND the DOM is no longer where it should be (`contentLost` or detached parent). Forces the reconciler to *destroy and recreate* the child — its DOM is unrecoverable. Triggered when a custom NodeView replaces its own DOM out from under PM, or an outer decoration's wrapper was removed.
* **(A2) recurse into child + parent gets `CHILD_DIRTY`/`CONTENT_DIRTY`** — the dirty range is interior to the child; descend and let the child decide what's dirty inside *it*. The parent only learns "one of my children is dirty" (`CHILD_DIRTY`) so the next `update` will descend rather than skip; if the dirty range touches the child's open or close token (the `from == offset || to == end` branch) parent gets `CONTENT_DIRTY` instead, which forces `updateChildren` to actually re-run rather than just match-and-skip.
* **(B) child gets `NODE_DIRTY` (or `CONTENT_DIRTY` if no children)** — the dirty range crosses a child boundary, so a single child mutation can't account for it. The child is marked `NODE_DIRTY` (rebuild). The exception: if the child has no children of its own and `dom == contentDOM`, `CONTENT_DIRTY` is enough — the child can re-derive its content without DOM rebuild.
* **(C) `this.dirty = CONTENT_DIRTY`** — the dirty range doesn't fall inside any child interval. This happens when the mutation is in the *gaps* between children (text directly inside a textblock, hack-node disturbance). Re-run the parent's `updateChildren`.

`markParentsDirty` (`viewdesc.ts:519-525`) propagates upward so the next `update` actually descends to the dirty subtree: the immediate parent gets `CONTENT_DIRTY`, ancestors above that get `CHILD_DIRTY`.

The whole point of distinguishing `CHILD_DIRTY` vs `CONTENT_DIRTY` vs `NODE_DIRTY` is: each level lets the reconciler skip more aggressively. `CHILD_DIRTY` parent can match-and-skip past clean children and only descend into dirty ones. `CONTENT_DIRTY` forces `updateChildren` to actually run. `NODE_DIRTY` means "you can't even reuse this desc — destroy it."

### 3.7 `updateNextNode`'s lock-around-text exception (`viewdesc.ts:1289-1325`)

Normally a "locked" DOM (a node that contains the active IME composition; see `isLocked`, `viewdesc.ts:1401`) cannot be reused — modifying it would interrupt composition. But there is one carefully-narrow exception (`viewdesc.ts:1301-1303`):

```ts
let locked = this.isLocked(nextDOM) &&
    !(node.isText && next.node && next.node.isText &&
      next.nodeDOM.nodeValue == node.text &&
      next.dirty != NODE_DIRTY && sameOuterDeco(outerDeco, next.outerDeco))
```

In English: the node is treated as locked **unless** all of the following hold:

1. The new node is a text node.
2. The existing desc's node is also a text node.
3. The DOM text node's value already equals the new text — i.e. the browser's typing has *already produced* the right content.
4. The desc isn't `NODE_DIRTY`.
5. Outer decorations match.

This is the IME single-character insert path. The user types `あ`; the browser inserts the character into the live text node before ProseMirror's transaction runs. By the time the reconciler arrives, the DOM already has the correct text. If we treated the locked node as un-reusable, we'd destroy the composition. Instead, we let `next.update(node, ...)` succeed with a no-op — the desc keeps the same DOM, the composition keeps its anchor, and ProseMirror's view stays consistent with state.

### 3.8 `recreateWrapper` — preconditions enumerated (`viewdesc.ts:1329-1342`)

```ts
recreateWrapper(next, node, outerDeco, innerDeco, view, pos) {
  if (next.dirty || node.isAtom || !next.children.length ||
      !next.node.content.eq(node.content) ||
      !sameOuterDeco(outerDeco, next.outerDeco) ||
      !innerDeco.eq(next.innerDeco)) return null
  let wrapper = NodeViewDesc.create(this.top, node, outerDeco, innerDeco, view, pos)
  if (wrapper.contentDOM) {
    wrapper.children = next.children
    next.children = []
    for (let ch of wrapper.children) ch.parent = wrapper
  }
  next.destroy()
  return wrapper
}
```

The wrapper-recreation path fires only when **all five** preconditions hold:

1. `!next.dirty` — the existing desc isn't already flagged for rebuild.
2. `!node.isAtom` — the new node has children (atoms can't have wrappers in the same sense).
3. `next.children.length > 0` — there are children to migrate. (No point creating a wrapper just to wrap nothing.)
4. `next.node.content.eq(node.content)` — the **content** is identical (this is the whole reason we can move children over).
5. `sameOuterDeco(outerDeco, next.outerDeco) && innerDeco.eq(next.innerDeco)` — decorations on this level haven't changed.

Together: only the *node markup* differs (type, attrs, marks). Build a fresh outer desc with the new node's DOM, transplant the children array (and re-parent), destroy the old wrapper. Children keep their identity — their DOM, their descs, any composition state inside them.

The canonical example: a `heading` whose `level` attribute changes from 1 to 2. Same content (`"Title"`), different markup (`<h1>` → `<h2>`). Without `recreateWrapper`, the entire subtree would be rebuilt — including the text desc inside, which would lose its identity. With `recreateWrapper`, only the wrapper element changes; the inner `TextViewDesc` and its `#text` DOM node carry over unchanged.

If the preconditions fail, the path returns `null` and `updateNextNode` falls through to destroying and recreating the whole subtree. Plugin authors who expect `recreateWrapper` to fire and don't see it should check preconditions 4 and 5 first — a subtle inner-decoration change is the most common reason it doesn't.

### 3.9 `protectLocalComposition` substitution mechanism (`viewdesc.ts:835-852`)

When the reconciler enters a `NodeViewDesc` that contains an active IME composition, it first calls `localCompositionInfo(view, pos)` (`viewdesc.ts:815-833`) to find the active composition text node and its position. If found, `protectLocalComposition` is called *before* `updateChildren`:

```ts
protectLocalComposition(view, {node, pos, text}) {
  if (this.getDesc(node)) return                       // already covered by a desc
  let topNode = node
  for (;; topNode = topNode.parentNode!) {              // climb to direct child of contentDOM
    if (topNode.parentNode == this.contentDOM) break
    while (topNode.previousSibling) topNode.parentNode!.removeChild(topNode.previousSibling)
    while (topNode.nextSibling) topNode.parentNode!.removeChild(topNode.nextSibling)
    if (topNode.pmViewDesc) topNode.pmViewDesc = undefined
  }
  let desc = new CompositionViewDesc(this, topNode, node, text)
  view.input.compositionNodes.push(desc)
  // KEY MOVE: substitute the composition desc into this.children at [pos, pos+text.length]
  this.children = replaceNodes(this.children, pos, pos + text.length, view, desc)
}
```

The mechanism: the live composition text node is wrapped in a synthetic `CompositionViewDesc`, which is then **spliced into `this.children`** at the position the composition occupies. When `updateChildren` runs immediately after, its `findNodeMatch` will see this synthetic desc at the expected position. Since `CompositionViewDesc.matchesNode` accepts the corresponding text node, the desc is matched-and-skipped — its DOM is *not* touched. The composition DOM (which the IME is actively writing to) is left untouched by reconciliation for the duration of the composition.

When the composition ends (`compositionend`), `clearComposition` (in `domchange.ts`) destroys all `CompositionViewDesc`s, marks their parents dirty, and the next `updateState` rebuilds them as normal `TextViewDesc`s. The composition is "absorbed" back into the desc tree.

### 3.10 Rationale: "preserve DOM as much as possible"

Multiple browser features fail if DOM nodes are recreated:

* **Selection** — collapsing/extending across a freshly-created element breaks the focus ring (`index.ts:191-192` notes the Chrome/IE/Edge bug).
* **IME composition** — a `compositionupdate` in flight against a node that's been swapped out is silently discarded; the user sees their typed text vanish. `localCompositionInfo` (`viewdesc.ts:815-833`) and `protectLocalComposition` (`viewdesc.ts:835-852`) wrap the live text node in a `CompositionViewDesc` so `updateChildren` sees it as immutable.
* **Focus** — `view.dom` keeps focus only if it (or one of its descendants that was already focused) is not removed.
* **CSS animations / scroll position** — anchored to the same DOM node.

Hence the mantra: try to **mutate** the existing DOM (text content, attributes) rather than replace it. Strictly speaking the algorithm *can* still move a children array — `recreateWrapper` (`viewdesc.ts:1336-1338`) physically transfers `next.children` to a fresh wrapper, which from a user/decorator perspective is a structural move. But the children themselves and their DOM are not recreated; only the wrapper element changes.

### 3.11 `renderDescs` (`viewdesc.ts:1039-1058`)

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

## 3a. `ViewDesc.setSelection` — the reconciler's selection writer (`viewdesc.ts:406-486`)

This is the **default selection writer** used by the view, distinct from the optional `NodeView.setSelection` hook on user-supplied node views. Whenever ProseMirror needs to translate a (PM-state) anchor/head pair into a DOM selection, `selectionToDOM` calls `docView.setSelection(anchor, head, view, force?)`. Signature:

```ts
setSelection(anchor: number, head: number, view: EditorView, force = false): void
```

The implementation walks down to the deepest desc whose interior contains the entire range, then writes to `view.root.getSelection()`. Outline (line numbers from `viewdesc.ts`):

```ts
setSelection(anchor, head, view, force) {
  // 1. Descend into the child that fully contains [from, to]
  let from = Math.min(anchor, head), to = Math.max(anchor, head)
  for (let i = 0, offset = 0; i < this.children.length; i++) {        // 409
    let child = this.children[i], end = offset + child.size
    if (from > offset && to < end)                                    // 411
      return child.setSelection(anchor - offset - child.border,
                                head - offset - child.border,
                                view, force)                          // 412
    offset = end
  }

  // 2. Resolve anchor/head to {node, offset} DOM positions
  let anchorDOM = this.domFromPos(anchor, anchor ? -1 : 1)            // 416
  let headDOM   = head == anchor ? anchorDOM : this.domFromPos(head, head ? -1 : 1)
  let domSel    = (view.root as Document).getSelection()!
  let selRange  = view.domSelectionRange()                            // 419

  // 3. brKludge: detect Firefox/Safari placement bugs around BR / contenteditable=false
  let brKludge = false
  if ((browser.gecko || browser.safari) && anchor == head) {          // 426
    let {node, offset} = anchorDOM
    if (node.nodeType == 3) {                                         // text
      brKludge = !!(offset && node.nodeValue![offset - 1] == "\n")    // 429
      // Issue #1128: cursor at end-of-text-node-before-BR fails on Firefox
      if (brKludge && offset == node.nodeValue!.length) {             // 431
        for (let scan = node, after; scan; scan = scan.parentNode) {
          if (after = scan.nextSibling) {
            if (after.nodeName == "BR")
              anchorDOM = headDOM = {node: after.parentNode!,
                                     offset: domIndex(after) + 1}     // 435 — re-anchor past the BR
            break
          }
          let desc = scan.pmViewDesc
          if (desc && desc.node && desc.node.isBlock) break
        }
      }
    } else {                                                          // element
      let prev = node.childNodes[offset - 1]
      brKludge = prev && (prev.nodeName == "BR" ||
                          (prev as HTMLElement).contentEditable == "false")
    }
  }

  // 4. Firefox-specific force flag: cursor in front of an uneditable node sometimes vanishes
  if (browser.gecko && selRange.focusNode &&
      selRange.focusNode != headDOM.node &&
      selRange.focusNode.nodeType == 1) {                             // 449
    let after = selRange.focusNode.childNodes[selRange.focusOffset]
    if (after && (after as HTMLElement).contentEditable == "false") force = true
  }

  // 5. Short-circuit: DOM selection is already correct (and we're not forcing)
  if (!(force || brKludge && browser.safari) &&
      isEquivalentPosition(anchorDOM.node, anchorDOM.offset,
                           selRange.anchorNode!, selRange.anchorOffset) &&
      isEquivalentPosition(headDOM.node, headDOM.offset,
                           selRange.focusNode!, selRange.focusOffset))
    return                                                            // 457

  // 6. Write the selection. Prefer collapse+extend for inverted-selection support.
  let domSelExtended = false
  if ((domSel.extend || anchor == head) && !(brKludge && browser.gecko)) {
    domSel.collapse(anchorDOM.node, anchorDOM.offset)                 // 464
    try {
      if (anchor != head) domSel.extend(headDOM.node, headDOM.offset) // 467
      domSelExtended = true
    } catch (_) {
      // Chrome can leave the selection empty after collapse() in some hidden-frame cases;
      // Safari can throw if the editor is hidden. Fall back to Range-based path.
    }
  }
  if (!domSelExtended) {
    if (anchor > head) [anchorDOM, headDOM] = [headDOM, anchorDOM]    // 479 — Range can't invert
    let range = document.createRange()
    range.setEnd(headDOM.node, headDOM.offset)
    range.setStart(anchorDOM.node, anchorDOM.offset)
    domSel.removeAllRanges()
    domSel.addRange(range)
  }
}
```

Walkthrough by responsibility:

* **Descent (lines 409-414).** If both endpoints fall *strictly inside* a single child (`from > offset && to < end`), recurse — child positions are translated by subtracting `offset + child.border`. This delegation lets a `MarkViewDesc` or a `CustomNodeViewDesc` with its own `setSelection` (the user-supplied hook) handle selections inside its own subtree. The recursion bottoms out at the deepest containing desc.
* **DOM resolution (lines 416-419).** `domFromPos(pos, side)` is the central pos→DOM bridge (file 17). `side` is `-1` for non-zero positions (prefer the end of the previous content, so selection is *after* preceding content) and `1` for `pos == 0` (no preceding content). For collapsed selections the same `{node, offset}` is used for both anchor and head (line 417).
* **brKludge (lines 421-446).** Two browser quirks:
  - **Firefox #1073 / Safari #1092**: collapsing the cursor immediately *after* a `<br>` doesn't always work — the cursor visually lags behind its reported position. Detected by checking if the position is at the end of a text node whose final char is `\n` (an editable line-break before a real `<br>`), or right after an element-level `<br>` / `contenteditable=false` child.
  - **Issue #1128**: when the position is at the very end of a text node followed by a `<br>` in a block, re-anchor the DOM position to `{node: after.parentNode, offset: index(after) + 1}` — i.e. *past* the `<br>` (line 435). Walks up to find the next sibling, stopping at block boundaries.
* **Firefox uneditable-neighbour kludge (lines 449-452).** When the existing focus is in front of a `contenteditable=false` element (e.g. a widget), Firefox sometimes refuses to re-anchor the selection. Force a write to override.
* **Short-circuit (lines 454-457).** If the DOM selection is already *equivalent* to where we want it (`isEquivalentPosition` accounts for text-node vs element-position aliasing), do nothing — avoids needless `selectionchange` events that would feed back into the observer.
* **Write — prefer `collapse` + `extend` (lines 463-477).** `extend` lets us write *inverted* selections (focus before anchor). Wrapped in `try/catch` because Chrome and Safari can throw in obscure hidden-frame cases.
* **Fallback — `Range` (lines 478-485).** `Range` cannot represent an inverted selection, so swap anchor/head if `anchor > head`. Use `removeAllRanges() + addRange()` so the new selection replaces any existing one cleanly.

**Why is this not just `selection.setBaseAndExtent(...)`?** That API is well-supported but doesn't handle the brKludge quirks, doesn't know about the descent rule, and would not allow recursion into `NodeView.setSelection` hooks. The split implementation is what lets custom node views override selection placement (e.g. a code-mirror node view setting its inner editor's selection) while still falling back to a working default for everything else.

Note that this method is the **default**. The third arg `view` is what user-supplied `NodeView.setSelection` hooks receive — historically the public docs called the third arg `root`, but it has always been the `EditorView`. The docs were corrected.

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
| `setSelection?(anchor, head, view, force?)` | no | Override how a selection that lands inside this node is mapped to a DOM selection. (See §3a for the default implementation.) |
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

## 6a. Worked examples — reuse paths

### 6a.1 `recreateWrapper` firing — heading level change

Initial: `doc(heading(level: 1)("Title"))`. User runs a command that produces `setBlockType(heading, {level: 2})`. After mapping the only difference is the heading's `attrs.level`.

1. `updateStateInner` → `docView.update(newDoc, ...)` → `updateChildren(view, 0)`.
2. `findNodeMatch(newH2, ...)`: the new `heading(level=2)` does **not** `eq` the old `heading(level=1)` (different attrs). No match.
3. `updateNextNode(newH2, ...)`: calls `oldH1.update(newH2, ...)`. `NodeViewDesc.update` checks `node.sameMarkup(this.node)` — same type but **different attrs** → returns `false` (sameMarkup compares attrs).
4. `updateNextNode` falls through to `recreateWrapper(oldH1, newH2, ...)`. Preconditions:
   * `!oldH1.dirty` ✓
   * `!newH2.isAtom` ✓
   * `oldH1.children.length > 0` ✓ (the text "Title")
   * `oldH1.node.content.eq(newH2.content)` ✓ (still `"Title"`)
   * outer/inner decos unchanged ✓
5. Build a fresh `NodeViewDesc` from `newH2` — produces a new `<h2>` element. Transplant `oldH1.children` (the `TextViewDesc("Title")` and its `#text` DOM node) into the new wrapper. Set their `parent` to the new wrapper.
6. Append the existing `#text "Title"` into the new `<h2>` (via `renderDescs` on the next pass).
7. Destroy `oldH1` (which now has empty children).

**Result**: the `<h1>` element is replaced by a `<h2>` element, but the inner text node is the **same DOM identity** — focus, IME state, scroll position, and any DOM-level user attachments survive.

### 6a.2 `MarkViewDesc` reuse skip with `spec.spanning = false`

Schema: `code` mark with `spec.spanning = false`. Initial doc: `p(code("foo"), code("bar"))` rendered as `<p><code>foo</code><code>bar</code></p>`. (Two separate `<code>` because spanning is off — the two adjacent code-marked text runs are kept as distinct elements.)

User types `X` between `foo` and `bar`, also marked `code`. New doc: `p(code("foo"), code("X"), code("bar"))`. Reconciler enters paragraph's `updateChildren`:

1. First child `text("foo", marks=[code])`: `syncToMarks([code], inline=true)` — current mark stack is empty, push `code`. Scan up to `index+3` for a reusable `MarkViewDesc(code)`; finds the first one. Push onto stack, descend into it. Match its `text("foo")` child (unchanged). Pop back.
2. Second child `text("X", marks=[code])`: `syncToMarks([code], ...)`. Currently there's still one `code` on the stack (or just popped). The keep-loop wants to reuse it, but the line `marks[keep].type.spec.spanning !== false` is false → break out of the keep-loop with `keep == 0`. Pop the existing `code` wrapper. Push a fresh `code` wrapper. Insert `text("X")` desc inside it.
3. Third child `text("bar", marks=[code])`: same as step 2 — pop, push fresh `code` wrapper, reuse the original `text("bar")` desc inside it.

**Result**: three separate `<code>` elements in the DOM, each with one text run. Without `spanning = false`, step 2 would have reused the first `<code>` wrapper across all three runs and produced a single `<code>foo X bar</code>`.

### 6a.3 Dirty propagation — second-level child changes

Doc: `doc(blockquote(p("alpha"), p("beta")))`. DOM mutation observed inside `<p>beta</p>` at offset 5 (the trailing `a`).

1. `descAt(domNode)` resolves to `TextViewDesc("beta")`. `markDirty` is called on its parent chain.
2. On the inner `p`, `markDirty(0, 4)` runs. The dirty range is fully inside the text child's interior (border is 0 for text). Branch (A2): recurse into the text desc. Text `markDirty` sets `dirty = NODE_DIRTY` (text descs treat any dirty as needing rebuild) and the parent `p` gets `dirty = CHILD_DIRTY`.
3. `markParentsDirty` walks up from the `p` desc:
   * Parent `blockquote` (level 1): `dirty = CONTENT_DIRTY` — re-run `updateChildren`.
   * `doc` (level 2): `dirty = CHILD_DIRTY` — descend, but skip clean children.
4. Next `updateState`:
   * `docView.update`: `dirty == CHILD_DIRTY`, run `updateChildren` (line 219 of pseudocode in §3.3 only rerenders if changed, but the descent still happens).
   * Match `blockquote` via `findNodeMatch` (its content is unchanged at this level, but its inner deco-state hasn't changed either; blockquote is `dirty = CONTENT_DIRTY` so `matchesNode` returns false). Fall to `updateNextNode` → `blockquote.update` → `updateChildren`.
   * Match first `p("alpha")` (unchanged, `dirty = NOT_DIRTY`) — `findNodeMatch` succeeds, skip.
   * Second `p`: `dirty = CHILD_DIRTY` so doesn't `eq` → fall to `updateNextNode` → `p.update` → `updateChildren`.
   * Inside `p`, the text desc has `dirty = NODE_DIRTY`. `findNodeMatch` returns false. `updateNextNode` rebuilds the text desc.

The key observation: each level only does the minimum work allowed by its `dirty` flag. The `p("alpha")` desc and its text are entirely untouched.

---

## 6b. Why-questions

### Why is `updateStateInner` synchronous and not batched?

Because the DOM selection is the user's input cursor. If the view delayed its DOM write to the next animation frame, intervening keystrokes would land in DOM positions that no longer correspond to the new state — the next `MutationObserver` flush would see "phantom" mutations and produce wrong transactions. Synchronously writing the DOM (then `domObserver.start()` again) keeps the user's typing always anchored in the latest state.

### Why does `findNodeMatch` only scan ≤5 children ahead?

Empirical heuristic (`viewdesc.ts:1249`: `Math.min(this.top.children.length, i + 5)`). Without a bound the algorithm could degrade to O(n²) in adversarial cases — e.g. a transaction that swaps the order of N children would have each new child scan the whole tail. 5 is wide enough to cover common cases (a child inserted in the middle, a swap of adjacent children, a couple of widget displacements) without giving up the O(n) bound. Beyond 5, `addNode` creates a fresh desc and the original is destroyed when the loop ends — paying for the rebuild rather than for an unbounded scan.

### Why does `preMatch.matches` get reversed (line 1447)?

The producer (the suffix walk) discovers matches in *reverse document order* (right-to-left). The consumer is `findNodeMatch` (line 1245), which is called from a forward pass with a `index` that moves left-to-right and indexes into `preMatch.matches[index - preMatch.index]` — that arithmetic only works if `matches` is in document order. One reverse at the end is cheaper than reversing the indexing math at every consumer call.

### Why does ProseMirror separate `MarkViewDesc` from the text desc rather than stacking marks as attributes?

Three reasons (covered in §2.1): real DOM elements with their own attributes (`<a href>`, `<em>`), spanning across multiple text nodes, and first-class lifecycles via `MarkView` specs. A class-on-text-node approach would not support `<a>` (which needs an actual element), would not support custom mark views with `contentDOM`, and would force every text-internal change to also invalidate the marks.

---

## 7. Cross-references

* `domobserver.ts` (file 15) for *how* DOM mutations enter the loop.
* `domchange.ts` for the parsing path that converts mutations to a transaction.
* `domcoords.ts` (file 17) for the math behind `coordsAtPos` / `posAtCoords`.
* `decoration.ts` (file 10) for the decoration set this file repeatedly references.
