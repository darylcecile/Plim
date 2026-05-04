import { type BlockDescriptor, type MarkDescriptor, defineBlock, defineMark } from './blocks.js';

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
});

export const italicMark = defineMark({
	name: 'italic',
	toDOM: () => document.createElement('em'),
});

export const underlineMark = defineMark({
	name: 'underline',
	toDOM: () => document.createElement('u'),
});

export const strikethroughMark = defineMark({
	name: 'strikethrough',
	toDOM: () => document.createElement('s'),
});

export const codeMark = defineMark({
	name: 'code',
	toDOM: () => {
		const el = document.createElement('code');
		el.className = 'plim-inline-code';
		return el;
	},
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
