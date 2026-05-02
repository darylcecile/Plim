# ProseMirror input processing and browser constraints

## Executive summary

ProseMirror does not try to fully replace the browser's editing engine. Instead, it uses contenteditable as an input surface, lets the browser handle many difficult native behaviors, and then translates DOM/selection changes back into model transactions.

The key input principle is:

```text
If the browser is better at the interaction, let it happen in DOM,
then observe/reparse/diff the changed range and convert it to a transaction.
If ProseMirror must preserve structure, intercept with a command/handler.
```

This is why `prosemirror-view` is full of browser-specific code. Contenteditable is inconsistent, especially for IME, mobile keyboards, selection, deletions around uneditable nodes, tables/lists, clipboard HTML, and bogus `<br>` behavior.

For lower-level source details added after QA review, including why this snapshot is not `beforeinput`-first, how `DOMObserver.flush` maps mutations to model ranges, and how selection/coordinate mapping handles browser quirks, see `07-browser-input-rendering-deep-dive.md`.

## Event and input state

`EditorView` owns an `InputState` instance (`prosemirror-view/src/index.ts`, local line 51). `InputState` tracks transient browser interaction state (`prosemirror-view/src/input.ts`, local lines 19-44):

- shift state;
- active mouse down and last click timing/proximity;
- last key code/time;
- last selection origin/time;
- iOS Enter tracking;
- focus/touch timestamps;
- Chrome delete/composition tracking;
- composition state and composition node;
- composition ID/pending changes;
- DOM change count;
- registered event handlers.

This state is intentionally not part of `EditorState`. It is view-local, browser-local, and mutable.

## Event handler registration

`initInput(view)` installs handlers on `view.dom` (`input.ts`, local lines 46-61). Each event goes through:

1. `eventBelongsToView(view, event)`: ignore events outside the view or stopped by node views.
2. `runCustomHandler(view, event)`: direct/plugin `handleDOMEvents` handlers get first chance.
3. Built-in handler if the event is allowed and the editor is editable for edit handlers.

`ensureListeners` also registers custom `handleDOMEvents` that were not in the built-in handler map (`input.ts`, local lines 76-88).

The event maps are split conceptually:

- `handlers`: general events;
- `editHandlers`: editing events only run when `view.editable` is true.

## Keydown and keypress

### Keydown

The keydown handler (`input.ts`, local lines 106-136):

1. Tracks shift and last key code.
2. Ignores keydown when in or near IME composition.
3. Forces DOMObserver flush for most keys.
4. Applies iOS Enter special handling.
5. Runs `handleKeyDown` props.
6. Runs built-in `captureKeyDown`.
7. If handled, prevents default.
8. Otherwise records selection origin as `"key"` and lets the browser proceed.

Normal text typing usually does **not** dispatch directly from keydown. The browser inserts text into DOM, the mutation observer sees it, and `readDOMChange` creates a transaction.

### Keypress

The keypress handler (`input.ts`, local lines 142-160) handles an edge case: if a printable character is typed while the current selection is not a simple same-parent text selection, ProseMirror cannot rely on the browser's default insertion. It creates a default transaction with `tr.insertText(text)` and runs `handleTextInput`; if not handled, it dispatches the default transaction.

## DOMObserver

`DOMObserver` wraps `MutationObserver` and `selectionchange` (`prosemirror-view/src/domobserver.ts`, local lines 39-80).

It observes:

- child list changes;
- character data changes;
- attributes;
- subtree;
- old values for character/attribute changes.

It also has fallbacks/workarounds:

- IE11 `DOMCharacterDataModified`;
- IE mutation order issues;
- Safari composition-in-table issues;
- selection suppression;
- bogus `<br>` cleanup;
- Gecko `<br>` cleanup.

Source examples: `domobserver.ts`, local lines 55-72, 132-145, and 195-220.

### Flush pipeline

`DOMObserver.flush()` is the bridge from browser DOM mutation to model update (`domobserver.ts`, local lines 174-194 and beyond):

1. Drain pending mutation records.
2. Read DOM selection.
3. Detect whether DOM selection changed.
4. For editable views, call `registerMutation` for each mutation.
5. Compute a model position range `[from, to]` touched by mutations.
6. Collect added DOM nodes and `typeOver` information.
7. Mark the relevant `ViewDesc` range dirty.
8. Call `handleDOMChange(from, to, typeOver, added)`, which is `readDOMChange`.
9. If the view tree remains dirty, re-sync from state; otherwise sync DOM selection as needed.

The `dom.pmViewDesc` expando set by `ViewDesc` lets the observer map from arbitrary DOM mutation targets back to document positions (`viewdesc.ts`, local lines 148-151).

### registerMutation

`registerMutation` finds the nearest `ViewDesc` and returns the affected model position range. For:

- `childList`: compute range around changed siblings via DOM positions;
- `attributes`: dirty the node range;
- `characterData`: dirty the text desc range and detect type-over.

Source: `prosemirror-view/src/domobserver.ts`, local lines 252-302.

## readDOMChange

`readDOMChange(view, from, to, typeOver, addedNodes)` is the critical reconciliation function (`prosemirror-view/src/domchange.ts`, local lines 81-146 and 221-276).

It has two broad paths.

### Selection-only changes

If `from < 0`, there was no document mutation. The function:

1. Computes origin from recent `lastSelectionOrigin`.
2. Reads model selection from DOM with `selectionFromDOM`.
3. If different, dispatches `tr.setSelection(newSel)`.
4. Adds metadata:
   - `"pointer"` for pointer selection;
   - `"composition"` for composition selection;
   - scroll into view for keyboard origin.

Source: `domchange.ts`, local lines 81-100.

### DOM content changes

If DOM changed:

1. Resolve `from` and expand the affected range to a shared ancestor boundary (`domchange.ts`, local lines 102-105).
2. Parse the changed DOM range with `parseBetween` (`domchange.ts`, local lines 108 and 15-56).
3. Compare old model slice and parsed DOM content.
4. Use `findDiff` to compute minimal changed positions (`domchange.ts`, local lines 122 and 353-383).
5. Detect special cases:
   - type-over selection;
   - iOS/Android Enter;
   - Backspace that should be handled by key command;
   - Chrome composition delete/reinsert;
   - Android virtual keyboard enter suggestions;
   - IE non-breaking-space behavior;
   - surrogate pairs.
6. Build and dispatch a transaction:
   - deletion -> `tr.delete`;
   - mark change -> `tr.addMark` or `tr.removeMark`;
   - simple text insertion -> `tr.insertText`;
   - generic structural change -> `tr.replace` with parsed slice.
7. Add composition metadata and `scrollIntoView`.

Source: `domchange.ts`, local lines 148-276.

## parseBetween

`parseBetween` reparses the live DOM in context (`domchange.ts`, local lines 15-56):

- Asks `docView.parseRange(from_, to_)` for the DOM parent and offsets to parse.
- Reads DOM selection anchor/focus and passes them as `findPositions`.
- Uses `view.someProp("domParser")` or `DOMParser.fromSchema`.
- Parses with:
  - `topNode`: current model parent;
  - `topMatch`: current content match at insertion index;
  - `topOpen: true`;
  - DOM `from`/`to` offsets;
  - whitespace mode based on parent;
  - `ruleFromNode` to preserve known view-desc nodes;
  - `context`: resolved source position.

This is a core design insight: ProseMirror does not parse the whole editor after every input. It narrows to the changed DOM area and parses with schema context.

## Text input path

Typical simple typing:

```text
keydown
  -> not handled by keymap/captureKeyDown
  -> browser inserts text into contenteditable DOM
  -> MutationObserver queues characterData/childList mutation
  -> DOMObserver.flush
  -> readDOMChange
  -> parseBetween
  -> findDiff
  -> handleTextInput props get a chance
  -> tr.insertText(...)
  -> view.dispatch(tr)
  -> app/state.apply
  -> view.updateState
```

The official view guide says typing is usually left to the browser to preserve spellcheck, autocapitalization, mobile behavior, and native features (`website/markdown/guide/view.md`, local lines 53-58).

## Mouse and pointer input

`mousedown` (`input.ts`, local lines 278-301):

1. Flush/end active composition.
2. Detect single/double/triple click by timing/proximity.
3. Convert coordinates to model position with `view.posAtCoords`.
4. Create `MouseDown` state for single click or run double/triple handlers.

`MouseDown` tracks:

- starting document;
- whether the modifier indicates node selection;
- drag potential;
- target DOM;
- default-selection allowance;
- temporary draggable/contentEditable attributes for browser drag behavior.

On mouseup, it may:

- run `handleClickOn` / `handleClick`;
- select clicked leaf/atom/node;
- set a nearby selection;
- or allow the browser's native selection.

Selection transactions from pointer input get `"pointer": true` metadata (`input.ts`, local lines 186-192).

## Composition and IME

IME is one of ProseMirror's hardest browser constraints. The code tracks composition state rather than trying to eagerly convert every composition mutation into final document state.

### Start/update

`compositionstart` and `compositionupdate` (`input.ts`, local lines 457-491):

1. Flush DOM observer.
2. If stored marks or non-inclusive marks require special handling, set a mark cursor and end/reset composition.
3. Work around Gecko mark inheritance issues.
4. Set `view.input.composing = true`.
5. Schedule timeout handling, especially on Android.

### During composition

`ViewDesc` protects active composition DOM nodes from being destroyed during rendering. `NodeViewDesc.localCompositionInfo` and `protectLocalComposition` find and preserve the text node involved in composition (`prosemirror-view/src/viewdesc.ts`, local lines 815-852).

### End

On `compositionend`, ProseMirror:

- sets composing false;
- records timestamp;
- records pending mutation composition ID;
- clears composition node;
- force-flushes bad Safari compositions or schedules a microtask flush;
- increments composition ID;
- schedules final cleanup.

Source: `prosemirror-view/src/input.ts`, local lines 502-512.

Transactions produced from pending composition changes get `"composition": compositionID` metadata (`domchange.ts`, local lines 81-97 and 239-240).

## Clipboard

### Copy/cut serialization

`serializeForClipboard` (`prosemirror-view/src/clipboard.ts`, local lines 5-40):

1. Runs `transformCopied` props.
2. Simplifies deeply open single-child slices and records context.
3. Serializes content with `clipboardSerializer` or `DOMSerializer.fromSchema`.
4. Adds `data-pm-slice` metadata to preserve open depths and context.
5. Produces text using `clipboardTextSerializer` or `textBetween`.

### Paste parsing

`parseFromClipboard` (`clipboard.ts`, local lines 42-110):

1. Determine text vs HTML path based on `plainText`, code context, and HTML availability.
2. Run `transformPastedText` or `transformPastedHTML`.
3. For code, create a plain text slice.
4. For plain text, optionally use `clipboardTextParser`, otherwise convert lines to paragraphs.
5. For HTML, parse with `clipboardParser`, `domParser`, or schema `DOMParser`.
6. Read and apply `data-pm-slice` if present.
7. For external HTML, normalize siblings so pasted content can fit into the current schema context.
8. Run `transformPasted`.

The sibling normalization logic searches ancestor contexts for a place where pasted top-level siblings can fit, wrapping as needed (`clipboard.ts`, local lines 114-190).

## Drag and drop

Drag/drop uses the same slice machinery as clipboard:

- current drag state is stored on `view.dragging`;
- drop position is computed from coordinates;
- dropped content is parsed as a slice;
- `handleDrop` props can intercept;
- otherwise ProseMirror inserts/moves the slice with a transaction tagged `"uiEvent": "drop"`.

The relevant code is in `prosemirror-view/src/input.ts` below the clipboard sections.

## Browser constraints and workarounds

ProseMirror's codebase documents many practical constraints:

| Constraint | ProseMirror response |
| --- | --- |
| Native selection handles bidi, line motion, platform conventions | Let browser move DOM selection; read it back into `Selection` |
| Typing integrates spellcheck/autocorrect/mobile keyboards | Let browser mutate DOM; observe and diff |
| IME composition mutates DOM incrementally and inconsistently | Track composition state/IDs; protect composition DOM; defer flushes |
| Browser deletion may insert bogus `<br>` nodes | Detect and remove browser-specific bogus breaks |
| Mobile Enter behavior is inconsistent | Detect iOS/Android Enter and translate to key commands |
| Clipboard HTML may require table wrappers or context | Use `data-pm-slice`, wrapper maps, and schema context |
| Node views may contain uneditable/custom DOM | `stopEvent`, `ignoreMutation`, `contentDOM`, parse rules |
| DOM selection can become broken after DOM writes | Stop observer during writes; force selection sync in Chrome/IE/Edge cases |

## Input design lessons for Plim

1. Do not fight contenteditable blindly. Native selection, IME, spellcheck, and mobile input are too complex to fully replace without huge cost.
2. Isolate browser quirks behind an input adapter. ProseMirror's quirks are concentrated in `prosemirror-view`; Plim should keep this layer explicit and heavily tested.
3. Model user intent separately from DOM symptoms. A key press, composition update, text insertion, paste, and drop should have typed event metadata.
4. Preserve the "observe then reparse narrow range" strategy, but expose better diagnostics when DOM-to-model reconciliation fails.
5. Make composition a first-class state machine, not scattered booleans/timeouts.
6. Treat custom node views as untrusted browser islands with explicit contracts for event handling, mutation handling, and managed child content.
7. Build browser regression tests early. Most editor correctness failures will be browser/event-order issues, not pure model issues.
