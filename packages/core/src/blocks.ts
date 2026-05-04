// Block & mark factories. Note: these factories return descriptors, not instances of an editor.

import type { BlockNode, TextSpan } from './document.js';
import type { EditorHandle } from './editor-handle.js';
import type { EditorState, Transaction } from './transaction.js';
import type { ValidationBuilders, ValidationRule } from './validation.js';

/**
 * Contributed by blocks/marks (and one day extensions) to the floating
 * selection toolbar. Items are evaluated against the current state on
 * every selection change; `visibleWhen` controls whether the button is
 * shown at all, `activeWhen` toggles the highlighted "on" appearance,
 * `disabledWhen` greys the button out without hiding it.
 *
 * `perform` receives a thin context: the live state, an `editor` with
 * `createTransaction`/`dispatch`, and an `anchor` element so popover-
 * shaped items (link URL input) can position themselves relative to
 * their button. `close()` dismisses any open popover the toolbar owns.
 */
export type ToolbarItemContext = {
	state: EditorState;
	editor: { createTransaction(): Transaction; dispatch(tx: Transaction): void };
	anchor: HTMLElement;
	close(): void;
};

export type ToolbarItem = {
	name: string;
	/** Short visible label / tooltip. */
	label: string;
	/** Optional inner HTML for the button (e.g. `<b>B</b>`). Defaults to `label`. */
	icon?: string;
	/** Optional shortcut hint shown in the tooltip ("⌘B"). No runtime effect. */
	shortcut?: string;
	/** Logical group; the toolbar renders separators between groups. */
	group?: 'mark' | 'block' | 'action' | string;
	/** Sort within group; lower priority renders first. */
	priority?: number;
	visibleWhen?: (b: ValidationBuilders) => ValidationRule;
	activeWhen?: (b: ValidationBuilders) => ValidationRule;
	disabledWhen?: (b: ValidationBuilders) => ValidationRule;
	perform: (ctx: ToolbarItemContext) => void | Promise<void>;
};

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
	/**
	 * If true, plain Enter inside this block inserts a literal `\n` into
	 * the block's text (line break) instead of splitting into a new block,
	 * and ArrowDown / ArrowRight at the end of the last visual line / end
	 * of the block exits to the next block — creating a fresh paragraph
	 * underneath if no next block exists. Code blocks set this so users
	 * can compose multi-line code without each Enter creating a new
	 * code block, while still being able to escape downward via arrow
	 * keys (Notion's behavior). Shift+Enter (which already inserts `\n`)
	 * is unaffected.
	 */
	multilineText?: boolean;
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
	/**
	 * Parse one or more lines of markdown into a block of this type. Called
	 * by `parseMarkdown` (in `@plim/markdown`) when this descriptor is
	 * registered. Receives the current line plus the surrounding cursor so
	 * multi-line shapes (fenced code, callouts spanning blocks) can peek
	 * ahead. Return `null` if this descriptor does not match the line — the
	 * parser will try the next descriptor and finally fall through to
	 * built-ins. Return `{block, consumed}` to claim ≥1 line(s); `consumed`
	 * is how many input lines this match ate.
	 *
	 * Rationale: this is the dual of `toMarkdown`. Without it, copying a
	 * callout (which serializes via `toMarkdown` as `> [!INFO] …`) and
	 * pasting it back parses as a built-in `quote` block — losing the
	 * callout type and any tone attrs. With `fromMarkdown` registered, the
	 * roundtrip is lossless even across plain markdown channels.
	 */
	fromMarkdown?: (ctx: BlockMarkdownParseContext) => BlockMarkdownParseResult | null;
	/**
	 * Items this block contributes to the floating selection toolbar — most
	 * commonly "turn into" transforms (e.g. heading levels, paragraph,
	 * quote). Each item's `visibleWhen` decides whether it shows up. By
	 * default the toolbar renders block items only when the selection is
	 * non-empty; supply your own `visibleWhen` to override.
	 */
	toolbar?: ToolbarItem | ToolbarItem[];
};

/**
 * Cursor over the markdown input, exposed to `BlockDescriptor.fromMarkdown`.
 * Implementations typically inspect `lines[index]` and may peek further
 * lines (`lines[index + n]`) for multi-line shapes.
 */
export type BlockMarkdownParseContext = {
	readonly lines: readonly string[];
	readonly index: number;
	/** Render an inline markdown line into TextSpans (handles built-in marks). */
	parseInline(line: string): TextSpan[];
};

export type BlockMarkdownParseResult = {
	block: BlockNode;
	/** Number of input lines this match consumed (≥1). */
	consumed: number;
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
	/**
	 * Items this mark contributes to the floating selection toolbar. If
	 * omitted, the mark has no toolbar presence. The common case is a
	 * single toggle item; multiple items are supported for marks with
	 * variants (e.g. a future "color" mark with swatch buttons).
	 *
	 * Defaults applied when an item omits the corresponding rule:
	 *   - `visibleWhen`: `and([selectionNotEmpty, blockSupportsDecoration])`
	 *   - `activeWhen`:  `markActiveInSelection(mark.name)`
	 */
	toolbar?: ToolbarItem | ToolbarItem[];
};

export function defineMark(
	descOrFactory: MarkDescriptor | ((editor: EditorHandle) => MarkDescriptor),
): (editor: EditorHandle) => MarkDescriptor {
	if (typeof descOrFactory === 'function') return descOrFactory;
	return () => descOrFactory;
}
