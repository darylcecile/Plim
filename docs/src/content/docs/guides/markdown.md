---
title: Markdown
description: Round-trip between Markdown and Plim documents.
---

`@plim/markdown` round-trips between Markdown and Plim documents. It understands the
built-in block & mark vocabulary (paragraphs, headings, quotes, bulleted/numbered/todo
lists, dividers, fenced code, images, plus `**bold**`, `*italic*`, `` `code` ``,
`~strike~`, `[link](href)`, `<u>underline</u>`).

See the [`@plim/markdown` API reference](/api/markdown/) for `contentFromMarkdown`,
`parseMarkdown`, and `contentToMarkdown`.

```ts
import { contentFromMarkdown, parseMarkdown, contentToMarkdown } from '@plim/markdown';

// Variadic line form - convenient for inline-defined initial content.
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

Custom blocks opt in by implementing `fromMarkdown` (consulted before the built-in line
parser; first non-null wins) and `toMarkdown` (returns a string or array of lines). See
[custom blocks](/guides/custom-blocks/) for how those descriptor fields fit in.
