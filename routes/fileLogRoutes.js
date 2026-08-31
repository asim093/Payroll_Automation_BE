const express = require('express');
const router = express.Router();
const {
  createFileLog,
  getAllFileLogs,
  getFileLogById,
  updateFileLog,
  deleteFileLog,
  retryFileLog,
  getFileContent,
  getFilePreviewData,
} = require('../controllers/fileLogController');

router.route('/').post(createFileLog).get(getAllFileLogs);
router.post('/:id/retry', retryFileLog);
router.get('/:id/content', getFileContent);
router.get('/:id/preview-data', getFilePreviewData);
router.route('/:id').get(getFileLogById).put(updateFileLog).delete(deleteFileLog);

module.exports = router;
