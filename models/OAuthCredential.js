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
  },
  { timestamps: true }
);

module.exports = mongoose.model('OAuthCredential', oauthCredentialSchema);
