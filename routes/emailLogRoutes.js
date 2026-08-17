const express = require('express');
const router = express.Router();
const {
  createEmailLog,
  getAllEmailLogs,
  getEmailLogById,
  updateEmailLog,
  deleteEmailLog,
} = require('../controllers/emailLogController');

router.route('/').post(createEmailLog).get(getAllEmailLogs);
router.route('/:id').get(getEmailLogById).put(updateEmailLog).delete(deleteEmailLog);

module.exports = router;
