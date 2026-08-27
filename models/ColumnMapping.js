const mongoose = require('mongoose');

// Compliance Report Generator — Phase 1. Replicates the Excel "Payroll File
// Columns Mapping" sheet: for each field the compliance report needs to
// find in a client's payroll file, the list of alternative column-header
// names that column might actually be named. No business logic here yet -
// this is just the reference data the (future) column-matching logic will
// read from.
const columnMappingSchema = new mongoose.Schema(
  {
    destinationField: {
      type: String,
      enum: ['StartDate', 'EmployeeName', 'SSN', 'Email'],
      required: true,
      unique: true,
    },
    alternativeNames: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ColumnMapping', columnMappingSchema);
