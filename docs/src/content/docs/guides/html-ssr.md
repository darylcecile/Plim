---
title: HTML & SSR
description: Render a Plim document to an HTML string with no DOM - for SSR, SEO, email, and edge runtimes.
---

`@plim/html` renders a Plim document model to an HTML **string** with no DOM APIs - for
server previews, SEO, transactional emails, and edge runtimes. It's the read-only,
server-side counterpart to `@plim/editor`. `serializeToHTML` accepts a `DocumentNode`,
`EditorState`, `Snapshot`, or `BlockNode[]`; output is escaped by default (only the
`raw_html` block is emitted verbatim - sanitize untrusted input).

See the [`@plim/html` API reference](/api/html/) for `serializeToHTML`, `BlockRenderer`,
and the rendering context.

```ts
import { serializeToHTML, type BlockRenderer } from '@plim/html';

// Fragment by default; pass { document: true } for a full <!doctype html> page.
const fragment = serializeToHTML(snapshot);

// Override or add per-block / per-mark renderers - everything else falls back to the defaults.
const callout: BlockRenderer = (node, ctx) =>
  `<aside${ctx.attr('class', ctx.classFor('callout'))}>${ctx.renderInline(node.text)}</aside>`;

const page = serializeToHTML(doc, { document: true, classPrefix: 'plim-', blocks: { callout } });
```

Unknown blocks render as a neutral `<div data-block-type="...">` (or your
`onUnknownBlock`); unknown marks pass their inner HTML through unchanged, so the package
stays decoupled from `@plim/collaboration`'s `commentMark` and any custom marks.
