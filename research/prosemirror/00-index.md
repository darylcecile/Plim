# ProseMirror Dossier — Master Index

A high-density technical reference produced for a next-gen editor spec. Every
file is grounded in the cloned ProseMirror source under
`/tmp/prosemirror-research/`. Citations use `package/src/file.ts:line`.

This index lists all 22 numbered files (some are placeholders to be filled by
sibling research tasks), gives a recommended reading order, a glossary stub of
core terms, and a "navigate by goal" map.

---

## 1. File Listing

| #  | File                                       | Topic / 1-line description |
|----|--------------------------------------------|----------------------------|
| 00 | `00-index.md`                              | This index — TOC, glossary, navigation. |
| 01 | `01-architecture-overview.md`              | Package landscape, model/state/view split, unidirectional data flow, DOM↔doc sync, immutability rationale. |
| 02 | `02-model-document-tree.md`                | `Node`, `Fragment`, `TextNode`, `Mark`; offsets, indexing, immutability invariants. |
| 03 | `03-model-schema.md`                       | `Schema`, `NodeSpec`, `MarkSpec`, attributes, content expressions, `ContentMatch`. |
| 04 | `04-model-resolved-positions.md`           | `ResolvedPos`, position arithmetic, `NodeRange`, depth, parent/before/after. |
| 05 | `05-model-slice-replace.md`                | `Slice` (open depths), `replace()` algorithm, fragment splicing. |
| 06 | `06-model-dom-roundtrip.md`                | `DOMParser` / `DOMSerializer`, `ParseRule`, `toDOM`, paste pipeline integration. |
| 07 | `07-transform-steps.md`                    | `Step` abstraction, `ReplaceStep`, `ReplaceAroundStep`, `AddMark/RemoveMarkStep`, `AttrStep`, JSON form. |
| 08 | `08-transform-mapping.md`                  | `StepMap`, `Mapping`, position recovery, association/bias, why mapping is invertible. |
| 09 | `09-transform-high-level.md`               | `Transform` helpers (`replaceRange`, `wrap`, `lift`, `setBlockType`, `join`, `split`). |
| 10 | `10-state-and-plugins.md`                  | `EditorState`, `Configuration`, `StateField`, `Plugin`, `PluginKey`, `PluginSpec`, `appendTransaction`, `filterTransaction`. |
| 11 | `11-transactions-and-selection.md`         | `Transaction` extends `Transform`, selection types (`TextSelection`/`NodeSelection`/`AllSelection`), stored marks, meta. |
| 12 | `12-commands.md`                           | `Command` signature, prosemirror-commands catalog, dry-run pattern (`dispatch?`), command composition (`chainCommands`). |
| 13 | `13-view-lifecycle.md`                     | `EditorView` constructor, `update`/`updateState`/`setProps`/`destroy`, prop merging, plugin views. |
| 14 | `14-view-input-events.md`                  | `prosemirror-view/src/input.ts`: keydown/mousedown/paste/drop/focus, `handleDOMEvents`, capture keys. |
| 15 | `15-view-domobserver-and-domchange.md`     | `MutationObserver` pipeline, `selectionchange`, `readDOMChange`, `findDiff`, IME/composition handling. |
| 16 | `16-view-viewdesc-tree.md`                 | `ViewDesc` hierarchy, `NodeViewDesc`, `MarkViewDesc`, `WidgetViewDesc`, `CompositionViewDesc`, `ViewTreeUpdater`. |
| 17 | `17-view-decorations.md`                   | `Decoration`, `DecorationSet`, widget/inline/node types, decoration sources, performance. |
| 18 | `18-view-node-views.md`                    | Custom `NodeView` interface, `update`/`destroy`/`stopEvent`/`ignoreMutation`, `MarkView`, atoms, contenteditable=false. |
| 19 | `19-keymap-and-inputrules.md`              | `prosemirror-keymap` binding resolution, modifier handling; `prosemirror-inputrules` regex-driven shortcuts. |
| 20 | `20-history.md`                            | `prosemirror-history`: `Branch`, `Item`, rope storage, undo/redo, `closeHistory`, integration with `appendTransaction`. |
| 21 | `21-collab-and-rebasing.md`                | `prosemirror-collab`: OT-style rebasing via `Mapping`, `receiveTransaction`, `sendableSteps`, version tracking. |
| 22 | `22-schemas-examples-and-extensibility.md` | `prosemirror-schema-basic`, `prosemirror-schema-list`, `prosemirror-example-setup`; how to compose a real editor. |

> Files 02–22 are owned by sibling research tasks. This task delivers
> `00-index.md` and `01-architecture-overview.md`.

---

## 2. Recommended Reading Order

For people building a next-gen editor, read top-to-bottom — each layer builds
on the previous one.

1. **Foundations.** `01` (architecture) → `02` (document tree) → `03` (schema)
   → `04` (resolved positions) → `05` (slice/replace).
2. **DOM bridge for the model.** `06` (DOM round-trip) — needed for paste,
   serialization, initial content.
3. **Mutating documents.** `07` (steps) → `08` (mapping) → `09` (transform
   helpers).
4. **Stateful editor.** `10` (state + plugins) → `11` (transactions/selection)
   → `12` (commands).
5. **View layer.** `13` (lifecycle) → `14` (input) → `15` (DOM observer/IME)
   → `16` (viewdesc) → `17` (decorations) → `18` (node views).
6. **Composable editor surface.** `19` (keymap/inputrules) → `20` (history)
   → `21` (collab) → `22` (schemas + example setup).

If you have only an hour: read `01`, `10`, `13`, `15`. That gives you the
spine: data flow, state, view lifecycle, and the DOM↔doc bridge.

---

## 3. Glossary Stub

Definitions are intentionally short; canonical detail lives in the file
referenced in parentheses.

- **Schema** — Declarative description of allowed node types, mark types,
  attributes, and content expressions; every `Node` belongs to exactly one
  schema. (`03`, `prosemirror-model/src/schema.ts:572`.)
- **Node** — Immutable element in the document tree. May be a text node,
  inline non-text node, or block node. Holds a `NodeType`, attrs, a `Fragment`
  of children, and inline `Mark[]`. (`02`, `prosemirror-model/src/node.ts:22`.)
- **Mark** — Immutable label attached to inline content (e.g. `strong`,
  `link`). Sets are deduplicated and ordered. (`02`,
  `prosemirror-model/src/mark.ts:10`.)
- **Fragment** — Immutable ordered list of sibling nodes with cached size
  metadata. (`02`, `prosemirror-model/src/fragment.ts:10`.)
- **Slice** — A `Fragment` plus `openStart`/`openEnd` depths describing how
  many levels at each end are "cut open" (not closed nodes). The unit of
  `replace()`. (`05`, `prosemirror-model/src/replace.ts:24`.)
- **Transform** — Mutable accumulator of `Step`s applied to a starting
  document, producing a sequence of intermediate docs and a `Mapping`. Pure
  data — no editor coupling. (`07`/`09`,
  `prosemirror-transform/src/transform.ts:28`.)
- **Step** — Atomic, invertible, JSON-serializable document edit. The OT
  primitive. (`07`, `prosemirror-transform/src/step.ts:16`.)
- **Mapping** — Composition of `StepMap`s that translate positions across a
  sequence of edits. Foundation for collaborative rebasing and decoration
  bookkeeping. (`08`, `prosemirror-transform/src/map.ts:172`.)
- **ResolvedPos** — A position annotated with the full path of ancestor
  nodes/indices/offsets, enabling O(depth) navigation. (`04`,
  `prosemirror-model/src/resolvedpos.ts:12`.)
- **EditorState** — Immutable bundle: `doc`, `selection`, `storedMarks`, plus
  one slot per plugin's `StateField`. New states are produced by
  `state.apply(tr)`. (`10`, `prosemirror-state/src/state.ts:90`.)
- **Plugin** — Composable behavior unit: optional state field, `props` (view
  hooks), `view` factory, and transaction filters/appenders. Identified by an
  optional `PluginKey`. (`10`, `prosemirror-state/src/plugin.ts:71`.)
- **EditorView** — Mutable DOM-rendering controller. Owns the DOM, input
  handlers, `DOMObserver`, `docView` (ViewDesc tree). Receives `EditorState`s
  and reconciles the DOM. (`13`, `prosemirror-view/src/index.ts:30`.)
- **ViewDesc** — Internal tree mirroring the document, mapping each
  doc/decoration/mark to a DOM range. Powers reconciliation and pos↔DOM
  conversion. (`16`, `prosemirror-view/src/viewdesc.ts:136`.)
- **NodeView** — User-supplied custom rendering for a node type, with hooks
  for updates, mutations, events. (`18`,
  `prosemirror-view/src/viewdesc.ts:31`.)
- **Decoration** — View-only annotation (widget, inline attrs, node attrs)
  carried in a `DecorationSet`, mapped through transactions. (`17`,
  `prosemirror-view/src/decoration.ts:108`.)
- **ParseRule / DOMSerializer** — `prosemirror-model`'s DOM↔doc converter
  pair, configurable per `NodeSpec`/`MarkSpec`. (`06`,
  `prosemirror-model/src/from_dom.ts`, `prosemirror-model/src/to_dom.ts`.)

---

## 4. How to Navigate by Goal

| Goal                                                            | Read |
|-----------------------------------------------------------------|------|
| Understand the overall design philosophy                        | `01`, then `10` |
| Define a custom document schema (custom block, mark, attribute) | `03`, `06`, `22` |
| Compute or migrate document positions                           | `04`, `08` |
| Implement a custom edit operation (e.g. "wrap in callout")      | `07`, `09`, `12` |
| Build a plugin that tracks state (e.g. presence, lint)          | `10`, `11`, `17` |
| Implement undo/redo or rebase against a server                  | `08`, `20`, `21` |
| Render a node with React/Vue/Svelte                             | `16`, `18`, `13` |
| Add overlays/highlights without touching the document           | `17`, `18` |
| Support IME / dead keys / Android GBoard                        | `14`, `15`, `13` |
| Handle paste / drag-drop / clipboard                            | `06`, `14`, `17` |
| Bind keyboard shortcuts                                         | `19`, `12` |
| Ship Markdown/WYSIWYG transforms while typing                   | `19`, `07` |
| Debug "why is the DOM out of sync with the doc?"                | `15`, `16`, `13` |
| Build a multi-user collaborative editor                         | `21`, `08`, `20` |
| Replace ProseMirror's view but keep the model/state             | `01`, `13`, `16` |

---

## 5. Source Tree Reference

Cloned repos under `/tmp/prosemirror-research/`:

```
prosemirror-model/         doc tree, schema, slice, DOM I/O      (no PM deps)
prosemirror-transform/     steps, mapping, transform helpers      → model
prosemirror-state/         immutable state, plugins, transactions → model, transform, view*
prosemirror-view/          DOM rendering, input, MutationObserver → model, state, transform
prosemirror-commands/      stock editing commands                 → model, transform, state
prosemirror-keymap/        keyboard shortcut plugin               → state
prosemirror-inputrules/    regex-driven inline transforms         → state, transform
prosemirror-history/       undo/redo plugin                       → state, transform, view
prosemirror-collab/        OT rebasing plugin                     → state
prosemirror-schema-basic/  starter doc/text/paragraph schema      → model
prosemirror-schema-list/   list nodes + commands                  → model, transform, state
prosemirror-example-setup/ batteries-included demo wiring         → many
website/                   guides, examples, markdown reference
```

\* `prosemirror-state` declares `prosemirror-view` only as a *type* dep so
that selections can reference `EditorView` for click handling; it does not
pull view at runtime.
