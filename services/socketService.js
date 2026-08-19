/**
 * PHASE 9 — thin wrapper around the Socket.io server instance, so any other
 * backend module can broadcast without needing a reference to the raw
 * httpServer/io object (server.js creates it once at boot via initSocket()).
 *
 * Kept deliberately minimal: no rooms, no per-client state, no auth beyond
 * what the browser already needs to reach the dashboard at all — this is a
 * read-only, one-way status feed (server -> connected dashboards), not a
 * two-way channel, so there's nothing for a client to send that the server
 * needs to trust or validate.
 */
let io = null;

const initSocket = (httpServer) => {
  const { Server } = require('socket.io');
  io = new Server(httpServer, {
    // Matches the REST API's own cors() middleware in server.js (no origin
    // restriction) — this is an internal ops dashboard, not a public API.
    cors: { origin: '*' },
  });

  io.on('connection', (socket) => {
    console.log(`[SOCKET] Dashboard connected (${socket.id}). ${io.engine.clientsCount} connected total.`);
    socket.on('disconnect', () => {
      console.log(`[SOCKET] Dashboard disconnected (${socket.id}). ${io.engine.clientsCount} connected total.`);
    });
  });

  return io;
};

// Broadcasts to every connected dashboard. A no-op (not an error) if
// called before initSocket() has run, or if the payload has nowhere to
// go — io.emit() itself is already a no-op with zero connected clients, so
// there's no extra "is anyone listening" check needed here.
const broadcastScanActivity = (payload) => {
  if (!io) return;
  io.emit('scan-activity', payload);
};

module.exports = { initSocket, broadcastScanActivity };
