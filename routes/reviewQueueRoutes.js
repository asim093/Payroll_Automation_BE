const express = require('express');
const router = express.Router();
const {
  createReviewQueueEntry,
  getAllReviewQueueEntries,
  getReviewQueueEntryById,
  updateReviewQueueEntry,
  deleteReviewQueueEntry,
  resolveReviewItem,
  bulkResolveReviewItems,
} = require('../controllers/reviewQueueController');

router.route('/').post(createReviewQueueEntry).get(getAllReviewQueueEntries);
// Registered before '/:id' - otherwise Express would match "bulk-resolve"
// as an :id value (harmless here since that block only handles GET/PUT/
// DELETE, not POST, but kept consistent with the same precaution used
// elsewhere in this codebase, e.g. clientRoutes.js).
router.post('/bulk-resolve', bulkResolveReviewItems);
router.patch('/:id/resolve', resolveReviewItem);
router
  .route('/:id')
  .get(getReviewQueueEntryById)
  .put(updateReviewQueueEntry)
  .delete(deleteReviewQueueEntry);

module.exports = router;
