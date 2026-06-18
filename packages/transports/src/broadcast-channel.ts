// Cross-context sync with zero servers: wrap the native `BroadcastChannel` so
// same-origin tabs, iframes, and workers share a `Transport<T>`. A channel never
// receives its own posts, which is exactly the broadcast-to-others semantics the
// rest of Plim's sync code expects.

import type { Transport } from './transport.js';

/** A structural subset of the DOM `BroadcastChannel` — enough to drive a transport. */
export interface BroadcastChannelLike {
	postMessage(message: unknown): void;
	addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
	removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
	close(): void;
}

export interface BroadcastChannelTransportOptions {
	/**
	 * Create the channel. Defaults to `new BroadcastChannel(name)`. Provide this
	 * to inject a polyfill (e.g. in Node or tests).
	 */
	factory?: (name: string) => BroadcastChannelLike;
}

/** A `Transport<T>` backed by a same-origin `BroadcastChannel`. */
export class BroadcastChannelTransport<T> implements Transport<T> {
	private readonly channel: BroadcastChannelLike;
	private readonly handlers = new Set<(message: T) => void>();
	private readonly listener: (event: { data: unknown }) => void;
	private closed = false;

	constructor(name: string, options: BroadcastChannelTransportOptions = {}) {
		const make = options.factory ?? ((n: string) => new BroadcastChannel(n) as BroadcastChannelLike);
		this.channel = make(name);
		this.listener = (event) => {
			const message = event.data as T;
			for (const handler of [...this.handlers]) handler(message);
		};
		this.channel.addEventListener('message', this.listener);
	}

	send(message: T): void {
		if (this.closed) throw new Error('@plim/transports: cannot send on a closed transport');
		this.channel.postMessage(message);
	}

	onMessage(handler: (message: T) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.handlers.clear();
		this.channel.removeEventListener('message', this.listener);
		this.channel.close();
	}
}
