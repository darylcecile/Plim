# @plim/core

The runtime-agnostic heart of the [Plim](https://github.com/darylcecile/plim) block editor: the document model, transactions, validation, the action / extension / trigger system, history, snapshots, and the built-in block & mark library. It has **no DOM dependencies** and is consumed by `@plim/editor`, `@plim/react`, `@plim/markdown`, `@plim/ledger`, and the rest of the stack.

If you are building an editor UI you will install this alongside `@plim/editor` (and optionally `@plim/react`). If you are building tooling — a server-side document transform, a custom sync layer, a validator — you can use `@plim/core` on its own.

## Install

```sh
pnpm add @plim/core
```

## The driver & document model

`PlimDriver` is the configuration object for an editor: which theme, marks, blocks, actions, and extensions are available. It owns no DOM — a view layer (`@plim/editor`) mounts against it.

```ts
import {
  PlimDriver,
  paragraphBlock, headingBlock, bulletedListBlock, numberedListBlock, todoListBlock,
  quoteBlock, codeBlock, horizontalRuleBlock,
  boldMark, italicMark, underlineMark, strikethroughMark, codeMark, linkMark,
} from '@plim/core';

const plim = new PlimDriver({
  theme: 'light',                       // 'light' | 'dark'
  registeredMarks: [boldMark, italicMark, underlineMark, strikethroughMark, codeMark, linkMark],
  registeredBlocks: [
    paragraphBlock, headingBlock,
    bulletedListBlock, numberedListBlock, todoListBlock,
    quoteBlock, codeBlock, horizontalRuleBlock,
  ],
  registeredActions: [],
  extensions: [],
});
```

`PlimDriverConfig` fields are all optional: `theme`, `registeredMarks`, `registeredBlocks`, `registeredActions`, `extensions`.

A mounted editor exposes an `EditorHandle` — the live API you read state from and dispatch edits through:

```ts
interface EditorHandle {
  readonly plim: PlimDriver;
  readonly isReady: boolean;
  getState(): EditorState;
  setState(s: EditorState): void;
  dispatch(tx: Transaction): void;
  createTransaction(): Transaction;
  onTransaction(cb: (tx, state) => void): () => void;
  onAsyncEvent<T>(name: string, handler): () => void;
  triggerAsyncEvent<T>(name: string, payload?): Promise<T>;
  whenReady(cb: () => void): void;
  restoreSnapshot(snap: Snapshot): void;
  readonly history: History;
  readonly blocks: BlockDescriptor[];
  readonly marks: MarkDescriptor[];
  readonly actions: ActionDescriptor[];
  supportsDecoration(blockType: string): boolean;
}
```

## Transactions

Every change to the document is a `Transaction`: a batch of operations applied atomically and (where possible) invertibly. Create one from the handle, mutate, then `commit()`.

```ts
const tx = editor.createTransaction();
tx.insertText([0], 0, 'Hello');
tx.setBlockType([0], 'heading', { level: 1 });
tx.toggleMark('bold', { path: [0], from: 0, to: 5 });
tx.commit();
```

Transaction methods include `insertText`, `replaceRange`, `splitBlock`, `joinBackward`, `setBlockType`, `setBlockAttrs`, `insertBlock`, `removeBlock`, `moveBlock`, `toggleMark` / `addMark` / `removeMark`, `setSelection`, and `setMeta`. Set `tx.setMeta('addToHistory', false)` to keep an ephemeral edit out of undo history.

## Built-in blocks & marks

Importable descriptors, ready to register on a driver:

- **Marks** — `boldMark`, `italicMark`, `underlineMark`, `strikethroughMark`, `codeMark`, `linkMark` (with popover toolbar), `highlightMark`, `mentionMark`. The arrays `builtInMarks` give you all of them.
- **Blocks** — `paragraphBlock`, `headingBlock`, `bulletedListBlock`, `numberedListBlock`, `todoListBlock`, `quoteBlock`, `codeBlock`, `toggleBlock`, `horizontalRuleBlock`, `imageBlock`, `embeddedMediaBlock`, `tableBlock`, `rawHTMLBlock`. The array `builtInBlocks` gives you all of them.

## Defining custom blocks

`defineBlock` registers a structural unit — a paragraph, heading, callout, embed, or anything you invent. A block renders to DOM (`toDOM`) or to a component via a host bridge (`toComponent`).

```ts
import { defineBlock, type BlockPayload } from '@plim/core';

export const calloutBlock = defineBlock({
  name: 'callout',
  type: 'standalone',
  toDOM: (payload: BlockPayload) => {
    const wrap = document.createElement('div');
    wrap.className = 'plim-callout';
    // payload.content[0] is the editor-owned [data-block-content] slot.
    wrap.appendChild((payload.content as HTMLElement[])[0]);
    return wrap;
  },
});
```

Key descriptor fields: `type` (`'standalone' | 'inline'`), `nestable`, `atomic`, `supportsDecoration`, `multilineText`, `continueAs`, `toolbar`, and `toMarkdown` / `fromMarkdown` for Markdown round-tripping. `defineBlock` also accepts a factory `(editor) => descriptor` so a block can close over `editor.createTransaction()`.

## Defining custom marks

`defineMark` registers an inline annotation — bold, a link, a badge. Marks are wrappers; the editor inserts the text and nested marks inside whatever element you return.

```ts
import { defineMark } from '@plim/core';

export const highlightMark = defineMark({
  name: 'highlight',
  toDOM: () => {
    const el = document.createElement('mark');
    el.className = 'plim-highlight';
    return el;
  },
  toolbar: {
    name: 'highlight', label: 'Highlight', icon: 'H', shortcut: '⌘⇧H', group: 'mark',
    perform: ({ state, editor }) => {
      const tx = editor.createTransaction();
      tx.toggleMark('highlight', { from: state.selection.anchor, to: state.selection.head });
      tx.commit();
    },
  },
});
```

## Actions & triggers

Actions are behaviour units bound to triggers — they power keyboard shortcuts, slash menus, mention pop-ups, clipboard handling, and undo/redo.

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
```

Triggers: `triggers.keyboard.shortcut('Mod+b')` (`Mod` = `Cmd`/`Ctrl`), `triggers.keyboard.character('/')`, `triggers.keyboard.key('Escape')`, and `triggers.clipboard.action('cut' | 'copy' | 'paste')`. Validation rule names — `selectionNotEmpty`, `blockSupportsDecoration`, `startOfBlock`, `endOfBlock`, `precededByWhitespace`, `inTextBlock` — compose via `and`, `or`, `not`, `predicate`, `markActiveInSelection`, `blockTypeIs`.

## Extensions

`defineExtension` bundles blocks, marks, and actions behind one registration so reusable features ship as a unit.

```ts
import { defineAction, defineExtension, mentionMark, triggers } from '@plim/core';

export const mentionExtension = defineExtension(() => ({
  name: 'mention',
  registeredMarks: [mentionMark],
  registeredActions: [
    defineAction('mention', {
      trigger: triggers.keyboard.character('@'),
      triggerValidationRules: ({ or }) => or(['startOfBlock', 'precededByWhitespace']),
      cancellationTriggers: [triggers.keyboard.key('Escape')],
      perform: async (_state, ctx) => ctx.triggerAsyncEvent('showMentionSuggestions'),
    }),
  ],
  onTransaction: (tx, ctx) => { /* observe commits */ },
  transformPaste: (data, ctx) => { /* return true to claim the paste */ },
}));
```

The factory receives the live `EditorHandle` and is cached per-factory, so passing one extension to multiple drivers is cheap.

## History

Every dispatched transaction is captured in a bounded history (default 200 entries).

```ts
const history = plim.getHistory(); // or editor.history from a handle
history.undo();
history.redo();
history.canUndo;   // boolean
history.canRedo;   // boolean
const off = history.onChange(({ canUndo, canRedo, past, future }) => { /* re-render buttons */ });
```

## Snapshots

A `Snapshot` is a full, serializable state capture — for autosave/restore, "revert to here", or shipping a document over the wire.

```ts
import { Snapshot } from '@plim/core';

const snap = new Snapshot(editor);     // or new Snapshot(editor.getState())
const json = snap.serialize();
const restored = Snapshot.deserialize(json);
editor.restoreSnapshot(restored);      // replaces state; does not push history
```

## Where to go next

- **[Mount a view](https://github.com/darylcecile/plim/tree/main/packages/editor)** — `@plim/editor` (vanilla) or `@plim/react` (React bindings).
- **[Markdown round-tripping](https://github.com/darylcecile/plim/tree/main/packages/markdown)** — `@plim/markdown`.
- **[Sync & collaboration](https://github.com/darylcecile/plim/tree/main/packages/ledger)** — `@plim/ledger` and `@plim/collaboration`.
- **Full API contract** — [`REQUIREMENTS.md`](https://github.com/darylcecile/plim/blob/main/REQUIREMENTS.md).
- **Reference app** — [`examples/notion-clone`](https://github.com/darylcecile/plim/tree/main/examples/notion-clone).

## License

See the [LICENSE](./LICENSE) file in this package.
