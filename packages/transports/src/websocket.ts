// A reconnecting JSON WebSocket client as a `Transport<T>`. It hides the parts of
// raw WebSockets that every app re-implements badly: it buffers `send`s issued
// while the socket is down and flushes them on (re)connect, reconnects with
// exponential backoff after an unexpected close, and reports connection state
// through `onStatus`. It is wire-agnostic about the `WebSocket` implementation —
// the browser global by default, or inject one (e.g. `ws`) for Node.

import type { Transport } from './transport.js';

export type WebSocketStatus = 'connecting' | 'open' | 'closed';

/** The slice of the WHATWG `WebSocket` instance API this transport uses. */
export interface WebSocketLike {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: (event: unknown) => void): void;
	removeEventListener(type: string, listener: (event: unknown) => void): void;
	readonly readyState: number;
}

/** A `WebSocket` constructor with the standard static `OPEN` ready-state. */
export interface WebSocketCtor {
	new (url: string, protocols?: string | string[]): WebSocketLike;
	readonly OPEN: number;
}

export interface WebSocketTransportOptions {
	/** Sub-protocols passed to the socket constructor. */
	protocols?: string | string[];
	/** WebSocket implementation. Defaults to the global `WebSocket`. */
	WebSocketImpl?: WebSocketCtor;
	/** Serialize an outgoing message. Default `JSON.stringify`. */
	serialize?: (message: unknown) => string;
	/** Parse an inbound frame. Default `JSON.parse`. */
	deserialize?: (raw: string) => unknown;
	/** Backoff before reconnect attempt `n` (1-based), in ms. Default exponential 250ms → 10s. */
	backoffMs?: (attempt: number) => number;
	/** Give up after this many consecutive failed reconnects. Default `Infinity`. */
	maxRetries?: number;
	/** Notified on every connection-state change. */
	onStatus?: (status: WebSocketStatus) => void;
	/** Connect immediately on construction. Default `true`. */
	autoConnect?: boolean;
	/** Schedule a delayed callback. Defaults to `setTimeout`. Injectable for tests. */
	setTimeoutImpl?: (handler: () => void, ms: number) => unknown;
	/** Cancel a scheduled callback. Defaults to `clearTimeout`. Injectable for tests. */
	clearTimeoutImpl?: (handle: unknown) => void;
}

const defaultBackoff = (attempt: number): number => Math.min(250 * 2 ** (attempt - 1), 10_000);

/** A reconnecting, buffering, JSON-framed WebSocket transport. */
export class WebSocketTransport<T> implements Transport<T> {
	private readonly url: string;
	private readonly protocols: string | string[] | undefined;
	private readonly Impl: WebSocketCtor;
	private readonly serialize: (message: unknown) => string;
	private readonly deserialize: (raw: string) => unknown;
	private readonly backoff: (attempt: number) => number;
	private readonly maxRetries: number;
	private readonly onStatus: ((status: WebSocketStatus) => void) | undefined;
	private readonly setTimer: (handler: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;

	private socket: WebSocketLike | null = null;
	private readonly handlers = new Set<(message: T) => void>();
	private readonly outbox: string[] = [];
	private status: WebSocketStatus = 'closed';
	private attempt = 0;
	private reconnectTimer: unknown = null;
	private userClosed = false;
	private listeners: Array<[string, (event: unknown) => void]> = [];

	constructor(url: string, options: WebSocketTransportOptions = {}) {
		const Impl = options.WebSocketImpl ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
		if (!Impl) {
			throw new Error('@plim/transports: no WebSocket implementation found; pass options.WebSocketImpl');
		}
		this.url = url;
		this.protocols = options.protocols;
		this.Impl = Impl;
		this.serialize = options.serialize ?? ((m) => JSON.stringify(m));
		this.deserialize = options.deserialize ?? ((raw) => JSON.parse(raw) as unknown);
		this.backoff = options.backoffMs ?? defaultBackoff;
		this.maxRetries = options.maxRetries ?? Number.POSITIVE_INFINITY;
		this.onStatus = options.onStatus;
		this.setTimer = options.setTimeoutImpl ?? ((handler, ms) => setTimeout(handler, ms));
		this.clearTimer = options.clearTimeoutImpl ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
		if (options.autoConnect ?? true) this.connect();
	}

	/** Current connection state. */
	get connectionStatus(): WebSocketStatus {
		return this.status;
	}

	/** Open the socket (and re-arm auto-reconnect). Safe to call when already open. */
	connect(): void {
		this.userClosed = false;
		if (this.socket || this.status === 'connecting') return;
		this.open();
	}

	send(message: T): void {
		if (this.userClosed) throw new Error('@plim/transports: cannot send on a closed transport');
		const frame = this.serialize(message);
		if (this.socket && this.socket.readyState === this.Impl.OPEN) {
			this.socket.send(frame);
		} else {
			this.outbox.push(frame);
		}
	}

	onMessage(handler: (message: T) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	close(): void {
		this.userClosed = true;
		this.handlers.clear();
		this.outbox.length = 0;
		if (this.reconnectTimer !== null) {
			this.clearTimer(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.teardownSocket();
		this.setStatus('closed');
	}

	private open(): void {
		this.setStatus('connecting');
		let socket: WebSocketLike;
		try {
			socket = this.protocols === undefined ? new this.Impl(this.url) : new this.Impl(this.url, this.protocols);
		} catch {
			this.scheduleReconnect();
			return;
		}
		this.socket = socket;

		const on = (type: string, listener: (event: unknown) => void): void => {
			socket.addEventListener(type, listener);
			this.listeners.push([type, listener]);
		};

		on('open', () => {
			this.attempt = 0;
			this.setStatus('open');
			this.flush();
		});
		on('message', (event) => {
			const data = (event as { data?: unknown }).data;
			if (typeof data !== 'string') return;
			let message: T;
			try {
				message = this.deserialize(data) as T;
			} catch {
				return;
			}
			for (const handler of [...this.handlers]) handler(message);
		});
		on('close', () => {
			this.teardownSocket();
			if (this.userClosed) {
				this.setStatus('closed');
				return;
			}
			this.scheduleReconnect();
		});
		on('error', () => {
			// `error` is always followed by `close`; let the close handler drive
			// reconnect so we never schedule it twice.
		});
	}

	private flush(): void {
		if (!this.socket || this.socket.readyState !== this.Impl.OPEN) return;
		while (this.outbox.length > 0) {
			const frame = this.outbox.shift()!;
			this.socket.send(frame);
		}
	}

	private scheduleReconnect(): void {
		if (this.userClosed) return;
		this.attempt += 1;
		if (this.attempt > this.maxRetries) {
			this.setStatus('closed');
			return;
		}
		this.setStatus('connecting');
		const delay = this.backoff(this.attempt);
		this.reconnectTimer = this.setTimer(() => {
			this.reconnectTimer = null;
			if (this.userClosed) return;
			this.open();
		}, delay);
	}

	private teardownSocket(): void {
		const socket = this.socket;
		if (!socket) return;
		for (const [type, listener] of this.listeners) socket.removeEventListener(type, listener);
		this.listeners = [];
		this.socket = null;
		try {
			socket.close();
		} catch {
			// ignore — already closing/closed
		}
	}

	private setStatus(status: WebSocketStatus): void {
		if (this.status === status) return;
		this.status = status;
		this.onStatus?.(status);
	}
}
