# Plim

A Notion-inspired block editor for the web, built as a TypeScript monorepo. Plim ships a framework-agnostic core, a DOM view layer, a Markdown parser/serializer, and React bindings — all small, composable, and designed to be embedded in your own product.

> **Status:** pre-1.0 (`0.0.x`). The public API is mostly stable but may shift before `1.0`.

## Packages

| Package | Description |
| --- | --- |
| [`@plim/core`](./packages/core) | Schema, document model, transactions, validation rules, action/extension/trigger system, history, and the built-in block & mark descriptors. Runtime-agnostic — no DOM. |
| [`@plim/markdown`](./packages/markdown) | Parse Markdown into a Plim document (`contentFromMarkdown`, `parseMarkdown`) and serialize back (`contentToMarkdown`). |
| [`@plim/editor`](./packages/editor) | The view layer. Mounts a Plim document into a `contenteditable`, owns the floating toolbar, the block-handle gutter, paste/clipboard handling, drag-and-drop, and the keyboard pipeline. Ships its own stylesheet. |
| [`@plim/react`](./packages/react) | React bindings: `<PlimEditor>`, `useEditorHandle()`, slash-command and mention extensions with first-class React components, and a bridge for defining blocks with `toComponent` (real React components persisted into the doc). |

`examples/notion-clone` is a full Vite + React app exercising all four packages — it's the litmus test the whole repo is built against.

## Install

```sh
# Vanilla (no React)
pnpm add @plim/core @plim/editor @plim/markdown

# React
pnpm add @plim/core @plim/editor @plim/markdown @plim/react react react-dom
```

Import the editor stylesheet once at your app entry:

```ts
import "@plim/editor/styles.css";
```

## Quickstart (React)

```tsx
import {
  PlimDriver,
  boldMark, italicMark, underlineMark, strikethroughMark, codeMark, linkMark,
  paragraphBlock, headingBlock, bulletedListBlock, numberedListBlock,
  todoListBlock, quoteBlock, horizontalRuleBlock,
} from '@plim/core';
import { contentFromMarkdown } from '@plim/markdown';
import {
  PlimEditor, useEditorHandle,
  SlashCommandMenu, slashCommandExtension, DEFAULT_SLASH_ITEMS,
} from '@plim/react';
import '@plim/editor/styles.css';

const plim = new PlimDriver({
  theme: 'light',
  extensions: [slashCommandExtension()],
  registeredMarks: [boldMark, italicMark, underlineMark, strikethroughMark, codeMark, linkMark],
  registeredBlocks: [
    paragraphBlock, headingBlock,
    bulletedListBlock, numberedListBlock, todoListBlock,
    quoteBlock, horizontalRuleBlock,
  ],
});

const initialContent = contentFromMarkdown(
  '# Hello, Plim',
  'Press `/` to open the slash menu, or just start typing.',
);

export function App() {
  const handle = useEditorHandle();
  return (
    <>
      <PlimEditor plim={plim} handle={handle} initialContent={initialContent} autoFocus />
      <SlashCommandMenu editor={handle} items={DEFAULT_SLASH_ITEMS} />
    </>
  );
}
```

## Quickstart (vanilla)

`@plim/editor` exports `deriveEditor`, a framework-agnostic mount that produces an `EditorHandle` directly. See `packages/editor/src/index.ts` for `DeriveEditorOptions`, `attachContainer`, and the `renderReactBlock` bridge for hosting React components inside custom blocks without depending on `@plim/react`.

```ts
import { PlimDriver, paragraphBlock, headingBlock, boldMark, italicMark } from '@plim/core';
import { deriveEditor, attachContainer } from '@plim/editor';
import { contentFromMarkdown } from '@plim/markdown';
import '@plim/editor/styles.css';

const plim = new PlimDriver({
  registeredMarks: [boldMark, italicMark],
  registeredBlocks: [paragraphBlock, headingBlock],
});

const editor = deriveEditor(plim, {
  containerAdapter: attachContainer(() => document.querySelector('#editor')),
  initialContent: contentFromMarkdown('# Hello'),
  autoFocus: true,
});

editor.mount();
```

## Examples

[`examples/notion-clone`](./examples/notion-clone) is the reference app — a Notion-style page with the slash menu, @-mentions, inline status badges, custom callout (`toDOM`) and counter (`toComponent`) blocks, syntax-highlighted code blocks, undo/redo, and the full toolbar. Run it with:

```sh
pnpm install
pnpm dev:notion         # opens http://localhost:5174
```

## Development

```sh
pnpm install
pnpm -r build           # build all packages
pnpm -r typecheck       # typecheck all packages
pnpm test               # node tests (transactions, schema, markdown, validation, paste)
pnpm test:browser       # browser tests (view layer, toolbar, paste, drag-handle)
pnpm dev:notion         # run the reference example
```

The full implementation history is tracked in [`todo.md`](./todo.md); the API contract lives in [`REQUIREMENTS.md`](./REQUIREMENTS.md).

## Releases

Versioning and changelogs are managed with [Changesets](https://github.com/changesets/changesets), with all four `@plim/*` packages bumped in lockstep (configured via `fixed` in `.changeset/config.json`).

```sh
pnpm changeset          # describe a release
pnpm version            # apply changesets, bump versions, write CHANGELOG
pnpm release            # build + publish to npm
```

## Licensing

The published library packages are licensed under the **Dazza Public License 1.0** — see [`LICENSE`](./LICENSE).

Documentation is licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) unless stated otherwise.

Examples and starter templates are licensed under the MIT License unless stated otherwise.

Project names, logos, mascots, screenshots, and other brand assets are not licensed for reuse except as needed to truthfully refer to the project.
