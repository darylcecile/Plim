# ProseMirror transactions, state, commands, and plugins

## Executive summary

ProseMirror's state system is a persistent reducer pipeline. User actions, DOM changes, commands, history operations, and programmatic edits all converge on `Transaction`. Applying a transaction produces a new `EditorState`; plugins can veto it, observe it through state fields, or append follow-up transactions.

The transaction pipeline is the main extensibility seam. It is powerful because every change is inspectable and mappable. It is difficult because behavior can be distributed across command code, view event handlers, plugin props, transaction metadata, plugin filters, plugin state fields, appended transactions, and plugin views.

For lower-level details on step classes, replacement fitting, mapping recovery, and collaboration rebasing, see `08-transform-replacement-and-collaboration-deep-dive.md`.

## EditorState

`EditorState` is an immutable value with a fixed configuration (`prosemirror-state/src/state.ts`, local lines 83-90).

Base fields:

| Field | Meaning | Source |
| --- | --- | --- |
| `doc` | Current document node | `state.ts`, local lines 21-25 |
| `selection` | Current selection object | `state.ts`, local lines 27-30 |
| `storedMarks` | Marks to apply to future typed input | `state.ts`, local lines 32-35 |
| `scrollToSelection` | Counter used by view to decide whether to scroll selection into view | `state.ts`, local lines 37-40 |

Plugins add more state fields. `Configuration` builds the ordered list of base fields plus plugin fields and enforces keyed-plugin uniqueness (`state.ts`, local lines 45-60).

### Creating state

`EditorState.create(config)` builds a `Configuration`, allocates a new `EditorState`, and initializes each field (`state.ts`, local lines 184-190). If no document is supplied, the schema top node is filled with `schema.topNodeType.createAndFill()` (`state.ts`, local lines 21-24).

### Applying a transaction

There are two relevant APIs:

- `state.apply(tr)`: returns only the new state.
- `state.applyTransaction(tr)`: returns `{state, transactions}`, including any appended transactions.

`applyTransaction` does:

1. Run `filterTransaction` hooks. If any returns false, ignore the transaction (`state.ts`, local lines 123-139).
2. Apply the root transaction with `applyInner`.
3. Loop over plugins with `appendTransaction`.
4. If a plugin appends a transaction, filter it, tag it with `appendedTransaction`, apply it, and keep looping.
5. Return the final state and full transaction list (`state.ts`, local lines 137-168).

`applyInner` requires that `tr.before.eq(this.doc)`; mismatched transactions throw. It creates a new `EditorState` and asks each field to produce its new value (`state.ts`, local lines 170-179).

## Transaction

`Transaction` subclasses `Transform` (`prosemirror-state/src/transaction.ts`, local line 42). It therefore inherits:

- current `doc`;
- `steps`;
- pre-step `docs`;
- accumulated `mapping`;
- transform methods such as `replace`, `delete`, `insert`, `addMark`, `removeMark`, `setBlockType`, `split`, `join`, `lift`, `wrap`.

It adds:

- timestamp (`time`);
- current selection;
- stored marks;
- updated bitfield for selection/marks/scroll;
- metadata map (`transaction.ts`, local lines 43-65).

### Lazy selection mapping

Transactions do not eagerly update selection after every step. The getter maps the last known selection through only the maps added since it was last read (`transaction.ts`, local lines 67-77).

This matters because commands can chain many operations and still ask for `tr.selection` at any point. It also avoids repeated selection recalculation.

### Selection updates

`setSelection(selection)` checks that the selection points into the current transaction document, sets the selection, marks selection as updated, clears stored marks, and returns the transaction (`transaction.ts`, local lines 79-89).

By default, if a transaction changes the document without explicitly setting selection, the old selection is mapped through the transaction's steps.

### Stored marks

Stored marks model "the marks that should apply to the next typed input" when a cursor is empty and the user toggles bold/italic/etc. They are automatically cleared after document changes or explicit selection changes (`transaction.ts`, local lines 96-131). `addStoredMark`, `removeStoredMark`, and `ensureMarks` update this state (`transaction.ts`, local lines 96-124).

### Metadata

`setMeta` and `getMeta` store arbitrary metadata keyed by string, `Plugin`, or `PluginKey` (`transaction.ts`, local lines 185-195).

Known metadata patterns:

| Metadata | Producer | Meaning |
| --- | --- | --- |
| `"pointer": true` | `prosemirror-view` | Selection transaction came from pointer input |
| `"composition": id` | `prosemirror-view` | Transaction came from an IME composition |
| `"uiEvent": "paste" | "cut" | "drop"` | `prosemirror-view` | Clipboard/drop user action |
| `"addToHistory": false` | caller/plugins | History plugin should skip this transaction |
| `historyKey` metadata | history plugin | Marks undo/redo transactions |
| plugin object/key | any plugin | Collision-resistant plugin-local signaling |

Metadata is flexible but untyped. This is one of ProseMirror's most important DX seams for improvement.

## Transform and Step model

`Transform` is the base mutable builder for document changes (`prosemirror-transform/src/transform.ts`, local lines 23-41). It stores:

- `steps`: applied steps;
- `docs`: document before each step;
- `mapping`: accumulated position maps;
- `doc`: current document after steps.

`step(step)` applies a step and throws if it fails. `maybeStep(step)` applies it and returns a `StepResult` without throwing (`transform.ts`, local lines 46-60). `addStep` appends the old doc, step, map, and new doc (`transform.ts`, local lines 88-94).

### Step maps

`StepMap` maps positions through a single step. Its ranges are triples `[start, oldSize, newSize]` (`prosemirror-transform/src/map.ts`, local lines 68-76). `mapResult` returns deletion flags in addition to the mapped position (`map.ts`, local lines 38-66 and 93-116).

`Mapping` chains step maps and supports mirror mappings for inversion/rebasing (`map.ts`, local lines 166-249). This is what lets history and collaboration preserve positions through complex change sequences.

## Selection model

Every selection has:

- `$anchor` and `$head` resolved positions;
- one or more `SelectionRange`s;
- `from`/`to` based on the main range;
- mapping support;
- content extraction/replacement;
- JSON serialization;
- a bookmark for history (`prosemirror-state/src/selection.ts`, local lines 7-24 and 61-180).

Built-in selection classes:

| Selection | Meaning |
| --- | --- |
| `TextSelection` | Cursor or text range inside inline content |
| `NodeSelection` | A single selectable node |
| `AllSelection` | Entire document, including cases where normal text positions do not cover all content |

`Selection.near`, `Selection.findFrom`, `Selection.atStart`, and `Selection.atEnd` search for valid text or node selections (`selection.ts`, local lines 113-151).

### Selection bookmarks

Bookmarks are document-independent selection handles that can be mapped through changes and later resolved in a document. History uses them to restore selections without keeping old document objects alive unnecessarily (`selection.ts`, local lines 173-180 and 192-204).

## Plugin system

`PluginSpec` is the core plugin definition (`prosemirror-state/src/plugin.ts`, local lines 5-45):

```ts
PluginSpec = {
  props?: EditorProps
  state?: StateField
  key?: PluginKey
  view?: (view: EditorView) => PluginView
  filterTransaction?: (tr, state) => boolean
  appendTransaction?: (transactions, oldState, newState) => Transaction | null
}
```

### Plugin state fields

A state field has:

- `init(config, instance)`;
- `apply(tr, value, oldState, newState)`;
- optional `toJSON`;
- optional `fromJSON`.

Source: `plugin.ts`, local lines 91-115.

Plugin state must be immutable, because it becomes part of the persistent `EditorState` value. The official state guide explicitly calls this out (`website/markdown/guide/state.md`, local lines 169-173).

### Plugin props

Plugin props are bound to the plugin instance and then consumed by `EditorView.someProp` (`plugin.ts`, local lines 58-82). Props are the bridge from state plugins to view behavior:

- event handlers (`handleKeyDown`, `handlePaste`, `handleDrop`, `handleDOMEvents`, etc.);
- decorations;
- node views;
- editable/attributes;
- parsers/serializers;
- clipboard transforms.

The official view guide explains prop resolution: direct props first, then plugin props in order; some props are first-value wins, handlers stop at first `true`, and some are combined (`website/markdown/guide/view.md`, local lines 187-198).

### Plugin views

Plugin views are stateful view-side objects created when an editor view is associated with state. They can implement:

- `update(view, prevState)`;
- `destroy()`.

Source: `plugin.ts`, local lines 23-27 and 47-55.

This is used for DOM side effects such as tooltips, menus, observers, and plugin-owned UI.

### Transaction filters and appenders

`filterTransaction` can cancel a transaction before state changes. This is powerful for read-only constraints, max document sizes, collaborative locks, or schema-specific rules. It can also become a hidden source of "why did my command do nothing?" behavior.

`appendTransaction` can enforce invariants after changes. The state pipeline calls it repeatedly until no plugin appends more transactions (`state.ts`, local lines 140-168). This enables normalization plugins but can create complex ordering interactions.

## Commands

The command protocol is:

```ts
type Command = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  view?: EditorView
) => boolean
```

Source: `prosemirror-state/src/transaction.ts`, local lines 8-18; official command guide lines 1-44.

Semantics:

- Return `false` if not applicable.
- If applicable and `dispatch` is omitted, return `true` without performing the action.
- If applicable and `dispatch` is provided, dispatch a transaction or perform a view-side action, then return `true`.
- The optional `view` is an escape hatch for DOM-aware commands.

This makes commands useful for both UI enablement and execution.

### Command chains

`chainCommands` tries commands in order until one returns true (`prosemirror-commands/src/commands.ts`, local lines 726-733). The base keymap uses this for keys such as Backspace and Enter (`commands.ts`, local lines 736-758).

For example, Backspace is:

```text
deleteSelection
  -> joinBackward
  -> selectNodeBackward
  -> otherwise allow browser/native behavior
```

The official command guide explains why the browser is allowed to handle ordinary in-text backspace: preserving native spellcheck and related behavior (`website/markdown/guide/commands.md`, local lines 85-94).

### Schema-aware commands

Examples:

- `wrapIn(nodeType, attrs)` computes a `blockRange` and `findWrapping`, then dispatches `tr.wrap` (`commands.ts`, local lines 531-540).
- `setBlockType(nodeType, attrs)` checks textblocks and parent replacement validity before dispatching `tr.setBlockType` (`commands.ts`, local lines 543-571).
- `toggleMark(markType, attrs, options)` handles cursor stored marks or selected ranges, mark applicability, inline atoms, whitespace trimming, and add/remove semantics (`commands.ts`, local lines 604-671).

## Keymap plugin

`prosemirror-keymap` turns keydown events into commands:

- Key names are normalized with platform-aware modifiers (`keymap.ts`, local lines 8-45).
- `keymap(bindings)` returns a plugin with `props.handleKeyDown` (`keymap.ts`, local lines 47-78).
- `keydownHandler` looks up direct bindings, shift variants, and fallback keyCode mappings, then calls command `(state, dispatch, view)` (`keymap.ts`, local lines 83-109).
- Multiple keymap plugins are allowed; earlier plugins have precedence (`keymap.ts`, local lines 73-75).

## Input rules

Input rules are regex-triggered transforms for typed text (`prosemirror-inputrules/src/inputrules.ts`, local lines 4-56).

Pipeline:

1. Plugin provides `handleTextInput`.
2. On text input, inspect up to `MAX_MATCH = 500` chars before cursor plus inserted text (`inputrules.ts`, local lines 75 and 112-117).
3. Skip rules based on code node/mark settings (`inputrules.ts`, local lines 119-134).
4. Run the first matching rule.
5. If the rule returns a transaction, optionally store undo metadata and dispatch it (`inputrules.ts`, local lines 135-139).

`undoInputRule` inverts the stored rule transaction and restores typed text if needed (`inputrules.ts`, local lines 144-167).

## History

History is step/map based, not snapshot based. The source comment explains that it cannot simply roll back to previous states because ProseMirror supports changes that are not added to history, such as collaborative remote updates (`prosemirror-history/src/history.ts`, local lines 5-20).

History stores two `Branch`es:

- done stack;
- undone stack.

Each branch contains `Item`s that may hold:

- an inverted step;
- a position map;
- a selection bookmark marking the start of an undo event.

Undo/redo:

1. Pop latest event from one branch.
2. Apply its inverted/mapped steps as a transform.
3. Resolve stored selection bookmark.
4. Add the reverse transform to the opposite branch.
5. Return a transaction tagged with history metadata (`history.ts`, local lines 329-343 and 423-447).

History groups adjacent changes by time and changed ranges. Default depth is 100 and default new-group delay is 500ms (`history.ts`, local lines 373-393).

## State/plugin design lessons for Plim

1. Keep the pure reducer pipeline. All durable document changes should pass through a transaction-like object.
2. Preserve an explicit change trail. It unlocks history, collaboration, decorations, analytics, and debugging.
3. Make transaction metadata typed. Replace ProseMirror's arbitrary meta keys with declared event/action metadata contracts.
4. Make plugin ordering visible. ProseMirror's plugin order is powerful but implicit; Plim should expose ordering, dependencies, and conflicts.
5. Separate "can run" from "run", but with a clearer API than optional `dispatch`.
6. Avoid hidden appended-transaction loops. If normalization hooks can append changes, expose trace/debug tooling and loop limits.
7. Treat view-side plugin objects as effects with lifecycle, not as part of editor state.
8. Make selection and position mapping first-class in extension APIs; do not require every extension author to manually map raw integers.
