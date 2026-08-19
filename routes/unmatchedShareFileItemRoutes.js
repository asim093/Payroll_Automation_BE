const express = require('express');
const router = express.Router();
const {
  getAllUnmatchedItems,
  resolveUnmatchedItem,
  dismissUnmatchedItem,
} = require('../controllers/unmatchedShareFileItemController');

router.get('/', getAllUnmatchedItems);
router.patch('/:id/resolve', resolveUnmatchedItem);
router.patch('/:id/dismiss', dismissUnmatchedItem);

module.exports = router;
