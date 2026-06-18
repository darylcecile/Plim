# @plim/html

`@plim/html` is a headless, SSR-safe serializer for turning a Plim document model into an HTML string. It uses no DOM APIs, so it can run in Node, edge runtimes, server previews, SEO rendering, and email pipelines.

```ts
import { serializeToHTML } from '@plim/html';

const html = serializeToHTML(doc);
```

`serializeToHTML` accepts a `DocumentNode`, `EditorState`, `Snapshot`, or `BlockNode[]`. By default it returns an HTML fragment. Pass `{ document: true }` to wrap the result in a minimal `<!doctype html><html><body>…` document.

## Custom renderers

Built-in block and mark renderers are exposed and can be overridden or extended. Custom renderers receive a recursive context with escaping helpers and the resolved registries.

```ts
import { serializeToHTML, type BlockRenderer } from '@plim/html';

const callout: BlockRenderer = (node, ctx) =>
`<aside${ctx.attr('class', ctx.classFor('callout'))}>${ctx.renderInline(node.text)}${ctx.renderBlocks(node.children ?? [])}</aside>`;

const html = serializeToHTML(doc, {
classPrefix: 'my-editor-',
blocks: {
callout,
},
});
```

Unknown blocks never throw; they render as a neutral `<div data-block-type="…">…</div>` unless `onUnknownBlock` is supplied. Unknown marks pass their inner HTML through unchanged.

## Security

All text and attribute values are escaped by default, including links, image attributes, and custom helpers via `ctx.escape()` and `ctx.attr()`. The only exception is the `raw_html` block, which is emitted verbatim from `attrs.html`, `attrs.content`, `attrs.raw`, or its text content. Only serialize trusted `raw_html` content or sanitize it before it enters the document, otherwise it can execute XSS.

## Tables

Core only defines the `table` block name. This package supports `attrs.rows` as arrays/cell objects when present, otherwise it treats table `children` as rows and each row's `children` as cells as a best-effort structural representation.
