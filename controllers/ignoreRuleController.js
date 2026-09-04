const { listIgnoreRules, createIgnoreRule, deleteIgnoreRule } = require('../services/ignoreRuleService');

exports.getIgnoreRules = async (req, res, next) => {
  try {
    const rules = await listIgnoreRules();
    res.status(200).json(rules);
  } catch (error) {
    next(error);
  }
};

exports.createIgnoreRule = async (req, res, next) => {
  try {
    const { scope, type, value, action, clientId, label } = req.body;
    const result = await createIgnoreRule({
      scope,
      type,
      value,
      action,
      clientId,
      label,
      createdBy: req.headers['x-user-email'],
    });
    res.status(201).json(result);
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
};

exports.deleteIgnoreRule = async (req, res, next) => {
  try {
    const deleted = await deleteIgnoreRule(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Ignore rule not found' });
    }
    res.status(200).json({ message: 'Ignore rule removed.' });
  } catch (error) {
    next(error);
  }
};
