# @plim/html

`@plim/html` is a headless, SSR-safe serializer for turning a [Plim](https://github.com/darylcecile/plim) document model into an HTML string. It uses no DOM APIs, so it can run in Node, edge runtimes, server previews, SEO rendering, and email pipelines. It is the read-only, server-side counterpart to [`@plim/editor`](https://github.com/darylcecile/plim/tree/main/packages/editor), and is **optional**.

## Install

```sh
pnpm add @plim/html @plim/core
```

## Usage

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

## API

- `serializeToHTML(input, options?)` — `input` is a `DocumentNode`, `EditorState`, `Snapshot`, or `BlockNode[]`; `options` includes `document`, `classPrefix`, `blocks`, `marks`, and `onUnknownBlock`.
- `defaultBlockRenderers` / `defaultMarkRenderers` — the built-in renderer maps, exported so you can extend rather than replace them.
- `toDocumentNode(input)` — normalize any accepted input to a `DocumentNode`.
- `escape(value)` / `attr(name, value)` — the escaping helpers also available on the render context as `ctx.escape` / `ctx.attr`.
- Types: `BlockRenderer`, `MarkRenderer`, `RenderContext`, `HTMLInput`, `HTMLSerializerOptions`.

## Where to go next

- **Document model** — [`@plim/core`](https://github.com/darylcecile/plim/tree/main/packages/core).
- **Markdown round-tripping** — [`@plim/markdown`](https://github.com/darylcecile/plim/tree/main/packages/markdown).
- **Full API contract** — [`REQUIREMENTS.md`](https://github.com/darylcecile/plim/blob/main/REQUIREMENTS.md).

## License

See the [LICENSE](./LICENSE) file in this package.
