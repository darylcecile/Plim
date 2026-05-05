import { type BlockDescriptor, type MarkDescriptor, type ToolbarItem, type ToolbarItemContext, defineBlock, defineMark } from './blocks.js';
import type { EditorHandle } from './editor-handle.js';
import { flattenBlocks, getBlockAt } from './selection.js';

// Resolve which block paths a block-mode toolbar item should operate on.
// In block-mode the user has block-selected one or more blocks via the
// drag handle / shift+click; we walk the doc to find their paths. Falls
// back to the head selection path for selection-mode invocations.
function targetPathsForBlockTransform(ctx: ToolbarItemContext): number[][] {
	if (ctx.blockSelection.size > 0) {
		const out: number[][] = [];
		for (const entry of flattenBlocks(ctx.state.doc)) {
			if (ctx.blockSelection.has(entry.block.id)) out.push(entry.path);
		}
		return out;
	}
	return [ctx.state.selection.head.path];
}

// Toolbar helpers ----------------------------------------------------------
//
// All built-in mark toggles share the same `perform`: emit a `toggleMark`
// op spanning the current selection. `tx.toggleMark` already handles the
// "is on / is off" decision based on whether every span in the range
// already carries the mark, so we don't have to recompute that here.
function toggleMarkItem(name: string, label: string, icon?: string, shortcut?: string): ToolbarItem {
	const item: ToolbarItem = {
		name,
		label,
		group: 'mark',
		perform: ({ state, editor }) => {
			const tx = editor.createTransaction();
			tx.toggleMark(name, {
				from: { path: state.selection.anchor.path, offset: state.selection.anchor.offset },
				to: { path: state.selection.head.path, offset: state.selection.head.offset },
			});
			tx.commit();
		},
	};
	if (icon) item.icon = icon;
	if (shortcut) item.shortcut = shortcut;
	return item;
}

// Marks ---------------------------------------------------------------------
//
// Mark `toDOM` returns an *empty wrapper* element. The editor inserts the
// span's text (and any nested mark wrappers) inside it. Descriptors must NOT
// set `textContent` themselves — doing so would clobber nested marks like
// bold-inside-link. Use `payload.attrs` to read mark-level attributes
// (`href`, `id`, etc.) and emit them as DOM attributes / classes only.

export const boldMark = defineMark({
	name: 'bold',
	toDOM: () => document.createElement('strong'),
	toolbar: toggleMarkItem('bold', 'Bold', '<b>B</b>', '⌘B'),
});

export const italicMark = defineMark({
	name: 'italic',
	toDOM: () => document.createElement('em'),
	toolbar: toggleMarkItem('italic', 'Italic', '<i>I</i>', '⌘I'),
});

export const underlineMark = defineMark({
	name: 'underline',
	toDOM: () => document.createElement('u'),
	toolbar: toggleMarkItem('underline', 'Underline', '<u>U</u>', '⌘U'),
});

export const strikethroughMark = defineMark({
	name: 'strikethrough',
	toDOM: () => document.createElement('s'),
	toolbar: toggleMarkItem('strikethrough', 'Strikethrough', '<s>S</s>', '⌘⇧S'),
});

export const codeMark = defineMark({
	name: 'code',
	toDOM: () => {
		const el = document.createElement('code');
		el.className = 'plim-inline-code';
		return el;
	},
	toolbar: toggleMarkItem('code', 'Code', '<span style="font-family:monospace">&lt;&gt;</span>', '⌘E'),
});

export const linkMark = defineMark({
	name: 'link',
	toDOM: (p) => {
		const el = document.createElement('a');
		const href = (p.attrs?.href as string | undefined) ?? '#';
		el.setAttribute('href', href);
		el.setAttribute('rel', 'noreferrer');
		el.setAttribute('target', '_blank');
		return el;
	},
	// The link toolbar item swaps the toolbar for an inline URL input
	// rather than just toggling the mark. The view-side toolbar treats
	// items whose `name === 'link'` specially (renders the popover); the
	// `perform` is still here as a no-op fallback in case some embedder
	// wires up a non-toolbar invocation path.
	toolbar: {
		name: 'link',
		label: 'Link',
		icon: '🔗',
		shortcut: '⌘K',
		group: 'mark',
		perform: () => {
			/* handled by toolbar popover */
		},
	},
});

export const highlightMark = defineMark({
	name: 'highlight',
	toDOM: () => document.createElement('mark'),
});

// Mention mark — atomic inline reference to an entity (user, page, etc.).
// Renders as a `<span class="plim-mention">` so consumers can style it as a
// pill, and exposes its identifier via `data-mention-id` for downstream
// hooks (analytics, click handlers, etc.). The presence of this mark on a
// span signals to the editor that the span should behave as an atomic unit
// (a single Backspace deletes the whole run rather than one character) —
// surfaced via `data-atomic="true"` for view-layer consumers.
export const mentionMark = defineMark({
	name: 'mention',
	toDOM: (p) => {
		const el = document.createElement('span');
		el.className = 'plim-mention';
		const id = (p.attrs?.id as string | undefined) ?? '';
		const href = p.attrs?.href as string | undefined;
		if (id) el.setAttribute('data-mention-id', id);
		if (href) el.setAttribute('data-mention-href', href);
		el.setAttribute('data-atomic', 'true');
		return el;
	},
});

// Blocks --------------------------------------------------------------------

export const paragraphBlock = defineBlock({
	name: 'paragraph',
	type: 'standalone',
	supportsDecoration: true,
	toolbar: {
		name: 'turn-into-paragraph',
		label: 'Text',
		icon: '¶',
		group: 'block',
		priority: 0,
		// `appliesTo` defaults to 'block' for items contributed by a
		// BlockDescriptor — they only render when the block is selected.
		activeWhen: (b) => b.blockTypeIs('paragraph'),
		perform: (ctx) => {
			const tx = ctx.editor.createTransaction();
			for (const path of targetPathsForBlockTransform(ctx)) {
				tx.setBlockType(path, 'paragraph');
			}
			tx.commit();
		},
	},
});

function headingTransform(level: 1 | 2 | 3): ToolbarItem {
	return {
		name: `turn-into-heading-${level}`,
		label: `Heading ${level}`,
		icon: `H${level}`,
		group: 'block',
		priority: level,
		activeWhen: (b) =>
			b.and([
				b.blockTypeIs('heading'),
				b.predicate((ctx) => {
					const blk = getBlockAt(ctx.state.doc, ctx.state.selection.head.path);
					return !!blk && blk.type === 'heading' && (blk.attrs?.level as number | undefined) === level;
				}, `headingLevel${level}`),
			]),
		perform: (ctx) => {
			const tx = ctx.editor.createTransaction();
			for (const path of targetPathsForBlockTransform(ctx)) {
				tx.setBlockType(path, 'heading', { level });
			}
			tx.commit();
		},
	};
}

export const headingBlock = defineBlock({
	name: 'heading',
	type: 'standalone',
	supportsDecoration: true,
	toolbar: [headingTransform(1), headingTransform(2), headingTransform(3)],
});

export const bulletedListBlock = defineBlock({
	name: 'bulleted_list_item',
	type: 'standalone',
	nestable: true,
	supportsDecoration: true,
});

export const numberedListBlock = defineBlock({
	name: 'numbered_list_item',
	type: 'standalone',
	nestable: true,
	supportsDecoration: true,
});

export const todoListBlock = defineBlock({
	name: 'to_do',
	type: 'standalone',
	nestable: true,
	supportsDecoration: true,
});

export const toggleBlock = defineBlock({
	name: 'toggle',
	type: 'standalone',
	nestable: true,
	supportsDecoration: true,
});

export const quoteBlock = defineBlock({
	name: 'quote',
	type: 'standalone',
	nestable: true,
	supportsDecoration: true,
	toolbar: {
		name: 'turn-into-quote',
		label: 'Quote',
		icon: '❝',
		group: 'block',
		priority: 10,
		activeWhen: (b) => b.blockTypeIs('quote'),
		perform: (ctx) => {
			const tx = ctx.editor.createTransaction();
			for (const path of targetPathsForBlockTransform(ctx)) {
				tx.setBlockType(path, 'quote');
			}
			tx.commit();
		},
	},
});

export const codeBlock = defineBlock({
	name: 'code',
	type: 'standalone',
	supportsDecoration: false,
});

export const horizontalRuleBlock = defineBlock({
	name: 'divider',
	type: 'standalone',
	atomic: true,
	supportsDecoration: false,
});

export const imageBlock = defineBlock({
	name: 'image',
	type: 'standalone',
	atomic: true,
	supportsDecoration: false,
});

export const embeddedMediaBlock = defineBlock({
	name: 'embed',
	type: 'standalone',
	atomic: true,
	supportsDecoration: false,
});

export const rawHTMLBlock = defineBlock({
	name: 'raw_html',
	type: 'standalone',
	atomic: true,
	supportsDecoration: false,
});

export const tableBlock = defineBlock({
	name: 'table',
	type: 'standalone',
	supportsDecoration: false,
});

export const builtInBlocks: Array<(editor: EditorHandle) => BlockDescriptor> = [
	paragraphBlock,
	headingBlock,
	bulletedListBlock,
	numberedListBlock,
	todoListBlock,
	toggleBlock,
	quoteBlock,
	codeBlock,
	horizontalRuleBlock,
];

export const builtInMarks: Array<(editor: EditorHandle) => MarkDescriptor> = [
	boldMark,
	italicMark,
	underlineMark,
	strikethroughMark,
	codeMark,
	linkMark,
	highlightMark,
	mentionMark,
];
