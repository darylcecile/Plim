# @plim/transports

Tiny, generic **duplex-channel primitives** for the [Plim](https://github.com/darylcecile/plim) block editor — and anything else that needs to move JSON-safe messages over a wire.

A `Transport<T>` is the smallest useful abstraction over a two-way message channel:

```ts
interface Transport<T> {
  send(message: T): void;
  onMessage(handler: (message: T) => void): () => void;
  close(): void;
}
```

Everything in Plim that syncs — real-time collaboration, comment threads, presence — is written against this one interface, so you can swap the wire (in-process, cross-tab, WebSocket, WebRTC, your own) without touching the feature code.

## Install

```sh
pnpm add @plim/transports
```

## What's in the box

- **`createMemoryTransportPair<T>()`** — two linked in-process transports (A↔B). Great for two-party tests and embedding.
- **`MemoryBus<T>`** — an in-process broadcast hub; every `connect()` returns a `Transport<T>` and a message from one peer is delivered to all the others (never echoed to the sender). Mirrors `BroadcastChannel` semantics for N peers in one process.
- **`BroadcastChannelTransport<T>`** — sync across same-origin browser tabs/workers via the native [`BroadcastChannel`](https://developer.mozilla.org/docs/Web/API/BroadcastChannel) API.
- **`WebSocketTransport<T>`** — a reconnecting JSON WebSocket client. Buffers `send`s while offline, flushes on (re)connect, exponential backoff, and an `onStatus` hook. Works in the browser and in Node (pass a `WebSocket` implementation).
- **`mapTransport(inner, encode, decode)`** — adapt a `Transport<A>` into a `Transport<B>` with a codec (e.g. wrap/compress/namespace messages).

## License

See the [LICENSE](./LICENSE) file in this package.
