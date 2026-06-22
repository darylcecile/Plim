# @plim/markdown

A Markdown parser and serializer for [Plim](https://github.com/darylcecile/plim) documents. It round-trips between Markdown text and Plim's block tree, understands the built-in block & mark vocabulary, and lets your custom blocks opt into Markdown support. Runtime-agnostic (no DOM) — useful in the browser, on a server, or in a build step.

## Install

```sh
pnpm add @plim/markdown @plim/core
```

## Parse & serialize

```ts
import { contentFromMarkdown, parseMarkdown, contentToMarkdown } from '@plim/markdown';

// Variadic line form — convenient for inline-defined initial content.
const doc = contentFromMarkdown(
  '# Hello, Plim',
  '',
  'A **block** editor with `code` and *style*.',
);

// Array form, with custom-block descriptors that implement `fromMarkdown`.
const parsed = parseMarkdown(rawText.split('\n'), { blocks: [calloutBlock] });

// Serialize back; pass the same descriptors so their `toMarkdown` runs.
const md = contentToMarkdown(parsed, { blocks: [calloutBlock] });
```

### API

- `contentFromMarkdown(...lines: string[]): DocumentNode` — variadic convenience wrapper around `parseMarkdown`.
- `parseMarkdown(lines: readonly string[], options?: { blocks?: BlockDescriptor[] }): DocumentNode`.
- `contentToMarkdown(doc: DocumentNode | BlockNode[], options?: { blocks?: BlockDescriptor[] }): string`.

## Supported vocabulary

Out of the box it handles the built-in blocks and marks:

- **Blocks** — paragraphs, headings (`#`…`######`), quotes (`>`), bulleted / numbered / todo lists, horizontal rules (`---`), fenced code blocks, and images.
- **Marks** — `**bold**`, `*italic*`, `` `code` ``, `~strike~`, `[link](href)`, and `<u>underline</u>`.

## Custom-block round-tripping

A custom block participates in Markdown by implementing two optional hooks on its descriptor:

- **`fromMarkdown`** — consulted *before* the built-in line parser; the first non-null result wins. Use it to claim lines (e.g. a `> [!NOTE]` callout) and produce a `BlockNode`.
- **`toMarkdown`** — returns a string or an array of lines for serialization.

Pass the descriptors that implement these hooks to both `parseMarkdown` and `contentToMarkdown` via the `blocks` option, and the round-trip stays lossless for your custom content.

## Where to go next

- **Document model** — [`@plim/core`](https://github.com/darylcecile/plim/tree/main/packages/core) (`defineBlock`, `BlockDescriptor`, `DocumentNode`).
- **HTML output** — [`@plim/html`](https://github.com/darylcecile/plim/tree/main/packages/html) for SSR / email rendering.
- **Reference app** — [`examples/notion-clone`](https://github.com/darylcecile/plim/tree/main/examples/notion-clone).

## License

See the [LICENSE](./LICENSE) file in this package.
