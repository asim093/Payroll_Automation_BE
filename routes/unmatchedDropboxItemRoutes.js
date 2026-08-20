const express = require('express');
const router = express.Router();
const {
  getAllUnmatchedItems,
  resolveUnmatchedItem,
  dismissUnmatchedItem,
  deleteUnmatchedItem,
} = require('../controllers/unmatchedDropboxItemController');

router.get('/', getAllUnmatchedItems);
router.patch('/:id/resolve', resolveUnmatchedItem);
router.patch('/:id/dismiss', dismissUnmatchedItem);
router.delete('/:id', deleteUnmatchedItem);

module.exports = router;
