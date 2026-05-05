# Plim Architecture (ProseMirror-inspired)

Design spec for a Plim editor that aligns with `api-wishlist.md` and takes inspiration from ProseMirror — without using ProseMirror or Tiptap as a runtime dependency.

| # | Doc | Topic |
|---|-----|-------|
| 00 | [overview](./00-overview.md) | Layered architecture, primitives, end-to-end flows, why this fixes the recurring example bugs |
| 01 | [schema-and-state](./01-schema-and-state.md) | `defineBlock`/`defineMark`, content expressions, `Schema`, `EditorState`, `Document`, `Selection`, `Transaction`, `Step`, `Mapping`, validation rules registry, bridge to `@plim/model` |
| 02 | [view-and-dom](./02-view-and-dom.md) | `EditorView`, `ViewDesc` tree, render pipeline, `DOMObserver`, `readDOMChange`, parser/serializer, selection mapping, click/IME/keymap, decorations, regression checklist |
| 03 | [actions-and-triggers](./03-actions-and-triggers.md) | `defineAction`, `triggers.*`, `triggerValidationRules` (`and`/`or`), `cancellationTriggers`, priority, async event bus, built-in actions catalog, `ActionRouter` |
| 04 | [input-and-paste](./04-input-and-paste.md) | `defineInputRule`/`definePasteRule`, clipboard pipeline, copy/cut/paste, drag and drop, `beforeinput`, IME, slash/mention/emoji lifecycle, markdown rule pack |
| 05 | [extensions](./05-extensions.md) | `defineExtension`, `ExtensionManager`, dependency graph, caching, lifecycle hooks, built-in extension catalog, `extendBlock/Mark/Action`, testing |
| 06 | [history-and-snapshots](./06-history-and-snapshots.md) | `historyPlugin`, undo/redo with mapping-aware remap, `HistoryHandle`, `Snapshot`, schema migrations, time-travel debugging |
| 07 | [react-bindings](./07-react-bindings.md) | `<PlimEditor />`, `useEditorHandle`, `useAsyncEventListener`, `toComponent`/`PlimChildren`, node views, SSR, Tailwind hooks, codemod |
| 08 | [packages-and-migration](./08-packages-and-migration.md) | Target package layout, dependency graph, 9-phase migration plan with exit criteria |
| 09 | [wishlist-api-mapping](./09-wishlist-api-mapping.md) | Every `api-wishlist.md` API → exact final TS signature, package path, full compilable program, stability matrix, symbol index |

**Reading order**

- Implementers: 00 → 08 → 09 → 01 → 02 → 03 → 04 → 05 → 06 → 07.
- API consumers: 09 first, then 03 and 07.

**Authoritative source**: `api-wishlist.md` (root). Anything in this folder that contradicts the wishlist is a bug in this folder.
