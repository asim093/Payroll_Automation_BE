const MatchingRule = require('../models/MatchingRule');

const LEGACY_TYPES = ['exact_email', 'domain', 'notification_pattern'];

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

  if (newRules.length > 0) {
    await MatchingRule.insertMany(newRules);
  }
};

const deleteAllRulesForClient = async (clientId) => {
  await MatchingRule.deleteMany({ clientId });
};

module.exports = { syncLegacyRulesForClient, deleteAllRulesForClient };
