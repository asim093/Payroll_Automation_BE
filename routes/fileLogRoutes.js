const express = require('express');
const router = express.Router();
const {
  createFileLog,
  getAllFileLogs,
  getFileLogById,
  updateFileLog,
  deleteFileLog,
} = require('../controllers/fileLogController');

router.route('/').post(createFileLog).get(getAllFileLogs);
router.route('/:id').get(getFileLogById).put(updateFileLog).delete(deleteFileLog);

module.exports = router;
