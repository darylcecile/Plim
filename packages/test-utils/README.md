# @plim/test-utils

Runner-agnostic helpers for testing Plim documents, transactions, blocks, marks, and extensions without mounting a browser editor.

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
