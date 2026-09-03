const express = require('express');
const router = express.Router();
const {
  createClient,
  getAllClients,
  getClientsWithLastActivity,
  getClientHistory,
  getClientProfile,
  getClientById,
  updateClient,
  retryFolderSetup,
  getPayrollFiles,
  deleteClient,
} = require('../controllers/clientController');

router.route('/').post(createClient).get(getAllClients);
router.get('/with-last-activity', getClientsWithLastActivity);
router.get('/:id/history', getClientHistory);
router.get('/:id/profile', getClientProfile);
router.get('/:id/payroll-files', getPayrollFiles);
router.post('/:id/retry-folder-setup', retryFolderSetup);
router.route('/:id').get(getClientById).put(updateClient).delete(deleteClient);

module.exports = router;
