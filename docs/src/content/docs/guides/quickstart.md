---
title: Quickstart
description: Mount a Plim editor in React or in vanilla JavaScript in a few lines.
---

This guide gets a working editor on screen. For the full symbol-level details of
every option used here, see the [`@plim/core`](/api/core/),
[`@plim/editor`](/api/editor/), and [`@plim/react`](/api/react/) API references.

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

`PlimDriver` is the runtime that owns your registered blocks, marks, and
extensions. `<PlimEditor>` mounts a document into the DOM, and `useEditorHandle()`
gives you an [`EditorHandle`](/api/core/) to drive it.

## Quickstart (vanilla)

`@plim/editor` exports `deriveEditor`, a framework-agnostic mount that produces an
`EditorHandle` directly. See the [`@plim/editor` API reference](/api/editor/) for
`DeriveEditorOptions`, `attachContainer`, and the `renderReactBlock` bridge for
hosting React components inside custom blocks without depending on `@plim/react`.

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

## Next steps

- Add your own [custom blocks](/guides/custom-blocks/) and
  [custom marks](/guides/custom-marks/).
- Wire keyboard shortcuts and menus with
  [actions & triggers](/guides/actions-and-triggers/).
- Bundle features into reusable [extensions](/guides/extensions/).
