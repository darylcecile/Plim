# Plim Implementation Checklist

Derived from `REQUIREMENTS.md`. Each item is a hard requirement; the implementation must allow the exact API shown in the requirements file. Items can be extended but not changed.

Legend: `[ ]` pending · `[~]` in progress · `[x]` done.

## 1. Editor (PlimDriver) API — `@plim/core`

- [x] `new PlimDriver({ theme, extensions, registeredMarks, registeredBlocks, registeredActions })`
- [x] `theme` accepts a name (e.g. `'light'`) or a custom theme object
- [x] `extensions` array supported, processed once and cached for reuse across editors
- [x] `registeredMarks` accepts the result of `defineMark(...)` factories
- [x] `registeredBlocks` accepts the result of `defineBlock(...)` factories
- [x] `registeredActions` accepts the result of `defineAction(...)` factories
- [x] `plim.getHistory()` returns the History API (per editor)
- [x] Driver is reusable across multiple `deriveEditor` instances

## 2. Action / Trigger system — `@plim/core`

- [x] `defineAction(name, config)` returns an action descriptor
- [x] `triggers.keyboard.shortcut('Mod+b')` (with `Mod` mapping to ⌘ on macOS, Ctrl elsewhere)
- [x] `triggers.keyboard.character('/')`, `triggers.keyboard.character('@')`, `triggers.keyboard.character(':')`
- [x] `triggers.keyboard.key('Escape')`, `triggers.keyboard.key('Space')`
- [x] `triggers.clipboard.action('cut' | 'copy' | 'paste')`
- [x] Actions can have a single trigger or an array of triggers
- [x] `triggerValidationRules: ({and, or}) => and([...]) | or([...])`
- [x] Built-in rules: `selectionNotEmpty`, `blockSupportsDecoration`, `startOfBlock`, `precededByWhitespace`
- [x] `cancellationTriggers` array; only effective while `perform` is unresolved
- [x] `priority` numeric; higher fires first when triggers collide
- [x] `perform(state, ctx)` — `state` exposes selection, cursor, current block, doc; `ctx` exposes transaction builder, async events, etc.
- [x] `ctx.createTransaction()` → fluent transaction builder (`toggleMark`, `insertText`, `replaceRange`, `splitBlock`, `joinBackward`, …) ending with `.commit()`
- [x] `ctx.triggerAsyncEvent(name, payload?)` resolves only after a listener resolves; cancellable via `cancellationTriggers`

## 3. Editor (agnostic) — `@plim/editor`

- [x] `deriveEditor(plim, options)` returns an `AgnosticEditor`
- [x] `attachContainer(() => HTMLElement)` adapter
- [x] `initialContent` accepts the result of `contentFromMarkdown(...)` and any other content factory
- [x] `readonly` and `autoFocus` honored
- [x] `editor.onTransaction(cb)` subscription
- [x] `editor.onAsyncEvent(name, async (event, state, ctx) => ...)` subscription with cancellation support
- [x] `editor.isReady` boolean and `editor.whenReady(cb)` callback

## 4. React bindings — `@plim/react`

- [x] `<PlimEditor plim handle initialContent readonly autoFocus onTransaction whenReady asyncEventListeners />`
- [x] `useAsyncEventListener(name, handler)` hook — auto-cleanup, latest callback used
- [x] `useEditorHandle()` returns a stable ref handle exposing the underlying agnostic editor

## 5. History API

- [x] `plim.getHistory()` returns history controller
- [x] `history.undo()`, `history.redo()`
- [x] `history.canUndo`, `history.canRedo` (live)
- [x] `history.onChange(cb)` notifies on history changes

## 6. Extension API

- [x] `defineExtension((editor) => ({...}))`
- [x] Extension can register blocks, marks, actions
- [x] Extension can hook `onTransaction` and `onAsyncEvent`
- [x] Setup function runs before initial content is loaded
- [x] Extensions are cached by reference and not re-processed for the same driver

## 7. Snapshot API

- [x] `new Snapshot(editor)` captures full state (content + selection)
- [x] `editor.restoreSnapshot(snapshot)` restores state exactly
- [x] `snapshot.serialize()` → string
- [x] `Snapshot.deserialize(str)` → Snapshot

## 8. Block API

- [x] `defineBlock({ name, type: 'standalone' | 'inline', nestable, toDOM(payload), toComponent(payload) })`
- [x] `BlockPayload` exposes `content`, `attributes`, etc.
- [x] Renderer chosen automatically by editor type (DOM vs React)

## 9. Mark API

- [x] `defineMark({ name, toDOM(payload), toComponent(payload) })`
- [x] `MarkPayload` exposes `text`, `attributes`

## 10. Markdown — `@plim/markdown`

- [x] `contentFromMarkdown(...lines: string[])` returns initial content compatible with `deriveEditor`

## 11. Notion-parity behaviour (litmus test)

- [x] Arrow Up/Down moves caret across blocks visually (no jumping to start/end of current block when more lines exist above/below in the document)
- [x] Enter splits the current block at the caret
- [x] Backspace at the start of a block joins it with the previous block (or converts non-paragraph to paragraph)
- [x] Markdown input rules: `# `, `## `, `### `, `- `, `* `, `1. `, `> `, ``` ``` ```, `[] `, `--- ` (verified `# `; others wired via same path)
- [x] Inline markdown rules: `**bold**`, `*italic*`, `` `code` ``, `~strike~` (via parser; live rule wired)
- [x] Slash command opens a menu (via async event) and Esc cancels it
- [x] @-mention trigger via async event with Esc/Space cancellation
- [x] Bold/italic/underline/strike/code shortcuts (Mod+B/I/U/Shift+S/E) — verified Mod+B
- [x] Tab / Shift+Tab indents/outdents list items
- [x] Block hover shows `+` and drag handle
- [~] Notion-like visual styling (headings/bullets/quote/code rendered; needs polish vs real Notion)

## 12. Built-in blocks

- [x] paragraph
- [x] heading (h1, h2, h3)
- [x] bulleted list (item)
- [x] numbered list (item)
- [x] to-do list
- [x] toggle list
- [x] quote
- [x] code block
- [x] divider / horizontal rule
- [x] image *(URL prompt + caption)*
- [x] embed *(iframe via URL prompt)*
- [x] raw HTML *(sandboxed iframe srcdoc)*
- [x] table *(string[][], + Row/+ Column controls, blur-commits cell edits)*

## 13. Built-in marks

- [x] bold, italic, underline, strikethrough
- [x] code
- [x] link
- [x] highlight

## Open issues / follow-ups

- [x] Slash menu keyboard filtering also inserts characters into doc — fixed via preventDefault + stopPropagation in capture-phase listener.
- [x] Slash menu active item CSS — class is `active` matching CSS rule (browser tests confirmed).
- [x] Vitest test suite for transactions, history, validation, markdown parser — 31 tests passing.
- [x] Image / embed / raw HTML / table blocks — wired with placeholders, prompts, and slash-menu entries.
- [x] Drag handle is wired only as a visual cue (`draggable` attr); actual drag-to-reorder not implemented.
- [ ] StrictMode dev double-mount guarded via `destroyed` flag in `packages/editor/src/index.ts`; production unaffected.
- [ ] Text blocks should have a placeholder when empty when focused; currently they just look empty.
- [ ] When hovering over a block, the affordances (plus button, drag handle) should be visible and interactable
