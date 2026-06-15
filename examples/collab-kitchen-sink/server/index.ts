// Standalone collaboration backend for the kitchen-sink demo.
//
// This is the whole "server" — a real, deployable WebSocket hub in ~40 lines.
// It is a thin adapter around `CollabHub` from @plim/core: Hono handles plain
// HTTP (a health check + a landing blurb) and the `ws` server carries the
// `CollabMessage` protocol. Every browser tab that connects is registered as a
// `HubClient`; the hub linearizes their submissions into one canonical order and
// broadcasts confirmed records back, so every tab converges on the same doc.
//
// Swap the in-memory `CollabHub` for one backed by your own store (Postgres,
// Redis, a CRDT engine, Durable Objects…) and this same file becomes a
// production server — that is exactly the seam the layer is designed around.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import { CollabHub, type CollabMessage, type HubClient } from '@plim/core';
import { COLLAB_PATH, COLLAB_PORT, makeBaseDoc } from '../src/shared.js';

// One hub = one shared document, held in memory. Restarting the process resets
// it (reload every tab afterwards). A real deployment would persist the log.
const hub = new CollabHub(makeBaseDoc());

const app = new Hono();
app.get('/healthz', (c) => c.json({ ok: true, peers: hub.peers().length, head: hub.authority.head }));
app.get('/', (c) =>
	c.text(
		`Plim collaboration server.\n` +
			`WebSocket endpoint: ws://<host>:${COLLAB_PORT}${COLLAB_PATH}\n` +
			`Connected peers: ${hub.peers().length} · canonical version: ${hub.authority.head}\n` +
			`Open the Vite app (http://localhost:5176) in multiple tabs to collaborate.`,
	),
);

const server = serve({ fetch: app.fetch, port: COLLAB_PORT, hostname: '0.0.0.0' }, (info) => {
	console.log(`[collab] hub listening on http://localhost:${info.port}  ·  ws ${COLLAB_PATH}`);
});

const wss = new WebSocketServer({ noServer: true });

// Route only OUR path through the hub; anything else (e.g. a stray probe) is
// refused so we never collide with other upgrade users.
server.on('upgrade', (req, socket, head) => {
	const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
	if (pathname !== COLLAB_PATH) {
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws: WebSocket) => {
	// The hub pushes canonical/awareness messages into this sink; we serialize
	// them onto the wire. WebSocket/TCP preserves per-connection order, which is
	// the one ordering guarantee the hub requires.
	const client: HubClient = {
		send: (message: CollabMessage) => {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
		},
	};
	hub.add(client);

	ws.on('message', (data) => {
		let message: CollabMessage;
		try {
			message = JSON.parse(data.toString()) as CollabMessage;
		} catch {
			return; // ignore malformed frames
		}
		hub.receive(client, message);
	});

	ws.on('close', () => hub.remove(client));
	ws.on('error', () => hub.remove(client));
});
