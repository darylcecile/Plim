// The one abstraction everything syncs against: a generic, two-way, fire-and-
// forget message channel. Keep it minimal — `send` a message, `onMessage` to
// receive, `close` to tear down. Any concrete wire (in-process, BroadcastChannel,
// WebSocket, WebRTC, postMessage, …) implements this, so feature code that syncs
// (collaboration, comments, presence) never names a wire.

/** A bidirectional channel that carries values of type `T`. */
export interface Transport<T> {
	/** Push a message toward the peer(s) on the other side. */
	send(message: T): void;
	/** Subscribe to inbound messages. Returns an unsubscribe function. */
	onMessage(handler: (message: T) => void): () => void;
	/** Permanently close this endpoint. Further `send`s are an error. */
	close(): void;
}

/**
 * Adapt a `Transport<A>` into a `Transport<B>` through a codec. Use it to wrap,
 * namespace, version, compress, or otherwise reshape messages without rewriting
 * the underlying wire — e.g. multiplex several features over one socket by
 * tagging messages, or persist a different shape than you transmit.
 */
export function mapTransport<A, B>(
	inner: Transport<A>,
	encode: (message: B) => A,
	decode: (message: A) => B,
): Transport<B> {
	return {
		send: (message) => inner.send(encode(message)),
		onMessage: (handler) => inner.onMessage((raw) => handler(decode(raw))),
		close: () => inner.close(),
	};
}
