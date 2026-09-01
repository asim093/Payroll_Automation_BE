const Client = require('../models/Client');
const EmailLog = require('../models/EmailLog');
const MatchingRule = require('../models/MatchingRule');

const getActiveRulesByType = async (clientIds, type) =>
  MatchingRule.find({ clientId: { $in: clientIds }, type, active: true }).lean();

const buildClientLookup = (clients) => new Map(clients.map((client) => [String(client._id), client]));

const uniqueClientIdsMatching = (rules, predicate) => [
  ...new Set(rules.filter(predicate).map((rule) => String(rule.clientId))),
];


const matchClientBySender = async (senderEmail, subject, activeClients) => {
  const normalizedSender = (senderEmail || '').trim().toLowerCase();
  const senderDomain = normalizedSender.split('@')[1] || '';
  const normalizedSubject = (subject || '').toLowerCase();

  activeClients = activeClients || (await Client.find({ status: 'active' }));
  const clientById = buildClientLookup(activeClients);
  const clientIds = activeClients.map((client) => client._id);

  const resolveAmbiguityBySubject = async (candidateClientIds) => {
    if (!normalizedSubject) return null;

    const keywordRules = await getActiveRulesByType(candidateClientIds, 'subject_keyword');
    const clientsWithRules = new Set(keywordRules.map((rule) => String(rule.clientId)));
    const matchingClientIds = uniqueClientIdsMatching(keywordRules, (rule) => normalizedSubject.includes(rule.value));

    if (matchingClientIds.length === 1) {
      return clientById.get(matchingClientIds[0]);
    }
    if (matchingClientIds.length > 1) {
      return null;
    }

    const clientsWithoutRules = candidateClientIds.filter((id) => !clientsWithRules.has(String(id)));
    if (clientsWithoutRules.length === 1) {
      return clientById.get(String(clientsWithoutRules[0]));
    }

    return null;
  };

  const emailRules = await getActiveRulesByType(clientIds, 'exact_email');
  const exactMatchClientIds = uniqueClientIdsMatching(emailRules, (rule) => rule.value === normalizedSender);
  if (exactMatchClientIds.length > 1) {
    const resolvedClient = await resolveAmbiguityBySubject(exactMatchClientIds);
    if (resolvedClient) {
      console.warn(
        `AMBIGUOUS MATCH RESOLVED: sender "${normalizedSender}" matched multiple clients by exact email, subject-keyword picked "${resolvedClient.name}".`
      );
      return { client: resolvedClient, method: 'subject_keyword' };
    }
    console.warn(
      `AMBIGUOUS MATCH: sender "${normalizedSender}" matches multiple clients (exact email): [${exactMatchClientIds
        .map((id) => clientById.get(id)?.name)
        .join(', ')}]`
    );
    return null;
  }
  if (exactMatchClientIds.length === 1) {
    return { client: clientById.get(exactMatchClientIds[0]), method: 'exact_email' };
  }

  if (senderDomain) {
    const domainRules = await getActiveRulesByType(clientIds, 'domain');
    const domainMatchClientIds = uniqueClientIdsMatching(domainRules, (rule) => rule.value === senderDomain);
    if (domainMatchClientIds.length > 1) {
      const resolvedClient = await resolveAmbiguityBySubject(domainMatchClientIds);
      if (resolvedClient) {
        console.warn(
          `AMBIGUOUS MATCH RESOLVED: sender "${normalizedSender}" matched multiple clients by domain "${senderDomain}", subject-keyword picked "${resolvedClient.name}".`
        );
        return { client: resolvedClient, method: 'subject_keyword' };
      }
      console.warn(
        `AMBIGUOUS MATCH: sender "${normalizedSender}" matches multiple clients (domain "${senderDomain}"): [${domainMatchClientIds
          .map((id) => clientById.get(id)?.name)
          .join(', ')}]`
      );
      return null;
    }
    if (domainMatchClientIds.length === 1) {
      return { client: clientById.get(domainMatchClientIds[0]), method: 'domain' };
    }
  }

  if (normalizedSubject) {
    const keywordRules = await getActiveRulesByType(clientIds, 'subject_keyword');
    const keywordMatchClientIds = uniqueClientIdsMatching(keywordRules, (rule) => normalizedSubject.includes(rule.value));
    if (keywordMatchClientIds.length > 1) {
      console.warn(
        `AMBIGUOUS MATCH: subject "${subject}" matches multiple clients (subject-keyword): [${keywordMatchClientIds
          .map((id) => clientById.get(id)?.name)
          .join(', ')}]`
      );
      return null;
    }
    if (keywordMatchClientIds.length === 1) {
      return { client: clientById.get(keywordMatchClientIds[0]), method: 'subject_keyword' };
    }
  }

  return null;
};

const matchClientByDomainPendingReview = async (senderEmail, activeClients) => {
  const normalizedSender = (senderEmail || '').trim().toLowerCase();
  const senderDomain = normalizedSender.split('@')[1] || '';
  if (!senderDomain) return null;

  activeClients = activeClients || (await Client.find({ status: 'active' }));
  const clientById = buildClientLookup(activeClients);
  const clientIds = activeClients.map((client) => client._id);

  const domainRules = await getActiveRulesByType(clientIds, 'domain');
  const domainMatchClientIds = uniqueClientIdsMatching(domainRules, (rule) => rule.value === senderDomain);
  if (domainMatchClientIds.length !== 1) return null;

  const client = clientById.get(domainMatchClientIds[0]);
  const previouslySeen = await EmailLog.exists({ sender: normalizedSender, matchedClientId: client._id });
  return previouslySeen ? null : client;
};


const matchClientBySubjectKeyword = async (subject, activeClients) => {
  const normalizedSubject = (subject || '').toLowerCase();
  if (!normalizedSubject) return null;

  activeClients = activeClients || (await Client.find({ status: 'active' }));
  const clientById = buildClientLookup(activeClients);
  const clientIds = activeClients.map((client) => client._id);

  const keywordRules = await getActiveRulesByType(clientIds, 'subject_keyword');
  const matchClientIds = uniqueClientIdsMatching(keywordRules, (rule) => normalizedSubject.includes(rule.value));
  if (matchClientIds.length > 1) {
    console.warn(
      `AMBIGUOUS MATCH: subject "${subject}" matches multiple clients (subject-keyword): [${matchClientIds
        .map((id) => clientById.get(id)?.name)
        .join(', ')}]`
    );
    return null;
  }
  if (matchClientIds.length === 1) {
    return clientById.get(matchClientIds[0]);
  }
  return null;
};


const matchClientByNotificationPattern = async (senderEmail, activeClients) => {
  const normalizedSender = (senderEmail || '').trim().toLowerCase();
  if (!normalizedSender) return null;

  activeClients = activeClients || (await Client.find({ status: 'active' }));
  const clientById = buildClientLookup(activeClients);
  const clientIds = activeClients.map((client) => client._id);

  const patternRules = await getActiveRulesByType(clientIds, 'notification_pattern');
  const matchedRule = patternRules.find((rule) => rule.value && normalizedSender.includes(rule.value));

  return matchedRule ? clientById.get(String(matchedRule.clientId)) : null;
};


const matchInactiveClientBySender = async (senderEmail) => {
  const normalizedSender = (senderEmail || '').trim().toLowerCase();
  const senderDomain = normalizedSender.split('@')[1] || '';

  const inactiveClients = await Client.find({ status: 'inactive' });
  if (inactiveClients.length === 0) return null;
  const clientById = buildClientLookup(inactiveClients);
  const clientIds = inactiveClients.map((client) => client._id);

  const emailRules = await getActiveRulesByType(clientIds, 'exact_email');
  const exactMatchId = emailRules.find((rule) => rule.value === normalizedSender)?.clientId;
  if (exactMatchId) return clientById.get(String(exactMatchId));

  if (senderDomain) {
    const domainRules = await getActiveRulesByType(clientIds, 'domain');
    const domainMatchId = domainRules.find((rule) => rule.value === senderDomain)?.clientId;
    if (domainMatchId) return clientById.get(String(domainMatchId));
  }

  return null;
};

module.exports = {
  matchClientBySender,
  matchClientByNotificationPattern,
  matchClientBySubjectKeyword,
  matchInactiveClientBySender,
  matchClientByDomainPendingReview,
};
