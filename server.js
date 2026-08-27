require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const { initSocket } = require('./services/socketService');

const clientRoutes = require('./routes/clientRoutes');
const emailLogRoutes = require('./routes/emailLogRoutes');
const fileLogRoutes = require('./routes/fileLogRoutes');
const reviewQueueRoutes = require('./routes/reviewQueueRoutes');
const triggerRoutes = require('./routes/triggerRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const scanActivityRoutes = require('./routes/scanActivityRoutes');
const unmatchedShareFileItemRoutes = require('./routes/unmatchedShareFileItemRoutes');
const unmatchedDropboxItemRoutes = require('./routes/unmatchedDropboxItemRoutes');
const internalRoutes = require('./routes/internalRoutes');
const authRoutes = require('./routes/authRoutes');
const oauthRoutes = require('./routes/oauthRoutes');
const complianceReportRoutes = require('./routes/complianceReportRoutes');

connectDB();

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/clients', clientRoutes);
app.use('/api/email-logs', emailLogRoutes);
app.use('/api/file-logs', fileLogRoutes);
app.use('/api/review-queue', reviewQueueRoutes);
app.use('/api', triggerRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/scan-activity', scanActivityRoutes);
app.use('/api/unmatched-sharefile-items', unmatchedShareFileItemRoutes);
app.use('/api/unmatched-dropbox-items', unmatchedDropboxItemRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/compliance-reports', complianceReportRoutes);

app.use('/internal', internalRoutes);

app.use('/oauth', oauthRoutes);

app.get('/', (req, res) => {
  res.send('Payroll Automation API is running');
});


app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});


app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);


  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }

  if (err.name === 'ValidationError') {
    const fields = Object.fromEntries(
      Object.entries(err.errors).map(([field, fieldError]) => [field, fieldError.message])
    );
    return res.status(400).json({ error: 'Validation failed', fields });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({ error: `Invalid value for "${err.path}": ${err.value}` });
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res.status(409).json({ error: `Duplicate value for "${field}"` });
  }

  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 5000;


const httpServer = http.createServer(app);
initSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (HTTP + WebSocket)`);
});
