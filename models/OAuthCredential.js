const mongoose = require('mongoose');

// PHASE-UI-13 — DB-backed storage for OAuth refresh tokens obtained via the
// web-hosted login flow (see services/microsoftOAuthSetupService.js), as an
// alternative to pasting one into .env by hand. Shared across every process
// that reads from the same MongoDB (the web service AND both cron jobs),
// unlike .env - which is per-Render-service and needs updating separately
// everywhere - so re-authorizing once here fixes every process at once.
//
// Deliberately its OWN collection, never returned by any public API route -
// GET /api/settings (a different, freely-fetched document) must never end
// up serializing a real refresh token to the browser.
const oauthCredentialSchema = new mongoose.Schema(
  {
    // e.g. 'microsoft-delegated' - one document per provider/flow.
    provider: {
      type: String,
      required: true,
      unique: true,
    },
    refreshToken: {
      type: String,
      required: true,
    },
    // Purely informational (shown nowhere sensitive) - which mailbox this
    // token actually belongs to, so a future admin can tell at a glance
    // whether the right account is connected without decoding the token.
    loggedInAs: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('OAuthCredential', oauthCredentialSchema);
