---
title: Custom blocks
description: Define your own block types with DOM or React renderers and register them on the driver.
---

Blocks are the structural units of a document - paragraphs, headings, lists, code,
images, or anything you invent. Define one with `defineBlock` and register it on the
driver. Blocks can render to plain DOM (`toDOM`) or to React (`toComponent`) - the
appropriate path is chosen by the editor at runtime.

See [`defineBlock`](/api/core/) and [`BlockPayload`](/api/core/) in the
`@plim/core` API reference for the full descriptor surface.

```tsx
import { defineBlock, type BlockPayload } from '@plim/core';

// DOM block - the editor inserts the editable content slot for you.
export const calloutBlock = defineBlock({
  name: 'callout',
  type: 'standalone',
  toDOM: (payload: BlockPayload) => {
    const wrap = document.createElement('div');
    wrap.className = 'plim-callout';
    wrap.dataset.tone = String(payload.attrs.tone ?? 'info');

    const icon = document.createElement('span');
    icon.className = 'plim-callout-icon';
    icon.contentEditable = 'false';
    icon.textContent = String(payload.attrs.icon ?? '\u{1F4A1}');
    wrap.appendChild(icon);

    // payload.content[0] is the editor-owned [data-block-content] element
    wrap.appendChild((payload.content as HTMLElement[])[0]);
    return wrap;
  },
});
```

## Key descriptor fields

- `type: 'standalone' | 'inline'` - top-level block vs. inline-only.
- `nestable` - allow child blocks (lists, toggles).
- `atomic` - block has no editable content (images, dividers, embeds).
- `supportsDecoration` - whether marks (bold, italic...) apply to its text. Defaults
  `true` for text blocks.
- `multilineText` - Enter inserts `\n` instead of splitting (used by code blocks).
- `continueAs` - block type used for the *next* block when Enter splits this one.
- `toolbar` - one or many `ToolbarItem`s exposed in the floating toolbar.
- `toMarkdown` / `fromMarkdown` - opt into markdown round-tripping.

## Factory blocks (React + transactions)

`defineBlock` also accepts a factory `(editor) => descriptor`, which is how you write
React blocks that need to commit transactions:

```tsx
import { defineBlock } from '@plim/core';

export const counterBlock = defineBlock((editor) => ({
  name: 'counter',
  type: 'standalone',
  atomic: true,
  supportsDecoration: false,
  toComponent: (payload) => (
    <CounterCard
      title={String(payload.attrs.title ?? 'Counter')}
      count={Number(payload.attrs.count ?? 0)}
      onChange={(next) => {
        const path = findPathForBlockId(editor, payload.id);
        if (!path) return;
        const tx = editor.createTransaction();
        tx.setBlockAttrs(path, { count: next });
        tx.commit();
      }}
    />
  ),
}));
```

## Editable React blocks with `ContentSlot`

For editable React blocks (where some content lives in a React tree but the text is
still editor-owned), import `ContentSlot` from `@plim/react` and render it where the
`[data-block-content]` element should land:

```tsx
import { defineBlock, type BlockPayload } from '@plim/core';
import { ContentSlot } from '@plim/react';

export const calloutBlock = defineBlock({
  name: 'callout',
  type: 'standalone',
  toComponent: (payload: BlockPayload) => {
    const slot = (payload.content as HTMLElement[])[0];
    const tone = String(payload.attrs.tone ?? 'info');
    return (
      <div className="plim-callout" data-tone={tone}>
        <span className="plim-callout-icon" contentEditable={false}>
          {String(payload.attrs.icon ?? '\u{1F4A1}')}
        </span>
        {/* The editor owns the text inside this slot; React owns everything else. */}
        <ContentSlot el={slot} />
      </div>
    );
  },
});
```

`ContentSlot` mounts the editor's slot element with `display: contents` so it doesn't
introduce extra layout, and its ref no-ops once the slot is already attached - React's
reconciliation never fights the editor's in-place text updates.

:::tip
See `packages/core/src/builtins.ts` for the built-in block library and
`examples/notion-clone/src/customBlocks.tsx` for richer DOM- and React-based blocks
(callout + counter).
:::
