const express = require('express');
const router = express.Router();
const { getScanActivity } = require('../controllers/scanActivityController');

router.get('/', getScanActivity);

module.exports = router;
