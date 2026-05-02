# Plim

A browser-safe TypeScript monorepo for building Notion-compatible WYSIWYG editors.

## Package layout

- `@plim/model` (`packages/model`) — canonical document records, rich text, IDs, validation, normalization, serialization, and transaction helpers.
- `@plim/blocks` (`packages/blocks`) — built-in block catalog, default data factories, nesting rules, slash metadata, normalization, and validation.
- `@plim/editor` (`packages/editor`) — framework-agnostic editor runtime with immutable state, transactions, command/plugin registries, rendering hooks, undo/redo, and persistence adapters.
- `@plim/input` (`packages/input`) — command definitions, keyboard shortcuts, slash menus, Markdown input rules, autocomplete, clipboard/drop parsing, and composition guards.
- `@plim/selection` (`packages/selection`) — logical text/block selections, selection mapping, drag/drop target resolution, layout helpers, and announcements.
- `@plim/databases` (`packages/databases`) — client-side data sources, property values, filters, sorts, grouping, formulas, relations, rollups, updates, and database-view queries.
- `@plim/react` (`packages/react`) — React bindings and components over the model/editor concepts with React as a peer dependency.

The monorepo uses pnpm workspaces and ESM TypeScript packages.

## Basic usage

```ts
import { createEditor, createIdFactory, createParagraphBlock } from '@plim/editor';

const clock = { now: () => new Date().toISOString() };
const idFactory = createIdFactory();
const editor = createEditor({ clock, idFactory });
const rootPageId = editor.rootPageId;
const paragraph = createParagraphBlock({
  workspaceId: editor.state.document.workspace.id,
  parent: { kind: 'page', pageId: rootPageId },
  text: 'Hello Plim',
  clock,
  idFactory
});

await editor.dispatch([
  { op: 'create_block', block: paragraph },
  { op: 'insert_child', parentId: rootPageId, childId: paragraph.id, at: { kind: 'append' } }
]);
```

## Examples

See [`examples/basic-editor`](examples/basic-editor) for a browser-oriented TypeScript app with a Notion-like document surface. It opens to a clean centered page, lets you edit the page title and blocks directly, exposes subtle block add/handle controls, supports inline slash commands, hides package diagnostics behind **Developer details**, and persists snapshots locally.

Run it after installing and building the workspace packages:

```sh
pnpm install
pnpm run build
pnpm --filter @plim/example-basic-editor dev
```

## Development

- Install dependencies: `pnpm install`
- Typecheck all package references: `pnpm run typecheck`
- Build declarations and ESM output: `pnpm run build`
- Run tests: `pnpm test`
