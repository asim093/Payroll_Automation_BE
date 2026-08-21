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
  deleteClient,
} = require('../controllers/clientController');

router.route('/').post(createClient).get(getAllClients);
router.get('/with-last-activity', getClientsWithLastActivity);
router.get('/:id/history', getClientHistory);
router.get('/:id/profile', getClientProfile);
router.route('/:id').get(getClientById).put(updateClient).delete(deleteClient);

module.exports = router;
