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
