const MatchingRule = require('../models/MatchingRule');
const Client = require('../models/Client');
const ReviewQueue = require('../models/ReviewQueue');
const EmailLog = require('../models/EmailLog');
const { classifyMatchValue, deriveRuleType } = require('../utils/matchValue');

const VALID_TYPES = ['exact_email', 'domain', 'notification_pattern', 'subject_keyword'];
const UNIQUE_ACROSS_CLIENTS_TYPES = ['exact_email', 'domain'];
const SENDER_TYPES = ['exact_email', 'domain'];
const PREVIEW_LIMIT = 20;

const normalizeValue = (value) => String(value || '').trim().toLowerCase();

// For a sender rule the value's shape is authoritative: "@acme.com" is a domain,
// "bob@acme.com" is an exact_email, regardless of the type the caller asked for.
// Returns { type, value } or { error } for an unrecognisable sender value.
const resolveRuleTypeAndValue = (requestedType, rawValue) => {
  if (!SENDER_TYPES.includes(requestedType)) {
    return { type: requestedType, value: normalizeValue(rawValue) };
  }
  const derived = deriveRuleType(rawValue);
  if (!derived) {
    return { error: 'Enter a full email address or a domain like acme.com.' };
  }
  return { type: derived, value: classifyMatchValue(rawValue).value };
};

const doesEmailMatchRule = (email, type, normalizedValue) => {
  if (!normalizedValue) return false;
  const sender = String(email.sender || '').trim().toLowerCase();
  const subject = String(email.subject || '').toLowerCase();

  switch (type) {
    case 'exact_email':
      return sender === normalizedValue;
    case 'domain':
      return (sender.split('@')[1] || '') === normalizedValue;
    case 'subject_keyword':
      return subject.includes(normalizedValue);
    case 'notification_pattern':
      return sender.includes(normalizedValue);
    default:
      return false;
  }
};

exports.getAllRules = async (req, res, next) => {
  try {
    const filter = req.query.clientId ? { clientId: req.query.clientId } : {};
    const rules = await MatchingRule.find(filter)
      .populate('clientId', 'name status')
      .sort({ type: 1, createdAt: -1 });
    res.status(200).json(rules);
  } catch (error) {
    next(error);
  }
};

exports.getRulesForClient = async (req, res, next) => {
  try {
    const rules = await MatchingRule.find({ clientId: req.params.clientId }).sort({ type: 1, createdAt: -1 });
    res.status(200).json(rules);
  } catch (error) {
    next(error);
  }
};

exports.createRule = async (req, res, next) => {
  try {
    const { clientId, type, value } = req.body;

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }
    if (!type || !VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: `type is required and must be one of: ${VALID_TYPES.join(', ')}` });
    }
    if (!value || !String(value).trim()) {
      return res.status(400).json({ error: 'value is required' });
    }

    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const resolved = resolveRuleTypeAndValue(type, value);
    if (resolved.error) {
      return res.status(400).json({ error: resolved.error });
    }
    const { type: finalType, value: normalizedValue } = resolved;

    if (UNIQUE_ACROSS_CLIENTS_TYPES.includes(finalType)) {
      const conflict = await MatchingRule.findOne({ type: finalType, value: normalizedValue, active: true }).populate(
        'clientId',
        'name'
      );
      if (conflict && String(conflict.clientId._id) !== String(clientId)) {
        return res.status(409).json({
          error: `This ${finalType === 'exact_email' ? 'email address' : 'domain'} is already used by client "${conflict.clientId.name}"`,
        });
      }
    }

    const duplicateOnSameClient = await MatchingRule.findOne({ clientId, type: finalType, value: normalizedValue });
    if (duplicateOnSameClient) {
      return res.status(409).json({ error: 'This rule already exists for this client' });
    }

    const rule = await MatchingRule.create({
      clientId,
      type: finalType,
      value: normalizedValue,
      source: 'manual',
      createdBy: req.body.createdBy || undefined,
    });

    res.status(201).json(rule);
  } catch (error) {
    next(error);
  }
};

exports.updateRule = async (req, res, next) => {
  try {
    const rule = await MatchingRule.findById(req.params.id);
    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    if (req.body.active !== undefined) {
      rule.active = Boolean(req.body.active);
    }

    if (req.body.value !== undefined || req.body.type !== undefined) {
      const requestedType = req.body.type !== undefined ? req.body.type : rule.type;
      if (!VALID_TYPES.includes(requestedType)) {
        return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
      }
      const rawValue = req.body.value !== undefined ? req.body.value : rule.value;
      if (!String(rawValue || '').trim()) {
        return res.status(400).json({ error: 'value is required' });
      }
      const resolved = resolveRuleTypeAndValue(requestedType, rawValue);
      if (resolved.error) {
        return res.status(400).json({ error: resolved.error });
      }
      const { type: nextType, value: nextValue } = resolved;

      if (UNIQUE_ACROSS_CLIENTS_TYPES.includes(nextType)) {
        const conflict = await MatchingRule.findOne({
          _id: { $ne: rule._id },
          type: nextType,
          value: nextValue,
          active: true,
        }).populate('clientId', 'name');
        if (conflict && String(conflict.clientId._id) !== String(rule.clientId)) {
          return res.status(409).json({
            error: `This ${nextType === 'exact_email' ? 'email address' : 'domain'} is already used by client "${conflict.clientId.name}"`,
          });
        }
      }

      const duplicate = await MatchingRule.findOne({
        _id: { $ne: rule._id },
        clientId: rule.clientId,
        type: nextType,
        value: nextValue,
      });
      if (duplicate) {
        return res.status(409).json({ error: 'This rule already exists for this client' });
      }

      rule.type = nextType;
      rule.value = nextValue;
    }

    await rule.save();
    res.status(200).json(rule);
  } catch (error) {
    next(error);
  }
};

exports.previewRuleMatches = async (req, res, next) => {
  try {
    const { type, value } = req.body;

    if (!type || !VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: `type is required and must be one of: ${VALID_TYPES.join(', ')}` });
    }
    if (!value || !String(value).trim()) {
      return res.status(400).json({ error: 'value is required' });
    }

    const normalizedValue = normalizeValue(value);

    const pendingEmailEntries = await ReviewQueue.find({
      type: 'email',
      resolvedClientId: null,
      archivedReason: null,
    })
      .select('_id referenceId')
      .lean();

    if (pendingEmailEntries.length === 0) {
      return res.status(200).json({ count: 0, items: [], matchedIds: [] });
    }

    const emailIds = pendingEmailEntries.map((entry) => entry.referenceId);
    const emailLogs = await EmailLog.find({ _id: { $in: emailIds } })
      .select('sender subject receivedAt')
      .lean();
    const emailById = new Map(emailLogs.map((log) => [String(log._id), log]));

    const matches = [];
    pendingEmailEntries.forEach((entry) => {
      const email = emailById.get(String(entry.referenceId));
      if (!email) return;
      if (doesEmailMatchRule(email, type, normalizedValue)) {
        matches.push({
          reviewQueueId: entry._id,
          sender: email.sender,
          subject: email.subject,
          receivedAt: email.receivedAt,
        });
      }
    });

    matches.sort((a, b) => new Date(b.receivedAt || 0).getTime() - new Date(a.receivedAt || 0).getTime());

    res.status(200).json({
      count: matches.length,
      items: matches.slice(0, PREVIEW_LIMIT),
      matchedIds: matches.map((match) => match.reviewQueueId),
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteRule = async (req, res, next) => {
  try {
    const rule = await MatchingRule.findByIdAndDelete(req.params.id);
    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }
    res.status(200).json({ message: 'Rule deleted successfully' });
  } catch (error) {
    next(error);
  }
};
