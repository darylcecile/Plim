# ProseMirror Dossier — Master Index

A high-density technical reference produced for a next-gen editor spec. Every
file is grounded in the cloned ProseMirror source. Citations use
`package/src/file.ts:line`.

This index lists all 23 files actually present in this directory, gives a
recommended reading order, a glossary, scope/version notes, and a
"navigate by goal" map.

---

## 1. File Listing

The list below matches the on-disk files in `research/prosemirror/`. The
numbering is contiguous; topics that don't have a dedicated file (notably
the model-side DOM round-trip — see GAP note in §6) are folded into the
neighbouring chapters and are also called out in the "navigate by goal"
table.

| #  | File                                          | Topic / 1-line description |
|----|-----------------------------------------------|----------------------------|
| 00 | `00-index.md`                                 | This index — TOC, glossary, scope, navigation. |
| 01 | `01-architecture-overview.md`                 | Package landscape, model/state/view split, unidirectional data flow, DOM↔doc sync, immutability rationale. |
| 02 | `02-document-model.md`                        | `Node`, `Fragment`, `TextNode`, `Mark`, `Slice`; offsets, equality, JSON, `replace()`. |
| 03 | `03-schema-and-content-expressions.md`        | `Schema`, `NodeSpec`, `MarkSpec`, attribute specs, content-expression mini-language, NFA/DFA `ContentMatch`. |
| 04 | `04-resolved-positions.md`                    | `ResolvedPos`, position arithmetic, `NodeRange`, depth, parent/before/after. |
| 05 | `05-transform-and-steps.md`                   | `Step`, `ReplaceStep`/`ReplaceAroundStep`, `AddMark/RemoveMarkStep`, `AttrStep`, `Transform` helpers (`replaceRange`, `wrap`, `lift`, `setBlockType`, `join`, `split`), `Fitter`. |
| 06 | `06-position-mapping.md`                      | `StepMap`, `Mapping`, `MapResult`, `Mappable`, position recovery (`recover`/`mirror`), association/bias, collab rebasing. |
| 07 | `07-state-and-plugins.md`                     | `EditorState`, `Configuration`, `StateField`, `Plugin`, `PluginKey`, `PluginSpec`, `Transaction`, `appendTransaction` fixpoint, `filterTransaction`. |
| 08 | `08-selection.md`                             | `Selection` base class, `TextSelection`/`NodeSelection`/`AllSelection`, `SelectionRange`, `SelectionBookmark`, mapping selections. |
| 09 | `09-view-and-viewdesc.md`                     | `EditorView` lifecycle, `ViewDesc` tree, prop merging, plugin views, `someProp`. |
| 10 | `10-decorations.md`                           | `Decoration`, `DecorationSet`, widget/inline/node decorations, mapping, performance. |
| 11 | `11-dom-parser.md`                            | `DOMParser`, `ParseRule` (`TagParseRule`/`StyleParseRule`/`GenericParseRule`), `ParseOptions`, parse-context selectors, `getAttrs`. |
| 12 | `12-dom-serializer.md`                        | `DOMSerializer`, `DOMOutputSpec`, `serializeFragment`, hole positions, mark serialization. |
| 13 | `13-input-pipeline.md`                        | `prosemirror-view/src/input.ts`: keydown/mousedown/paste/drop/focus, `handleDOMEvents`, `capturekeys.ts`. |
| 14 | `14-ime-composition.md`                       | Composition state machine, `view.composing`, `compositionend`, `clearComposition`, browser quirks. |
| 15 | `15-domobserver-and-domchange.md`             | `MutationObserver` pipeline, `selectionchange`, `readDOMChange`, `findDiff`, Android/iOS heuristics. |
| 16 | `16-clipboard.md`                             | Copy/cut/paste pipeline, `__parseFromClipboard`/`serializeForClipboard`, `Slice.maxOpen`, paste context selectors. |
| 17 | `17-coordinates-and-hit-testing.md`           | `view.coordsAtPos`, `view.posAtCoords`, `domcoords.ts`, line/page geometry. |
| 18 | `18-cross-browser-quirks.md`                  | `browser.ts` flags, IE/Safari/Chrome/Firefox/iOS/Android-specific paths. |
| 19 | `19-commands-keymap-inputrules.md`            | `Command` signature, `chainCommands`, `prosemirror-commands` catalog, `keymap` plugin, `inputRules`. |
| 20 | `20-history-and-collab.md`                    | `prosemirror-history` (`Branch`/`Item`/rope), undo/redo, `closeHistory`; `prosemirror-collab` rebasing, `receiveTransaction`, `sendableSteps`. |
| 21 | `21-rendering-pipeline-end-to-end.md`         | Full top-to-bottom render trace from `dispatch` to repaint. |
| 22 | `22-edge-cases-and-pitfalls.md`               | Catalog of well-known footguns, undocumented invariants, and "why does X behave like that" answers. |

---

## 2. Recommended Reading Order

For people building a next-gen editor, read top-to-bottom — each layer builds
on the previous one.

1. **Foundations.** `01` (architecture) → `02` (document model) → `03`
   (schema + content expressions) → `04` (resolved positions).
2. **Mutating documents.** `05` (transform & steps) → `06` (position mapping).
3. **Stateful editor.** `07` (state + plugins) → `08` (selection).
4. **View layer.** `09` (view + viewdesc) → `10` (decorations) → `11` (DOM
   parser) → `12` (DOM serializer).
5. **Input + DOM bridging.** `13` (input pipeline) → `14` (IME composition)
   → `15` (DOM observer / domchange) → `16` (clipboard) → `17` (coordinates
   / hit testing) → `18` (cross-browser quirks).
6. **Composable editor surface.** `19` (commands + keymap + inputrules) →
   `20` (history + collab) → `21` (end-to-end render trace) → `22`
   (edge cases / pitfalls).

If you have only an hour: read `01`, `07`, `09`, `15`. That gives you the
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
  pair, configurable per `NodeSpec`/`MarkSpec`. (`11`/`12`,
  `prosemirror-model/src/from_dom.ts`, `prosemirror-model/src/to_dom.ts`.)
- **Mappable** — Interface implemented by anything that can map a position
  forward through edits: `StepMap`, `Mapping`. Has `map(pos, assoc?)` and
  `mapResult(pos, assoc?)`. (`06`, `prosemirror-transform/src/map.ts:3`.)
- **MapResult** — Output of `Mappable.mapResult`: a mapped position plus
  bit flags `deleted`, `deletedBefore`, `deletedAfter`, `deletedAcross`.
  (`06`, `prosemirror-transform/src/map.ts:32`.)
- **recover** — Encoded "where was this position before the edit?" token
  used by `StepMap` to restore a deleted position to its original neighbour.
  (`06`, `prosemirror-transform/src/map.ts:50–70`.)
- **mirror** — A `Mapping` annotation that pairs two `StepMap`s as inverses
  of each other; collab rebasing relies on it. (`06`,
  `prosemirror-transform/src/map.ts:172–210`.)
- **delInfo** — Bit-packed deletion flags returned by `StepMap._map`'s
  position-mapping algorithm; surfaced on `MapResult`.
- **assoc** — Position-bias parameter (`-1` or `+1`). Decides which side of
  a deletion an edge-of-deletion position sticks to.
- **Bookmark** — Lightweight serializable form of a `Selection` that
  survives mapping. (`08`, `prosemirror-state/src/selection.ts`.)
- **appendTransaction** — Plugin hook that may emit follow-up transactions
  during the post-`applyInner` fixpoint loop. (`07`,
  `prosemirror-state/src/state.ts:148`.)
- **meta** — Per-transaction key/value store (`tr.setMeta(key, val)` /
  `tr.getMeta(key)`); the canonical channel for plugin-to-plugin signals.
  (`07`, `prosemirror-state/src/transaction.ts`.)
- **FieldDesc** — Internal record describing one slot in `EditorState`
  (a built-in or plugin-supplied state field). (`07`,
  `prosemirror-state/src/state.ts`.)
- **Configuration** — Frozen bundle of `(schema, plugins, fields)` shared
  between every state produced by `state.apply`. (`07`,
  `prosemirror-state/src/state.ts`.)
- **Fitter** — Algorithm in `prosemirror-transform/src/replace.ts` that
  takes a desired slice and a destination range and produces the actual
  `ReplaceStep`/`ReplaceAroundStep`. (`05`,
  `prosemirror-transform/src/replace.ts`.)
- **clearIncompatible** — Helper that strips marks/content disallowed by
  the destination schema, used when `setBlockType`/clipboard cross schema
  boundaries. (`05`, `prosemirror-transform/src/structure.ts`.)
- **linebreakReplacement** — `NodeSpec` flag identifying the inline leaf
  that round-trips with `\n` (typically `hard_break`). At most one type
  per schema may carry it. (`03`, `prosemirror-model/src/schema.ts:486,613`.)
- **ContentMatch** — A DFA state representing "where am I inside this
  node's content expression?". The schema layer's oracle for legality.
  (`03`, `prosemirror-model/src/content.ts:10`.)
- **NFA / DFA** — Thompson-construction NFA built from the content
  expression AST, then determinized to a `ContentMatch` graph at schema
  compile time. (`03`, `prosemirror-model/src/content.ts:282`.)
- **wrappings** — A `findWrapping` result: list of node types that, when
  wrapped around a target node, produce content acceptable at a given
  position. Cached per `(state, target)` in `ContentMatch.wrapCache` and
  per-schema in `Schema.cached.wrappings`. (`03`,
  `prosemirror-model/src/content.ts:104–133`.)
- **Command** — Function `(state, dispatch?, view?) => boolean` exported
  from `prosemirror-state` and used everywhere from keymap to menu UI.
  (`07`/`19`, `prosemirror-state/src/transaction.ts`.)

---

## 4. How to Navigate by Goal

| Goal                                                            | Read |
|-----------------------------------------------------------------|------|
| Understand the overall design philosophy                        | `01`, then `07` |
| Define a custom document schema (custom block, mark, attribute) | `03`, `11`, `12` |
| Compute or migrate document positions                           | `04`, `06` |
| Implement a custom edit operation (e.g. "wrap in callout")      | `05`, `19` |
| Build a plugin that tracks state (e.g. presence, lint)          | `07`, `08`, `10` |
| Implement undo/redo or rebase against a server                  | `06`, `20` |
| Render a node with React/Vue/Svelte                             | `09`, `10` |
| Add overlays/highlights without touching the document           | `10`, `09` |
| Support IME / dead keys / Android GBoard                        | `13`, `14`, `15` |
| Handle paste / drag-drop / clipboard                            | `16`, `11`, `13` |
| Bind keyboard shortcuts                                         | `19` |
| Ship Markdown/WYSIWYG transforms while typing                   | `19`, `05` |
| Debug "why is the DOM out of sync with the doc?"                | `15`, `09`, `18` |
| Build a multi-user collaborative editor                         | `20`, `06` |
| Replace ProseMirror's view but keep the model/state             | `01`, `09` |

---

## 5. Source Tree Reference

The dossier was written against locally-cloned ProseMirror sources at
`/tmp/pm-source/`. The reader is expected to populate this path before
following citations:

```sh
mkdir -p /tmp/pm-source && cd /tmp/pm-source
for r in model transform state view commands keymap inputrules history \
         collab schema-basic schema-list example-setup gapcursor dropcursor \
         tables test-builder; do
  git clone --depth=1 "https://github.com/ProseMirror/prosemirror-$r"
done
```

Cloned repos under `/tmp/pm-source/`:

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
prosemirror-tables/        table nodes + commands                 → many
website/                   guides, examples, markdown reference
```

\* `prosemirror-state` declares `prosemirror-view` only as a *type* dep so
that selections can reference `EditorView` for click handling; it does not
pull view at runtime.

### 5.1 Version pin

This dossier was assembled against the `master` HEAD of each repo at the
following approximate commit dates (line numbers were verified at the time
of writing — drift is possible):

| Package | Snapshot date | Notes |
|---------|---------------|-------|
| `prosemirror-model` | 2024 | Includes `linebreakReplacement`, `AttributeSpec.validate`. |
| `prosemirror-transform` | 2024 | Includes `Transform.setNodeAttribute` / `setDocAttribute`, `DocAttrStep`. |
| `prosemirror-state` | 2024 | Includes `appendTransaction` `seen` book-keeping (`state.ts:148`). |
| `prosemirror-view` | 2024 | Includes `markViews`, `__endComposition` test hook. |

If you regenerate this dossier later, pin the snapshot in a
`research/prosemirror/source-versions.lock` file and re-verify any cited
line number whose surrounding code may have shifted.

---

## 6. Scope and Non-goals

What this dossier **covers** in depth (files 00–22 above):

- The four core packages (`prosemirror-model`, `-transform`, `-state`,
  `-view`) at the level needed to re-implement them.
- Schema, content expressions, position arithmetic, transforms, mapping,
  state/plugins, selection, view layer, decorations, DOM I/O, input
  pipeline, IME, clipboard, history, collab.

What is **partially covered or out of scope**:

- `prosemirror-schema-basic` / `-schema-list`: used as examples but not
  documented exhaustively. `splitListItem`/`liftListItem`/`sinkListItem`
  appear in `19` only as references.
- `prosemirror-example-setup`: only mentioned for orientation; treat its
  source as the canonical "real editor wiring" reference.
- `prosemirror-gapcursor`, `-dropcursor`, `-tables`: mentioned in
  `22-edge-cases-and-pitfalls.md` only.
- React/Vue/Svelte wrappers (`prosemirror-react`, `tiptap`, etc.) are
  **out of scope** — only the underlying `NodeView` interface is covered.
- Markdown round-tripping (`prosemirror-markdown`) is **out of scope**.
- ProseMirror's history of API evolution (deprecated `EditorView.props`,
  legacy `Compose` API, etc.) is **out of scope** — the dossier targets
  current `master`.

The dossier is structured so the four core packages can be inhaled
independently of the surrounding ecosystem. If you need any of the
out-of-scope topics, treat the cited package source as the reference.
