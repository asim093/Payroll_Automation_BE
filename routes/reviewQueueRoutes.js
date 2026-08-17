const express = require('express');
const router = express.Router();
const {
  createReviewQueueEntry,
  getAllReviewQueueEntries,
  getReviewQueueEntryById,
  updateReviewQueueEntry,
  deleteReviewQueueEntry,
  resolveReviewItem,
} = require('../controllers/reviewQueueController');

router.route('/').post(createReviewQueueEntry).get(getAllReviewQueueEntries);
router.patch('/:id/resolve', resolveReviewItem);
router
  .route('/:id')
  .get(getReviewQueueEntryById)
  .put(updateReviewQueueEntry)
  .delete(deleteReviewQueueEntry);

module.exports = router;
