// CommentSync — glue between a `CommentStore` and a `Transport<CommentMessage>`.
//
// It does three things: (1) fan out locally authored events to peers, (2) merge
// inbound events/snapshots into the store, and (3) handle late-join catch-up —
// on construction it announces `hello`, and any peer that hears a `hello`
// replies with its full event log as a `snapshot`. Because the store ingests
// idempotently (dedupe by event id) and convergently (deterministic fold), the
// redundant snapshots that multiple peers send are harmless.

import type { Transport } from '@plim/transports';

import type { CommentStore } from './store.js';
import type { CommentEvent, CommentMessage } from './types.js';

export class CommentSync {
	private readonly disposers: Array<() => void> = [];
	private closed = false;

	constructor(
		private readonly store: CommentStore,
		private readonly transport: Transport<CommentMessage>,
	) {
		this.disposers.push(
			store.onLocalEvents((events: CommentEvent[]) => {
				if (this.closed) return;
				this.transport.send({ type: 'events', events });
			}),
		);
		this.disposers.push(transport.onMessage((msg) => this.onMessage(msg)));
		// Announce ourselves so existing peers send us their history.
		this.transport.send({ type: 'hello', actor: store.actor });
	}

	private onMessage(msg: CommentMessage): void {
		if (this.closed) return;
		switch (msg.type) {
			case 'hello':
				// A peer joined: hand them everything we know.
				this.transport.send({ type: 'snapshot', events: this.store.snapshot() });
				break;
			case 'snapshot':
			case 'events':
				this.store.ingest(msg.events);
				break;
		}
	}

	/** Detach from the store and stop relaying. Does not close the transport. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const d of this.disposers) d();
		this.disposers.length = 0;
	}
}

/** Convenience factory mirroring the constructor. */
export function createCommentSync(
	store: CommentStore,
	transport: Transport<CommentMessage>,
): CommentSync {
	return new CommentSync(store, transport);
}
