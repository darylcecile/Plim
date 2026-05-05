# Plim Architecture — Overview

> Status: **Authoritative spec, design phase**. Inspired by ProseMirror's separation of state/view/transform, but Plim-native. We do **not** use ProseMirror or Tiptap as a runtime dependency.
>
> Companion docs:
> - `01-schema-and-state.md` — schema, document state, transactions, steps
> - `02-view-and-dom.md` — view layer, DOM observer/parser/renderer, selection mapping
> - `03-actions-and-triggers.md` — action system, triggers, validation rules, cancellation
> - `04-input-and-paste.md` — input rules, paste rules, clipboard, IME
> - `05-extensions.md` — extension API and lifecycle
> - `06-history-and-snapshots.md` — undo/redo and snapshots
> - `07-react-bindings.md` — `@plim/react`
> - `08-packages-and-migration.md` — package layout, migration plan
> - `09-wishlist-api-mapping.md` — `api-wishlist.md` → concrete TS APIs

## 1. Goals

1. **API parity with `api-wishlist.md`.** Every snippet in the wishlist must compile and behave as documented. Where the wishlist is silent we extend; where it is opinionated we follow it exactly.
2. **DOM is a render target, not the source of truth.** All edits flow through transactions on a virtual document. The DOM is observed, parsed, and reconciled — never trusted directly.
3. **Schema-first.** Blocks and marks are declared up front (`defineBlock`, `defineMark`). The schema validates documents, parses DOM, and serializes DOM/components.
4. **One pipeline for all input.** Typing, paste, drop, programmatic edits, and remote edits all produce `Transaction`s applied through the same dispatch pipeline.
5. **Pluggable everywhere.** Behaviour is composed through extensions (which register blocks, marks, actions, plugins) — there is no privileged "core" behaviour that extensions can't replicate.
6. **Headless / framework-agnostic core.** `@plim/core` and `@plim/view` know nothing about React. `@plim/react` is a thin renderer over `@plim/view`.

## 2. Non-goals

- Server, persistence, collab transport. Out of scope. (We ship CRDT-friendly primitives — see `06-history-and-snapshots.md` — but no transport.)
- Legacy browser support. Modern Chrome/Safari/Firefox only.
- Reusing ProseMirror's runtime. We borrow shapes and patterns; we do not import its packages.

## 3. Layered architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    @plim/react                              │
│  PlimEditor, useEditorHandle, useAsyncEventListener,        │
│  React node-view bridge over @plim/view                     │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────┴──────────────────────────────┐
│                    @plim/view                               │
│  EditorView, DOMObserver, DOMParser, DOMSerializer,         │
│  ViewDesc tree, SelectionMapper, IME/composition handler,   │
│  paste/drop pipeline, keymap dispatcher                     │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────┴──────────────────────────────┐
│                    @plim/editor                             │
│  AgnosticEditor (deriveEditor), container adapters,         │
│  transaction queue, async event bus, ready lifecycle        │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────┴──────────────────────────────┐
│                    @plim/core                               │
│  PlimDriver, EditorState, Schema, Transaction, Step,        │
│  Mapping, defineBlock, defineMark, defineAction,            │
│  defineExtension, ExtensionManager, History, Snapshot,      │
│  triggers, validation rule registry, plugin contract        │
└──────────────────────────────┬──────────────────────────────┘
                               │
                ┌──────────────┴──────────────┐
                │      @plim/model            │  (existing)
                │  RichText, block payloads,  │
                │  pure data shapes           │
                └─────────────────────────────┘
```

Side packages: `@plim/markdown` (markdown↔state), `@plim/blocks` (built-in block defs), `@plim/marks` (built-in mark defs), `@plim/actions` (built-in actions: bold, italic, slash, mention, emoji, cut/copy/paste, history).

## 4. Core primitives (canonical names)

These names are normative — every other doc must use them.

| Primitive | Purpose | Lives in |
|-----------|---------|----------|
| `PlimDriver` | The configured "instance" — schema + extensions + actions + history factory. Stateless w.r.t. a single editor; produces editors. | `@plim/core` |
| `Schema` | Compiled set of `BlockSpec`s + `MarkSpec`s built from `registeredBlocks`/`registeredMarks` + extensions. Knows content rules, parseDOM, toDOM, toComponent. | `@plim/core` |
| `EditorState` | Immutable snapshot: `{ doc, selection, schema, plugins, storedMarks, history }`. | `@plim/core` |
| `Transaction` | Mutation builder against an `EditorState`. Composed of `Step`s. Produces a new `EditorState` when committed. | `@plim/core` |
| `Step` | Atomic mutation: `ReplaceStep`, `AddMarkStep`, `RemoveMarkStep`, `SetBlockAttrsStep`, `MoveStep`, etc. Invertible. | `@plim/core` |
| `Mapping` | Position remapping across step sequences (used for selection, decorations, collab). | `@plim/core` |
| `AgnosticEditor` | A live editor instance: state holder + transaction dispatcher + container adapter + async event bus. | `@plim/editor` |
| `EditorView` | The DOM-bound presentation of an `AgnosticEditor`. Owns the view-desc tree, observer, parser. | `@plim/view` |
| `ViewDesc` | One-to-one mirror of a model node in the DOM, indexed by `data-plim-id`. | `@plim/view` |
| `Plugin` | `{ key, state?, props?, appendTransaction? }`. Pure, ProseMirror-style plugin contract. | `@plim/core` |
| `Action` | High-level user-facing operation: `{ name, trigger, triggerValidationRules, cancellationTriggers, perform, priority }`. Runs **above** plugins; uses the public `ctx` API. | `@plim/core` |
| `Extension` | Bundle of `{ registeredBlocks, registeredMarks, registeredActions, plugins, onTransaction, onAsyncEvent }`. Cached per `(driver, extensionId)`. | `@plim/core` |
| `Snapshot` | Serializable `EditorState` capture, restorable into any editor with a compatible schema. | `@plim/core` |

### Why both Plugin and Action?

ProseMirror has plugins. The wishlist uses Actions. They serve different layers:

- **Plugins** are low-level, internal, and operate on `EditorState`/`Transaction` — input rules, paste rules, decorations, history, collab, keymap. Authors of the editor's internal behaviour write plugins.
- **Actions** are high-level, user-facing, and operate on the public `state`/`ctx` API. Application code writes actions. Built-in keyboard shortcuts (Mod+B → bold) are actions.

An action `perform` receives `state` (read-only view of `EditorState` + selection + cursor position) and `ctx` (`{ createTransaction, triggerAsyncEvent, getSchema, getView, dispatch, getRegistry }`). Internally an action becomes one or more transactions through `ctx.createTransaction().…commit()`.

## 5. End-to-end data flow (typing the letter `b`)

```
keydown 'b' (no Mod)
  └─► EditorView.handleKeyDown → no action match (Mod+B requires modifier)
        └─► browser writes 'b' into contenteditable
              └─► DOMObserver flushes mutations on next microtask
                    └─► DOMObserver.readDOMChange(fromPos, toPos)
                          ├─► parseBetween(parentDom, from, to) using Schema.parseDOM
                          ├─► findDiff(oldSlice, newSlice) → { start, endA, endB, text }
                          └─► dispatch(tr.replace(start, endA, parsedSlice))
                                ├─► plugins.appendTransaction(tr) (input rules, etc.)
                                ├─► state' = state.apply(tr)
                                ├─► history records step (unless meta.addToHistory=false)
                                ├─► EditorView.update(state')
                                │     └─► ViewDesc.diff & patch DOM (only dirty descs)
                                │     └─► SelectionMapper.write(state'.selection)
                                ├─► AgnosticEditor.onTransaction listeners fire
                                └─► Extensions.onTransaction hooks fire
```

## 6. End-to-end data flow (typing `## ` to make a heading)

```
keypress ' ' after '##'
  └─► browser writes ' ' into DOM
        └─► DOMObserver → readDOMChange → tr1 = replace(insert ' ')
              └─► plugins.appendTransaction(tr1)
                    └─► markdownInputRulePlugin matches /^(#{1,3}) $/
                          └─► returns tr2 that:
                                • setBlockType(blockId, 'heading', { level: 2 })
                                • replace block textContent (drop leading '## ')
                          └─► dispatch(tr1+tr2 as a single composite transaction)
```

The `## ` characters are removed by the input rule's replace step — fixing the persistent bug where the markdown trigger characters lingered.

## 7. End-to-end data flow (Mod+B with selection)

```
keydown Mod+B
  └─► EditorView.handleKeyDown
        └─► ActionRouter.findMatching('keyboard.shortcut', 'Mod+b')
              └─► validate triggerValidationRules:
                    and([selectionNotEmpty, blockSupportsDecoration]) → ok
              └─► action.perform(state, ctx)
                    └─► ctx.createTransaction().toggleMark('bold', range).commit()
                          └─► dispatch as above
        └─► event.preventDefault()
```

## 8. Threading model

- All editor mutations are synchronous and run on the main thread.
- Async events (`triggerAsyncEvent`) suspend the action's `perform` promise but do **not** suspend the dispatch loop. Other transactions (typing) can interleave; the action holds a `Mapping` that remaps any positions it captured.
- DOMObserver flushes are scheduled via microtask. During a flush, plugins run synchronously.
- IME composition is detected via `compositionstart`/`compositionend`; the observer batches mutations into one transaction at `compositionend`.

## 9. Identity & addressing

- Every block in the model has a stable `id: string` (already true in `@plim/model`).
- Every rendered DOM node carries `data-plim-id="<blockId>"` on the block root and `data-plim-mark="<markName>"` on mark wrappers.
- `ViewDesc` is keyed by `id`. A re-render that finds a matching `id` updates in place; a missing `id` removes; a new `id` mounts.
- Positions in `Transaction`s are `(blockId, offset)` tuples for ergonomics, but resolve internally to `(absolutePos)` for `Step`s. `Mapping` operates on absolute positions.

## 10. Why this architecture fixes the recent bug class

The vanilla and React examples have repeatedly broken because:

1. They sample DOM `textContent` ad-hoc on `blur`, `Enter`, `Backspace`, etc., losing inline marks, mishandling IME, and dropping space/backspace at boundaries.
2. They duplicate behaviour between vanilla and React.
3. Markdown trigger removal is hand-coded per shortcut.

This architecture eliminates all three:

1. The DOM observer + dirty-range parser is the **only** thing that reads the DOM. It runs on every mutation, including space/backspace, and produces a transaction or no-op deterministically.
2. Both examples become thin: vanilla mounts an `EditorView`, React renders `<PlimEditor />`. All editing behaviour lives in `@plim/view` + plugins.
3. Markdown is a single input-rule plugin; trigger characters are removed by the rule's replace step, not by ad-hoc string slicing.

## 11. Inheritance from ProseMirror — and where we diverge

| Concept | ProseMirror | Plim |
|---------|-------------|------|
| State / View / Transform split | yes | yes |
| Schema with content expressions | yes | yes (block-level only — see §3 of `01-schema-and-state.md`) |
| Steps & inverses | yes | yes |
| Plugin keys & plugin state | yes | yes |
| DOM observer + parseBetween + findDiff | yes | yes |
| InputRule / PasteRule | plugin patterns | first-class types (`defineInputRule`, `definePasteRule`) |
| User-facing commands | `Command` type, ad-hoc | **`Action` type** with declarative triggers/validation/cancellation (per wishlist) |
| Extension assembly | manual | `defineExtension` + `ExtensionManager` (per wishlist) |
| Component rendering | node views (DOM) | node views **+ optional `toComponent`** for React (per wishlist) |
| Marks structure | inline marks on text nodes | same |
| Block payload model | nodes with attrs | `BlockPayload` (per wishlist) — `{ id, type, attributes, content, children }` |
| Snapshots | manual (state.toJSON) | first-class `Snapshot` class (per wishlist) |
| Async UI hooks | none | `triggerAsyncEvent` + `onAsyncEvent` (per wishlist) |

## 12. Open questions answered up front

- **"Can two extensions register the same block name?"** No — `ExtensionManager` throws at assembly. Last-wins is too dangerous; explicit override APIs (`overrideBlock(name, spec)`) are provided instead.
- **"Are actions executed inside or outside the dispatch loop?"** Outside. They produce transactions through `ctx`. This means `await` inside a `perform` is safe.
- **"How are positions stable across async actions?"** Each `ctx` capture binds a `Mapping` that updates as transactions commit. Positions accessed after `await` are remapped automatically.
- **"What's the minimum browser API requirement?"** `MutationObserver`, `Selection`/`Range`, `getBoundingClientRect`, `requestAnimationFrame`, `ClipboardEvent.clipboardData`, `InputEvent.inputType`, `composition*` events. All available in modern Chrome/Safari/Firefox.

## 13. Reading order

For implementers: 00 → 08 (packages) → 09 (wishlist mapping) → 01 (schema/state) → 02 (view/dom) → 03 (actions) → 04 (input/paste) → 05 (extensions) → 06 (history) → 07 (react).

For API consumers: 09 first, then 03 and 07.
