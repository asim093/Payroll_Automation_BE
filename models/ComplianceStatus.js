const mongoose = require('mongoose');

// Compliance Report Generator — Phase 1. Reference data from the Excel
// "Settings" sheet's Complete-Statuses list. All seeded values are
// currently isComplete:true (every status in this initial list counts as
// "complete") - the flag exists as a field, not a hardcoded assumption, so
// a future status that should NOT count as complete can be added without a
// schema change.
const complianceStatusSchema = new mongoose.Schema(
  {
    statusValue: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    isComplete: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ComplianceStatus', complianceStatusSchema);
