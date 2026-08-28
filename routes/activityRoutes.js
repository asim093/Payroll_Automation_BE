const express = require('express');
const router = express.Router();
const { getActivityDetails } = require('../controllers/activityController');

router.get('/:id/details', getActivityDetails);

module.exports = router;
