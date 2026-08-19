const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    matchingRules: {
      emailAddresses: {
        type: [String],
        default: [],
      },
      domains: {
        type: [String],
        default: [],
      },
      // Sender-domain (or address) pattern used to recognize this client's
      // ShareFile "new item" notification emails, e.g. "logiforms.com".
      notificationSenderPattern: {
        type: String,
        trim: true,
      },
    },
    // Not read by the processing pipeline currently — emails stay in their
    // original Outlook location (Inbox) per requirements, only file-copies
    // move to destination. Kept (optional, no validation depends on it) for
    // future-proofing and so existing data isn't lost.
    outlookFolderPath: {
      type: String,
      trim: true,
    },
    // PHASE 11 — the Graph mail-folder Id of this client's dedicated
    // Outlook folder (the one Phase 3's clientFolderSetupService.js
    // auto-creates at Settings' outlookRootPath + this client's name).
    // Cached here at create/edit time specifically so
    // emailProcessor.js's per-email copy-to-folder step (see
    // completeFileProcessing()) never has to re-walk the folder path via
    // Graph on every single email — it just reads this field. Left unset
    // if the delegated flow wasn't configured, or if the Outlook step
    // failed at setup time (see folderSetupWarnings) — the copy step
    // skips gracefully when this is empty rather than failing.
    outlookFolderId: {
      type: String,
      trim: true,
    },
    // Client's own full relative path under Settings' shareFileRootPath (see
    // utils/folderPath.js's joinFolderPath()), typed entirely manually via
    // AddClientModal — e.g. "Acme Corp/Payroll Files", not just a single
    // segment swapped into a fixed template. Defaults to the client's name
    // if left blank; sharefileService.js falls back to client.name in that
    // case.
    shareFilePath: {
      type: String,
      trim: true,
    },
    // Client's own full relative path under Settings' dropboxRootPath (see
    // utils/folderPath.js's joinFolderPath()), typed entirely manually via
    // AddClientModal — e.g. "Acme Corp/Payroll Files", not just a single
    // segment swapped into a fixed template. Defaults to the client's name
    // if left blank; dropboxService.js falls back to client.name in that
    // case.
    dropboxPath: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
    // Set by services/clientFolderSetupService.js right after a client is
    // created (or edited with a changed path) — one entry per destination
    // (Dropbox/ShareFile/Outlook) whose folder could not be
    // checked/auto-created (permission issue, API limitation, etc.). Never
    // blocks the client save itself; just surfaced as a warning badge on the
    // Clients page so it can be resolved manually. Reset to [] whenever the
    // setup re-runs and everything succeeds.
    folderSetupWarnings: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true }
);

// Case-insensitive uniqueness on name, enforced at the DB level (not just in
// the controller) - collation strength:2 makes MongoDB itself treat "Acme
// Corp" and "acme corp" as the same key. This is the safety-net for the
// narrow race where two create-requests for the same name both pass the
// controller's findDuplicateByName check before either has saved; the
// controller catches the resulting E11000 and turns it into the same
// friendly duplicate-name message.
clientSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

module.exports = mongoose.model('Client', clientSchema);
