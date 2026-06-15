// A browser `Transport` over a real WebSocket.
//
// The Collaborator speaks an abstract `CollabMessage` stream; this turns it into
// JSON frames on a socket and — crucially — survives reconnects without losing
// or double-applying edits:
//
//   • On every (re)open we replay the last `hello` (re-registers this peer and
//     pulls the full canonical backlog, which acks anything that landed while we
//     were gone) and the last `presence` (restores our cursor for others).
//   • We also replay the last in-flight `submit`. That is safe — never a
//     double-apply — because the authority de-duplicates records by id: if the
//     submit already landed it is skipped; if it was lost on the dropped socket
//     it is finally accepted. Without this, a submit lost mid-flight would be
//     stranded (the client keeps exactly one record in flight and won't resend
//     it on its own).
//   • Messages enqueued while the socket is down are flushed on open.
//
// Per-connection FIFO (guaranteed by TCP/WebSocket) is the only ordering the hub
// requires, so the confirmed stream is always applied in canonical order.

import type { CollabMessage, Transport } from '@plim/core';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export interface WebSocketTransportOptions {
	url: string;
	/** Notified whenever the connection state changes (for UI). */
	onStatus?: (status: ConnectionStatus) => void;
	/** Delay between reconnect attempts in ms (default 1000). */
	reconnectMs?: number;
}

export class WebSocketTransport implements Transport {
	private ws: WebSocket | null = null;
	private readonly handlers = new Set<(message: CollabMessage) => void>();
	private readonly outbox: CollabMessage[] = [];
	private lastHello: CollabMessage | null = null;
	private lastPresence: CollabMessage | null = null;
	private lastSubmit: CollabMessage | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private closed = false;
	private _status: ConnectionStatus = 'connecting';

	constructor(private readonly options: WebSocketTransportOptions) {
		this.open();
	}

	get status(): ConnectionStatus {
		return this._status;
	}

	send(message: CollabMessage): void {
		// Remember the messages that must be re-established on a fresh socket.
		if (message.type === 'hello') this.lastHello = message;
		else if (message.type === 'presence') this.lastPresence = message;
		else if (message.type === 'submit') this.lastSubmit = message;

		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(message));
			return;
		}
		// hello/presence/submit are replayed wholesale on (re)open; only buffer the
		// rest (sync/bye) so we don't send duplicates.
		if (message.type !== 'hello' && message.type !== 'presence' && message.type !== 'submit') {
			this.outbox.push(message);
		}
	}

	onMessage(handler: (message: CollabMessage) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	close(): void {
		this.closed = true;
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		const ws = this.ws;
		this.ws = null;
		this.handlers.clear();
		if (ws) {
			try {
				ws.close();
			} catch {
				/* already closing */
			}
		}
	}

	private setStatus(status: ConnectionStatus): void {
		if (this._status === status) return;
		this._status = status;
		this.options.onStatus?.(status);
	}

	private open(): void {
		if (this.closed) return;
		this.setStatus('connecting');
		let ws: WebSocket;
		try {
			ws = new WebSocket(this.options.url);
		} catch {
			this.scheduleReconnect();
			return;
		}
		this.ws = ws;

		ws.onopen = () => {
			this.setStatus('online');
			// Re-establish identity + awareness, recover a possibly-lost submit, then
			// drain anything queued while we were offline.
			if (this.lastHello) ws.send(JSON.stringify(this.lastHello));
			if (this.lastPresence) ws.send(JSON.stringify(this.lastPresence));
			if (this.lastSubmit) ws.send(JSON.stringify(this.lastSubmit));
			while (this.outbox.length > 0) ws.send(JSON.stringify(this.outbox.shift()!));
		};

		ws.onmessage = (event: MessageEvent) => {
			let message: CollabMessage;
			try {
				message = JSON.parse(typeof event.data === 'string' ? event.data : '') as CollabMessage;
			} catch {
				return;
			}
			for (const handler of [...this.handlers]) handler(message);
		};

		ws.onclose = () => {
			if (this.ws === ws) this.ws = null;
			if (this.closed) return;
			this.setStatus('offline');
			this.scheduleReconnect();
		};

		ws.onerror = () => {
			try {
				ws.close();
			} catch {
				/* surfaced via onclose */
			}
		};
	}

	private scheduleReconnect(): void {
		if (this.closed || this.reconnectTimer !== null) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.open();
		}, this.options.reconnectMs ?? 1000);
	}
}
