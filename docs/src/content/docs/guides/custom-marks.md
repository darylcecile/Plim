---
title: Custom marks
description: Define inline annotations - bold, links, mentions, custom badges - with defineMark.
---

Marks are inline annotations applied to runs of text - bold, italic, links, mentions,
custom badges. They are wrappers; the editor inserts the text and any nested marks
inside whatever element you return.

See [`defineMark`](/api/core/) in the `@plim/core` API reference for the full
descriptor surface.

```tsx
import { defineMark } from '@plim/core';

export const highlightMark = defineMark({
  name: 'highlight',
  toDOM: () => {
    const el = document.createElement('mark');
    el.className = 'plim-highlight';
    return el;
  },
  toolbar: {
    name: 'highlight',
    label: 'Highlight',
    icon: 'H',
    shortcut: 'Cmd+Shift+H',
    group: 'mark',
    perform: ({ state, editor }) => {
      const tx = editor.createTransaction();
      tx.toggleMark('highlight', {
        from: state.selection.anchor,
        to: state.selection.head,
      });
      tx.commit();
    },
  },
});
```

Toolbar items default to `visibleWhen: and([selectionNotEmpty, blockSupportsDecoration])`
and `activeWhen: markActiveInSelection(<name>)` so most marks need no extra wiring.

## Built-in marks

`@plim/core` ships: `boldMark`, `italicMark`, `underlineMark`, `strikethroughMark`,
`codeMark`, `linkMark` (with popover toolbar), `highlightMark`, and `mentionMark`
(atomic, used by the React mention extension). For an atomic-mark example with its own
action panel, see `examples/notion-clone/src/statusBadge.tsx`.

Next: see [actions & triggers](/guides/actions-and-triggers/) for binding behaviour to
input, and [extensions](/guides/extensions/) for packaging marks for reuse.
