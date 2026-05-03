# Plim

A browser-safe TypeScript monorepo for building Notion-compatible WYSIWYG editors.

## Package layout

- `@plim/core` (`packages/core`) — driver configuration, block/mark/action/extension builders, immutable content helpers, history, triggers, transactions, and snapshots.
- `@plim/editor` (`packages/editor`) — framework-agnostic DOM editor runtime with container attachment, state subscriptions, async events, transaction dispatch, and snapshot restore.
- `@plim/markdown` (`packages/markdown`) — lightweight Markdown-to-Plim content conversion for headings, lists, quotes, dividers, and inline marks.
- `@plim/react` (`packages/react`) — React bindings and components over the core/editor concepts with React as a peer dependency.

The monorepo uses pnpm workspaces and ESM TypeScript packages.

## Basic usage

```ts
import { PlimDriver, defineAction, triggers } from '@plim/core';
import { attachContainer, deriveEditor } from '@plim/editor';
import { contentFromMarkdown } from '@plim/markdown';

const plim = new PlimDriver({
  theme: 'notion-light',
  registeredActions: [
    defineAction('slashCommand', {
      trigger: triggers.keyboard.character('/'),
      triggerValidationRules: ({ or }) => or(['startOfBlock', 'precededByWhitespace']),
      perform: async (_state, ctx) => ctx.triggerAsyncEvent('showSlashCommandMenu')
    })
  ]
});

const editor = deriveEditor(plim, {
  containerAdapter: attachContainer(() => document.getElementById('editor')),
  initialContent: contentFromMarkdown('# Hello Plim', '', 'Type `/` for commands.'),
  autoFocus: true
});

editor.onAsyncEvent('showSlashCommandMenu', async () => {
  // Render your app-specific command menu.
});
```

## Examples

See [`examples/basic-editor`](examples/basic-editor) for a vanilla TypeScript app and [`examples/react-tailwind-editor`](examples/react-tailwind-editor) for a React app. Both open to a clean centered Notion-like page, expose hover block controls, support inline slash commands, demonstrate custom command-menu wiring, and inherit the shared block editing runtime: Enter splits blocks, ArrowUp/ArrowDown traverse single-line block boundaries without jumping the caret to the start/end first, handles reorder blocks with drag-and-drop, and clipboard paste normalizes internal Plim blocks plus external plain text/HTML.

Run it after installing and building the workspace packages:

```sh
pnpm install
pnpm run build
pnpm --filter @plim/example-basic-editor dev
pnpm --filter @plim/example-react-tailwind-editor dev
```

## Development

- Install dependencies: `pnpm install`
- Typecheck all package references: `pnpm run typecheck`
- Build declarations and ESM output: `pnpm run build`
- Run tests: `pnpm test`
- Run browser regressions: `pnpm run test:example:browser` and `pnpm run test:example:react-browser`
