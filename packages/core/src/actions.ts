import type { EditorState } from './transaction.js';
import { Transaction } from './transaction.js';
import type { Trigger } from './triggers.js';
import { type ValidationBuilders, type ValidationRule, builders } from './validation.js';

export type ActionContext = {
	createTransaction(): Transaction;
	triggerAsyncEvent<T = unknown>(name: string, payload?: unknown): Promise<T>;
	dispatch(tx: Transaction): void;
	state: EditorState;
};

export type ActionPerform = (state: EditorState, ctx: ActionContext) => unknown | Promise<unknown>;

export type ActionDescriptor = {
	name: string;
	trigger: Trigger | Trigger[];
	triggerValidationRules?: (b: ValidationBuilders) => ValidationRule;
	cancellationTriggers?: Trigger[];
	perform: ActionPerform;
	priority?: number;
};

export function defineAction(name: string, config: Omit<ActionDescriptor, 'name'>): ActionDescriptor {
	return { name, ...config };
}

/** Marker so consumers can detect a registered action descriptor. */
export const ACTION_TAG = Symbol.for('plim.action');
