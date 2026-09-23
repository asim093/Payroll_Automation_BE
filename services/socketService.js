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

// Pushed on every compliance-generation job change (per-client result,
// warnings, completion) — replaces the frontend's old 1.2s poll of
// generate-status/active with a single persistent connection.
const broadcastComplianceJobStatus = (payload) => {
  if (!io) return;
  io.emit('compliance-job-status', payload);
};

// Pushed on every EmailActionJob change (per-item status, completion).
// sourceType distinguishes 'applicant_reminder' from 'customer_report_email'
// so one event name covers both job types.
const broadcastEmailActionJobStatus = (payload) => {
  if (!io) return;
  io.emit('email-action-job-status', payload);
};

// Pushed whenever a FileLog/EmailLog gets matched/assigned to a client (auto
// during a scan, or manually from the review queue) or an ignore-rule
// resolves a review-queue item — any page showing a client's files/emails or
// the ingestion/review queue can refetch instead of requiring a reload.
const broadcastClientDataChanged = (payload) => {
  if (!io) return;
  io.emit('client-data-changed', payload);
};

module.exports = {
  initSocket,
  broadcastScanActivity,
  broadcastComplianceJobStatus,
  broadcastEmailActionJobStatus,
  broadcastClientDataChanged,
};
