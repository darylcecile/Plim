# ProseMirror architecture overview

## Executive summary

ProseMirror is best understood as a set of small packages arranged around one invariant: **the authoritative editor state is an immutable, schema-constrained document value, and the browser DOM is a projection plus input device**.

The core cycle is:

```text
DOM event or programmatic action
  -> EditorView input/props/commands
  -> Transaction
  -> EditorState.applyTransaction
  -> new EditorState
  -> EditorView.updateState
  -> incremental DOM and selection sync
```

The important separation is not "model vs view" in a generic MVC sense. It is:

1. `prosemirror-model` defines persistent content values and schema constraints.
2. `prosemirror-transform` defines document changes as replayable, invertible, mappable steps.
3. `prosemirror-state` defines immutable editor state, selections, transactions, and plugin state.
4. `prosemirror-view` owns browser integration: contenteditable DOM, events, mutation observation, composition, clipboard, drag/drop, decorations, node views, and incremental rendering.
5. Supporting packages (`commands`, `keymap`, `inputrules`, `history`, `collab`, schemas) are plugins and helpers layered over those primitives.

This gives ProseMirror strong correctness and composability, but also creates developer-experience pain points: integer positions are powerful but easy to misuse, schema/content expressions are stringly typed, plugin behavior is distributed across many hooks, transaction metadata is mostly untyped, and browser workarounds leak into extension author mental models.

## Package responsibilities

| Package | Responsibility | Core abstractions |
| --- | --- | --- |
| `prosemirror-model` | Define document values and schema-aware parsing/serialization | `Node`, `Fragment`, `Mark`, `Slice`, `Schema`, `NodeType`, `MarkType`, `ContentMatch`, `ResolvedPos`, `DOMParser`, `DOMSerializer` |
| `prosemirror-transform` | Describe and apply document changes | `Step`, `StepResult`, `Transform`, `StepMap`, `Mapping`, replace/lift/wrap/split/join helpers |
| `prosemirror-state` | Hold editor state and derive new states from transactions | `EditorState`, `Transaction`, `Selection`, `TextSelection`, `NodeSelection`, `AllSelection`, `Plugin`, `PluginKey`, `StateField` |
| `prosemirror-view` | Connect state to browser DOM and user input | `EditorView`, `InputState`, `DOMObserver`, `ViewDesc`, `NodeView`, `MarkView`, `Decoration`, `DecorationSet` |
| `prosemirror-commands` | Editing action protocol and built-in structural commands | `Command`, `chainCommands`, `toggleMark`, `wrapIn`, `setBlockType`, `baseKeymap` |
| `prosemirror-keymap` | Keydown-to-command dispatch | `keymap`, `keydownHandler` |
| `prosemirror-inputrules` | Regex-triggered transforms after typed input | `InputRule`, `inputRules`, `undoInputRule` |
| `prosemirror-history` | Selective undo/redo over steps/maps | `history`, `undo`, `redo`, `closeHistory` |
| `prosemirror-collab` | Central-authority collaboration over rebased steps | `collab`, `receiveTransaction`, `sendableSteps`, `getVersion` |

## The three-layer state stack

### 1. Document model

The document is a `Node` tree. Non-leaf nodes contain a `Fragment` of child nodes. Inline markup is not represented as nested inline DOM; instead, inline nodes carry sorted arrays of `Mark` values. The official guide calls this out as a deliberate departure from HTML because it gives inline content one canonical form and makes text operations easier (`website/markdown/guide/doc.md`, lines 48-84).

The model is persistent: edits create new nodes/fragments and share unchanged subtrees. The source comment on `Node` explicitly says nodes are persistent data structures and must not be mutated (`prosemirror-model/src/node.ts`, local lines 10-21). The guide explains why: immutable values avoid invalid in-between states, help collaboration, and make incremental DOM updates efficient (`website/markdown/guide/doc.md`, local lines 111-145).

### 2. Transform and transaction model

A `Transform` starts from a document and accumulates `Step` objects. Each step produces a new document and a `StepMap`; the transform accumulates those maps in a `Mapping` (`prosemirror-transform/src/transform.ts`, local lines 23-41 and 88-94). `StepMap` stores changed chunks as `[start, oldSize, newSize]` triples and maps old positions to new positions (`prosemirror-transform/src/map.ts`, local lines 68-76 and 93-116).

A `Transaction` is a `Transform` plus editor-state changes: selection, stored marks, metadata, time, and scroll intent (`prosemirror-state/src/transaction.ts`, local lines 22-42 and 56-65). Selection is lazily mapped through steps when `tr.selection` is read (`transaction.ts`, local lines 67-77).

### 3. Editor state and plugin state

`EditorState` holds the current document, selection, stored marks, scroll counter, and plugin-defined state fields. It is a persistent value. Applying a transaction creates a new `EditorState` by running every field's `apply` function (`prosemirror-state/src/state.ts`, local lines 83-90 and 170-179).

Plugins are part of the state configuration. They can:

- add view props, such as event handlers or decorations;
- define immutable state fields;
- veto transactions with `filterTransaction`;
- append follow-up transactions with `appendTransaction`;
- create `PluginView` objects tied to an `EditorView`.

The application loop in `EditorState.applyTransaction` first runs filters, applies the root transaction, then repeatedly gives plugins a chance to append transactions until no plugin adds one (`prosemirror-state/src/state.ts`, local lines 123-168).

## Browser integration model

The view guide states the key browser strategy: ProseMirror renders the document into contenteditable DOM, but often lets the browser handle selection motion and typing. After the browser mutates DOM or DOM selection, ProseMirror rereads the affected DOM and converts the difference into a transaction (`website/markdown/guide/view.md`, local lines 24-58).

That makes the view a reconciler in both directions:

```text
State -> DOM
  EditorView.updateStateInner
  -> ViewDesc tree update
  -> DOM patches
  -> DOM selection sync

DOM -> State
  DOM events / MutationObserver / selectionchange
  -> DOMObserver.flush
  -> readDOMChange
  -> parse changed DOM range
  -> find model diff
  -> dispatch transaction
```

This design is pragmatic. Browsers have hard-to-reimplement native behavior for bidirectional text, IME, spellcheck, autocorrect, native selection geometry, mobile keyboards, and clipboard/drop. But the price is a large amount of browser-specific input code in `prosemirror-view`.

## Extension surfaces

ProseMirror's extension model is mostly plugin-based, with different concepts spread over several APIs:

| Surface | Used for | Notes |
| --- | --- | --- |
| Schema node/mark specs | Document structure, attributes, parse/render rules | Powerful but mostly static and stringly typed |
| Commands | User actions and command applicability checks | `(state, dispatch?, view?) => boolean`; dispatch optional for "can run" checks |
| Keymaps | Keyboard shortcuts | Plugin prop `handleKeyDown`; plugin order defines precedence |
| Input rules | Text pattern transforms | Run from `handleTextInput`, not generic events |
| Plugins | State, props, event handlers, decorations, transaction filters/appends | Extremely flexible, but behavior can be hard to trace |
| Node views / mark views | Custom DOM for document nodes/marks | Escape hatch with lifecycle, contentDOM, event/mutation controls |
| Decorations | Non-document visual overlays | Must be mapped through transactions for performance |
| Transaction metadata | Cross-plugin signaling | Flexible but untyped |

## Primary interaction graph

```text
Schema
  -> creates NodeType/MarkType
  -> creates/validates Node/Mark/Fragment
  -> provides DOMParser/DOMSerializer rules

EditorState
  -> holds doc/selection/storedMarks/plugin fields
  -> produces Transaction via state.tr

Transaction
  -> extends Transform
  -> accumulates Step + StepMap
  -> updates selection/storedMarks/meta/scroll

Plugin
  -> contributes state fields to EditorState
  -> contributes props to EditorView
  -> filters/appends transactions during applyTransaction

EditorView
  -> renders EditorState.doc with ViewDesc tree
  -> resolves props from direct props and plugins
  -> converts DOM input to transactions
  -> dispatches transactions to external app or internal state.apply
```

## Architectural strengths

1. **Pure, inspectable content model.** The document is independent of DOM and can be serialized, transformed, tested, collaborated on, and diffed.
2. **Step trail instead of opaque mutations.** History, collaboration, decorations, and selections can map through changes because every edit produces maps.
3. **Browser-native input where needed.** ProseMirror avoids reimplementing the hardest selection and text input behaviors.
4. **Incremental rendering.** Persistent nodes plus `ViewDesc` matching allow DOM reuse.
5. **Composable plugin mechanism.** Plugins can extend state and view behavior without forking the core.

## Architectural costs

1. **Integer-position mental model.** Single-number positions are compact and mappable, but they are not self-explanatory for block/editor app developers.
2. **Stringly typed schema and metadata.** Content expressions, node/mark names, groups, and transaction meta keys rely heavily on strings.
3. **Implicit precedence.** Plugin order determines handler, prop, keymap, and transaction behavior.
4. **Distributed action semantics.** A single user action may involve DOM handlers, commands, input rules, transaction filters, append transactions, history metadata, and view updates.
5. **Leaky browser constraints.** Extension authors often must understand composition, DOM mutations, selection mapping, and node view mutation handling to build robust advanced nodes.
