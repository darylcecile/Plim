# Plim basic editor example

This example shows a browser-oriented Plim integration without a UI framework. It presents a Notion-like document surface while demonstrating how to:

- create and mount an editor with `@plim/editor`
- create and append blocks using `@plim/model` operations
- register and execute an editor command
- use `@plim/blocks` for block definitions, defaults, normalization, and validation
- use `@plim/input` slash-trigger and markdown-input helpers
- use `@plim/selection` to build block selections and accessibility announcements
- query a small client-side data source with `@plim/databases`
- persist editor snapshots to `localStorage` through a browser persistence adapter

## Run it

Build the workspace packages first from the repository root, then run the example:

```sh
pnpm install
pnpm run build
pnpm --filter @plim/example-basic-editor typecheck
pnpm --filter @plim/example-basic-editor dev
```

Then open the URL printed by Vite. The example uses pnpm workspace dependencies that point at the package builds in this repository.

## What to do in the example

The main page is the editor. It should feel like a small Notion-style document, with package diagnostics hidden behind **Developer details**:

1. Click the large page title, heading, paragraph, quote, or to-do text and type.
2. Click outside the block to commit the text back into Plim document state.
3. Press `Enter` while editing a block to commit it and create a new paragraph below it.
4. Press `Shift` + `Enter` for a line break inside the current block.
5. Toggle the to-do checkbox to dispatch an `update_block` operation.
6. Use arrow keys at the start or end of a block to move the caret into the previous or next block.
7. Type markdown markers like `# `, `## `, or `[] ` at the start of a block to transform it while typing.
8. Type `/to`, `/h`, or `/quote` directly inside a block to open the inline slash menu, then use arrow keys and `Enter` to choose an item.
9. Hover a block to reveal the `+` add control, drag handle, and move up/down controls.
10. Drag the block handle or use the move controls to reorganize blocks.
11. Use the quick insert strip below the document for text, to-do, and quote blocks.
12. Open **Developer details** to inspect the block catalog, slash/Markdown helper, selection helper, client database query, and persistence status.
13. Click **Save**, refresh the page, and confirm the document reloads from `localStorage`.

The developer panel is intentionally secondary. The default experience should read as an editor first and an API demonstration second.

## Useful scripts

```sh
pnpm --filter @plim/example-basic-editor typecheck
pnpm --filter @plim/example-basic-editor build
```

The source is intentionally framework-free. `index.html` mounts `src/main.ts`, which registers renderers, commands, input helpers, selection handling, a database query panel, and local snapshot persistence.
