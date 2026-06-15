# API Requirements

This doc outlines the design of the API for Plim. It covers the core APIs for creating and managing the editor, as well as the APIs for defining blocks, marks, actions, and extensions. The API is designed to be flexible and extensible, allowing developers to easily customize and extend the editor's functionality to fit their specific use cases.

This doc MUST be used as a guide and requirements checklist for the implementation of the Plim editor and its related packages. It should be referred to throughout the development process to ensure that all necessary features and functionalities are implemented according to the design specifications outlined in this document.

## Editor API

The editor should be simple to create, with configurable options (that can be changed at runtime). It should also be easy to get the editor's state and subscribe to changes.

```ts
import { PlimDriver, defineAction, triggers } from '@plim/core';

const plim = new PlimDriver({
	theme: 'light', // theme name or custom theme object
	extensions: [ /* array of extensions to use */ ], // array of extensions to use in the editor
	registeredMarks: [
		boldMark(),
		italicMark(),
		underlineMark(),
		strikethroughMark(),
		codeMark(),
		linkMark(),
		highlightMark(),
		// ...other marks
	],
	registeredBlocks: [
		paragraphBlock(),
		headingBlock(),
		imageBlock(),
		numberedListBlock(),
		bulletedListBlock(),
		horizontalRuleBlock(),
		quoteBlock(),
		codeBlock(),
		embeddedMediaBlock(),
		rawHTMLBlock(),
		tableBlock(),
		// ...other blocks
	],
	registeredActions: [
		defineAction('bold', {
			trigger: triggers.keyboard.shortcut('Mod+b'),
			triggerValidationRules: ({and, or}) => and([
				"selectionNotEmpty", // trigger only if there is a selection
				"blockSupportsDecoration", // trigger only if the current block supports decoration marks (e.g. text blocks)
			]),
			perform: async (state, ctx) => {
				// state contains cursor position, selection, etc. that can be used to determine the context of the action.
				// ctx contains the tools for performing the actions (e.g. transaction builders, state updaters, etc.)

				const { selection } = state;

				await ctx.createTransaction()
					.toggleMark('bold', { from: selection.from, to: selection.to })
					.commit(); // queues the transaction to be committed to the editor
			}
		}),
		defineAction('slashCommand', {
			trigger: triggers.keyboard.character('/'),
			triggerValidationRules: ({and, or}) => or([
				"startOfBlock", // trigger if the slash is at the start of a block
				"precededByWhitespace", // trigger if the slash is preceded by whitespace
			]),
			cancellationTriggers: [
				triggers.keyboard.key('Escape'), // cancel the slash command menu when Escape is pressed
			],
			perform: async (state, ctx) => {
				// show slash command menu based on the current state
				// triggerAsyncEvent will await until the event is handled and resolved by the event listener, allowing the action to be cancelled if the event is cancelled (e.g. if the user presses Escape to close the menu without selecting a command)
				return ctx.triggerAsyncEvent('showSlashCommandMenu');
			},
		}),
		defineAction('mention', {
			trigger: triggers.keyboard.character('@'),
			triggerValidationRules: ({and, or}) => or([
				"startOfBlock", // trigger if the at symbol is at the start of a block
				"precededByWhitespace", // trigger if the at symbol is preceded by whitespace
			]),
			cancellationTriggers: [
				triggers.keyboard.key('Escape'), // cancel the mention suggestions when Escape is pressed
				triggers.keyboard.key('Space'), // optionally cancel the mention suggestions when Space is pressed (e.g. if the user decides not to select a suggestion and continues typing)
			]
			perform: async (state, ctx) => {
				// show mention suggestions based on the current state
				// triggerAsyncEvent will await until the event is handled and resolved by the event listener, allowing the action to be cancelled if the event is cancelled (e.g. if the user presses Escape to close the menu without selecting a mention)
				return ctx.triggerAsyncEvent('showMentionSuggestions');
			},
			priority: 1, // higher priority actions will be triggered first if multiple actions have the same trigger
		}),
		defineAction('emoji', {
			trigger: triggers.keyboard.character(':'),
			triggerValidationRules: ({and, or}) => or([
				"startOfBlock", // trigger if the colon is at the start of a block
				"precededByWhitespace", // trigger if the colon is preceded by whitespace
			]),
			cancellationTriggers: [
				triggers.keyboard.key('Escape'), // cancel the emoji suggestions when Escape is pressed
				triggers.keyboard.key('Space'), // optionally cancel the emoji suggestions when Space is pressed (e.g. if the user decides not to select a suggestion and continues typing)
				triggers.keyboard.character(':'), // optionally cancel the emoji suggestions if another colon is typed (e.g. if the user decides to type a colon without selecting an emoji)
			],
			perform: async (state, ctx) => {
				// show emoji suggestions based on the current state
				// triggerAsyncEvent will await until the event is handled and resolved by the event listener, allowing the action to be cancelled if the event is cancelled (e.g. if the user presses Escape to close the menu without selecting an emoji)
				return ctx.triggerAsyncEvent('showEmojiSuggestions');
			},
			priority: 1, // higher priority actions will be triggered first if multiple actions have the same trigger
		}),
		defineAction('cut', {
			trigger: [
				triggers.keyboard.shortcut('Mod+x'),
				triggers.clipboard.action('cut')
			],
			perform: async (state, ctx) => {
				// handle cut action (e.g. set custom clipboard data, etc.)
			}
			priority: 1, // higher priority actions will be triggered first if multiple actions have the same trigger
		}),
		defineAction('copy', {
			trigger: [
				triggers.keyboard.shortcut('Mod+c'),
				triggers.clipboard.action('copy')
			],
			perform: async (state, ctx) => {
				// handle copy action (e.g. set custom clipboard data, etc.)
			}
			priority: 1, // higher priority actions will be triggered first if multiple actions have the same trigger
		}),
		defineAction('paste', {
			trigger: [
				triggers.keyboard.shortcut('Mod+v'),
				triggers.clipboard.action('paste')
			],
			perform: async (state, ctx) => {
				// handle paste action (e.g. read custom clipboard data, etc.)
			}
			priority: 1, // higher priority actions will be triggered first if multiple actions have the same trigger
		}),
	]
});
```

> [!NOTE]
> When using `cancellationTriggers`, the action can only be cancelled if the `perform` promise has not yet resolved. This means any custom actions being performed needs to resolve only when the action is fully completed (e.g. if the action shows a menu, the promise should resolve when the menu is closed, not when it's opened). This allows for more flexible and powerful interactions, while still giving developers control over the cancellation behavior of their actions.

```ts
// agnostic API for creating an editor from the plim instance

import { deriveEditor, attachContainer } from '@plim/editor';
import { contentFromMarkdown } from '@plim/markdown';

const agnosticEditor = deriveEditor(plim, {
	containerAdapter: attachContainer(() => document.getElementById('editor')),
	initialContent: contentFromMarkdown(
		'# Hello World',
		'',
		'This is a **markdown** content that will be converted to the editor\'s internal format on initialization.'
	),
	readonly: false, // whether the editor should be read-only
	autoFocus: true, // whether to focus the editor on init
});

agnosticEditor.onTransaction((transaction) => {
	// handle editor transactions (e.g. content changes, selection changes, etc.)
});

agnosticEditor.onAsyncEvent('showSlashCommandMenu', async (event, state, ctx) => {
	// state contains cursor position, selection, etc. that can be used to determine the context of the action.
	// ctx contains the tools for performing the actions (e.g. transaction builders, state updaters, etc.)
});

agnosticEditor.onAsyncEvent('showMentionSuggestions', async (event, state, ctx) => {
	// state contains cursor position, selection, etc. that can be used to determine the context of the action.
	// ctx contains the tools for performing the actions (e.g. transaction builders, state updaters, etc.)
});

agnosticEditor.onAsyncEvent('showEmojiSuggestions', async (event, state, ctx) => {
	// state contains cursor position, selection, etc. that can be used to determine the context of the action.
	// ctx contains the tools for performing the actions (e.g. transaction builders, state updaters, etc.)
});

agnosticEditor.isReady // boolean - true if the editor is ready to be interacted with (e.g. initial content has been loaded, and DOM element attached etc.)

agnosticEditor.whenReady(() => {
	// callback that will be called when the editor is ready to be interacted with
});
```

```tsx
// react API for creating an editor from the plim instance
import { PlimEditor, useAsyncEventListener } from '@plim/react';

function MyEditor() {
	const initialContent = contentFromMarkdown(
		'# Hello World',
		'',
		'This is a **markdown** content that will be converted to the editor\'s internal format on initialization.'
	);

	// hook auto cleans on unmount, and ensures the latest callback is used (e.g. if it uses any state from the component)
	const onSlashCommandMenu = useAsyncEventListener('showSlashCommandMenu', async (event, state, ctx) => {
		// state contains cursor position, selection, etc. that can be used to determine the context of the action.
		// ctx contains the tools for performing the actions (e.g. transaction builders, state updaters, etc.)
	});

	const onMentionSuggestions = useAsyncEventListener('showMentionSuggestions', async (event, state, ctx) => {
		// state contains cursor position, selection, etc. that can be used to determine the context of the action.
		// ctx contains the tools for performing the actions (e.g. transaction builders, state updaters, etc.)
	});

	const onEmojiSuggestions = useAsyncEventListener('showEmojiSuggestions', async (event, state, ctx) => {
		// state contains cursor position, selection, etc. that can be used to determine the context of the action.
		// ctx contains the tools for performing the actions (e.g. transaction builders, state updaters, etc.)
	});

	const editor = useEditorHandle();

	return (
		// renders as a managed div that the editor will attach to
		<PlimEditor
			plim={plim}
			handle={editor} // optional ref handle to get the editor instance
			initialContent={initialContent}
			readonly={false} // whether the editor should be read-only
			autoFocus={true} // whether to focus the editor on init
			onTransaction={(transaction) => {
				// handle editor transactions (e.g. content changes, selection changes, etc.)
			}}
			whenReady={() => {
				// callback that will be called when the editor is ready to be interacted with
			}}
			asyncEventListeners={[onSlashCommandMenu, onMentionSuggestions, onEmojiSuggestions]} // array of async event listeners to register on the editor
		/>
	);
}
```

## History API

The editor should have a built-in history system that allows for undo/redo functionality. The history should be easily accessible and manipulable by developers, allowing for features like custom undo/redo buttons, or even more complex features like time-travel debugging.

```ts
const history = plim.getHistory();

history.undo(); // undo the last transaction
history.redo(); // redo the last undone transaction
history.canUndo; // true if there are transactions that can be undone
history.canRedo; // true if there are transactions that can be redone

history.onChange((historyState) => {
	// historyState contains information about the current state of the history (e.g. past transactions, future transactions, etc.)
});
```

## Extension API

The editor should have a flexible extension system that allows developers to easily add new functionality to the editor. Extensions should be able to define new blocks, marks, actions, and even custom editor behaviors. The API for creating extensions should be simple and intuitive, allowing developers to focus on the functionality of their extension rather than the implementation details.

```ts
import { defineExtension } from '@plim/core';

const myExtension = defineExtension((editor: AgnosticEditor) => {
	// can do some setup with the editor instance if needed (e.g. register custom commands, etc.)
	// at this point the editor instance is not fully initialized yet (e.g. initial content has not been loaded, etc.), so some operations may not be available yet (e.g. getting the current state, etc.)

	return {
		name: 'myExtension',
		registeredBlocks: [
			// define new blocks
		],
		registeredMarks: [
			// define new marks
		],
		registeredActions: [
			// define new actions
		],
		onTransaction: (transaction, ctx) => {
			// define custom behavior on transactions (e.g. modify transactions, trigger side effects, etc.)
		},
		onAsyncEvent: async (event, state, ctx) => {
			// define custom behavior on async events (e.g. show a menu when a certain event is triggered, etc.)
		},
	}
});
```

Any attached extensions will be registered with the editor instance during initialization. Once initialized the extension will be cached and not re-processed on subsequent editor initializations, allowing for better performance when creating multiple editor instances with the same extensions. 

## Snapshot API

The editor should have a snapshot API that allows developers to easily capture and restore the state of the editor at any point in time. This can be useful for features like saving drafts, implementing a "revert to this point" feature, or even for debugging purposes.

```ts
import { Snapshot } from '@plim/core';

const snapshot = new Snapshot(editor); // creates a snapshot of the editor's current state

// ...some operations that modify the editor's state

editor.restoreSnapshot(snapshot); // restores the editor's state to the state captured in the snapshot

const serializedSnapshot = snapshot.serialize(); // serialize the snapshot to a JSON string for storage or transmission

// ...some operations that store or retrieve the serialized snapshot

const deserializedSnapshot = Snapshot.deserialize(serializedSnapshot); // deserialize the snapshot from a JSON string
```

A snapshot captures the entire state of the editor, including the content, selection, and any other relevant state. Restoring a snapshot will revert the editor back to the exact state it was in when the snapshot was created, allowing for powerful features like time-travel debugging or complex undo/redo functionality. To be used with caution as snapshots can consume a lot of memory if the editor's content is large, so it's recommended to use them sparingly and to always provide a way for users to manage their snapshots (e.g. delete old snapshots, etc.).


## Ledger / Sync API

Where snapshots capture _whole states_ and history captures _undoable steps_, the ledger captures the **stream of committed transactions** as a portable, replayable log. It is the foundation layer for bringing your own sync or CRDT engine: it does not impose a network model or a merge policy, it gives you the primitives (record, replay, merge, diff, conflict detection, rebase) to build one.

The serialized intermediary is the `LedgerRecord` — a flat, JSON-safe snapshot of one transaction's operations stamped with an `id`, a wall-clock `timestamp`, a logical `lamport` clock, an optional `source`, and a pre-computed id-keyed `touches` conflict surface. Records carry operations, not documents, so they stay small and cheap to ship over the wire.

```ts
import { TransactionLedger } from '@plim/core';

const ledger = new TransactionLedger({ source: 'clientA' });

// Record every committed transaction as it is dispatched.
const detach = ledger.attach(editor);

// …or record a transaction by hand.
ledger.record(transaction);

// Replay the whole log onto any other editor seeded with the same base
// document — a single setState, no history pollution.
ledger.replay(otherEditor);
const nextState = ledger.apply(otherEditor.getState()); // pure, no side effects

// Ship it over the wire and rebuild it on the other side.
const payload = ledger.serialize();
const remote = TransactionLedger.deserialize(payload);
```

Multiple ledgers **merge** into a single chronological order (deduplicated by record id), and **diff** to discover what each side is missing:

```ts
import { mergeLedgers, diffLedgers } from '@plim/core';

const merged = mergeLedgers(localLedger, remoteLedger); // chronological union
const { onlyInA, onlyInB, common } = diffLedgers(localLedger, remoteLedger);
```

Concurrent edits are handled two ways. **Conflict resolution** picks a winner when two records touch overlapping regions ("last write wins", "first write wins", "prefer this source", or a custom strategy):

```ts
import { findConflicts, resolveConflicts, lastWriteWins, preferSource } from '@plim/core';

const conflicts = findConflicts(merged.records); // every overlapping pair
const { kept, dropped } = resolveConflicts(merged.records, preferSource(['server', 'clientA']));
```

Or, to keep _both_ sides, **rebase** transforms one record's operations so they apply cleanly on top of a concurrent change — the editor equivalent of `git rebase`:

```ts
import { rebaseRecord } from '@plim/core';

const result = rebaseRecord(remoteRecord, localRecord, baseDoc);
if (result.ok) editor.setState(applyLedgerRecord(editor.getState(), result.record));
else /* fall back to resolveConflicts — the rebase was ambiguous */;
```

The ledger is deliberately unopinionated about transport and policy. It is honest about its limits: conflict detection is conservative (it would rather report a conflict than silently clobber), and rebase covers text edits and block insert/remove/split/move precisely while refusing — rather than guessing — when a concurrent change makes the result genuinely ambiguous.


## Blocks and Marks API

### Blocks API

Blocks are basic building units of the editor's content structure, representing different types of content (e.g. paragraphs, headings, images, etc.). The API for defining blocks should be flexible and allow for a wide range of block types and configurations. Blocks can be configured to be inline, nestable, and even atomic (i.e. cannot have content or child blocks). Blocks should also be able to define their own toolbar buttons and keyboard shortcuts for easy access.

```tsx
import { defineBlock, type BlockPayload } from '@plim/core';

const paragraphBlock = defineBlock({
	name: 'paragraph',
	type: 'standalone', // "standalone" or "inline" - whether the block is a standalone block (e.g. paragraph, heading, etc.) or an inline block (e.g. mention, emoji, etc.)
	nestable: true, // whether the block can have child blocks (e.g. a list block can have list item blocks as children)
	
	toDOM: (payload:BlockPayload) => {
		// convert the block's content to a DOM element for rendering in the editor
		const dom = document.createElement('p');
		dom.textContent = node.content; // example of setting the block's content as text content of the DOM element
		dom.setAttribute('data-block-type', 'paragraph'); // example of setting a data attribute to identify the block type in the DOM
		dom.setAttributes(payload.attributes); // example of applying any additional attributes from the payload to the DOM element
		return dom;
	},

	toComponent: (payload:BlockPayload) => {
		// convert the block's content to a React component for rendering in a React-based editor
		return (
			<p data-block-type="paragraph" {...payload.attributes}>
				{payload.content} // example of rendering the block's content as children of the component
			</p>
		);
	},
});
```

Depending on the Editor type (react or agnostic), the appropriate rendering method (toComponent or toDOM) will be used to render the block in the editor. The payload passed to the rendering methods contains all the necessary information about the block's content and state, allowing for flexible and dynamic rendering based on the block's context.

### Marks API

Marks are inline styles that can be applied to text content within blocks (e.g. bold, italic, links, etc.). The API for defining marks should be simple and allow for a wide range of mark types and configurations. Marks should be able to define their own toolbar buttons and keyboard shortcuts for easy access.

```tsx
import { defineMark, type MarkPayload } from '@plim/core';

const boldMark = defineMark({
	name: 'bold',
	
	toDOM: (payload: MarkPayload) => {
		// handle the application of the mark to a given range of text
		
		const dom = document.createElement('strong');
		dom.textContent = payload.text; // example of setting the marked text as the text content of the DOM element
		dom.setAttribute('data-mark-type', 'bold'); // example of setting a data attribute to identify the mark type in the DOM
		dom.setAttributes(payload.attributes); // example of applying any additional attributes from the payload to the DOM element
		return dom;
	},

	toComponent: (payload: MarkPayload) => {
		// handle the application of the mark to a given range of text in a React-based editor
		return (
			<strong data-mark-type="bold" {...payload.attributes}>
				{payload.text} // example of rendering the marked text as children of the component
			</strong>
		);
	},
});
```

