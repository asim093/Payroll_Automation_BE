const mongoose = require('mongoose');

const oauthCredentialSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      required: true,
      unique: true,
    },
    refreshToken: {
      type: String,
      required: true,
    },
    loggedInAs: {
      type: String,
      trim: true,
    },
    accessToken: {
      type: String,
    },
    accessTokenExpiresAt: {
      type: Date,
    },
    subdomain: {
      type: String,
    },
    refreshLockedUntil: {
      type: Date,
    },
    refreshLockHolder: {
      type: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('OAuthCredential', oauthCredentialSchema);
