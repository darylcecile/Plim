import { type BlockDescriptor, type MarkDescriptor, defineBlock, defineMark } from './blocks.js';

// Marks ---------------------------------------------------------------------

export const boldMark = defineMark({
	name: 'bold',
	toDOM: (p) => {
		const el = document.createElement('strong');
		el.textContent = p.text;
		return el;
	},
});

export const italicMark = defineMark({
	name: 'italic',
	toDOM: (p) => {
		const el = document.createElement('em');
		el.textContent = p.text;
		return el;
	},
});

export const underlineMark = defineMark({
	name: 'underline',
	toDOM: (p) => {
		const el = document.createElement('u');
		el.textContent = p.text;
		return el;
	},
});

export const strikethroughMark = defineMark({
	name: 'strikethrough',
	toDOM: (p) => {
		const el = document.createElement('s');
		el.textContent = p.text;
		return el;
	},
});

export const codeMark = defineMark({
	name: 'code',
	toDOM: (p) => {
		const el = document.createElement('code');
		el.className = 'plim-inline-code';
		el.textContent = p.text;
		return el;
	},
});

export const linkMark = defineMark({
	name: 'link',
	toDOM: (p) => {
		const el = document.createElement('a');
		el.textContent = p.text;
		const href = (p.attrs?.href as string | undefined) ?? '#';
		el.setAttribute('href', href);
		el.setAttribute('rel', 'noreferrer');
		el.setAttribute('target', '_blank');
		return el;
	},
});

export const highlightMark = defineMark({
	name: 'highlight',
	toDOM: (p) => {
		const el = document.createElement('mark');
		el.textContent = p.text;
		return el;
	},
});

// Mention mark — atomic inline reference to an entity (user, page, etc.).
// Renders as a `<span class="plim-mention">` so consumers can style it as a
// pill, and exposes its identifier via `data-mention-id` for downstream
// hooks (analytics, click handlers, etc.). The presence of this mark on a
// span signals to the editor that the span should behave as an atomic unit
// (a single Backspace deletes the whole run rather than one character).
export const mentionMark = defineMark({
	name: 'mention',
	toDOM: (p) => {
		const el = document.createElement('span');
		el.className = 'plim-mention';
		el.textContent = p.text;
		const id = (p.attrs?.id as string | undefined) ?? '';
		const href = p.attrs?.href as string | undefined;
		if (id) el.setAttribute('data-mention-id', id);
		if (href) el.setAttribute('data-mention-href', href);
		return el;
	},
});

// Blocks --------------------------------------------------------------------

export const paragraphBlock = defineBlock({
	name: 'paragraph',
	type: 'standalone',
	supportsDecoration: true,
});

export const headingBlock = defineBlock({
	name: 'heading',
	type: 'standalone',
	supportsDecoration: true,
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

export const builtInBlocks: Array<() => BlockDescriptor> = [
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

export const builtInMarks: Array<() => MarkDescriptor> = [
	boldMark,
	italicMark,
	underlineMark,
	strikethroughMark,
	codeMark,
	linkMark,
	highlightMark,
	mentionMark,
];
