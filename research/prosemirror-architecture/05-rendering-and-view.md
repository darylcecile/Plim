# ProseMirror rendering and view internals

## Executive summary

ProseMirror rendering is not a virtual DOM framework. It is a custom mutable DOM-description tree (`ViewDesc`) that mirrors the immutable document tree plus decorations and custom node views. The view compares old state and new state, reuses matching descriptors/DOM nodes, patches changed ranges, and carefully synchronizes DOM selection.

The rendering invariant is:

```text
EditorState.doc + decorations + nodeViews + editor props
  must be represented by EditorView.dom and DOM selection,
  except during controlled browser input/composition windows.
```

For lower-level source details added after QA review, including `updateStateInner`, `NodeViewDesc.create`, `ViewTreeUpdater`, `renderDescs`, and active-composition protection, see `07-browser-input-rendering-deep-dive.md`.

## EditorView construction

`EditorView` manages the DOM structure representing an editable document (`prosemirror-view/src/index.ts`, local lines 27-30).

Constructor flow (`index.ts`, local lines 69-93):

1. Store props and initial state.
2. Build or reuse the editor DOM element.
3. Compute `editable`.
4. Build custom node view set.
5. Create root `docView` with:
   - current document;
   - outer document decorations;
   - inner view decorations;
   - root DOM;
   - view reference.
6. Create `DOMObserver`, wired to `readDOMChange`.
7. Start observer.
8. Initialize input handlers.
9. Create plugin views.

Important instance fields:

- `state`: current `EditorState`;
- `dom`: root editable element;
- `docView`: root `NodeViewDesc`;
- `domObserver`: `DOMObserver`;
- `input`: `InputState`;
- `nodeViews`: custom node view factories;
- `pluginViews`: plugin-owned view-side objects;
- `dragging`: active drag data;
- composition/cursor wrapper fields.

## Dispatch and app integration

Every internal input path dispatches transactions through `view.dispatch`.

`EditorView.dispatch` delegates to direct `dispatchTransaction` if present, otherwise applies the transaction to current state and calls `updateState` (`prosemirror-view/src/index.ts`, local lines 510-514).

Conceptually:

```ts
dispatch(tr) {
  if (this._props.dispatchTransaction) {
    this._props.dispatchTransaction.call(this, tr)
  } else {
    this.updateState(this.state.apply(tr))
  }
}
```

This is the primary integration seam for external state systems. The official view guide shows a Redux-like integration where `dispatchTransaction` sends the transaction to the app's update loop, then the app calls `view.updateState(appState.editor)` (`website/markdown/guide/view.md`, local lines 83-122).

## updateStateInner

`updateStateInner` is the central render pipeline (`prosemirror-view/src/index.ts`, local lines 153-233).

It does:

1. Compare previous state/props to new state/props.
2. Rebuild node view map if plugins or node view props changed.
3. Update event listeners if plugins/handlers changed.
4. Recompute `editable`.
5. Update cursor wrapper for stored marks.
6. Gather decorations:
   - outer document decoration;
   - inner view decorations.
7. Decide scroll behavior:
   - reset;
   - scroll to selection;
   - preserve.
8. Decide whether document DOM needs update.
9. If selection or doc changed:
   - stop `DOMObserver`;
   - optionally force selection updates for browser bugs;
   - update existing `docView`, or destroy/recreate it if update fails;
   - sync DOM selection;
   - restart observer.
10. Update plugin views.
11. Update dragged node representation if needed.
12. Perform scroll reset/scroll/preserve action.

Two details matter:

- The DOM observer is stopped while ProseMirror mutates DOM to avoid reading its own render writes as user input.
- DOM selection is updated only when needed to avoid disrupting browser hidden selection state, as the official guide notes (`website/markdown/guide/view.md`, local lines 142-148).

## ViewDesc tree

The `ViewDesc` tree is a mutable mirror of rendered document/decorations. The source comment says it forms a doubly linked mutable tree starting at `view.docView` (`prosemirror-view/src/viewdesc.ts`, local lines 130-136).

`ViewDesc` stores:

- `parent`;
- `children`;
- `dom`;
- `contentDOM`;
- dirty flag.

It sets `dom.pmViewDesc = this` on every managed DOM node (`viewdesc.ts`, local lines 140-151). This expando is crucial: DOM events and mutations can quickly find their corresponding model/view descriptor.

Important methods/properties:

- `matchesWidget`, `matchesMark`, `matchesNode`, `matchesHack`: descriptor reuse checks.
- `parseRule`: how live DOM inside this desc should be parsed.
- `stopEvent`: event isolation for custom views/widgets.
- `size`, `border`: map descriptor to model positions.
- `posBeforeChild`, `posAtStart`, `posAtEnd`: position mapping.
- `localPosFromDOM`: convert DOM node/offset to model position using child descriptors and heuristics (`viewdesc.ts`, local lines 187-256).

## NodeViewDesc

`NodeViewDesc` is the main descriptor for document nodes (`viewdesc.ts`, local lines 663-679).

### Creation

`NodeViewDesc.create` (`viewdesc.ts`, local lines 690-723):

1. Look up custom node view factory for the node type.
2. If present, call it with:
   - node;
   - view;
   - `getPos`;
   - outer decorations;
   - inner decorations.
3. If no custom DOM:
   - text nodes render as DOM text nodes;
   - other nodes render with schema `toDOM` via `DOMSerializer.renderSpec`.
4. If a non-text node has no `contentDOM`, set `contentEditable=false` unless already set, and apply `draggable` if specified.
5. Apply outer decorations.
6. Return `CustomNodeViewDesc`, `TextViewDesc`, or plain `NodeViewDesc`.

This is how schema rendering and custom node views meet.

### parseRule

When reparsing live editor DOM, `NodeViewDesc.parseRule` returns a parse rule for the current node (`viewdesc.ts`, local lines 725-752):

- Usually returns `{node: node.type.name, attrs: node.attrs}`.
- Preserves whitespace for pre/code nodes.
- If no `contentDOM`, returns current node content via `getContent`.
- If content exists, points parser at `contentDOM`.
- Handles content-lost Chrome cases.

This helps DOM-change parsing avoid treating stable rendered nodes as arbitrary external HTML.

### Updating children

`NodeViewDesc.updateChildren` synchronizes the descriptor children with document child nodes and decorations (`viewdesc.ts`, local lines 763-813):

1. Determine inline/block mode and active composition info.
2. Create a `ViewTreeUpdater`.
3. Iterate decorations and document children with `iterDeco`.
4. For each widget decoration:
   - sync mark wrappers;
   - place/reuse widget descriptor.
5. For each child node:
   - sync mark wrappers;
   - try exact existing node match;
   - try updating the child that contains active composition;
   - try updating next compatible node;
   - otherwise add a new node descriptor.
6. Drop remaining descriptors.
7. Add textblock hacks if needed.
8. Destroy unused descriptors.
9. If changed, render descriptors into `contentDOM`.
10. Apply iOS hacks if needed.

The update algorithm's goal is to preserve DOM nodes whenever model nodes/decorations still match, especially around active composition.

### Composition protection

`localCompositionInfo` and `protectLocalComposition` preserve text DOM involved in IME composition so a render update does not destroy the browser's active composition (`viewdesc.ts`, local lines 815-852).

This is one of the strongest examples of browser constraints shaping rendering architecture.

## Custom node views and mark views

Node views give extensions full control over a node's DOM. A node view object can provide:

- `dom`: outer DOM;
- `contentDOM`: child content mount managed by ProseMirror;
- `update(node, decorations, innerDecorations)`;
- `selectNode` / `deselectNode`;
- `setSelection`;
- `stopEvent`;
- `ignoreMutation`;
- `destroy`.

The source intentionally avoids subclassing as the extension API because exposing descriptor internals would be too finicky (`viewdesc.ts`, local lines 681-689).

### Node view contract

If a node view provides `contentDOM`, ProseMirror manages the children inside it. If it does not, the node is treated as opaque/uneditable content, and the node view must handle its own UI.

This is powerful for embeds, tables, images, mentions, cards, and React/Vue components. It is also dangerous:

- incorrectly handling `stopEvent` can block editor behavior;
- incorrectly handling `ignoreMutation` can desynchronize DOM/state;
- updating DOM outside ProseMirror can trigger reparsing;
- node views must be careful around selection and composition.

## Decorations

Decorations are view-only overlays and attributes. They are not part of the document.

Types (`prosemirror-view/src/decoration.ts`, local lines 23-103 and 105-242):

| Decoration | Meaning |
| --- | --- |
| Widget | Insert a DOM node at a position |
| Inline | Add attrs to inline content over a range |
| Node | Add attrs/wrapper to a specific node |

Decorations can map through document changes. Widget and node decorations can be dropped if their mapped positions are deleted; inline decorations shrink/drop if mapped to an empty range (`decoration.ts`, local lines 32-35, 58-64, and 83-89).

The official view guide recommends storing large decoration sets in plugin state and mapping them through transactions instead of recreating them on every redraw (`website/markdown/guide/view.md`, local lines 235-255).

## Props and prop resolution

`EditorView.someProp` resolves behavior from:

1. direct editor props;
2. direct plugins passed to the view;
3. plugins stored in editor state.

The official view guide explains the semantics (`website/markdown/guide/view.md`, local lines 187-198):

- first value wins for some props;
- handlers run in order until one returns true;
- aggregate props combine values for things such as attributes/decorations.

This is an important extension-ordering mechanism. It is simple but implicit.

## Selection rendering

The view keeps DOM selection synchronized with `state.selection`:

- `selectionToDOM` writes DOM selection from model selection.
- `selectionFromDOM` reads DOM selection into model selection.
- `syncNodeSelection` handles selected-node DOM affordances.
- `DOMObserver` listens to `selectionchange` and flushes differences.

`updateStateInner` avoids writing DOM selection if the browser already has the right selection, because browsers track hidden selection state such as horizontal arrow-motion goal columns (`website/markdown/guide/view.md`, local lines 142-148).

## Rendering flow examples

### Programmatic command

```text
toggleMark command
  -> dispatch tr.addMark/removeMark or stored mark update
  -> state.applyTransaction
  -> view.updateState
  -> updateStateInner
  -> docView.update/updateChildren
  -> decorations/marks/DOM patched
  -> selection sync if needed
```

### Browser text input

```text
browser mutates text DOM
  -> DOMObserver.flush
  -> readDOMChange dispatches tr.insertText
  -> state.applyTransaction
  -> updateStateInner
  -> often no DOM rewrite needed because browser already inserted text
  -> selection is reconciled
```

The official view guide explicitly notes that typed text already added by the browser may require no DOM changes when the transaction is accepted (`website/markdown/guide/view.md`, local lines 135-140).

### Plugin decoration update

```text
transaction maps plugin decoration state
  -> plugin state field returns new DecorationSet
  -> viewDecorations gathers decorations
  -> docView.matchesNode sees decoration difference
  -> affected descriptors patch attrs/widgets
```

## Rendering design lessons for Plim

1. Keep DOM rendering incremental and model-driven, but expose clearer extension diagnostics for why a node was redrawn or reused.
2. Preserve a descriptor layer. Mapping DOM nodes back to model positions is essential for mutation/selection handling.
3. Make custom component contracts explicit. Node views are powerful but too easy to misuse.
4. Treat composition as a render-protection concern, not only an input concern.
5. Keep decorations separate from document content, but make common overlays easier to author with typed APIs.
6. Make prop/plugin precedence inspectable. Developers should be able to see which extension handled an event or supplied a prop.
7. Avoid forcing UI frameworks into the core. ProseMirror's DOM layer is framework-agnostic; Plim can preserve that while offering first-class adapters.
