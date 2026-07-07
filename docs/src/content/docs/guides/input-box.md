---
title: Input box (single-block composer)
description: Use PlimInputBox, a stripped-down single-block editor for Slack-style chat and comment composers.
---

`PlimEditor` is a full multi-block document surface. Chat messages, comment
boxes, and reply fields don't want that: they want a single-line-ish input that
still understands rich text. `PlimInputBox` is that mini editor -- a Slack-style
composer built on the exact same keystroke pipeline as `PlimEditor`, but running
in single-block mode.

## How it differs from `PlimEditor`

- **One block only.** Enter never splits the input into new blocks, and
  multi-paragraph pastes collapse to soft newlines. The document is always a
  single text block.
- **No block affordances.** There is no `+` add button and no drag handle -- just
  the text.
- **Enter submits.** Pressing Enter fires `onSubmit` (and clears the input);
  Shift+Enter inserts a soft newline. This is configurable (see below).
- **Stripped down.** Collaboration, ledger, and transport are simply not wired.
  Those attach to the `PlimDriver` by the consumer, so a plain driver here is all
  it takes to opt out.

Everything else carries over. Inline marks, markdown input rules, slash commands,
mentions, and [mojis](/guides/mojis/) all work, because `PlimInputBox` shares
`PlimEditor`'s input handling.

## React usage

```tsx
import * as React from 'react';
import {
  PlimDriver,
  boldMark, italicMark, codeMark, linkMark,
  paragraphBlock,
  type EditorState,
} from '@plim/core';
import {
  PlimInputBox, useEditorHandle,
  SlashCommandMenu, slashCommandExtension, DEFAULT_SLASH_ITEMS,
  MentionMenu, mentionExtension,
} from '@plim/react';
import { mojiExtension } from '@plim/mojis';
import '@plim/editor/styles.css';

const plim = new PlimDriver({
  extensions: [slashCommandExtension(), mentionExtension(), mojiExtension()],
  registeredMarks: [boldMark, italicMark, codeMark, linkMark],
  // A single-block input only ever renders paragraphs.
  registeredBlocks: [paragraphBlock],
});

export function Composer() {
  const handle = useEditorHandle();

  const handleSubmit = React.useCallback((state: EditorState) => {
    // The input clears + refocuses itself (clearOnSubmit default), so this
    // handler just records the message.
    console.log('send', state.doc);
  }, []);

  return (
    <div className="chat-composer">
      <PlimInputBox
        plim={plim}
        handle={handle}
        className="plim-input-box"
        placeholder="Message #general"
        onSubmit={handleSubmit}
      />
      {/* Menus are rendered as siblings and driven by the same handle. */}
      <SlashCommandMenu editor={handle} items={DEFAULT_SLASH_ITEMS} />
      <MentionMenu editor={handle} searchUsers={searchUsers} />
    </div>
  );
}
```

`onSubmit` receives the current `EditorState`; empty input never submits. A lone
`:smile:` moji or an `@mention` counts as content, so those still send.

## Enter behaviour

`PlimInputBox` is chat-first, so the Enter key is a submit gesture by default:

| Keys | `submitOnEnter` (default `true`) | `submitOnEnter={false}` |
| --- | --- | --- |
| Enter | Submit | Soft newline |
| Shift+Enter | Soft newline | Soft newline |
| Cmd/Ctrl+Enter | Submit | Submit |

Set `submitOnEnter={false}` for a "Enter inserts a newline, Cmd/Ctrl+Enter sends"
composer. Cmd/Ctrl+Enter always submits regardless of the setting.

## Props

`PlimInputBox` takes the familiar editor props (`plim`, `handle`,
`initialContent`, `readonly`, `autoFocus`, `onTransaction`, `whenReady`,
`asyncEventListeners`, `className`, `style`) plus a few composer-specific ones:

| Prop | Default | Description |
| --- | --- | --- |
| `placeholder` | -- | Hint shown while the input is empty. Applied at mount. |
| `submitOnEnter` | `true` | Enter submits (Shift+Enter inserts a newline). |
| `clearOnSubmit` | `true` | Reset to an empty input and refocus after a submit. |
| `onSubmit` | -- | Called with the current `EditorState` on submit. Never fires for empty input. |

See the [`@plim/react` API reference](/api/react/) for the full
`PlimInputBoxProps` type.

## Styling

`PlimInputBox` renders a bare container -- it does **not** add any chrome of its
own. `@plim/editor/styles.css` ships an opt-in `.plim-input-box` class that gives
you a bordered, rounded, comfortably padded box with an accent focus ring, a
sensible Slack-style default:

```tsx
<PlimInputBox plim={plim} handle={handle} className="plim-input-box" />
```

Drop the class (or supply your own) to style it from scratch.

Pop-up menus (slash, mention) anchor to the whole input box in single-block mode,
so when a composer is pinned to the bottom of its container the menu flips
cleanly **above** the box instead of covering the text you are typing.

## Persisting a submitted message

`onSubmit` hands you an `EditorState`; freeze its `doc` however you like. To store
or render a message as HTML, use [`serializeToHTML`](/guides/html-ssr/) from
`@plim/html`:

```tsx
import { serializeToHTML } from '@plim/html';

const handleSubmit = (state: EditorState) => {
  const html = serializeToHTML(state.doc);
  // ...append `html` to your message list
};
```

Wrap the rendered HTML in a `.plim-editor` element so the editor's scoped mark
styles (bold, code, links, mojis) apply to the frozen message.

## Next steps

- Bundle the input-rule features you want with [extensions](/guides/extensions/).
- Add [custom marks](/guides/custom-marks/) for inline formatting.
- Render submitted messages with [HTML & SSR](/guides/html-ssr/).
