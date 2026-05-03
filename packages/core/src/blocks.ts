// Block & mark factories. Note: these factories return descriptors, not instances of an editor.

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
	supportsDecoration?: boolean; // can text inside be decorated with marks (default true if text-bearing)
	atomic?: boolean;
	toDOM?: (payload: BlockPayload) => HTMLElement;
	toComponent?: (payload: BlockPayload) => unknown;
};

export function defineBlock(desc: BlockDescriptor): () => BlockDescriptor {
	return () => desc;
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

export function defineMark(desc: MarkDescriptor): () => MarkDescriptor {
	return () => desc;
}
