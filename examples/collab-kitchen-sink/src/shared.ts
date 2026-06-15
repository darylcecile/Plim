// Values shared by BOTH ends of the demo: the browser app (Vite) and the
// standalone collaboration server (Node/tsx). Keep this file free of any
// runtime-specific imports so either environment can load it — it only pulls a
// TYPE from @plim/core.

import type { DocumentNode } from '@plim/core';

/** Port the Hono collaboration server listens on. */
export const COLLAB_PORT = 8787;

/** WebSocket path the hub is mounted at. */
export const COLLAB_PATH = '/collab-ws';

/**
 * The shared origin document. The server seeds its `CollabHub` with this exact
 * document and every browser editor initializes from it, so all peers fold the
 * same canonical log onto the same starting point and converge byte-for-byte.
 * (If you change this, restart the server AND reload every tab.)
 */
export function makeBaseDoc(): DocumentNode {
	return {
		type: 'doc',
		children: [
			{ id: 'title', type: 'heading', attrs: { level: 2 }, text: [{ text: 'Shared document' }] },
			{
				id: 'intro',
				type: 'paragraph',
				text: [{ text: 'Open this page in another tab, window, browser, or device on your network — then type. Every edit syncs through the server and converges here, with your caret held steady.' }],
			},
			{ id: 'scratch', type: 'paragraph', text: [{ text: 'Start typing…' }] },
		],
	};
}
