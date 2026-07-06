---
title: Introduction
description: An overview of Plim, a Notion-inspired block editor built as a composable TypeScript monorepo.
---

Plim is a Notion-inspired block editor for the web, built as a TypeScript monorepo.
Plim ships a framework-agnostic core, a DOM view layer, a Markdown
parser/serializer, and React bindings - all small, composable, and designed to be
embedded in your own product.

:::note[Status]
Pre-1.0 (`0.0.x`). The public API is mostly stable but may shift before `1.0`.
:::

## The package stack

Plim is split into eleven focused packages. Take only the layers you need.

| Package | Description |
| --- | --- |
| [`@plim/core`](/api/core/) | Schema, document model, transactions, validation rules, action/extension/trigger system, history, and the built-in block & mark descriptors. Runtime-agnostic - no DOM. |
| [`@plim/ledger`](/api/ledger/) | Record, replay, merge, diff, and rebase transactions (`TransactionLedger`, `LedgerRecord`) plus conflict resolution - the bring-your-own sync / CRDT layer. Runtime-agnostic. |
| [`@plim/transports`](/api/transports/) | Tiny generic duplex-channel primitives (`Transport<T>`): in-memory loopback + broadcast bus, `BroadcastChannelTransport`, reconnecting `WebSocketTransport`, and `mapTransport` codecs. The wire that collaboration and comments sync over. Zero-dep. |
| [`@plim/collaboration`](/api/collaboration/) | Real-time multi-peer editing on top of the ledger: `Collaborator` (optimistic OT), `CollabHub` (transport-agnostic server half), presence/awareness, and version vectors - plus comments & threaded replies (`commentMark`, observable `CommentStore`, `CommentSync`). |
| [`@plim/markdown`](/api/markdown/) | Parse Markdown into a Plim document (`contentFromMarkdown`, `parseMarkdown`) and serialize back (`contentToMarkdown`). |
| [`@plim/editor`](/api/editor/) | The view layer. Mounts a Plim document into a `contenteditable`, owns the floating toolbar, the block-handle gutter, paste/clipboard handling, drag-and-drop, and the keyboard pipeline. Ships its own stylesheet. |
| [`@plim/react`](/api/react/) | React bindings: `<PlimEditor>`, `useEditorHandle()`, slash-command and mention extensions with first-class React components, and a bridge for defining blocks with `toComponent`. |
| [`@plim/mojis`](/api/mojis/) | Slackmoji-style custom inline emoji ("mojis"). Live-converts `:slug:` shortcodes as you type or paste, resolves through your own map or an async (cached) resolver for hundreds of workspace emoji, behaves like ordinary text for cursor/selection, and copies back out as `:slug:` markdown. Ships its own stylesheet. Optional. |
| [`@plim/html`](/api/html/) | Headless, SSR-safe serializer: render a document model to an HTML string (`serializeToHTML`) with overridable per-block / per-mark renderers and escaped-by-default output. No DOM - runs in Node, edge, email, and SEO pipelines. Optional. |
| [`@plim/storage`](/api/storage/) | Durable persistence primitives: pluggable `StorageAdapter`s (memory, `localStorage`, IndexedDB, transport) plus debounced snapshot autosave (`createAutosave`). Optional. |
| [`@plim/test-utils`](/api/test-utils/) | Runner-agnostic testing helpers: fluent document/mark builders, a headless `createTestEditor` (real driver, no DOM), `applyTx`, and inspectors/assertions for unit-testing your own blocks, marks, and extensions. |

## How the pieces fit

- **`@plim/core`** owns the document model and the transaction system. Everything
  else builds on it.
- **`@plim/editor`** (and **`@plim/react`** on top of it) renders that model and
  turns user input into transactions.
- **`@plim/markdown`** and **`@plim/html`** convert documents to and from other
  formats.
- **`@plim/mojis`** is an optional editor extension that adds custom inline emoji
  on top of `@plim/editor`.
- **`@plim/ledger`**, **`@plim/transports`**, **`@plim/collaboration`**, and
  **`@plim/storage`** form the sync and persistence layers.
- **`@plim/test-utils`** lets you exercise your blocks and extensions headlessly.

## Where to go next

- [Installation](/guides/installation/) - add Plim to your project.
- [Quickstart](/guides/quickstart/) - mount an editor in React or vanilla JS.
- [API reference](/api/core/) - the full, auto-generated symbol-level docs for
  every package.
