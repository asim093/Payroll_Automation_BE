const express = require('express');
const router = express.Router();
const {
  createClient,
  getAllClients,
  getClientsWithLastActivity,
  getClientHistory,
  getClientById,
  updateClient,
  deleteClient,
} = require('../controllers/clientController');

router.route('/').post(createClient).get(getAllClients);
// Both registered before '/:id' - otherwise Express would match
// "with-last-activity" as an :id value.
router.get('/with-last-activity', getClientsWithLastActivity);
router.get('/:id/history', getClientHistory);
router.route('/:id').get(getClientById).put(updateClient).delete(deleteClient);

module.exports = router;
