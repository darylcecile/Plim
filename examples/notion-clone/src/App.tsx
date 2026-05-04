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
import { ActionPanel, PlimEditor, useAsyncEventListener, useEditorHandle } from '@plim/react';
import { SlashMenu } from './SlashMenu.js';
import { MentionMenu, type MentionUser } from './MentionMenu.js';

const plim = new PlimDriver({
	theme: 'light',
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
		defineAction('slashCommand', {
			trigger: triggers.keyboard.character('/'),
			triggerValidationRules: ({ or }) => or(['startOfBlock', 'precededByWhitespace']),
			cancellationTriggers: [triggers.keyboard.key('Escape')],
			perform: async (_state, ctx) => {
				return ctx.triggerAsyncEvent('showSlashCommandMenu');
			},
		}),
		defineAction('mention', {
			trigger: triggers.keyboard.character('@'),
			triggerValidationRules: ({ or }) => or(['startOfBlock', 'precededByWhitespace']),
			cancellationTriggers: [triggers.keyboard.key('Escape'), triggers.keyboard.key(' ')],
			perform: async (_state, ctx) => {
				return ctx.triggerAsyncEvent('showMentionSuggestions');
			},
			priority: 1,
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
	const [slash, setSlash] = React.useState<{
		anchor: Element | null;
		caretRect: DOMRect | null;
		resolve: (cmd: string | null) => void;
	} | null>(null);
	const [mention, setMention] = React.useState<{
		anchor: Element | null;
		caretRect: DOMRect | null;
		resolve: (user: MentionUser | null) => void;
	} | null>(null);

	const onSlash = useAsyncEventListener('showSlashCommandMenu', async () => {
		return await new Promise<string | null>((resolve) => {
			const rect = currentCaretRect();
			// Anchor to the nearest block element so the panel re-aligns on scroll.
			let anchor: Element | null = null;
			const sel = window.getSelection();
			const node = sel?.anchorNode ?? null;
			if (node) {
				const el = node instanceof Element ? node : node.parentElement;
				anchor = el?.closest('[data-block-id]') ?? null;
			}
			setSlash({ anchor, caretRect: rect, resolve });
		});
	});

	const onMention = useAsyncEventListener('showMentionSuggestions', async () => {
		return await new Promise<MentionUser | null>((resolve) => {
			const rect = currentCaretRect();
			let anchor: Element | null = null;
			const sel = window.getSelection();
			const node = sel?.anchorNode ?? null;
			if (node) {
				const el = node instanceof Element ? node : node.parentElement;
				anchor = el?.closest('[data-block-id]') ?? null;
			}
			setMention({ anchor, caretRect: rect, resolve });
		});
	});

	const handleMentionChoice = React.useCallback(
		(user: MentionUser | null) => {
			const editor = handle.current;
			if (!editor) {
				mention?.resolve(user);
				setMention(null);
				return;
			}
			if (user) {
				const state = editor.getState();
				const sel = state.selection;
				const tx = editor.createTransaction();
				// Strip the trigger '@' that the keyboard insertion left in the doc.
				if (sel.head.offset > 0) {
					tx.replaceRange(sel.head.path, sel.head.offset - 1, sel.head.offset, [
						{ text: `@${user.name}`, marks: [{ type: 'link', attrs: { href: `#user-${user.id}` } }] },
						{ text: ' ' },
					]);
				}
				tx.commit();
			}
			mention?.resolve(user);
			setMention(null);
		},
		[handle, mention]
	);

	const handleSlashChoice = React.useCallback(
		(cmd: string | null) => {
			const editor = handle.current;
			if (!editor) {
				slash?.resolve(cmd);
				setSlash(null);
				return;
			}
			if (cmd) {
				const state = editor.getState();
				const sel = state.selection;
				const tx = editor.createTransaction();
				// Remove the trigger '/' character preceding caret
				if (sel.head.offset > 0) {
					tx.replaceRange(sel.head.path, sel.head.offset - 1, sel.head.offset, []);
				}
				switch (cmd) {
					case 'paragraph':
						tx.setBlockType(sel.head.path, 'paragraph');
						break;
					case 'h1':
						tx.setBlockType(sel.head.path, 'heading', { level: 1 });
						break;
					case 'h2':
						tx.setBlockType(sel.head.path, 'heading', { level: 2 });
						break;
					case 'h3':
						tx.setBlockType(sel.head.path, 'heading', { level: 3 });
						break;
					case 'bulleted':
						tx.setBlockType(sel.head.path, 'bulleted_list_item');
						break;
					case 'numbered':
						tx.setBlockType(sel.head.path, 'numbered_list_item');
						break;
					case 'todo':
						tx.setBlockType(sel.head.path, 'to_do', { checked: false });
						break;
					case 'toggle':
						tx.setBlockType(sel.head.path, 'toggle', { open: true });
						break;
					case 'quote':
						tx.setBlockType(sel.head.path, 'quote');
						break;
					case 'code':
						tx.setBlockType(sel.head.path, 'code');
						break;
					case 'divider':
						tx.setBlockType(sel.head.path, 'divider');
						break;
					case 'image':
						tx.setBlockType(sel.head.path, 'image');
						break;
					case 'embed':
						tx.setBlockType(sel.head.path, 'embed');
						break;
					case 'raw_html':
						tx.setBlockType(sel.head.path, 'raw_html');
						break;
					case 'table':
						tx.setBlockType(sel.head.path, 'table', {
							data: [
								['', '', ''],
								['', '', ''],
							],
						});
						break;
				}
				tx.commit();
			}
			slash?.resolve(cmd);
			setSlash(null);
		},
		[handle, slash]
	);

	return (
		<div className="page">
			<header className="page-header">
				<div className="emoji">📝</div>
				<h1 className="page-title" contentEditable suppressContentEditableWarning>
					Untitled
				</h1>
			</header>
			<PlimEditor
				plim={plim}
				handle={handle}
				initialContent={initialContent}
				autoFocus
				asyncEventListeners={[onSlash, onMention]}
			/>
			{slash ? (
				<ActionPanel
					open
					anchor={() => (slash.anchor ?? slash.caretRect) as Element | DOMRect | null}
					placement="bottom-start"
					onClose={() => {
						slash.resolve(null);
						setSlash(null);
					}}
					dismissOnOutsideClick
				>
					<SlashMenu onSelect={handleSlashChoice} />
				</ActionPanel>
			) : null}
			{mention ? (
				<ActionPanel
					open
					anchor={() => (mention.anchor ?? mention.caretRect) as Element | DOMRect | null}
					placement="bottom-start"
					onClose={() => {
						mention.resolve(null);
						setMention(null);
					}}
					dismissOnOutsideClick
				>
					<MentionMenu onSelect={handleMentionChoice} />
				</ActionPanel>
			) : null}
		</div>
	);
}

function currentCaretRect(): DOMRect | null {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0).cloneRange();
	range.collapse(true);
	const rects = range.getClientRects();
	if (rects.length > 0) return rects[0]!;
	const node = range.startContainer;
	if (node instanceof Element) return node.getBoundingClientRect();
	return null;
}
