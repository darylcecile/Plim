# @plim/react

React bindings for the [Plim](https://github.com/darylcecile/plim) block editor: a `<PlimEditor>` component, the `useEditorHandle()` hook, ready-made slash-command and mention extensions with first-class React menus, the comments UI layer, and a bridge for defining blocks as **real React components** (`toComponent`) that persist into the document.

## Install

```sh
pnpm add @plim/react @plim/editor @plim/core react react-dom
```

Import the editor stylesheet once at your app entry:

```ts
import '@plim/editor/styles.css';
```

## Quickstart

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
  extensions: [slashCommandExtension()],
  registeredMarks: [boldMark, italicMark, underlineMark, strikethroughMark, codeMark, linkMark],
  registeredBlocks: [
    paragraphBlock, headingBlock,
    bulletedListBlock, numberedListBlock, todoListBlock,
    quoteBlock, horizontalRuleBlock,
  ],
});

export function App() {
  const handle = useEditorHandle();
  return (
    <>
      <PlimEditor
        plim={plim}
        handle={handle}
        initialContent={contentFromMarkdown('# Hello, Plim', 'Press `/` for the slash menu.')}
        autoFocus
      />
      <SlashCommandMenu editor={handle} items={DEFAULT_SLASH_ITEMS} />
    </>
  );
}
```

## `<PlimEditor>`

```ts
type PlimEditorProps = {
  plim: PlimDriver;
  handle?: EditorHandle;          // from useEditorHandle(); lets sibling menus address the editor
  initialContent?: DocumentNode;
  readonly?: boolean;
  autoFocus?: boolean;
  onTransaction?: (tx, state) => void;
  whenReady?: () => void;
  asyncEventListeners?: AsyncListenerRegistration[];
  className?: string;
  style?: React.CSSProperties;
};
```

`useEditorHandle()` returns a stable `EditorHandle` you pass to `<PlimEditor handle={...}>` and to the menu components so they share the same live editor.

## Built-in extensions & menus

Two extensions ship ready to register on your driver, each paired with a React menu:

- **Slash commands** — `slashCommandExtension({ character?, eventName? })` + `<SlashCommandMenu editor={handle} items={DEFAULT_SLASH_ITEMS} />`. Items are `SlashCommandItem`s (`id`, `label`, `hint`, `icon`, `keywords`, and either `blockType`/`attrs` or a custom `apply`).
- **Mentions** — `mentionExtension({ character?, eventName?, priority? })` + `<MentionMenu />`. `DEFAULT_MENTION_USERS` is a starter dataset; supply your own `MentionUser[]`.

Both extensions trigger an async event you respond to by rendering a menu; `ActionPanel` / `HoverMenu` are the positioned primitives the menus build on (`currentCaretRect`, `currentSelectionRect`, `currentBlockAnchor` help you anchor custom UI).

## React blocks (`toComponent`)

Define a block whose body is a real React component, persisted into the document. For an **atomic** block (no editable text), just return JSX:

```tsx
import { defineBlock } from '@plim/core';

export const counterBlock = defineBlock((editor) => ({
  name: 'counter',
  type: 'standalone',
  atomic: true,
  supportsDecoration: false,
  toComponent: (payload) => (
    <CounterCard
      count={Number(payload.attrs.count ?? 0)}
      onChange={(next) => {
        const tx = editor.createTransaction();
        tx.setBlockAttrs(/* path for payload.id */ [], { count: next });
        tx.commit();
      }}
    />
  ),
}));
```

For an **editable** React block, render `ContentSlot` where the editor's `[data-block-content]` element should land — the editor owns the text inside it, React owns everything around it:

```tsx
import { defineBlock, type BlockPayload } from '@plim/core';
import { ContentSlot } from '@plim/react';

export const calloutBlock = defineBlock({
  name: 'callout',
  type: 'standalone',
  toComponent: (payload: BlockPayload) => (
    <div className="plim-callout">
      <span contentEditable={false}>💡</span>
      <ContentSlot el={(payload.content as HTMLElement[])[0]} />
    </div>
  ),
});
```

`ContentSlot` mounts the slot with `display: contents` (no extra layout) and no-ops once attached, so React's reconciliation never fights the editor's in-place text updates.

## Comments

`@plim/react` provides the UI for the comment system that lives in [`@plim/collaboration`](https://github.com/darylcecile/plim/tree/main/packages/collaboration). Mount one component:

```tsx
import { CommentsLayer } from '@plim/react';
<CommentsLayer editor={handle} store={store} currentUser={{ id: 'me', name: 'You' }} />;
```

Or compose your own panel from the exported building blocks: `CommentThreadCard`, `CommentCard`, `CommentComposer`, and the `useComments(store)` hook.

## Where to go next

- **Document model & APIs** — [`@plim/core`](https://github.com/darylcecile/plim/tree/main/packages/core).
- **View layer** — [`@plim/editor`](https://github.com/darylcecile/plim/tree/main/packages/editor).
- **Comments & collaboration** — [`@plim/collaboration`](https://github.com/darylcecile/plim/tree/main/packages/collaboration).
- **Reference app** — [`examples/notion-clone`](https://github.com/darylcecile/plim/tree/main/examples/notion-clone).

## License

See the [LICENSE](./LICENSE) file in this package.
