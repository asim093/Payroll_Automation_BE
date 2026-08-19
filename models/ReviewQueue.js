const mongoose = require('mongoose');

const reviewQueueSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['email', 'file'],
      required: true,
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    reason: {
      type: String,
      enum: ['unknown_sender', 'no_match', 'ambiguous', 'client_inactive', 'new_sender_domain_match'],
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    resolvedBy: {
      type: String,
      trim: true,
    },
    resolvedClientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
    },
    // Best-guess client for this entry, set at creation time when the
    // matcher has a reasonable hint (see clientMatcher.js's
    // matchClientByDomainPendingReview() and matchInactiveClientBySender())
    // — e.g. "this sender's domain matches Acme Corp, but this exact
    // address hasn't been confirmed before". Purely a UI convenience (a
    // one-click "Approve" instead of picking from the client dropdown);
    // resolving still always goes through the normal resolve endpoint.
    suggestedClientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReviewQueue', reviewQueueSchema);
