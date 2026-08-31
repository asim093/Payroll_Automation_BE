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


const resolveAccessToken = async (accessToken) => accessToken || getAccessToken();


const mailboxSegment = (mailboxEmail) =>
  mailboxEmail ? `users/${encodeURIComponent(mailboxEmail)}` : 'me';


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
    url.searchParams.set(
      '$select',
      'id,subject,from,sender,receivedDateTime,hasAttachments,bodyPreview'
    );

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


const getMessageBody = async (mailboxEmail, messageId, accessToken) => {
  try {
    const token = await resolveAccessToken(accessToken);

    const url = `${GRAPH_BASE_URL}/${mailboxSegment(mailboxEmail)}/messages/${encodeURIComponent(
      messageId
    )}?$select=subject,from,receivedDateTime,body,hasAttachments`;

    const response = await fetchWithRetry(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`getMessageBody ERROR: status ${response.status} - ${errorBody}`);
      throw new Error(`Graph API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    return {
      subject: data.subject,
      from: data.from?.emailAddress?.address || null,
      receivedDateTime: data.receivedDateTime,
      bodyContentType: data.body?.contentType || 'text',
      bodyContent: data.body?.content || '',
      hasAttachments: Boolean(data.hasAttachments),
    };
  } catch (error) {
    console.error(`getMessageBody ERROR: ${error.message}`);
    throw error;
  }
};


const assignCategory = async (mailboxEmail, messageId, categoryName, accessToken) => {
  try {
    const token = await resolveAccessToken(accessToken);

    const messageUrl = `${GRAPH_BASE_URL}/${mailboxSegment(mailboxEmail)}/messages/${encodeURIComponent(
      messageId
    )}`;

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

    const mergedCategories = existingCategories.includes(categoryName)
      ? existingCategories
      : [...existingCategories, categoryName];

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


const findOrCreateOutlookFolder = async (folderPath, accessToken, mailboxEmail) => {
  try {
    const token = await resolveAccessToken(accessToken);
    const segment = mailboxSegment(mailboxEmail);
    const pathSegments = folderPath
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean);

    let parentId = null; 

    for (const folderName of pathSegments) {
      const escapedName = folderName.replace(/'/g, "''");
      const listBase = parentId
        ? `${GRAPH_BASE_URL}/${segment}/mailFolders/${parentId}/childFolders`
        : `${GRAPH_BASE_URL}/${segment}/mailFolders`;
      const listUrl = `${listBase}?$filter=${encodeURIComponent(`displayName eq '${escapedName}'`)}`;

      const listResponse = await fetchWithRetry(listUrl, {
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

      const createResponse = await fetchWithRetry(listBase, {
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
      console.log(`  [OUTLOOK] Created mail folder "${folderName}" (part of "${folderPath}").`);
    }

    return parentId;
  } catch (error) {
    console.error(`findOrCreateOutlookFolder ERROR: ${error.message}`);
    throw error;
  }
};

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


const copyEmailToFolder = async (messageId, folderId, accessToken, mailboxEmail) => {
  try {
    const token = await resolveAccessToken(accessToken);
    const segment = mailboxSegment(mailboxEmail);

    const url = `${GRAPH_BASE_URL}/${segment}/messages/${encodeURIComponent(messageId)}/copy`;
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationId: folderId }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`copyEmailToFolder ERROR: status ${response.status} - ${errorBody}`);
      throw new Error(`Graph API error ${response.status}: ${errorBody}`);
    }

    return response.json();
  } catch (error) {
    console.error(`copyEmailToFolder ERROR: ${error.message}`);
    throw error;
  }
};


const deleteMailFolder = async (folderId, accessToken, mailboxEmail) => {
  try {
    const token = await resolveAccessToken(accessToken);
    const segment = mailboxSegment(mailboxEmail);
    const url = `${GRAPH_BASE_URL}/${segment}/mailFolders/${folderId}`;

    const response = await fetchWithRetry(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok && response.status !== 404) {
      const errorBody = await response.text();
      throw new Error(`delete mail folder failed (${response.status}): ${errorBody}`);
    }
    console.log(`  [OUTLOOK] Deleted mail folder (id ${folderId}).`);
  } catch (error) {
    console.error(`deleteMailFolder ERROR: ${error.message}`);
    throw error;
  }
};

module.exports = {
  getAccessToken,
  getRecentEmails,
  getEmailAttachments,
  getMessageBody,
  assignCategory,
  ensureCategoryExists,
  findOrCreateOutlookFolder,
  deleteMailFolder,
  copyEmailToFolder,
  moveEmailToFolder,
};
