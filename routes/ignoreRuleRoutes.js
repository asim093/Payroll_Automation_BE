const express = require('express');
const router = express.Router();
const { getIgnoreRules, createIgnoreRule, deleteIgnoreRule } = require('../controllers/ignoreRuleController');

router.route('/').get(getIgnoreRules).post(createIgnoreRule);
router.delete('/:id', deleteIgnoreRule);

module.exports = router;
