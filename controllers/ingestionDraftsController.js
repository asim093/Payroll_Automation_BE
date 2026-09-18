const { listDraftMessages, getDraftMessageDetail } = require('../services/ingestionDraftsService');

exports.getIngestionDrafts = async (req, res, next) => {
  try {
    const drafts = await listDraftMessages();
    res.status(200).json(
      drafts.map((draft) => ({
        id: draft.id,
        subject: draft.subject || '(No subject)',
        to: (draft.toRecipients || []).map((recipient) => recipient.emailAddress?.address).filter(Boolean),
        createdAt: draft.createdDateTime,
        modifiedAt: draft.lastModifiedDateTime,
        hasAttachments: Boolean(draft.hasAttachments),
        preview: draft.bodyPreview || '',
      }))
    );
  } catch (error) {
    next(error);
  }
};

exports.getIngestionDraftDetail = async (req, res, next) => {
  try {
    const detail = await getDraftMessageDetail(req.params.id);
    res.status(200).json(detail);
  } catch (error) {
    if (error.statusCode === 404) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
};
