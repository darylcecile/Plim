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
	MentionMenu,
	PlimEditor,
	SlashCommandMenu,
	mentionExtension,
	slashCommandExtension,
	useEditorHandle,
} from '@plim/react';

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

const initialContent = contentFromMarkdown(
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

export function App() {
	const handle = useEditorHandle();
	return (
		<div className="page">
			<header className="page-header">
				<div className="emoji">📝</div>
				<h1 className="page-title" contentEditable suppressContentEditableWarning>
					Untitled
				</h1>
			</header>
			<PlimEditor plim={plim} handle={handle} initialContent={initialContent} autoFocus />
			<SlashCommandMenu editor={handle} />
			<MentionMenu editor={handle} />
		</div>
	);
}
