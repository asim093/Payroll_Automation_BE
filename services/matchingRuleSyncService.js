const MatchingRule = require('../models/MatchingRule');

const LEGACY_TYPES = ['exact_email', 'domain', 'notification_pattern'];

const ruleKey = (type, value) => `${type}::${value}`;

const syncLegacyRulesForClient = async (client) => {
  await MatchingRule.deleteMany({
    clientId: client._id,
    source: 'legacy_sync',
    type: { $in: LEGACY_TYPES },
  });

  const newRules = [];

  (client.matchingRules?.emailAddresses || []).forEach((email) => {
    const value = String(email).trim().toLowerCase();
    if (value) newRules.push({ clientId: client._id, type: 'exact_email', value, source: 'legacy_sync' });
  });

  (client.matchingRules?.domains || []).forEach((domain) => {
    const value = String(domain).trim().toLowerCase();
    if (value) newRules.push({ clientId: client._id, type: 'domain', value, source: 'legacy_sync' });
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
  const alreadyThere = new Set(existing.map((rule) => ruleKey(rule.type, rule.value)));
  const toInsert = newRules.filter((rule) => !alreadyThere.has(ruleKey(rule.type, rule.value)));

  if (toInsert.length > 0) {
    await MatchingRule.insertMany(toInsert);
  }
};

const deleteAllRulesForClient = async (clientId) => {
  await MatchingRule.deleteMany({ clientId });
};

module.exports = { syncLegacyRulesForClient, deleteAllRulesForClient };
