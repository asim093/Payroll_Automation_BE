const Client = require('../models/Client');
const EmailLog = require('../models/EmailLog');

/**
 * Match a client by sender email address.
 * 1. Try an exact email match against matchingRules.emailAddresses.
 * 2. If no exact match, fall back to a domain match against matchingRules.domains.
 * Returns the matched Client document, or null if nothing matches — this
 * includes the "ambiguous" case (see below), which is intentionally treated
 * the same as no match so the caller sends it to needs_review rather than
 * guessing which of several clients it belongs to.
 */
const matchClientBySender = async (senderEmail) => {
  const normalizedSender = (senderEmail || '').trim().toLowerCase();
  const senderDomain = normalizedSender.split('@')[1] || '';

  const activeClients = await Client.find({ status: 'active' });

  // 1. Exact email match
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
    return exactMatches[0];
  }

  // 2. Domain match
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
      // A domain rule matches ANY sender at that domain, including ones
      // that were never actually meant to be this client - e.g. an
      // unrelated new company that happens to share the domain. Auto-file
      // only once this exact address has matched this exact client before
      // (either from an earlier automatic match, or a manual Review Queue
      // approval - see resolveOneReviewItem() in reviewQueueController.js,
      // which sets matchedClientId the same way). A brand-new address is
      // withheld here and picked back up by
      // matchClientByDomainPendingReview() below, which routes it to
      // Review Queue for a one-time manual confirmation instead.
      const previouslySeen = await EmailLog.exists({
        sender: normalizedSender,
        matchedClientId: client._id,
      });
      if (previouslySeen) {
        return client;
      }
      return null;
    }
  }

  // 3. No match
  return null;
};

/**
 * Diagnostic companion to matchClientBySender() — called only after that
 * function has already returned null, to tell apart "this sender's domain
 * matches an active client, but this exact address has never been
 * confirmed before" from a genuinely unknown sender (see emailProcessor.js).
 * Mirrors the domain-matching half of matchClientBySender() rather than
 * sharing code with it, same as matchInactiveClientBySender() below - kept
 * simple and self-contained rather than threading extra state through the
 * main matching path.
 *
 * @returns {Promise<import('../models/Client')|null>} the client this
 *   sender's domain matches, if it's still pending a first-time approval -
 *   null otherwise (no domain match, an ambiguous one, or already trusted).
 */
const matchClientByDomainPendingReview = async (senderEmail) => {
  const normalizedSender = (senderEmail || '').trim().toLowerCase();
  const senderDomain = normalizedSender.split('@')[1] || '';
  if (!senderDomain) return null;

  const activeClients = await Client.find({ status: 'active' });
  const domainMatches = activeClients.filter((client) =>
    (client.matchingRules?.domains || []).some((domain) => domain.toLowerCase() === senderDomain)
  );
  // An ambiguous domain match (2+ clients) is a different situation,
  // already handled generically upstream - only a single, unambiguous
  // match counts as "pending first-time approval" here.
  if (domainMatches.length !== 1) return null;

  const client = domainMatches[0];
  const previouslySeen = await EmailLog.exists({ sender: normalizedSender, matchedClientId: client._id });
  return previouslySeen ? null : client;
};

/**
 * Match a client by ShareFile notification sender, e.g. "notifications@logiforms.com".
 * Checks the sender address against each active client's
 * matchingRules.notificationSenderPattern (a domain/substring, not a strict
 * equality — a client's pattern "logiforms.com" matches any sender address
 * that contains it). Returns the matched Client document, or null.
 */
const matchClientByNotificationPattern = async (senderEmail) => {
  const normalizedSender = (senderEmail || '').trim().toLowerCase();
  if (!normalizedSender) return null;

  const activeClients = await Client.find({ status: 'active' });

  const patternMatch = activeClients.find((client) => {
    const pattern = client.matchingRules?.notificationSenderPattern;
    return pattern && normalizedSender.includes(pattern.toLowerCase());
  });

  return patternMatch || null;
};

/**
 * Checks whether a sender matches a client that exists but is currently
 * INACTIVE — used only to tell "this is a known client who's just been
 * paused/offboarded" apart from "this sender is completely unknown" when
 * matchClientBySender() (active clients only) comes back empty, so the
 * review-queue reason can reflect which situation it actually is.
 * Not ambiguity-aware like matchClientBySender — any single inactive match
 * is enough to answer the yes/no question this exists for.
 */
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
