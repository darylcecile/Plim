---
title: Testing
description: Unit-test your blocks, marks, and extensions headlessly - no browser required.
---

`@plim/test-utils` makes it easy to unit-test your own blocks, marks, and extensions
without mounting a browser - it productizes the headless-editor pattern this repo uses
across its own suite. You get fluent builders, a real-driver `createTestEditor` (no DOM),
`applyTx`, and runner-agnostic inspectors/assertions (works under Vitest, Jest, or
`node:test`). Add it as a `devDependency`.

See the [`@plim/test-utils` API reference](/api/test-utils/) for every builder and
assertion.

```ts
import { createTestEditor, doc, paragraph, bold, applyTx, assertPlainText } from '@plim/test-utils';

const editor = createTestEditor({ content: doc(paragraph('Hello ', bold('world'))) });
applyTx(editor, (tx) => tx.insertText([0], 11, '!'));
assertPlainText(editor.getState(), 'Hello world!');
```

Use `createIdFactory` for deterministic ids in snapshot fixtures, and register custom
`blocks` / `marks` / `extensions` on `createTestEditor` to exercise them headlessly.
