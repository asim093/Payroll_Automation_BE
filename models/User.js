const mongoose = require('mongoose');

// PHASE 10 — DUMMY auth only (see controllers/authController.js's top
// comment). Deliberately has NO password field: since login/signup accept
// literally any password with no verification, storing one (even hashed)
// would be pure liability for zero benefit — there's nothing real to check
// it against. Just enough to say "this email has an account" and show a
// last-login timestamp.
const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },
    lastLoginAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
