# ProseMirror browser input and rendering deep dive

## Why this addendum exists

The initial packet covered the architecture well, but the QA pass called out two areas that need more precision for a "full detail" research baseline:

1. **Citation reproducibility:** local line references must be tied to exact commits and package versions, not moving branches.
2. **Browser input/rendering internals:** the high-level "event -> transaction -> render" story needs the lower-level mechanics that will matter when designing Plim's browser adapter and renderer.

This addendum fills those gaps. Source references use the snapshot table in `00-source-index.md`.

## Source and version posture

ProseMirror is a package family. The packages in this research are separate repositories with separate npm versions. The local clones were checked against public GitHub mirrors, while package metadata points at the canonical `code.haverbeke.berlin` repositories.

The most important snapshot caveat is `prosemirror-view`: the researched source commit is package version `1.41.7`, while `npm view prosemirror-view version` returned `1.41.8` on 2026-05-02. The architectural claims below are about the cited source snapshot, not a claim that every line number matches the latest npm release forever.

For GitHub permalink-style verification, use full commit URLs such as:

- `https://github.com/ProseMirror/prosemirror-view/blob/ca4c78e9b56f1b164c0b3758b59d8748f11b7534/src/input.ts#L806-L827`
- `https://github.com/ProseMirror/prosemirror-view/blob/ca4c78e9b56f1b164c0b3758b59d8748f11b7534/src/domobserver.ts#L174-L250`
- `https://github.com/ProseMirror/prosemirror-view/blob/ca4c78e9b56f1b164c0b3758b59d8748f11b7534/src/viewdesc.ts#L763-L852`

## Input is not `beforeinput`-first

A tempting modern-editor design is "use `beforeinput` as the primary editing intent API." ProseMirror does **not** do that in this snapshot.

`input.ts` explicitly says support is too spotty and uses `beforeinput` only for a narrow Chrome Android backspace workaround after an uneditable node (`prosemirror-view/src/input.ts`, local lines 806-827). The handler schedules a DOM observer flush, waits 50ms, checks whether a DOM change happened, refocuses if necessary, tries the Backspace key handler, and finally falls back to deleting one character before the cursor.

That tells us ProseMirror's real input hierarchy is:

```text
keydown / keypress / composition / paste / drop / pointer events
  -> custom props and command handlers when structure must be controlled
  -> otherwise let browser mutate DOM/selection
  -> MutationObserver + selectionchange
  -> parse changed DOM range
  -> diff old model vs parsed model
  -> dispatch transaction
```

For Plim, a `beforeinput`-first design may be attractive, but it must keep a mutation/selection reconciliation fallback. Browser support, especially around IME, mobile keyboards, shadow DOM, and uneditable islands, cannot be treated as complete.

## Event handler order and ownership

`initInput(view)` registers built-in event handlers on `view.dom` (`input.ts`, local lines 46-61). Every registered event follows the same gate:

1. `eventBelongsToView(view, event)` checks that the event belongs to this editor and was not stopped by a node/widget view.
2. `runCustomHandler(view, event)` gives `handleDOMEvents` props first chance.
3. The built-in handler runs only if the editor is editable or the event is not an editing event.

The important subtlety is `eventBelongsToView`: it walks from the event target toward `view.dom` and returns false if any `pmViewDesc.stopEvent(event)` says the event should be isolated (`input.ts`, local lines 90-98). That is how custom node views and widget decorations can keep internal UI events away from the editor.

`ensureListeners(view)` also registers custom `handleDOMEvents` event types that are not part of the built-in handler map (`input.ts`, local lines 76-88). This means plugin/direct props can introduce arbitrary DOM event handling without changing ProseMirror's core event table.

Design implication for Plim: event ownership should be explicit and traceable. A better DX editor should expose "event was ignored because node view X stopped it" and "event was handled by extension Y" instead of requiring source-level debugging.

## Keyboard input path

`keydown` is mostly a control/command path, not the primary text insertion path:

- It records shift and last key information.
- It ignores events in or near composition.
- It force-flushes the DOM observer for non-IME key codes.
- It handles Android/iOS Enter hacks.
- It runs `handleKeyDown` props and `captureKeyDown`.
- If nothing handles the key, it records selection origin `"key"` and lets the browser proceed (`input.ts`, local lines 106-136).

`keypress` is a fallback for a specific case: printable input when the selection is not a same-parent `TextSelection`. In that case, ProseMirror builds a default `tr.insertText(text)` transaction, offers it to `handleTextInput`, dispatches it if unhandled, and prevents default (`input.ts`, local lines 142-160).

The normal simple typing path is therefore browser DOM mutation plus observer reconciliation, not direct transaction creation from `keydown`.

## Pointer, click, and drag input path

Mouse input starts by ending/flushing composition, classifying single/double/triple clicks by timing and proximity, and converting screen coordinates to model positions with `view.posAtCoords` (`input.ts`, local lines 278-301).

`MouseDown` stores:

- the start document, so later mouseup can tell whether state changed;
- whether the platform node-selection modifier is active;
- whether native browser selection should be allowed after pointer movement;
- potential drag data for draggable/selectable nodes;
- the DOM target/descriptor being interacted with (`input.ts`, local lines 303-358).

The class temporarily adds `draggable` or `contentEditable=false` to DOM when needed for browser drag behavior, while stopping and restarting the DOM observer around those writes (`input.ts`, local lines 346-354 and 361-369). On mouseup, it may run click handlers, select a node/atom/leaf, synthesize a nearby selection, or let the browser's default selection stand (`input.ts`, local lines 382-407).

Design implication for Plim: pointer input is not just "set selection at coordinates." It is a small state machine because native selection, drag initiation, custom node views, and browser quirks overlap.

## Composition and IME state machine

Composition is tracked in mutable `InputState`, not in `EditorState`. The fields include `composing`, `compositionNode`, `compositionNodes`, `compositionEndedAt`, `compositionID`, `compositionPendingChanges`, and `badSafariComposition` (`prosemirror-view/src/input.ts`, local lines 19-44).

On `compositionstart`/`compositionupdate`, ProseMirror:

1. Flushes DOM changes if composition was not already active.
2. Checks whether stored marks or non-inclusive marks require a cursor-wrapper path.
3. Applies Gecko and Chrome/Windows workarounds.
4. Sets `view.input.composing = true`.
5. Schedules a delayed composition end, with a long Android timeout (`input.ts`, local lines 454-492).

On `compositionend`, it:

1. Marks composing false.
2. Records the event timestamp.
3. Records whether pending mutation records should be tagged with the current `compositionID`.
4. Clears the composition node.
5. Force-flushes bad Safari compositions or schedules a microtask flush for pending records.
6. Increments `compositionID`.
7. Schedules final cleanup (`input.ts`, local lines 502-512).

Transactions built from composition-originated DOM changes get `"composition": compositionID` metadata (`domchange.ts`, local lines 81-100 and 223-240).

Design implication for Plim: composition should be an explicit browser-input state machine with phases, pending mutations, and render protection. Treating composition as a boolean will not be enough.

## DOMObserver flush mechanics

`DOMObserver` wraps `MutationObserver`, selection tracking, and old-browser fallbacks. It collects mutations into a queue and decides whether to flush immediately or soon based on browser-specific cases (`domobserver.ts`, local lines 39-80).

`flush()` is the central bridge from DOM to state (`domobserver.ts`, local lines 174-250):

1. Return early if no `docView` exists or a scheduled flush is pending.
2. Drain pending mutation records.
3. Read the DOM selection.
4. Decide whether selection changed, while respecting selection suppression and focus.
5. For editable views, call `registerMutation` for each mutation.
6. Merge returned mutation ranges into `[from, to]`.
7. Track `typeOver` and added nodes.
8. Clean up bogus browser-inserted `<br>` nodes in specific Backspace/Delete and Gecko cases.
9. If only focus reset the selection to document start, restore the state selection.
10. Otherwise mark `docView` dirty, run CSS checks, fix bad Safari composition if needed, call `handleDOMChange(from, to, typeOver, added)`, then either re-render dirty state or sync DOM selection.

The range returned by `registerMutation` is how arbitrary DOM mutations become model-position ranges. The method:

- ignores mutations inside nodes already recorded as inserted;
- finds the nearest `ViewDesc` for the mutation target;
- ignores root/editor bookkeeping attrs and mutations a descriptor says to ignore;
- for child-list changes, records added nodes, handles contentDOM/outside-content cases, and maps neighboring DOM siblings to model positions;
- for character data, records the changed text node and dirty range;
- for attributes, dirties the corresponding node range (`domobserver.ts`, local lines 252-302).

Design implication for Plim: a descriptor layer is not optional if using contenteditable. The browser reports DOM nodes and offsets; the editor needs a maintained DOM-to-model bridge to convert those into document ranges.

## DOM change parsing and diffing

`readDOMChange(view, from, to, typeOver, addedNodes)` is the reconciliation function. It has a selection-only path when `from < 0`: read `selectionFromDOM`, compare it to state, and dispatch `tr.setSelection` with `"pointer"` or `"composition"` metadata as appropriate (`domchange.ts`, local lines 81-100).

For content changes, it:

1. Resolves and expands the touched model range to a parseable parent context.
2. Calls `parseBetween(view, from, to)`.
3. Compares the old model content with the parsed DOM content via `findDiff`.
4. Handles special cases such as type-over, iOS/Android Enter, backspace delegation to key handlers, Chrome composition delete/reinsert, IE non-breaking-space behavior, Android virtual keyboard Enter suggestions, and surrogate pairs.
5. Dispatches the narrowest transaction it can: delete, add/remove mark, simple `insertText`, or generic `replace` with the parsed slice (`domchange.ts`, local lines 102-276 and 353-383).

`parseBetween` is context-aware. It asks `docView.parseRange(from, to)` for a DOM parent and offsets, passes DOM selection anchor/head as `findPositions`, uses `view.someProp("domParser") || DOMParser.fromSchema`, and parses with `topNode`, `topMatch`, `topOpen: true`, whitespace rules, `ruleFromNode`, and the resolved context (`domchange.ts`, local lines 15-56).

The crucial insight is that the live DOM is treated as a temporary witness for what the browser did. It is parsed in a narrow, schema-contextual range, diffed against the old model, and then discarded as source of truth once a transaction is accepted.

## Selection read/write internals

`selectionFromDOM(view, origin?)` reads the browser selection, maps DOM anchor/head through `docView.posFromDOM`, detects selectable atom nodes, handles multi-range selections, and calls `selectionBetween` to build a ProseMirror `Selection` (`selection.ts`, local lines 9-47 and 188-190).

`selectionToDOM(view, force?)` writes the model selection to DOM while avoiding unnecessary selection churn:

1. Sync selected-node DOM classes first.
2. Return if the editor does not own the current selection.
3. Delay selection syncing during Chrome drag selection when native selection is still in progress.
4. Disconnect selection observation.
5. Either select a cursor wrapper or call `docView.setSelection(anchor, head, view, force)`.
6. Apply the hidden-selection CSS class for invisible selections.
7. Record current selection and reconnect selection observation (`selection.ts`, local lines 55-101).

There are explicit WebKit/Chrome workarounds for selections between uneditable block nodes: ProseMirror temporarily makes nearby uneditable DOM editable, sets the selection, then restores uneditable state (`selection.ts`, local lines 103-130).

For shadow DOM on Safari, `safariShadowSelectionRange` may trigger `document.execCommand("indent")` solely to obtain a `beforeinput` target range because normal shadow-root selection access was historically broken (`domobserver.ts`, local lines 332-356). This is an example of why editor selection code must remain browser-quirk-aware even if the rest of the architecture is clean.

## Coordinate mapping

Pointer and tooltip features need model/DOM coordinate conversion. `posAtCoords` uses browser caret APIs, `elementFromPoint`, descriptor lookup, and browser-specific corrections for Safari draggable elements, Firefox offsets into inputs/images, WebKit uneditable nodes, trailing document positions, and `<br>` rounding (`domcoords.ts`, local lines 275-328).

`coordsAtPos` maps a model position back to a screen rectangle. It uses `docView.domFromPos`, text ranges, bidi-aware empty-range handling, browser-specific whitespace kludges, block-context horizontal lines, and atom node geometry (`domcoords.ts`, local lines 348-395 and below).

Design implication for Plim: coordinate mapping should be treated as part of the browser adapter, not as a trivial helper. It needs tests for bidi, atom nodes, uneditable widgets, empty blocks, and platform caret APIs.

## Rendering pipeline details

`EditorView.updateStateInner` decides whether to redraw based on plugin/node-view changes, `editable`, cursor wrappers, decorations, scroll policy, `docView.matchesNode`, and selection equality. If it needs to update selection or document DOM, it stops the DOM observer, updates/recreates `docView`, writes/syncs DOM selection, restarts the observer, updates plugin views, and handles scroll (`prosemirror-view/src/index.ts`, local lines 153-233).

The observer stop/start is not just an optimization. It prevents ProseMirror's own DOM writes from being interpreted as user input.

`NodeViewDesc.create` connects schema rendering and custom node views:

- It looks up a node view factory by node type name.
- If no custom DOM is returned, text nodes become DOM text nodes and non-text nodes use schema `toDOM` through `DOMSerializer.renderSpec`.
- Non-text nodes without `contentDOM` are made `contentEditable=false`, except `<br>`, and may be made draggable.
- Outer decorations are applied.
- It returns a custom, text, or plain node descriptor (`viewdesc.ts`, local lines 690-723).

`NodeViewDesc.parseRule` tells the live DOM parser how to treat known rendered nodes: preserve current node type/attrs, preserve whitespace for pre-like nodes, return current content for opaque nodes, point parsing at `contentDOM` when content is managed, and work around Chrome content-loss cases (`viewdesc.ts`, local lines 725-752).

## ViewDesc update and DOM patching

`updateChildren` is the core incremental rendering algorithm (`viewdesc.ts`, local lines 763-852):

1. Determine whether the node has inline content.
2. Locate active composition info if composing.
3. Create a `ViewTreeUpdater`, optionally locked to local composition DOM.
4. Iterate document children and decorations with `iterDeco`.
5. For widgets, sync mark wrappers and place/reuse widget descriptors.
6. For document children, sync mark wrappers and try:
   - exact existing node match;
   - updating the child that contains the active composition;
   - updating the next compatible node;
   - adding a new node descriptor.
7. Drop remaining descriptors.
8. Add textblock hacks for empty/trailing textblock behavior.
9. Destroy unused descriptors.
10. If changed or content-dirty, protect active composition DOM and call `renderDescs`.

`renderDescs(parentDOM, descs, view)` mutates DOM to match descriptor order. It walks expected descs against existing children, removes DOM nodes until the desired child is reached, inserts missing descriptor DOM, recurses into mark descriptors, removes trailing DOM nodes, and clears `trackWrites` when it wrote to a tracked parent (`viewdesc.ts`, local lines 1039-1058).

The update algorithm is not a generic VDOM diff. It is a descriptor-based reconciler built around ProseMirror's persistent document tree, sorted marks, decorations, and browser selection/composition constraints.

## Composition protection during rendering

When rendering during composition, `localCompositionInfo` verifies that the model selection and focused composition text node are inside the current descriptor. For inline content it searches for the text node's current text in the model fragment; for non-inline content it records an opaque composition-in-child case (`viewdesc.ts`, local lines 815-832).

`protectLocalComposition` then prevents the active composition DOM from being destroyed:

1. If the composition text node is already managed by a descriptor, leave it alone.
2. Otherwise climb to the top DOM node under `contentDOM`, removing siblings and stale descriptor expandos as needed.
3. Create a `CompositionViewDesc`.
4. Push it into `view.input.compositionNodes`.
5. Patch `this.children` so the composition descriptor occupies the corresponding text range (`viewdesc.ts`, local lines 835-852).

Design implication for Plim: the renderer must be aware of input composition. A pure "state changed, rerender subtree" strategy can break IME by deleting the browser-owned text node mid-composition.

## Decorations as persistent render inputs

Decorations are view-only values, but their implementation is model-aware:

- Widget decorations map through position maps and are dropped when their mapped position was deleted (`decoration.ts`, local lines 23-49).
- Inline decorations map both sides with inclusive flags and drop if the mapped range collapses (`decoration.ts`, local lines 51-75).
- Node decorations map start/end positions and are valid only when they still cover exactly one non-text child node (`decoration.ts`, local lines 77-103).
- `DecorationSet` is persistent and tree-shaped by document structure so drawing can efficiently compare and extract decorations for child nodes (`decoration.ts`, local lines 282-341).

Design implication for Plim: view-only annotations still need the same mapping discipline as selections. If Plim adds stable node IDs, decoration mapping can improve DX, but text-range decorations still need offset mapping.

## Clipboard and external HTML constraints

Clipboard uses the same `Slice` abstraction as selection replacement and drag/drop.

`serializeForClipboard` transforms copied slices, serializes HTML with a schema or custom serializer, writes `data-pm-slice` metadata for open depths/context, and computes plain text (`clipboard.ts`, local lines 5-40).

`parseFromClipboard` chooses a text or HTML path, runs transform hooks, parses with clipboard/dom/schema parsers, reads `data-pm-slice`, and normalizes external sibling content to fit schema context (`clipboard.ts`, local lines 42-110 and 114-190). It also has a `wrapMap` for table-related HTML elements because browser `innerHTML` parsing drops or relocates table children unless wrapped (`clipboard.ts`, local lines 191-233).

Design implication for Plim: import/export cannot be a thin `innerHTML` wrapper. Pasted HTML needs source metadata when internal and schema-context normalization when external.

## Browser constraints Plim should carry forward

The source details above suggest these concrete constraints for a ProseMirror-inspired editor:

1. Keep contenteditable as a browser input surface unless Plim is willing to reimplement selection, bidi, IME, spellcheck, autocorrect, mobile keyboard behavior, and clipboard/drop quirks.
2. Prefer typed `beforeinput` intents where reliable, but keep MutationObserver + contextual parse/diff as the correctness fallback.
3. Make browser input a first-class subsystem with explicit state machines for keyboard, pointer, clipboard, drag/drop, selection, and composition.
4. Preserve a descriptor tree that maps DOM nodes and offsets to model positions, owns render lifecycle, and mediates custom component islands.
5. Stop observing while applying editor-owned DOM writes.
6. Protect active composition DOM during rendering.
7. Make event ownership and mutation ownership traceable for extension authors.
8. Treat coordinate mapping, shadow DOM selection, uneditable nodes, bogus `<br>` nodes, and table clipboard parsing as testable browser-adapter responsibilities.
