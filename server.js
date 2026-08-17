require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const clientRoutes = require('./routes/clientRoutes');
const emailLogRoutes = require('./routes/emailLogRoutes');
const fileLogRoutes = require('./routes/fileLogRoutes');
const reviewQueueRoutes = require('./routes/reviewQueueRoutes');

connectDB();

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/clients', clientRoutes);
app.use('/api/email-logs', emailLogRoutes);
app.use('/api/file-logs', fileLogRoutes);
app.use('/api/review-queue', reviewQueueRoutes);

app.get('/', (req, res) => {
  res.send('Payroll Automation API is running');
});

// 404 handler — any request that didn't match a route above lands here.
// Must be registered after all routes, before the error handler.
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// Global error handler — must be last, and must take all 4 args (err, req,
// res, next) for Express to recognize it as an error handler. Every
// controller catch block calls next(error) instead of formatting its own
// response, so all error responses end up shaped consistently here.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  // Malformed JSON body (thrown by express.json() itself, before it reaches
  // any route handler).
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }

  // Mongoose schema validation errors -> 400 with per-field messages.
  if (err.name === 'ValidationError') {
    const fields = Object.fromEntries(
      Object.entries(err.errors).map(([field, fieldError]) => [field, fieldError.message])
    );
    return res.status(400).json({ error: 'Validation failed', fields });
  }

  // Invalid ObjectId (e.g. GET /api/clients/not-a-real-id) -> 400, not 500.
  if (err.name === 'CastError') {
    return res.status(400).json({ error: `Invalid value for "${err.path}": ${err.value}` });
  }

  // Duplicate key (e.g. EmailLog.messageId unique constraint) -> 409.
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res.status(409).json({ error: `Duplicate value for "${field}"` });
  }

  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
