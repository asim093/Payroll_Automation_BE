const { ConfidentialClientApplication } = require('@azure/msal-node');

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

const msalConfig = {
  auth: {
    clientId: process.env.CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
    clientSecret: process.env.CLIENT_SECRET,
  },
};

const cca = new ConfidentialClientApplication(msalConfig);

/**
 * Get an app-only access token for Microsoft Graph using the
 * client-credentials flow (same logic as test-auth.js, reusable).
 */
const getAccessToken = async () => {
  try {
    const result = await cca.acquireTokenByClientCredential({
      scopes: ['https://graph.microsoft.com/.default'],
    });
    return result.accessToken;
  } catch (error) {
    console.error(
      `getAccessToken ERROR: ${error.errorCode || 'unknown'} - ${error.message}`
    );
    throw error;
  }
};

// Every function below optionally accepts an accessToken — pass one (e.g.
// from delegatedAuthService.getAccessTokenFromRefreshToken()) to call Graph
// on behalf of a signed-in user; omit it to fall back to the app-only
// client-credentials token from getAccessToken() above. This is what lets
// the same functions serve both processInbox.js (app-only) and
// processInboxDelegated.js (delegated) without duplicating any code.
const resolveAccessToken = async (accessToken) => accessToken || getAccessToken();

// App-only calls address a mailbox as "users/{mailboxEmail}"; delegated
// calls address the signed-in user's own mailbox as "me" and don't take a
// mailbox address at all. Passing no mailboxEmail selects "me".
const mailboxSegment = (mailboxEmail) =>
  mailboxEmail ? `users/${encodeURIComponent(mailboxEmail)}` : 'me';

// Graph throttles with HTTP 429 under sustained load (plausible during a
// high-volume email batch — see runAllFlows.js's overlap-guard comment for
// the same underlying concern). Graph's 429 response includes a
// "Retry-After" header telling us exactly how long to back off, in
// seconds — this wraps a plain fetch() call, waits that long (or 5s if the
// header is missing), and retries the SAME request, up to
// MAX_RATE_LIMIT_RETRIES times. After that many failed attempts it just
// returns the last (still-429) response as-is, so the caller's existing
// `if (!response.ok) throw ...` handling takes over unchanged — a
// persistent rate-limit still surfaces as a real, visible error rather
// than retrying forever. Non-429 responses (success or any other error)
// are returned immediately on the first attempt, with zero added delay.
const MAX_RATE_LIMIT_RETRIES = 2;
const DEFAULT_RATE_LIMIT_WAIT_MS = 5000;

const fetchWithRetry = async (url, options, attempt = 0) => {
  const response = await fetch(url, options);

  if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
    const retryAfterHeader = response.headers.get('Retry-After');
    const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
    const waitMs =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : DEFAULT_RATE_LIMIT_WAIT_MS;

    console.warn(
      `  [GRAPH RATE-LIMIT] 429 for ${url} - retrying after ${waitMs / 1000}s (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})...`
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return fetchWithRetry(url, options, attempt + 1);
  }

  return response;
};

/**
 * Fetch emails received since a given timestamp from a mailbox folder.
 * GET /{users/{mailboxEmail}|me}/messages
 *     ?$top=50&$orderby=receivedDateTime desc&$filter=receivedDateTime ge {sinceTimestamp}
 * — or, when folderName is given —
 * GET /{users/{mailboxEmail}|me}/mailFolders/{folderName}/messages?...
 *
 * Deliberately does NOT filter on isRead — a message a user opened in
 * Outlook before our scan ran would permanently disappear from an
 * isRead:false filter and never get processed. Time-based delta-fetching
 * (this sinceTimestamp) is the replacement: every message received since
 * the last successful scan is considered, read or not. The messageId-based
 * duplicate check in EmailLog (see processEmail()) is what keeps this from
 * reprocessing anything already handled if the same window gets checked
 * twice (e.g. after a failed scan cycle).
 *
 * @param {string} [mailboxEmail] - omit to use "me" (the delegated user)
 * @param {string} [accessToken] - omit to use the app-only token
 * @param {string} [folderName] - omit for the default Inbox behavior
 *   (backward-compatible); pass a Graph well-known folder name to check a
 *   different folder instead, e.g. "JunkEmail" for the Junk Email folder.
 * @param {Date|string} [sinceTimestamp] - only messages received on/after
 *   this time are returned. Omit to fall back to the last 1 hour.
 */
const getRecentEmails = async (mailboxEmail, accessToken, folderName, sinceTimestamp) => {
  try {
    const token = await resolveAccessToken(accessToken);

    const base = folderName
      ? `${GRAPH_BASE_URL}/${mailboxSegment(mailboxEmail)}/mailFolders/${encodeURIComponent(folderName)}/messages`
      : `${GRAPH_BASE_URL}/${mailboxSegment(mailboxEmail)}/messages`;

    const since = sinceTimestamp ? new Date(sinceTimestamp) : new Date(Date.now() - 60 * 60 * 1000);

    const url = new URL(base);
    url.searchParams.set('$top', '50');
    url.searchParams.set('$orderby', 'receivedDateTime desc');
    url.searchParams.set('$filter', `receivedDateTime ge ${since.toISOString()}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `getRecentEmails ERROR (${folderName || 'Inbox'}): status ${response.status} - ${errorBody}`
      );
      throw new Error(`Graph API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    return data.value;
  } catch (error) {
    console.error(`getRecentEmails ERROR (${folderName || 'Inbox'}): ${error.message}`);
    throw error;
  }
};

/**
 * Fetch attachments for a specific email.
 * GET /{users/{mailboxEmail}|me}/messages/{messageId}/attachments
 *
 * @param {string} [mailboxEmail] - omit to use "me" (the delegated user)
 * @param {string} messageId
 * @param {string} [accessToken] - omit to use the app-only token
 */
const getEmailAttachments = async (mailboxEmail, messageId, accessToken) => {
  try {
    const token = await resolveAccessToken(accessToken);

    const url = `${GRAPH_BASE_URL}/${mailboxSegment(mailboxEmail)}/messages/${encodeURIComponent(
      messageId
    )}/attachments`;

    const response = await fetchWithRetry(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `getEmailAttachments ERROR: status ${response.status} - ${errorBody}`
      );
      throw new Error(`Graph API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    return data.value;
  } catch (error) {
    console.error(`getEmailAttachments ERROR: ${error.message}`);
    throw error;
  }
};

/**
 * Assign a category to an email, preserving any categories already on it.
 * 1. GET the message with $select=categories to read its current categories.
 * 2. Add categoryName to that array if it isn't already present.
 * 3. PATCH the message with the merged array.
 *
 * @param {string} [mailboxEmail] - omit to use "me" (the delegated user)
 * @param {string} messageId
 * @param {string} categoryName
 * @param {string} [accessToken] - omit to use the app-only token
 */
const assignCategory = async (mailboxEmail, messageId, categoryName, accessToken) => {
  try {
    const token = await resolveAccessToken(accessToken);

    const messageUrl = `${GRAPH_BASE_URL}/${mailboxSegment(mailboxEmail)}/messages/${encodeURIComponent(
      messageId
    )}`;

    // 1. Fetch current categories
    const getResponse = await fetchWithRetry(`${messageUrl}?$select=categories`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!getResponse.ok) {
      const errorBody = await getResponse.text();
      console.error(
        `assignCategory ERROR (fetch categories): status ${getResponse.status} - ${errorBody}`
      );
      throw new Error(`Graph API error ${getResponse.status}: ${errorBody}`);
    }

    const messageData = await getResponse.json();
    const existingCategories = messageData.categories || [];

    // 2. Merge in the new category, avoiding duplicates
    const mergedCategories = existingCategories.includes(categoryName)
      ? existingCategories
      : [...existingCategories, categoryName];

    // 3. PATCH the message with the full merged array
    const patchResponse = await fetchWithRetry(messageUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ categories: mergedCategories }),
    });

    if (!patchResponse.ok) {
      const errorBody = await patchResponse.text();
      console.error(
        `assignCategory ERROR (patch categories): status ${patchResponse.status} - ${errorBody}`
      );
      throw new Error(`Graph API error ${patchResponse.status}: ${errorBody}`);
    }

    const data = await patchResponse.json();
    return data;
  } catch (error) {
    console.error(`assignCategory ERROR: ${error.message}`);
    throw error;
  }
};

/**
 * Ensures a category exists in the mailbox's master category list, WITH a
 * color, before it's ever assigned to a message. Outlook's category colors
 * live on the mailbox-level master list (outlook/masterCategories), not on
 * the message — assigning a category name to a message that isn't in that
 * list yet just creates a colorless entry. Never overwrites an existing
 * category's color (e.g. if Marcel already made a "Processed" category in
 * some other color by hand) — does nothing if the name already exists.
 *
 * @param {string} categoryName
 * @param {string} color - a Graph preset color id, e.g. "preset1". Presets
 *   run preset0-preset24: 0 Red, 1 Orange, 2 Brown, 3 Yellow, 4 Green,
 *   5 Teal, 6 Olive, 7 Blue, 8 Purple, 9 Cranberry, 10 Steel, 11 DarkSteel,
 *   12 Gray, 13 DarkGray, 14 Black, 15-24 Dark* repeats of 0-9.
 *   Source: https://learn.microsoft.com/en-us/graph/api/resources/outlookcategory
 * @param {string} [accessToken] - omit to use the app-only token
 * @param {string} [mailboxEmail] - omit to use "me" (the delegated user)
 */
const ensureCategoryExists = async (categoryName, color, accessToken, mailboxEmail) => {
  try {
    const token = await resolveAccessToken(accessToken);
    const segment = mailboxSegment(mailboxEmail);
    const baseUrl = `${GRAPH_BASE_URL}/${segment}/outlook/masterCategories`;

    const listResponse = await fetchWithRetry(baseUrl, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!listResponse.ok) {
      const errorBody = await listResponse.text();
      throw new Error(`Could not list master categories (${listResponse.status}): ${errorBody}`);
    }
    const listData = await listResponse.json();
    const existing = (listData.value || []).find(
      (category) => category.displayName.toLowerCase() === categoryName.toLowerCase()
    );

    if (existing) {
      console.log(
        `  [CATEGORY SETUP] "${categoryName}" already exists (color: ${existing.color}) - leaving it as-is.`
      );
      return existing;
    }

    const createResponse = await fetchWithRetry(baseUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: categoryName, color }),
    });
    if (!createResponse.ok) {
      const errorBody = await createResponse.text();
      throw new Error(`Could not create category "${categoryName}" (${createResponse.status}): ${errorBody}`);
    }
    const created = await createResponse.json();
    console.log(`  [CATEGORY SETUP] Created "${categoryName}" category with color ${color}.`);
    return created;
  } catch (error) {
    console.error(`ensureCategoryExists ERROR: ${error.message}`);
    throw error;
  }
};

/**
 * NOT CURRENTLY USED - boss confirmed emails should stay in original
 * location (Inbox), only file-copies move to destination (Dropbox/local).
 * Kept here in case requirements change.
 *
 * Find (or create) a nested mail folder by path, e.g. "Clients/Test Client
 * One" — walks the path one segment at a time, creating any segment that
 * doesn't already exist as a child of the previous one, and returns the
 * final (innermost) folder's id.
 *
 * @param {string} folderPath - e.g. "Clients/Test Client One"
 * @param {string} [accessToken] - omit to use the app-only token
 * @param {string} [mailboxEmail] - omit to use "me" (the delegated user)
 */
const findOrCreateOutlookFolder = async (folderPath, accessToken, mailboxEmail) => {
  try {
    const token = await resolveAccessToken(accessToken);
    const segment = mailboxSegment(mailboxEmail);
    const pathSegments = folderPath
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean);

    let parentId = null; // null = root level (mailFolders directly, no parent)

    for (const folderName of pathSegments) {
      // OData string literals escape a single quote by doubling it.
      const escapedName = folderName.replace(/'/g, "''");
      const listBase = parentId
        ? `${GRAPH_BASE_URL}/${segment}/mailFolders/${parentId}/childFolders`
        : `${GRAPH_BASE_URL}/${segment}/mailFolders`;
      const listUrl = `${listBase}?$filter=${encodeURIComponent(`displayName eq '${escapedName}'`)}`;

      const listResponse = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!listResponse.ok) {
        const errorBody = await listResponse.text();
        throw new Error(`list "${folderName}" failed (${listResponse.status}): ${errorBody}`);
      }
      const listData = await listResponse.json();

      if (listData.value && listData.value.length > 0) {
        parentId = listData.value[0].id;
        continue;
      }

      // Not found under this parent — create it.
      const createResponse = await fetch(listBase, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: folderName }),
      });
      if (!createResponse.ok) {
        const errorBody = await createResponse.text();
        throw new Error(`create "${folderName}" failed (${createResponse.status}): ${errorBody}`);
      }
      const created = await createResponse.json();
      parentId = created.id;
    }

    return parentId;
  } catch (error) {
    console.error(`findOrCreateOutlookFolder ERROR: ${error.message}`);
    throw error;
  }
};

/**
 * NOT CURRENTLY USED - boss confirmed emails should stay in original
 * location (Inbox), only file-copies move to destination (Dropbox/local).
 * Kept here in case requirements change.
 *
 * Move an email into a different mail folder.
 * POST /{users/{mailboxEmail}|me}/messages/{messageId}/move  { destinationId }
 *
 * Note: Graph gives the moved message a NEW id in the destination folder —
 * the original messageId stops being addressable once this call succeeds.
 * Call this AFTER anything else that still needs the original id (e.g.
 * assignCategory), never before.
 *
 * @param {string} messageId
 * @param {string} folderId - from findOrCreateOutlookFolder()
 * @param {string} [accessToken] - omit to use the app-only token
 * @param {string} [mailboxEmail] - omit to use "me" (the delegated user)
 */
const moveEmailToFolder = async (messageId, folderId, accessToken, mailboxEmail) => {
  try {
    const token = await resolveAccessToken(accessToken);
    const segment = mailboxSegment(mailboxEmail);

    const url = `${GRAPH_BASE_URL}/${segment}/messages/${encodeURIComponent(messageId)}/move`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationId: folderId }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`moveEmailToFolder ERROR: status ${response.status} - ${errorBody}`);
      throw new Error(`Graph API error ${response.status}: ${errorBody}`);
    }

    return response.json();
  } catch (error) {
    console.error(`moveEmailToFolder ERROR: ${error.message}`);
    throw error;
  }
};

module.exports = {
  getAccessToken,
  getRecentEmails,
  getEmailAttachments,
  assignCategory,
  ensureCategoryExists,
  findOrCreateOutlookFolder,
  moveEmailToFolder,
};
