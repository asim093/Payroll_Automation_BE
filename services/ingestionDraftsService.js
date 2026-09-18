const { getAccessTokenFromRefreshToken } = require('./delegatedAuthService');
const { getEmailAttachments, isInlineImageAttachment } = require('./graphService');

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

// Dev-only Ingestion "Draft" tab: lists whatever is currently sitting in the
// connected mailbox's own Drafts folder (the same mailbox drafts get created
// into by reminderDraftService/customerEmailDraftService). Always the
// delegated-auth mailbox — there's no separate "test mailbox" concept for
// drafts the way regular inbox ingestion has one, so this always reads
// "/me/..." with the delegated token, never a users/{mailbox} segment.
const listDraftMessages = async () => {
  const accessToken = await getAccessTokenFromRefreshToken();
  const url = new URL(`${GRAPH_BASE_URL}/me/mailFolders/drafts/messages`);
  url.searchParams.set('$top', '100');
  url.searchParams.set('$orderby', 'createdDateTime desc');
  url.searchParams.set(
    '$select',
    'id,subject,toRecipients,createdDateTime,lastModifiedDateTime,hasAttachments,bodyPreview'
  );

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Could not list draft messages (${response.status}): ${errorBody}`);
  }
  const data = await response.json();
  return data.value || [];
};

// Full body (not just bodyPreview, which Graph truncates to ~255 chars) plus
// attachment names — fetched on demand per draft rather than up front for
// the whole list, same "list is cheap, detail is fetched on click" pattern
// the regular email ingestion detail pane already uses.
const getDraftMessageDetail = async (messageId) => {
  const accessToken = await getAccessTokenFromRefreshToken();
  const url = `${GRAPH_BASE_URL}/me/messages/${encodeURIComponent(
    messageId
  )}?$select=id,subject,toRecipients,createdDateTime,lastModifiedDateTime,body,hasAttachments`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const errorBody = await response.text();
    if (response.status === 404) {
      const error = new Error('This draft no longer exists — it may have been sent, deleted, or moved.');
      error.statusCode = 404;
      throw error;
    }
    throw new Error(`Could not load draft message (${response.status}): ${errorBody}`);
  }
  const data = await response.json();

  let attachments = [];
  if (data.hasAttachments) {
    const graphAttachments = await getEmailAttachments(undefined, messageId, accessToken);
    attachments = (graphAttachments || [])
      .filter((attachment) => !isInlineImageAttachment(attachment))
      .map((attachment) => ({ name: attachment.name, size: attachment.size }));
  }

  return {
    id: data.id,
    subject: data.subject || '',
    to: (data.toRecipients || []).map((recipient) => recipient.emailAddress?.address).filter(Boolean),
    createdAt: data.createdDateTime,
    modifiedAt: data.lastModifiedDateTime,
    bodyContentType: data.body?.contentType || 'text',
    bodyContent: data.body?.content || '',
    hasAttachments: Boolean(data.hasAttachments),
    attachments,
  };
};

module.exports = { listDraftMessages, getDraftMessageDetail };
