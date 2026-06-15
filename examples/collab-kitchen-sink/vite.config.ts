import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app is served by Vite; the collaboration backend is a separate Hono + ws
// process (see ../server/index.ts), started alongside Vite by `pnpm dev`. The
// browser connects straight to that server on COLLAB_PORT, so `host: true` lets
// other devices on your network join too.
export default defineConfig({
plugins: [react()],
server: { port: 5176, host: true },
});
