import {
	newId,
	normalizeText,
} from '@plim/core';
import type { BlockNode, DocumentNode, MarkInstance, TextSpan } from '@plim/core';

export type IdFactory = (prefix?: string) => string;

export type IdFactoryOptions = {
	prefix?: string;
};

export function createIdFactory(seed = 'test'): IdFactory {
	let next = 0;
	return (prefix = 'b') => `${seed}_${prefix}_${++next}`;
}

export type InlineChild = string | TextSpan | readonly InlineChild[];

export type BlockOptions = {
	id?: string;
	idFactory?: IdFactory;
	attrs?: Record<string, unknown>;
	text?: readonly InlineChild[];
	children?: readonly BlockNode[];
};

export type TextBlockOptions = {
	id?: string;
	idFactory?: IdFactory;
	children?: readonly BlockNode[];
};

type MaybeTextBlockOptions = InlineChild | TextBlockOptions;

export function doc(...blocks: BlockNode[]): DocumentNode {
	return { type: 'doc', children: blocks };
}

export function block(type: string, opts: BlockOptions = {}): BlockNode {
	const node: BlockNode = {
		id: opts.id ?? (opts.idFactory ?? newId)(),
		type,
	};
	if (opts.attrs) node.attrs = { ...opts.attrs };
	if (opts.text) node.text = inline(...opts.text);
	if (opts.children) node.children = [...opts.children];
	return node;
}

export function text(str: string): TextSpan {
	return { text: str };
}

export function inline(...children: readonly InlineChild[]): TextSpan[] {
	return normalizeText(flattenInline(children));
}

export function mark(type: string, attrs: Record<string, unknown> | undefined, ...children: InlineChild[]): TextSpan[] {
	const markInstance: MarkInstance = attrs ? { type, attrs: { ...attrs } } : { type };
	return inline(...children).map((span) => ({
		text: span.text,
		marks: [...(span.marks ?? []), markInstance],
	}));
}

export function bold(...children: InlineChild[]): TextSpan[] {
	return mark('bold', undefined, ...children);
}

export function italic(...children: InlineChild[]): TextSpan[] {
	return mark('italic', undefined, ...children);
}

export function underline(...children: InlineChild[]): TextSpan[] {
	return mark('underline', undefined, ...children);
}

export function strike(...children: InlineChild[]): TextSpan[] {
	return mark('strikethrough', undefined, ...children);
}

export function code(...children: InlineChild[]): TextSpan[] {
	return mark('code', undefined, ...children);
}

export function link(href: string, ...children: InlineChild[]): TextSpan[] {
	return mark('link', { href }, ...children);
}

export function highlight(...children: InlineChild[]): TextSpan[] {
	return mark('highlight', undefined, ...children);
}

export function paragraph(...children: MaybeTextBlockOptions[]): BlockNode {
	return textBlock('paragraph', children);
}

export function heading(level: 1 | 2 | 3 | number, ...children: MaybeTextBlockOptions[]): BlockNode {
	const { inlineChildren, options } = splitTextBlockArgs(children);
	return block('heading', { ...options, attrs: { level }, text: inlineChildren });
}

export function bulletItem(...children: MaybeTextBlockOptions[]): BlockNode {
	return textBlock('bulleted_list_item', children);
}

export function numberedItem(...children: MaybeTextBlockOptions[]): BlockNode {
	return textBlock('numbered_list_item', children);
}

export function todoItem(checked: boolean, ...children: MaybeTextBlockOptions[]): BlockNode {
	const { inlineChildren, options } = splitTextBlockArgs(children);
	return block('to_do', { ...options, attrs: { checked }, text: inlineChildren });
}

export function quote(...children: MaybeTextBlockOptions[]): BlockNode {
	return textBlock('quote', children);
}

export function codeBlock(source: string, langOrOptions?: string | TextBlockOptions, maybeOptions?: TextBlockOptions): BlockNode {
	const lang = typeof langOrOptions === 'string' ? langOrOptions : undefined;
	const options = (typeof langOrOptions === 'string' ? maybeOptions : langOrOptions) ?? {};
	return block('code', {
		...options,
		...(lang ? { attrs: { language: lang } } : {}),
		text: [source],
	});
}

export function divider(options: TextBlockOptions = {}): BlockNode {
	return block('divider', options);
}

export function toggle(...children: MaybeTextBlockOptions[]): BlockNode {
	return textBlock('toggle', children);
}

function textBlock(type: string, children: readonly MaybeTextBlockOptions[]): BlockNode {
	const { inlineChildren, options } = splitTextBlockArgs(children);
	return block(type, { ...options, text: inlineChildren });
}

function splitTextBlockArgs(children: readonly MaybeTextBlockOptions[]): { inlineChildren: InlineChild[]; options: TextBlockOptions; } {
	const last = children[children.length - 1];
	if (isTextBlockOptions(last)) {
		return { inlineChildren: children.slice(0, -1) as InlineChild[], options: last };
	}
	return { inlineChildren: children as InlineChild[], options: {} };
}

function isTextBlockOptions(value: MaybeTextBlockOptions | undefined): value is TextBlockOptions {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	if ('text' in value) return false;
	return 'id' in value || 'idFactory' in value || 'children' in value;
}

function flattenInline(children: readonly InlineChild[]): TextSpan[] {
	const out: TextSpan[] = [];
	for (const child of children) {
		if (typeof child === 'string') {
			out.push({ text: child });
		} else if (isInlineArray(child)) {
			out.push(...flattenInline(child));
		} else {
			out.push(cloneSpan(child));
		}
	}
	return out;
}

function isInlineArray(value: InlineChild): value is readonly InlineChild[] {
	return Array.isArray(value);
}

function cloneSpan(span: TextSpan): TextSpan {
	return {
		text: span.text,
		...(span.marks && span.marks.length ? { marks: span.marks.map(cloneMark) } : {}),
	};
}

function cloneMark(mark: MarkInstance): MarkInstance {
	return mark.attrs ? { type: mark.type, attrs: { ...mark.attrs } } : { type: mark.type };
}

