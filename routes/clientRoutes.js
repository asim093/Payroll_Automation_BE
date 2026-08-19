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
// All registered before '/:id' - otherwise Express would match
// "with-last-activity" (and similar) as an :id value.
router.get('/with-last-activity', getClientsWithLastActivity);
router.get('/:id/history', getClientHistory);
router.get('/:id/profile', getClientProfile);
router.route('/:id').get(getClientById).put(updateClient).delete(deleteClient);

module.exports = router;
