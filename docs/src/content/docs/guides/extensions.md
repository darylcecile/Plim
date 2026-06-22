---
title: Extensions
description: Bundle blocks, marks, and actions behind a single registration.
---

Extensions bundle blocks, marks, and actions behind a single registration. Use them to
ship reusable features (slash menu, mentions, your custom-block library) without leaking
five separate registries into your app.

See [`defineExtension`](/api/core/) in the `@plim/core` API reference for the full
surface.

```ts
import { defineAction, defineExtension, mentionMark, triggers } from '@plim/core';

export const mentionExtension = defineExtension(() => ({
  name: 'mention',
  registeredMarks: [mentionMark],
  registeredActions: [
    defineAction('mention', {
      trigger: triggers.keyboard.character('@'),
      triggerValidationRules: ({ or }) => or(['startOfBlock', 'precededByWhitespace']),
      cancellationTriggers: [triggers.keyboard.key('Escape'), triggers.keyboard.key(' ')],
      perform: async (_state, ctx) => ctx.triggerAsyncEvent('showMentionSuggestions'),
    }),
  ],
  // optional hooks
  onTransaction: (tx, ctx) => { /* observe or react to commits */ },
  transformPaste: (data, ctx) => { /* return true to claim the paste */ },
}));
```

The factory receives the live `EditorHandle`, so extensions can close over
`editor.createTransaction()` for their actions. Results are cached per-factory, so
passing the same extension to multiple `PlimDriver` instances is cheap.

## Built-in React extensions

[`@plim/react`](/api/react/) ships two extensions out of the box:

- `slashCommandExtension({ priority?, eventName? })` - pairs with
  `<SlashCommandMenu items={DEFAULT_SLASH_ITEMS} editor={handle} />`.
- `mentionExtension({ character?, eventName?, priority? })` - pairs with your own React
  menu rendered in response to the async event.
