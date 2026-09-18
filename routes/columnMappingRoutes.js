const express = require('express');
const router = express.Router();
const { getAllColumnMappings, updateAlternativeNames } = require('../controllers/columnMappingController');

router.get('/', getAllColumnMappings);
router.patch('/:id', updateAlternativeNames);

module.exports = router;
