---
title: History
description: Undo and redo through a bounded transaction history.
---

Every dispatched transaction is captured in a bounded history (default 200 entries). Set
`tx.meta.addToHistory = false` to opt out of capture for ephemeral operations.

See the [`@plim/core` API reference](/api/core/) for the history controller surface.

```ts
const history = plim.getHistory();

history.undo();
history.redo();
history.canUndo;   // boolean
history.canRedo;   // boolean

const off = history.onChange(({ canUndo, canRedo, past, future }) => {
  // re-render undo/redo buttons
});
```

`getHistory()` on the driver returns the most-recently-mounted editor's history
controller (use `editor.history` from a handle if you mount multiple editors against one
driver).

:::tip
Undo and redo flow through the normal `dispatch` path as real transactions, so an
attached [ledger](/guides/ledger-and-sync/) records them like any other edit.
:::
