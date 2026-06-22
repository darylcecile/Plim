# @plim/test-utils

Runner-agnostic helpers for testing [Plim](https://github.com/darylcecile/plim) documents, transactions, blocks, marks, and extensions without mounting a browser editor. It productizes the headless-editor pattern this repo uses across its own suite, and works under Vitest, Jest, or `node:test`. Add it as a `devDependency`.

## Install

```sh
pnpm add -D @plim/test-utils
```

## Usage

```ts
import { assertPlainText, bold, createTestEditor, doc, paragraph, applyTx } from '@plim/test-utils';

const editor = createTestEditor({
content: doc(paragraph('Hello ', bold('world'))),
});

applyTx(editor, (tx) => {
tx.insertText([0], 11, '!');
});

assertPlainText(editor.getState(), 'Hello world!');
```

## Stable snapshots

Use deterministic ids when fixtures need stable equality:

```ts
import { createIdFactory, doc, heading, paragraph, normalizeDoc } from '@plim/test-utils';

const ids = createIdFactory('case-a');
const fixture = doc(
heading(2, 'Title', { idFactory: ids }),
paragraph('Body', { idFactory: ids }),
);

expect(normalizeDoc(fixture)).toMatchSnapshot();
```

## Extending

Use `block` for custom blocks and `mark` for custom marks:

```ts
import { block, mark, paragraph } from '@plim/test-utils';

const callout = block('callout', {
attrs: { tone: 'info' },
text: ['Read me'],
});

const annotated = paragraph(mark('comment', { id: 'c1' }, 'review this'));
```

## What's in the box

- **Headless editor** — `createTestEditor({ content, blocks?, marks?, extensions? })` returns a real-driver `TestEditor` with no DOM; `applyTx(editor, fn)` and `apply(...)` dispatch transactions.
- **Document builders** — `doc`, `paragraph`, `heading`, `quote`, `codeBlock`, `divider`, `toggle`, `bulletItem`, `numberedItem`, `todoItem`, `block`, `text`, `inline`.
- **Mark builders** — `bold`, `italic`, `underline`, `strike`, `code`, `link`, `highlight`, and the generic `mark(name, attrs?, …children)`.
- **Inspectors** — `plainText`, `blockText`, `getBlock`, `marksAt`, `normalizeDoc`, `debugTree`, and `createIdFactory` for deterministic ids in snapshot fixtures.
- **Assertions** — `assertPlainText`, `assertBlockText`, `assertBlockType`, `assertHasMark`, `assertNoMark`, `assertDocEquals`.

## Where to go next

- **Document model & APIs** — [`@plim/core`](https://github.com/darylcecile/plim/tree/main/packages/core).
- **Full API contract** — [`REQUIREMENTS.md`](https://github.com/darylcecile/plim/blob/main/REQUIREMENTS.md).

## License

See the [LICENSE](./LICENSE) file in this package.
