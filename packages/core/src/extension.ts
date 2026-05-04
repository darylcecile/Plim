import type { ActionDescriptor } from './actions.js';
import type { BlockDescriptor, MarkDescriptor } from './blocks.js';

export type Theme = string | { name?: string; tokens?: Record<string, string> };

export type ExtensionShape = {
	name: string;
	registeredBlocks?: Array<() => BlockDescriptor>;
	registeredMarks?: Array<() => MarkDescriptor>;
	registeredActions?: ActionDescriptor[];
	onTransaction?: (tx: unknown, ctx: unknown) => void;
	onAsyncEvent?: (name: string, state: unknown, ctx: unknown) => Promise<unknown> | unknown;
	/**
	 * Paste-pipeline hook. Receives the normalised clipboard payload and
	 * the editor's action context. Return `true` to signal the extension
	 * has fully handled the paste (it committed its own transaction);
	 * return any falsy value (`undefined`/`false`) to let the next
	 * extension — or the built-in pipeline — try. Extensions are consulted
	 * in registration order, so the first one to return `true` wins.
	 *
	 * Typical use cases: paste-as-image (read `data.files`, upload, insert
	 * an image block), custom embed unfurling, replacing pasted JSON with
	 * a structured block, or just sniffing for a vendor-specific payload.
	 */
	transformPaste?: (data: { text: string; html: string; files: File[] }, ctx: unknown) => boolean | undefined | void;
};

export type ExtensionFactory = (editor: unknown) => ExtensionShape;

const __cache = new WeakMap<ExtensionFactory, ExtensionShape>();

export function defineExtension(factory: ExtensionFactory): ExtensionFactory {
	return factory;
}

export function processExtension(factory: ExtensionFactory, editor: unknown): ExtensionShape {
	const cached = __cache.get(factory);
	if (cached) return cached;
	const shape = factory(editor);
	__cache.set(factory, shape);
	return shape;
}
