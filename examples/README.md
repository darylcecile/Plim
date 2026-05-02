# Plim browser examples

`examples/basic-editor` demonstrates how to integrate the Plim browser TypeScript packages in a host web app while presenting a Notion-like editing surface. It stays framework-neutral while exercising the same package boundaries an application would use: `@plim/editor`, `@plim/blocks`, `@plim/input`, `@plim/selection`, and `@plim/databases`.

`examples/react-tailwind-editor` demonstrates the React integration path with `@plim/react`, Vite, Tailwind CSS, a seeded Plim document, local persistence, toolbar commands, and a live runtime inspector.

## Setup from the repository root

Install dependencies once at the root so the pnpm workspace links are available:

```sh
pnpm install
```

Validate and build the shared library packages before working on the example:

```sh
pnpm run typecheck
pnpm run build
pnpm test
```

These root scripts run the workspace TypeScript project references and Vitest suite for the Plim packages. The example is also part of `pnpm-workspace.yaml`, so you can run its scripts with pnpm filters from the repository root.

## Running the React + Tailwind example

The React app lives in `examples/react-tailwind-editor`:

```sh
pnpm --filter @plim/example-react-tailwind-editor typecheck
pnpm --filter @plim/example-react-tailwind-editor build
pnpm --filter @plim/example-react-tailwind-editor dev
```

It uses `PlimEditorProvider`, `PlimEditor`, React hooks, localStorage persistence, and Tailwind layers that style the default React renderer classes.

## Running the basic editor example

The example app lives in `examples/basic-editor` and exposes standard pnpm scripts for local development:

```sh
pnpm --filter @plim/example-basic-editor typecheck
pnpm --filter @plim/example-basic-editor build
pnpm --filter @plim/example-basic-editor dev
```

Vite serves `index.html`, compiles `src/main.ts`, and loads the local workspace package builds from the repository checkout.

## How to use the running example

The example is a clean document editor rather than a visible integration dashboard:

1. Click the large page title, heading, paragraph, quote, or to-do label and type.
2. Click away to commit the changed text into Plim state.
3. Press `Enter` while editing to commit the current block and insert a new paragraph below it.
4. Press `Shift` + `Enter` to keep editing the same block with a line break.
5. Use arrow keys at block boundaries to move the caret through the document like one continuous editor.
6. Type markdown markers such as `# `, `## `, and `[] ` to transform blocks while typing.
7. Type `/` inside a block to open the inline slash menu, navigate it with the keyboard, then choose a block type.
8. Hover a block to reveal subtle add, drag, and move controls.
9. Drag a block handle or use the move controls to reorganize blocks.
10. Toggle a to-do checkbox or use the quick insert strip below the document.
11. Use **Save**, refresh, and verify the document is restored from `localStorage`.

Package diagnostics are hidden behind **Developer details** in the top bar. Open it to inspect selected block metadata, selection-helper output, database-query results, command helper behavior, and persistence status.

## File walkthrough

- `examples/basic-editor/index.html` defines the browser entry point, top bar, hidden developer details panel, editor mount element, inline slash menu host, and module script that loads `src/main.ts`.
- `examples/basic-editor/src/main.ts` wires the Plim packages together. It creates an editor, mounts a render surface, renders editable page/block components, inserts sample blocks, dispatches commands, evaluates inline slash and Markdown input helpers, tracks selection state, queries a sample client database, and saves or loads editor snapshots.
- `examples/basic-editor/src/styles.css` contains host-app styling for a Notion-like centered document, page title, hover block controls, slash menu, and hidden developer diagnostics. The styles are intentionally local to the example so production apps can replace them.
- `examples/basic-editor/tsconfig.json` uses strict DOM-enabled, ESM-compatible settings and type-checks the browser source without emitting build artifacts.

## Library features demonstrated

The basic editor is designed to show these integration points:

- **Editor creation** with `createEditor`, a clock, an ID factory, and optional persistence configuration.
- **Block insertion and rendering** by creating model blocks, dispatching `create_block` and `insert_child` operations, and rendering document state through a browser surface such as `VanillaEditorSurface`.
- **Command dispatch** through editor commands such as `executeCommand('block.insertParagraph', ...)` and direct operation dispatch for application-specific actions.
- **Block catalog validation and defaults** using `createDefaultBlockData`, `getBlockDefinition`, `normalizeBlockByDefinition`, and `validateBlockByDefinition` before inserting or transforming blocks.
- **Input helpers** from `@plim/input`, including Markdown transforms with `evaluateMarkdownInputAfterInsertion`, slash trigger detection with `detectSlashTrigger`, and menu state helpers for accessible slash navigation.
- **Selection helpers** from `@plim/selection`, such as `selectBlockRange`, `adjacentEditableBlock`, `buildReorderOperations`, `deriveSelectedBlockIds`, `validateSelection`, and `announceSelection` for preserving, moving, and describing block selections.
- **Client database queries** with `queryDataSource` or `queryDatabaseViewBlock` to render filtered, sorted, projected rows without a server round trip.
- **Local persistence and snapshots** by exporting snapshots with `editor.exportSnapshot()`, loading a persisted snapshot with `createEditor({ snapshot })`, and saving through a local adapter such as `localStorage`.

## Minimal editor creation excerpt

```ts
import { createEditor, createIdFactory, createParagraphBlock } from '@plim/editor';

const clock = { now: () => new Date().toISOString() };
const idFactory = createIdFactory();
const editor = createEditor({ clock, idFactory });
const rootPageId = editor.rootPageId;

const paragraph = createParagraphBlock({
  workspaceId: editor.state.document.workspace.id,
  parent: { kind: 'page', pageId: rootPageId },
  text: 'Hello from Plim',
  clock,
  idFactory
});

await editor.dispatch([
  { op: 'create_block', block: paragraph },
  { op: 'insert_child', parentId: rootPageId, childId: paragraph.id, at: { kind: 'append' } }
]);
```

For a to-do block, create a `to_do` block with catalog defaults and dispatch the same pair of operations with the new block ID.

## Adapting the example in a host app

Treat the example as a browser integration pattern rather than a required architecture. In a production app, keep `Editor` ownership in your application state layer, subscribe to editor change events, translate toolbar and keyboard UI into commands or operations, and replace the sample persistence adapter with durable storage. Use the block catalog to validate custom insertion flows before committing operations, and keep DOM selection state synchronized through the selection helpers when focus moves into popovers, slash menus, or framework components.

Modern evergreen browsers are expected. The example assumes native ESM or a bundler-powered dev server, DOM APIs, `AbortController`, `structuredClone`-class behavior supplied by the runtime or tooling, and browser storage if local persistence is enabled. Serve the app through a local dev server rather than opening `index.html` directly so workspace package imports, module resolution, and source maps behave consistently.
