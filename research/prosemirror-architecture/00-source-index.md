# ProseMirror architecture source index

Scope: authoritative and high-signal sources for understanding how ProseMirror works before designing a new editor inspired by it. This packet focuses on the document data model, schema/content constraints, transactions, plugin interactions, browser input processing, and DOM rendering.

Start here:

1. `01-architecture-overview.md` for the system map.
2. `02-data-model-and-schema.md` for document values, schemas, positions, parsing, and serialization.
3. `03-transactions-state-and-plugins.md` for transforms, transactions, selection, plugins, commands, history, and keymaps.
4. `04-input-processing-and-browser-constraints.md` for the event/mutation pipeline.
5. `05-rendering-and-view.md` for `EditorView`, `ViewDesc`, node views, decorations, and selection rendering.
6. `07-browser-input-rendering-deep-dive.md` for the citation-reproducibility notes and the lower-level browser/rendering details added after QA review.
7. `08-transform-replacement-and-collaboration-deep-dive.md` for lower-level step, replacement, mapping, and rebasing mechanics.
8. `10-edge-case-gap-closure.md` for source-backed closure of rebasing, fitting, marks, schema compilation, selection, filler-node, coordinate, and node-view edge cases.
9. `09-research-coverage-matrix.md` for a goal-by-goal coverage checklist.

Source posture:

- **Official guide** means explanatory documentation from `prosemirror.net` / `ProseMirror/website`.
- **Source-confirmed** means verified against ProseMirror package source code.
- **Inference** means a design conclusion for Plim drawn from official docs and source behavior.

## Source snapshot

Local source clones used for this research were shallow clones under `/tmp/plim-prosemirror-research`. ProseMirror is a family of separately versioned packages, not a single monorepo. The package metadata names canonical repositories under `https://code.haverbeke.berlin/prosemirror/...`; the research clones use the public GitHub mirrors under `https://github.com/ProseMirror/...`.

Line references in this packet are against the exact commits below, not against moving `master` branches. When a claim says "current" or "latest", it should be read as "checked on 2026-05-02/03" and not as a durable architectural fact.

| Package/repo | Snapshot commit | Snapshot package version | npm version checked 2026-05-02/03 | Role |
| --- | --- | --- | --- | --- |
| `prosemirror-model` | `6264de069d8439131e88f8ba06973551916184e4` | `1.25.4` | `1.25.4` | Persistent document tree, schema, DOM parser/serializer |
| `prosemirror-transform` | `662b7a937bafde19b7e2a83241dbc8888e257c89` | `1.12.0` | `1.12.0` | Steps, transforms, position maps, structure operations |
| `prosemirror-state` | `ffad5d9450a0b93438be53a801deee1a223a81bf` | `1.4.4` | `1.4.4` | EditorState, Transaction, Selection, Plugin |
| `prosemirror-view` | `ca4c78e9b56f1b164c0b3758b59d8748f11b7534` | `1.41.7` | `1.41.8` | EditorView, DOM input, mutation observer, incremental rendering |
| `prosemirror-commands` | `52a84a842774fadec3b167bcdbd56085ec6c85df` | `1.7.1` | `1.7.1` | Command protocol and base editing commands |
| `prosemirror-keymap` | `d60e2447d63374d7612121675e9e7fa9ccfb2eb0` | `1.2.3` | `1.2.3` | Key normalization and command dispatch plugin |
| `prosemirror-inputrules` | `e3e5545f21d8ff4050be6f3134d653dc087918d3` | `1.5.1` | `1.5.1` | Regex-triggered typed input transformations |
| `prosemirror-history` | `445409bc99c88550c2312f5610829ecb25105a5f` | `1.5.0` | `1.5.0` | Undo/redo plugin built from steps, maps, and bookmarks |
| `prosemirror-collab` | `7736c6c9ad4407af2678112a1cad82c1d3c53dcf` | `1.3.1` | `1.3.1` | Central-authority collaboration helper built on step rebasing |
| `prosemirror-schema-basic` | `756726f792db269aa13a432c8b2240d6f9c29b64` | `1.2.4` | `1.2.4` | Example/basic node and mark schema |
| `ProseMirror/website` | `a16b4ece45f135e5f001ab59d25f2d43c25974e1` | n/a | n/a | Official guide source |

To reproduce local citations:

```sh
mkdir -p /tmp/plim-prosemirror-research
cd /tmp/plim-prosemirror-research
for repo in prosemirror-model prosemirror-transform prosemirror-state prosemirror-view prosemirror-commands prosemirror-keymap prosemirror-inputrules prosemirror-history prosemirror-collab prosemirror-schema-basic website; do
  git clone https://github.com/ProseMirror/$repo.git
done
git -C prosemirror-model checkout 6264de069d8439131e88f8ba06973551916184e4
git -C prosemirror-transform checkout 662b7a937bafde19b7e2a83241dbc8888e257c89
git -C prosemirror-state checkout ffad5d9450a0b93438be53a801deee1a223a81bf
git -C prosemirror-view checkout ca4c78e9b56f1b164c0b3758b59d8748f11b7534
git -C prosemirror-commands checkout 52a84a842774fadec3b167bcdbd56085ec6c85df
git -C prosemirror-keymap checkout d60e2447d63374d7612121675e9e7fa9ccfb2eb0
git -C prosemirror-inputrules checkout e3e5545f21d8ff4050be6f3134d653dc087918d3
git -C prosemirror-history checkout 445409bc99c88550c2312f5610829ecb25105a5f
git -C prosemirror-collab checkout 7736c6c9ad4407af2678112a1cad82c1d3c53dcf
git -C prosemirror-schema-basic checkout 756726f792db269aa13a432c8b2240d6f9c29b64
git -C website checkout a16b4ece45f135e5f001ab59d25f2d43c25974e1
```

## Official guide sources

### [Document guide](https://prosemirror.net/docs/guide/#doc)

- **Source type:** Official ProseMirror guide.
- **Relevant topics:** Node tree, Fragment, marks-as-metadata model, persistent values, integer positions, slices.
- **Key claims/details:**
  - A document is a `Node` whose content is a `Fragment` of child nodes.
  - ProseMirror models inline content as a flat sequence with mark metadata rather than a nested DOM-like inline tree.
  - Each document has one canonical representation: adjacent text nodes with identical marks are combined, empty text nodes are disallowed, and mark order is schema-defined.
  - Nodes are persistent values, not mutable DOM-like objects with parent pointers; updates produce new document values with structural sharing.
  - Integer positions treat a document as a token stream; non-leaf nodes contribute opening and closing tokens, text contributes character positions.
- **Primary source files:** `ProseMirror/website/markdown/guide/doc.md`, especially lines 12-15, 48-84, 111-156, and 243+ in the local snapshot.

### [Schema guide](https://prosemirror.net/docs/guide/#schema)

- **Source type:** Official ProseMirror guide.
- **Relevant topics:** Schema, node specs, mark specs, content expressions, groups, attributes, DOM parsing, DOM serialization.
- **Key claims/details:**
  - Every document has a schema that enumerates allowed node and mark types.
  - Every schema must define a top node, defaulting to `doc`, and a `text` node type.
  - Content expressions are regex-like strings over node names/groups and are used to validate child sequences.
  - Node order matters for parse precedence, mark ordering, and default filler generation.
  - Primitive node constructors can create invalid content; checked APIs and transform APIs enforce constraints.
  - `toDOM` and `parseDOM` connect the abstract model to browser DOM.
- **Primary source files:** `ProseMirror/website/markdown/guide/schema.md`, especially lines 1-12, 45-112, and 183-248 in the local snapshot.

### [Transform guide](https://prosemirror.net/docs/guide/#transform)

- **Source type:** Official ProseMirror guide.
- **Relevant topics:** Steps, transforms, step maps, mapping, inversion, rebasing.
- **Key claims/details:**
  - Document updates are decomposed into step values so history, collaboration, and plugin state can reason about changes.
  - A `Transform` accumulates steps and their maps.
  - Position maps translate positions across changes and support an association/bias parameter for ambiguous insertion boundaries.
  - Steps can be inverted and mapped through other steps, enabling history and collaboration-style rebasing.
- **Primary source files:** `ProseMirror/website/markdown/guide/transform.md`, especially lines 1-29, 30-64, 65-93, and 94-149 in the local snapshot.

### [State guide](https://prosemirror.net/docs/guide/#state)

- **Source type:** Official ProseMirror guide.
- **Relevant topics:** EditorState, selection, transactions, stored marks, plugins, transaction metadata.
- **Key claims/details:**
  - Editor state consists of `doc`, `selection`, `storedMarks`, and plugin-defined state fields.
  - State is persistent/immutable; applying a transaction derives a new state.
  - Transactions subclass `Transform` and add selection, stored marks, metadata, and scroll intent.
  - Plugins can provide props, state fields, transaction filters, appended transactions, and view-side objects.
- **Primary source files:** `ProseMirror/website/markdown/guide/state.md`, especially lines 1-25, 26-54, 55-116, and 117-209 in the local snapshot.

### [View guide](https://prosemirror.net/docs/guide/#view)

- **Source type:** Official ProseMirror guide.
- **Relevant topics:** Contenteditable, EditorView, DOM event processing, cyclic data flow, dispatchTransaction, incremental DOM updates, props, decorations, node views.
- **Key claims/details:**
  - The core view handles direct editing-surface interactions only: typing, clicking, copy/paste, and dragging.
  - The view renders the document to an editable DOM surface and keeps DOM selection synchronized with state selection.
  - ProseMirror often lets the browser handle cursor motion and typing, then reinterprets the resulting DOM/selection changes as transactions.
  - Data flow is DOM event -> EditorView -> Transaction -> new EditorState -> EditorView update.
  - Incremental rendering compares old and new document values and reuses unchanged DOM.
  - Props are resolved from direct props and plugin props; some props are first-match handlers and some are combined.
  - Decorations provide non-document visual overlays.
- **Primary source files:** `ProseMirror/website/markdown/guide/view.md`, especially lines 12-23, 24-58, 59-92, 124-148, 149-198, and 200-256 in the local snapshot.

### [Commands guide](https://prosemirror.net/docs/guide/#commands)

- **Source type:** Official ProseMirror guide.
- **Relevant topics:** Command protocol, applicability checks, keymaps, command chains.
- **Key claims/details:**
  - Commands take `(state, dispatch?, view?)` and return whether they handled the action.
  - `dispatch` is optional so UI can ask if a command is currently applicable without executing it.
  - Commands usually dispatch transactions, but may perform view-side effects.
  - Complex keys often chain small commands until one applies.
- **Primary source files:** `ProseMirror/website/markdown/guide/commands.md`, especially lines 1-44 and 70-105 in the local snapshot.

## Core source files

### `prosemirror-model`

- `src/node.ts`
  - `Node` is the persistent tree value. The class comment explicitly warns not to mutate nodes and explains structural sharing. Local lines 10-21.
  - `nodeSize` encodes flat position size: text length, one for leaf nodes, and content size plus two for non-leaf nodes. Local lines 49-54.
  - `canReplace`, `canReplaceWith`, and `check` validate child replacement, mark allow-lists, attrs, and mark-set canonical ordering. Local lines 264-316.
  - `TextNode` rejects empty strings and overrides `nodeSize` to text length. Local lines 353-397.
  - `slice`, `replace`, `resolve`, traversal, mark queries, JSON, and schema validation helpers live here. Local lines 157-177 and 209-214 are especially important.
- `src/fragment.ts`
  - `Fragment` is the persistent child sequence. Local lines 5-13.
  - `append` and `fromArray` merge adjacent text nodes with identical markup. Local lines 71-83 and 225-237.
  - `findIndex`, `nodesBetween`, and diff helpers support position navigation and DOM-change diffing. Local lines 26-43 and 190-205.
- `src/mark.ts`
  - `Mark` is a value with type and attrs. Local lines 4-17.
  - `addToSet` applies mark order and exclusion constraints. Local lines 19-45.
  - `sameSet` and `setFrom` canonicalize mark sets. Local lines 90-110.
- `src/resolvedpos.ts`
  - `ResolvedPos` turns a flat integer into ancestor path, depth, indices, starts/ends, marks, and ranges. Local lines 4-12, 37-95, 117-191, and 217-257.
  - `resolveCached` stores a small per-document WeakMap-backed cache of 12 resolved positions. Local lines 236-257.
  - `NodeRange` represents a depth-scoped range for block operations. Local lines 261+.
- `src/content.ts`
  - `ContentMatch` is the automaton state for a content expression. Local lines 6-20.
  - It matches node types/fragments, fills missing content, and finds wrappers. Local lines 33-49, 73-98, and 100-133.
  - Content expressions are parsed to an NFA and compiled to a DFA. Local lines 23-30 and parser/compiler code below line 169.
- `src/schema.ts`
  - `NodeType` and `MarkType` are schema-scoped type tags. Local lines 56-87 and 277-347.
  - `NodeType.createChecked`, `createAndFill`, `validContent`, and mark filtering enforce schema constraints. Local lines 146-184 and 186-233.
  - `Schema` converts specs to ordered maps, compiles node/mark types, caches identical `ContentMatch` automatons by content expression, computes mark allow-lists, and stores parser/serializer caches under `schema.cached`. Local lines 572-640.
  - `SchemaSpec`, `NodeSpec`, and `MarkSpec` define content, marks, groups, attrs, DOM parsing, and DOM serialization. Local lines 349+.
- `src/from_dom.ts`
  - `DOMParser` parses DOM into schema-valid nodes or open slices. Local lines 179-237.
  - Schema parse rules are gathered and sorted by priority. Local lines 277-314.
- `src/to_dom.ts`
  - `DOMSerializer` serializes nodes/fragments/marks from schema `toDOM` functions. Local lines 25-40, 42-87, and 130-148.
  - `DOMOutputSpec` uses `0` as a content hole. Local lines 7-23.

### `prosemirror-transform`

- `src/transform.ts`
  - `Transform` stores `steps`, pre-step `docs`, current `doc`, and accumulated `mapping`. Local lines 23-41.
  - `step`/`maybeStep` apply steps and append maps. Local lines 46-60 and 88-94.
  - High-level helpers such as `replace`, `replaceRange`, `replaceRangeWith`, `deleteRange`, `lift`, `wrap`, `split`, and `join` generate valid steps. Local lines 96-170 and beyond.
- `src/map.ts`
  - `StepMap` represents each change as triples `[start, oldSize, newSize]`. Local lines 68-76.
  - `map`/`mapResult` account for association and deletion flags. Local lines 93-116.
  - `Mapping` chains `StepMap`s and tracks mirror relationships for history/collaboration rebasing. Local lines 166-249.

### `prosemirror-state`

- `src/state.ts`
  - Base state fields are `doc`, `selection`, `storedMarks`, and `scrollToSelection`. Local lines 21-40.
  - `Configuration` merges base fields with plugin fields and enforces unique keyed plugins. Local lines 45-60.
  - `EditorState` is persistent and is derived via `apply`/`applyTransaction`. Local lines 83-90 and 117-179.
- `src/transaction.ts`
  - `Transaction` extends `Transform` and tracks selection, stored marks, timestamp, metadata, and scroll intent. Local lines 22-42 and 56-65.
  - Selection is lazily mapped through new steps. Local lines 67-77.
  - `setMeta`/`getMeta` carry semantic annotations for plugins and view input. Local lines 185-195.
- `src/selection.ts`
  - `Selection` base class supports ranges, mapping, content extraction, replacement, JSON registration, and bookmarks. Local lines 7-24 and 61-180.
  - `TextSelection`, `NodeSelection`, and `AllSelection` provide built-in selection kinds. Local lines 225+, 325+, and 399+.
- `src/plugin.ts`
  - `PluginSpec` defines props, state fields, keys, plugin views, filters, and append hooks. Local lines 5-45.
  - `Plugin` binds props and exposes `getState`; `PluginKey` provides collision-safe lookup. Local lines 68-89 and 125-142.

### `prosemirror-view`

- `src/index.ts`
  - `EditorView` owns the DOM, current state, `docView`, `DOMObserver`, input state, node views, and plugin views. Local lines 27-93.
  - `updateStateInner` is the render/sync pipeline. Local lines 153-233.
  - `dispatch` delegates to `dispatchTransaction` when provided, otherwise applies the transaction and updates state. Local lines 510-514.
- `src/input.ts`
  - `InputState` tracks mouse, keyboard, touch, focus, composition, and DOM-change state. Local lines 19-44.
  - `initInput` registers handlers and respects custom `handleDOMEvents`. Local lines 46-61 and 76-88.
  - Key, mouse, touch, composition, clipboard, and drag/drop handlers live here. Local lines 106-160, 278-491, and later clipboard/drop sections.
- `src/domobserver.ts`
  - `DOMObserver` wraps `MutationObserver` and `selectionchange`, queues mutations, computes document ranges, and calls `readDOMChange`. Local lines 39-80, 174-194, and 252+.
  - Contains many browser-specific guard paths for IE, Safari, Gecko, Chrome, mobile, and bogus `<br>` nodes. Local lines 55-72, 132-145, and 195-220.
- `src/domchange.ts`
  - `parseBetween` reparses the mutated DOM range in document context. Local lines 15-56.
  - `readDOMChange` turns selection-only changes or DOM diffs into transactions. Local lines 81-146 and 221-276.
  - `findDiff` calculates minimal changes and handles surrogate pair edge cases. Local lines 353-383.
- `src/viewdesc.ts`
  - `ViewDesc` is the mutable DOM-description tree, with `dom.pmViewDesc` linking DOM nodes back to descriptors. Local lines 130-151.
  - `NodeViewDesc.create` uses custom node views or schema `toDOM`. Local lines 663-723.
  - `NodeViewDesc.updateChildren` incrementally synchronizes children and decorations while protecting active compositions. Local lines 763-813 and 815-852.
- `src/decoration.ts`
  - Decorations are widget, inline, or node overlays that map through changes. Local lines 13-19, 23-103, and 105-242.
- `src/clipboard.ts`
  - Clipboard serialization uses `DOMSerializer`, `textBetween`, and `data-pm-slice` context metadata. Local lines 5-40.
  - Clipboard parsing uses text/HTML transforms, DOMParser, slice normalization, and schema context. Local lines 42-110 and 114-190.

### Supporting packages

- `prosemirror-commands/src/commands.ts`
  - Command protocol appears in source comments and implementation; base keymap chains behaviors for Enter, Backspace, Delete, and Select All. Local lines 8-15 and 736-758.
  - Parameterized commands like `wrapIn`, `setBlockType`, and `toggleMark` are schema-aware wrappers over transactions. Local lines 531-671.
- `prosemirror-keymap/src/keymap.ts`
  - Normalizes key names and modifiers, then runs command functions in plugin `handleKeyDown`. Local lines 47-78 and 83-109.
- `prosemirror-inputrules/src/inputrules.ts`
  - Regex rules trigger from `handleTextInput`, check code contexts, and dispatch a transaction. Local lines 4-56 and 79-142.
  - Undo for input rules inverts the stored transaction. Local lines 144-167.
- `prosemirror-history/src/history.ts`
  - History stores inverted steps plus maps, not whole document snapshots. Local lines 5-20.
  - Branches support rebasing, compression, and event grouping. Local lines 24-190 and 329-466.
- `prosemirror-collab/src/collab.ts`
  - Collaboration stores unconfirmed local steps with their inverted forms and origin transactions. Local lines 4-14 and 29-53.
  - `rebaseSteps` undoes local steps, applies remote steps, remaps local steps through the resulting mapping, and records mirror relationships. Local lines 14-27.
  - `receiveTransaction` confirms own steps, rebases remaining local steps over remote steps, tags the result as rebased and `addToHistory: false`, and updates the collab plugin state. Local lines 99-151.
  - `sendableSteps` exposes version, unconfirmed steps, client ID, and origin transactions for the central authority protocol. Local lines 153-178.
