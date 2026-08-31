const express = require('express');
const router = express.Router();
const { getActivityDetails, getEmailBody } = require('../controllers/activityController');

router.get('/email/:id/body', getEmailBody);
router.get('/:id/details', getActivityDetails);

module.exports = router;
