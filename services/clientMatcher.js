const Client = require('../models/Client');
const EmailLog = require('../models/EmailLog');


const matchClientBySender = async (senderEmail, activeClients) => {
  const normalizedSender = (senderEmail || '').trim().toLowerCase();
  const senderDomain = normalizedSender.split('@')[1] || '';

  activeClients = activeClients || (await Client.find({ status: 'active' }));

  const exactMatches = activeClients.filter((client) =>
    (client.matchingRules?.emailAddresses || []).some(
      (email) => email.toLowerCase() === normalizedSender
    )
  );
  if (exactMatches.length > 1) {
    console.warn(
      `AMBIGUOUS MATCH: sender "${normalizedSender}" matches multiple clients (exact email): [${exactMatches
        .map((client) => client.name)
        .join(', ')}]`
    );
    return null;
  }
  if (exactMatches.length === 1) {
    return { client: exactMatches[0], method: 'exact_email' };
  }

  if (senderDomain) {
    const domainMatches = activeClients.filter((client) =>
      (client.matchingRules?.domains || []).some(
        (domain) => domain.toLowerCase() === senderDomain
      )
    );
    if (domainMatches.length > 1) {
      console.warn(
        `AMBIGUOUS MATCH: sender "${normalizedSender}" matches multiple clients (domain "${senderDomain}"): [${domainMatches
          .map((client) => client.name)
          .join(', ')}]`
      );
      return null;
    }
    if (domainMatches.length === 1) {
      const client = domainMatches[0];
      const previouslySeen = await EmailLog.exists({
        sender: normalizedSender,
        matchedClientId: client._id,
      });
      if (previouslySeen) {
        return { client, method: 'domain' };
      }
      return null;
    }
  }

  return null;
};

const matchClientByDomainPendingReview = async (senderEmail, activeClients) => {
  const normalizedSender = (senderEmail || '').trim().toLowerCase();
  const senderDomain = normalizedSender.split('@')[1] || '';
  if (!senderDomain) return null;

  activeClients = activeClients || (await Client.find({ status: 'active' }));
  const domainMatches = activeClients.filter((client) =>
    (client.matchingRules?.domains || []).some((domain) => domain.toLowerCase() === senderDomain)
  );
  
  if (domainMatches.length !== 1) return null;

  const client = domainMatches[0];
  const previouslySeen = await EmailLog.exists({ sender: normalizedSender, matchedClientId: client._id });
  return previouslySeen ? null : client;
};


const matchClientByNotificationPattern = async (senderEmail, activeClients) => {
  const normalizedSender = (senderEmail || '').trim().toLowerCase();
  if (!normalizedSender) return null;

  activeClients = activeClients || (await Client.find({ status: 'active' }));

  const patternMatch = activeClients.find((client) => {
    const pattern = client.matchingRules?.notificationSenderPattern;
    return pattern && normalizedSender.includes(pattern.toLowerCase());
  });

  return patternMatch || null;
};


const matchInactiveClientBySender = async (senderEmail) => {
  const normalizedSender = (senderEmail || '').trim().toLowerCase();
  const senderDomain = normalizedSender.split('@')[1] || '';

  const inactiveClients = await Client.find({ status: 'inactive' });

  const exactMatch = inactiveClients.find((client) =>
    (client.matchingRules?.emailAddresses || []).some(
      (email) => email.toLowerCase() === normalizedSender
    )
  );
  if (exactMatch) return exactMatch;

  if (senderDomain) {
    const domainMatch = inactiveClients.find((client) =>
      (client.matchingRules?.domains || []).some((domain) => domain.toLowerCase() === senderDomain)
    );
    if (domainMatch) return domainMatch;
  }

  return null;
};

module.exports = {
  matchClientBySender,
  matchClientByNotificationPattern,
  matchInactiveClientBySender,
  matchClientByDomainPendingReview,
};
