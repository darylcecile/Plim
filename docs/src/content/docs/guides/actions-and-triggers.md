---
title: Actions & triggers
description: Bind first-class behaviour to keyboard, character, and clipboard triggers.
---

Actions are first-class behaviour units bound to triggers. They power keyboard
shortcuts, slash menus, mention pop-ups, clipboard handling, undo/redo, and anything
else input-driven.

See [`defineAction`](/api/core/) and [`triggers`](/api/core/) in the `@plim/core` API
reference for the full surface.

```ts
import { defineAction, triggers } from '@plim/core';

defineAction('bold', {
  trigger: triggers.keyboard.shortcut('Mod+b'),
  triggerValidationRules: ({ and }) => and(['selectionNotEmpty', 'blockSupportsDecoration']),
  perform: async (state, ctx) => {
    const tx = ctx.createTransaction();
    tx.toggleMark('bold', { from: state.selection.anchor, to: state.selection.head });
    tx.commit();
  },
});

defineAction('redo', {
  trigger: [
    triggers.keyboard.shortcut('Mod+Shift+z'),
    triggers.keyboard.shortcut('Mod+y'),
  ],
  perform: async () => { plim.getHistory().redo(); },
  priority: 10,
});
```

## Available triggers

- `triggers.keyboard.shortcut('Mod+b')` - `Mod` is `Cmd` on macOS, `Ctrl` elsewhere.
  Recognised modifiers: `Mod`, `Ctrl`, `Meta`/`Cmd`, `Alt`/`Option`, `Shift`.
- `triggers.keyboard.character('/')` - fires on the typed character. Unlike the other
  triggers, the browser is allowed to insert the character so menus (`/`, `@`, `:`) can
  show what the user typed.
- `triggers.keyboard.key('Escape')` - single named key.
- `triggers.clipboard.action('cut' | 'copy' | 'paste')`.

## Validation rules

Validation rule names: `selectionNotEmpty`, `blockSupportsDecoration`, `startOfBlock`,
`endOfBlock`, `precededByWhitespace`, `inTextBlock`. Builders `and`, `or`, `not`,
`predicate`, `markActiveInSelection`, `blockTypeIs` let you compose them.

## Cancellation and priority

`cancellationTriggers` only fire while `perform` is still pending - return a long-lived
promise from `perform` (e.g. `ctx.triggerAsyncEvent('showSlashCommandMenu')`) and
`Escape` will cancel it. `priority` resolves ties when multiple actions match the same
trigger (higher wins).
