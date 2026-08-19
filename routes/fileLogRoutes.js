const express = require('express');
const router = express.Router();
const {
  createFileLog,
  getAllFileLogs,
  getFileLogById,
  updateFileLog,
  deleteFileLog,
  retryFileLog,
} = require('../controllers/fileLogController');

router.route('/').post(createFileLog).get(getAllFileLogs);
router.post('/:id/retry', retryFileLog);
router.route('/:id').get(getFileLogById).put(updateFileLog).delete(deleteFileLog);

module.exports = router;
