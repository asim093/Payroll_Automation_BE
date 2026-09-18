const express = require('express');
const router = express.Router();
const {
  getAllComplianceStatuses,
  createComplianceStatus,
  updateComplianceStatus,
  deleteComplianceStatus,
} = require('../controllers/complianceStatusController');

router.route('/').get(getAllComplianceStatuses).post(createComplianceStatus);
router.route('/:id').patch(updateComplianceStatus).delete(deleteComplianceStatus);

module.exports = router;
