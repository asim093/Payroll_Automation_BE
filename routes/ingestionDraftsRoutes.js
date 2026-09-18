const express = require('express');
const router = express.Router();
const { getIngestionDrafts, getIngestionDraftDetail } = require('../controllers/ingestionDraftsController');

router.get('/', getIngestionDrafts);
router.get('/:id', getIngestionDraftDetail);

module.exports = router;
