const MatchingRule = require('../models/MatchingRule');
const { classifyMatchValue } = require('../utils/matchValue');

const LEGACY_TYPES = ['exact_email', 'domain', 'notification_pattern'];

const ruleKey = (type, value) => `${type}::${value}`;

// A sender value's shape decides its rule type and normalized form, regardless of
// which array it was stored in ("@acme.com" in emailAddresses is still a domain).
const senderRule = (clientId, raw) => {
  const { kind, value } = classifyMatchValue(raw);
  if (kind === 'email') return { clientId, type: 'exact_email', value, source: 'legacy_sync' };
  if (kind === 'domain') return { clientId, type: 'domain', value, source: 'legacy_sync' };
  return null; // invalid -> no rule
};

const syncLegacyRulesForClient = async (client) => {
  await MatchingRule.deleteMany({
    clientId: client._id,
    source: 'legacy_sync',
    type: { $in: LEGACY_TYPES },
  });

  const newRules = [];

  [
    ...(client.matchingRules?.emailAddresses || []),
    ...(client.matchingRules?.domains || []),
  ].forEach((raw) => {
    const rule = senderRule(client._id, raw);
    if (rule) newRules.push(rule);
  });

  const notificationPattern = String(client.matchingRules?.notificationSenderPattern || '').trim().toLowerCase();
  if (notificationPattern) {
    newRules.push({ clientId: client._id, type: 'notification_pattern', value: notificationPattern, source: 'legacy_sync' });
  }

  // Don't shadow a rule the user made by hand on the Rules page: if a manual
  // rule with the same (type, value) already exists for this client, skip
  // regenerating it here (BUG-11 - otherwise it shows up twice).
  const existing = await MatchingRule.find({
    clientId: client._id,
    type: { $in: LEGACY_TYPES },
  })
    .select('type value')
    .lean();
  const seen = new Set(existing.map((rule) => ruleKey(rule.type, rule.value)));
  const toInsert = [];
  for (const rule of newRules) {
    const key = ruleKey(rule.type, rule.value);
    if (seen.has(key)) continue; // a manual rule or an earlier entry already covers this
    seen.add(key);
    toInsert.push(rule);
  }

  if (toInsert.length > 0) {
    await MatchingRule.insertMany(toInsert);
  }
};

const deleteAllRulesForClient = async (clientId) => {
  await MatchingRule.deleteMany({ clientId });
};

module.exports = { syncLegacyRulesForClient, deleteAllRulesForClient };
