import * as React from 'react';
import {
	PlimDriver,
	bulletedListBlock,
	codeBlock as codeBlockFactory,
	codeMark,
	defineAction,
	embeddedMediaBlock,
	headingBlock,
	highlightMark,
	horizontalRuleBlock,
	imageBlock,
	italicMark,
	linkMark,
	newId,
	numberedListBlock,
	paragraphBlock,
	quoteBlock,
	rawHTMLBlock,
	strikethroughMark,
	tableBlock,
	todoListBlock,
	toggleBlock,
	triggers,
	underlineMark,
	boldMark,
} from '@plim/core';
import { contentFromMarkdown } from '@plim/markdown';
import {
	DEFAULT_SLASH_ITEMS,
	MentionMenu,
	PlimEditor,
	SlashCommandMenu,
	mentionExtension,
	slashCommandExtension,
	useEditorHandle,
	type MentionUser,
	type SlashCommandItem,
} from '@plim/react';
import { calloutBlock, makeCounterBlock, type CalloutTone } from './customBlocks.js';

// `counterBlock` needs to commit transactions back into the editor when
// the user presses +/- inside the React component, so we expose the
// current editor handle to the descriptor via a closure. The handle is
// populated by <PlimEditor /> on mount and read each time a counter
// renders or commits.
let editorAccess: import('@plim/editor').AgnosticEditor | null = null;
const counterBlock = makeCounterBlock(() => editorAccess);

const plim = new PlimDriver({
	theme: 'light',
	extensions: [slashCommandExtension(), mentionExtension()],
	registeredMarks: [boldMark, italicMark, underlineMark, strikethroughMark, codeMark, linkMark, highlightMark],
	registeredBlocks: [
		paragraphBlock,
		headingBlock,
		bulletedListBlock,
		numberedListBlock,
		todoListBlock,
		toggleBlock,
		quoteBlock,
		codeBlockFactory,
		horizontalRuleBlock,
		imageBlock,
		embeddedMediaBlock,
		rawHTMLBlock,
		tableBlock,
		// Custom block examples (see ./customBlocks.tsx).
		calloutBlock,
		counterBlock,
	],
	registeredActions: [
		defineAction('bold', {
			trigger: triggers.keyboard.shortcut('Mod+b'),
			triggerValidationRules: ({ and }) => and(['selectionNotEmpty', 'blockSupportsDecoration']),
			perform: async (state, ctx) => {
				const sel = state.selection;
				const tx = ctx.createTransaction();
				tx.toggleMark('bold', { from: sel.anchor, to: sel.head });
				tx.commit();
			},
		}),
		defineAction('italic', {
			trigger: triggers.keyboard.shortcut('Mod+i'),
			triggerValidationRules: ({ and }) => and(['selectionNotEmpty', 'blockSupportsDecoration']),
			perform: async (state, ctx) => {
				const sel = state.selection;
				const tx = ctx.createTransaction();
				tx.toggleMark('italic', { from: sel.anchor, to: sel.head });
				tx.commit();
			},
		}),
		defineAction('underline', {
			trigger: triggers.keyboard.shortcut('Mod+u'),
			triggerValidationRules: ({ and }) => and(['selectionNotEmpty', 'blockSupportsDecoration']),
			perform: async (state, ctx) => {
				const sel = state.selection;
				const tx = ctx.createTransaction();
				tx.toggleMark('underline', { from: sel.anchor, to: sel.head });
				tx.commit();
			},
		}),
		defineAction('strikethrough', {
			trigger: triggers.keyboard.shortcut('Mod+Shift+s'),
			triggerValidationRules: ({ and }) => and(['selectionNotEmpty', 'blockSupportsDecoration']),
			perform: async (state, ctx) => {
				const sel = state.selection;
				const tx = ctx.createTransaction();
				tx.toggleMark('strikethrough', { from: sel.anchor, to: sel.head });
				tx.commit();
			},
		}),
		defineAction('inlineCode', {
			trigger: triggers.keyboard.shortcut('Mod+e'),
			triggerValidationRules: ({ and }) => and(['selectionNotEmpty', 'blockSupportsDecoration']),
			perform: async (state, ctx) => {
				const sel = state.selection;
				const tx = ctx.createTransaction();
				tx.toggleMark('code', { from: sel.anchor, to: sel.head });
				tx.commit();
			},
		}),
		defineAction('undo', {
			trigger: triggers.keyboard.shortcut('Mod+z'),
			perform: async () => {
				plim.getHistory().undo();
			},
			priority: 10,
		}),
		defineAction('redo', {
			trigger: [triggers.keyboard.shortcut('Mod+Shift+z'), triggers.keyboard.shortcut('Mod+y')],
			perform: async () => {
				plim.getHistory().redo();
			},
			priority: 10,
		}),
	],
});

const baseContent = contentFromMarkdown(
	'# Welcome to Plim',
	'',
	'A Notion-style editor built on a clean, fast core. Press **/** to open the block menu, or try Markdown shortcuts like `#`, `-`, `>`, or `\``.',
	'',
	'## Features',
	'',
	'- Block-based editing',
	'- *Inline* **formatting** with `code`',
	'- Slash commands and mentions',
	'',
	'> Try splitting this block by pressing Enter — and joining with Backspace.',
	'',
	'```',
	'function hello() {',
	'  return "world";',
	'}',
	'```',
	''
);

// Inject a couple of custom-block examples after the markdown-derived
// content so the page demonstrates `toDOM` (the callout) and
// `toComponent` (the counter) out of the box. Open the slash menu to
// insert more.
const initialContent = {
	...baseContent,
	children: [
		...baseContent.children,
		{
			type: 'heading' as const,
			id: newId(),
			attrs: { level: 2 },
			text: [{ text: 'Custom blocks' }],
		},
		{
			type: 'paragraph' as const,
			id: newId(),
			text: [{ text: 'Two examples wired through the public extension API:' }],
		},
		{
			type: 'callout' as const,
			id: newId(),
			attrs: { tone: 'info' as CalloutTone },
			text: [
				{ text: 'Callouts are defined with ' },
				{ text: 'toDOM', marks: [{ type: 'code' }] },
				{ text: '. Editable text + a tone-coloured pill.' },
			],
		},
		{
			type: 'callout' as const,
			id: newId(),
			attrs: { tone: 'warn' as CalloutTone },
			text: [
				{ text: 'Pick a tone via slash: ' },
				{ text: '/info', marks: [{ type: 'code' }] },
				{ text: ', ' },
				{ text: '/success', marks: [{ type: 'code' }] },
				{ text: ', ' },
				{ text: '/warn', marks: [{ type: 'code' }] },
				{ text: ', ' },
				{ text: '/danger', marks: [{ type: 'code' }] },
				{ text: '.' },
			],
		},
		{
			type: 'counter' as const,
			id: newId(),
			attrs: { title: 'Tasks shipped', count: 3 },
		},
		{
			type: 'paragraph' as const,
			id: newId(),
			text: [
				{ text: 'The counter is a ' },
				{ text: 'toComponent', marks: [{ type: 'code' }] },
				{ text: ' block — a real React component that persists its value into the doc and survives undo/redo.' },
			],
		},
	],
};

// Slash menu items for the custom blocks. Selecting any of these
// fires the same `setBlockType` transaction the built-ins use, with
// the appropriate block type + default attrs.
const customSlashItems: readonly SlashCommandItem[] = [
	{
		id: 'callout-info',
		label: 'Callout — Info',
		hint: 'Highlight a tip',
		icon: '💡',
		keywords: ['callout', 'info', 'tip', 'note'],
		blockType: 'callout',
		attrs: { tone: 'info' satisfies CalloutTone },
	},
	{
		id: 'callout-success',
		label: 'Callout — Success',
		hint: 'Celebrate a win',
		icon: '✅',
		keywords: ['callout', 'success', 'done', 'ok'],
		blockType: 'callout',
		attrs: { tone: 'success' satisfies CalloutTone },
	},
	{
		id: 'callout-warn',
		label: 'Callout — Warning',
		hint: 'Flag something risky',
		icon: '⚠️',
		keywords: ['callout', 'warn', 'warning', 'caution'],
		blockType: 'callout',
		attrs: { tone: 'warn' satisfies CalloutTone },
	},
	{
		id: 'callout-danger',
		label: 'Callout — Danger',
		hint: 'Mark a hazard',
		icon: '🛑',
		keywords: ['callout', 'danger', 'error', 'critical'],
		blockType: 'callout',
		attrs: { tone: 'danger' satisfies CalloutTone },
	},
	{
		id: 'counter',
		label: 'Counter',
		hint: 'Interactive React block',
		icon: '🔢',
		keywords: ['counter', 'count', 'tally', 'react'],
		blockType: 'counter',
		attrs: { title: 'Counter', count: 0 },
	},
];

const slashItems: readonly SlashCommandItem[] = [...DEFAULT_SLASH_ITEMS, ...customSlashItems];

export function App() {
	const handle = useEditorHandle();
	// Expose the live editor to `counterBlock`'s closure so the React
	// component can commit transactions back into the doc when the user
	// clicks +/−. PlimEditor populates `handle.current` imperatively
	// inside its mount effect; this effect runs after that and copies the
	// reference into the module-scope variable the descriptor closes over.
	React.useEffect(() => {
		editorAccess = handle.current;
		return () => {
			editorAccess = null;
		};
	});
	return (
		<div className="page">
			<header className="page-header">
				<div className="emoji">📝</div>
				<h1 className="page-title" contentEditable suppressContentEditableWarning>
					Untitled
				</h1>
			</header>
			<PlimEditor plim={plim} handle={handle} initialContent={initialContent} autoFocus />
			<SlashCommandMenu editor={handle} items={slashItems} />
			<MentionMenu editor={handle} searchUsers={fakeAsyncUserSearch} />
		</div>
	);
}

// Demo async user source. Real apps would hit an API; here we simulate
// a 250ms network round-trip and honour the AbortSignal so cancelled
// requests don't fight newer ones.
const ALL_USERS: MentionUser[] = [
	{ id: 'u1', name: 'Alice Anderson', handle: 'alice', avatar: '🦊', role: 'Engineering' },
	{ id: 'u2', name: 'Ben Becker', handle: 'ben', avatar: '🐻', role: 'Design' },
	{ id: 'u3', name: 'Carla Cruz', handle: 'carla', avatar: '🐱', role: 'Product' },
	{ id: 'u4', name: 'Diego Diaz', handle: 'diego', avatar: '🦅', role: 'Engineering' },
	{ id: 'u5', name: 'Elena Eriksen', handle: 'elena', avatar: '🐺', role: 'Marketing' },
	{ id: 'u6', name: 'Farah Fadel', handle: 'farah', avatar: '🐯', role: 'Operations' },
	{ id: 'u7', name: 'Gabriel Gomes', handle: 'gabriel', avatar: '🦁', role: 'Engineering' },
	{ id: 'u8', name: 'Hana Hashimoto', handle: 'hana', avatar: '🐰', role: 'Research' },
];

async function fakeAsyncUserSearch(query: string, signal: AbortSignal): Promise<MentionUser[]> {
	await new Promise<void>((resolve, reject) => {
		const id = window.setTimeout(resolve, 250);
		signal.addEventListener('abort', () => {
			window.clearTimeout(id);
			reject(new DOMException('aborted', 'AbortError'));
		});
	});
	const q = query.trim().toLowerCase();
	if (!q) return ALL_USERS.slice(0, 5);
	return ALL_USERS.filter(
		(u) =>
			u.name.toLowerCase().includes(q) ||
			u.handle.toLowerCase().includes(q) ||
			(u.role ? u.role.toLowerCase().includes(q) : false)
	);
}
