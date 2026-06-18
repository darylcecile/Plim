// In-process transports — no wire at all. Two flavors:
//
//  - `MemoryBus<T>`: an N-peer broadcast hub. Every `connect()` hands back a
//    `Transport<T>`; a message from one endpoint is delivered to all the *other*
//    open endpoints and never echoed to the sender. That mirrors how
//    `BroadcastChannel` behaves across tabs, so a feature wired to a bus in a
//    test behaves the same when wired to a real BroadcastChannel in a browser.
//  - `createMemoryTransportPair<T>()`: the common two-party case (A↔B), built on
//    a bus with exactly two endpoints.
//
// Delivery is synchronous and FIFO by default (deterministic — what tests want).
// Pass `{ async: true }` to defer delivery to a microtask, which surfaces
// optimistic-UI/ordering assumptions the way a real async wire would.

import type { Transport } from './transport.js';

interface Endpoint<T> {
	closed: boolean;
	handlers: Set<(message: T) => void>;
}

export interface MemoryBusOptions {
	/**
	 * Deliver on a microtask instead of synchronously. Default `false` (sync,
	 * deterministic). Turn on to emulate the asynchrony of a real wire.
	 */
	async?: boolean;
}

/**
 * An in-process broadcast hub. Note that messages are passed **by reference** —
 * there is no serialization — so treat inbound messages as immutable and send
 * fresh values; do not mutate a message after sending it.
 */
export class MemoryBus<T> {
	private readonly endpoints = new Set<Endpoint<T>>();
	private readonly queue: Array<() => void> = [];
	private draining = false;
	private readonly async: boolean;

	constructor(options: MemoryBusOptions = {}) {
		this.async = options.async ?? false;
	}

	/** Number of currently open endpoints. */
	get size(): number {
		return this.endpoints.size;
	}

	/** Open a new endpoint connected to every other endpoint on this bus. */
	connect(): Transport<T> {
		const endpoint: Endpoint<T> = { closed: false, handlers: new Set() };
		this.endpoints.add(endpoint);
		return {
			send: (message) => this.broadcast(endpoint, message),
			onMessage: (handler) => {
				endpoint.handlers.add(handler);
				return () => endpoint.handlers.delete(handler);
			},
			close: () => {
				if (endpoint.closed) return;
				endpoint.closed = true;
				endpoint.handlers.clear();
				this.endpoints.delete(endpoint);
			},
		};
	}

	private broadcast(from: Endpoint<T>, message: T): void {
		if (from.closed) throw new Error('@plim/transports: cannot send on a closed transport');
		const targets = [...this.endpoints].filter((e) => e !== from && !e.closed);
		const deliver = (): void => {
			for (const target of targets) {
				if (target.closed) continue;
				for (const handler of [...target.handlers]) handler(message);
			}
		};
		if (this.async) {
			queueMicrotask(deliver);
		} else {
			this.enqueue(deliver);
		}
	}

	// A shared FIFO drain so that messages sent *from within* a handler are
	// delivered after the current dispatch completes — never re-entrantly.
	private enqueue(task: () => void): void {
		this.queue.push(task);
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				const next = this.queue.shift()!;
				next();
			}
		} finally {
			this.draining = false;
		}
	}
}

/** Two linked in-process transports: a message on one arrives on the other. */
export function createMemoryTransportPair<T>(options?: MemoryBusOptions): [Transport<T>, Transport<T>] {
	const bus = new MemoryBus<T>(options);
	return [bus.connect(), bus.connect()];
}
