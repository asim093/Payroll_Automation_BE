const express = require('express');
const router = express.Router();
const {
  createClient,
  getAllClients,
  getClientById,
  updateClient,
  deleteClient,
} = require('../controllers/clientController');

router.route('/').post(createClient).get(getAllClients);
router.route('/:id').get(getClientById).put(updateClient).delete(deleteClient);

module.exports = router;
