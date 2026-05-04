// Block & mark factories. Note: these factories return descriptors, not instances of an editor.

import type { TextSpan } from './document.js';
import type { EditorHandle } from './editor-handle.js';

export type BlockPayload = {
	id: string;
	type: string;
	attrs: Record<string, unknown>;
	content: unknown; // for DOM: HTMLElement[]; for React: ReactNode
	textContent: string;
	isEmpty: boolean;
};

export type BlockDescriptor = {
	name: string;
	type: 'standalone' | 'inline';
	nestable?: boolean;

	/**
	 * Whether this block can be decorated with marks  (default true if text-bearing)
	 */
	supportsDecoration?: boolean;

	/**
	 * Whether this block is "atomic" (non-text, non-nestable, treated as a single unit by the editor). Atomic blocks have no editable content and cannot be split or merged; they can only be inserted or deleted as a whole. Examples include images, dividers, embeds, etc.
	 */
	atomic?: boolean;
	
	/**
	 * Block type to use for the right-hand block when Enter splits this
	 * block. Defaults to the same type (standard paragraph-style behavior).
	 * Set to `'paragraph'` for "structural" blocks (callouts, quotes,
	 * headings, etc.) that should not propagate themselves on Enter — the
	 * caret continues in a fresh paragraph instead of cloning the block.
	 * Notion uses this for headings, callouts, quotes, and dividers.
	 */
	continueAs?: string;
	toDOM?: (payload: BlockPayload) => HTMLElement;
	toComponent?: (payload: BlockPayload) => unknown;
	/**
	 * Serialize this block to one or more lines of markdown. Receives the
	 * block payload (with `textContent` already flattened from spans) and
	 * a `serializeInline(spans)` helper that emits inline markdown for an
	 * arbitrary span array using the registered marks. Return either a
	 * single string (one line) or an array of strings (multiple lines for
	 * fenced/multiline content). Children are serialized separately by the
	 * walker and indented automatically; do not include child output here.
	 * If unset, the serializer falls back to `textContent` as a plain
	 * paragraph line — fine for most text blocks; structural blocks
	 * (image, divider, callout chrome) should set this explicitly.
	 */
	toMarkdown?: (payload: BlockPayload, ctx: BlockMarkdownContext) => string | string[];
};

export type BlockMarkdownContext = {
	/** Render an inline span array (with marks) as inline markdown text. */
	serializeInline: (spans: TextSpan[]) => string;
	/** The block's raw text spans (with marks intact). Empty for atomic / non-text blocks. */
	spans: TextSpan[];
	/** Nesting depth (0 = top-level). */
	depth: number;
};

export function defineBlock(
	descOrFactory: BlockDescriptor | ((editor: EditorHandle) => BlockDescriptor),
): (editor: EditorHandle) => BlockDescriptor {
	if (typeof descOrFactory === 'function') return descOrFactory;
	return () => descOrFactory;
}

export type MarkPayload = {
	type: string;
	attrs: Record<string, unknown>;
	text: string;
	content: unknown;
};

export type MarkDescriptor = {
	name: string;
	toDOM?: (payload: MarkPayload) => HTMLElement;
	toComponent?: (payload: MarkPayload) => unknown;
};

export function defineMark(
	descOrFactory: MarkDescriptor | ((editor: EditorHandle) => MarkDescriptor),
): (editor: EditorHandle) => MarkDescriptor {
	if (typeof descOrFactory === 'function') return descOrFactory;
	return () => descOrFactory;
}
