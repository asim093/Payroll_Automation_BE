let io = null;

const initSocket = (httpServer) => {
  const { Server } = require('socket.io');
  io = new Server(httpServer, {

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

const broadcastScanActivity = (payload) => {
  if (!io) return;
  io.emit('scan-activity', payload);
};

module.exports = { initSocket, broadcastScanActivity };
