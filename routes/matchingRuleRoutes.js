const express = require('express');
const router = express.Router();
const {
  getAllRules,
  getRulesForClient,
  createRule,
  updateRule,
  deleteRule,
} = require('../controllers/matchingRuleController');

router.get('/', getAllRules);
router.get('/client/:clientId', getRulesForClient);
router.post('/', createRule);
router.patch('/:id', updateRule);
router.delete('/:id', deleteRule);

module.exports = router;
