// EditorHandle is the public, framework-agnostic surface that block /
// mark / extension factories close over at resolution time. It excludes
// lifecycle-only methods (`mount`/`destroy`) and renderer-specific bits
// (`view`) so it can live in @plim/core without pulling in @plim/editor.
// `AgnosticEditor` (in @plim/editor) extends this interface.

import type { ActionContext } from './actions.js';
import type { ActionDescriptor } from './actions.js';
import type { BlockDescriptor, MarkDescriptor } from './blocks.js';
import type { History } from './history.js';
import type { PlimDriver } from './driver.js';
import type { Snapshot } from './snapshot.js';
import type { EditorState, Transaction } from './transaction.js';

export type AsyncEventHandler<T = unknown> = (
	event: { name: string; payload?: unknown },
	state: EditorState,
	ctx: ActionContext,
) => Promise<T> | T;

export interface EditorHandle {
	readonly plim: PlimDriver;
	readonly isReady: boolean;
	getState(): EditorState;
	setState(s: EditorState): void;
	dispatch(tx: Transaction): void;
	createTransaction(): Transaction;
	onTransaction(cb: (tx: Transaction, state: EditorState) => void): () => void;
	onAsyncEvent<T = unknown>(name: string, handler: AsyncEventHandler<T>): () => void;
	triggerAsyncEvent<T = unknown>(name: string, payload?: unknown): Promise<T>;
	whenReady(cb: () => void): void;
	restoreSnapshot(snap: Snapshot): void;
	readonly history: History;
	readonly blocks: BlockDescriptor[];
	readonly marks: MarkDescriptor[];
	readonly actions: ActionDescriptor[];
	supportsDecoration(blockType: string): boolean;
}
