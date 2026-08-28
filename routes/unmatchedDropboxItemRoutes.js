const express = require('express');
const router = express.Router();
const {
  getAllUnmatchedItems,
  resolveUnmatchedItem,
  bulkResolveUnmatchedItems,
  dismissUnmatchedItem,
  deleteUnmatchedItem,
} = require('../controllers/unmatchedDropboxItemController');

router.get('/', getAllUnmatchedItems);
router.post('/bulk-resolve', bulkResolveUnmatchedItems);
router.patch('/:id/resolve', resolveUnmatchedItem);
router.patch('/:id/dismiss', dismissUnmatchedItem);
router.delete('/:id', deleteUnmatchedItem);

module.exports = router;
