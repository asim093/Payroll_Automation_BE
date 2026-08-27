/**
 * Compliance Report Generator — Phase 1 seed script.
 * Populates ColumnMapping and ComplianceStatus with the reference data
 * copied from the Excel "Payroll File Columns Mapping" and "Settings"
 * sheets. Idempotent - uses findOneAndUpdate(..., {upsert:true}) per entry
 * (same pattern as OAuthCredential's login-upsert elsewhere in this
 * codebase), so running this multiple times never creates duplicates and
 * self-heals if a single entry was ever only partially seeded.
 *
 * Run with: node scripts/seedColumnMappingAndStatuses.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const ColumnMapping = require('../models/ColumnMapping');
const ComplianceStatus = require('../models/ComplianceStatus');

const COLUMN_MAPPINGS = [
  { destinationField: 'StartDate', alternativeNames: ['HireDate', 'Employee Hire Date', 'Assignment_StartDate', 'STARTDATE'] },
  { destinationField: 'EmployeeName', alternativeNames: ['Name', 'Employee Name', 'Full Name', 'EmployeeName', 'Empname', 'LASTNAME'] },
  { destinationField: 'SSN', alternativeNames: ['SSN', 'Employee SSN', 'SSN No'] },
  { destinationField: 'Email', alternativeNames: ['Email', 'Employee Email', 'Employees_Email_Address', 'Email Address'] },
];

const COMPLIANCE_STATUSES = ['New', 'DNQ', 'Qualified', 'Processed', 'Certified', 'Denial', 'Awaiting Docs'].map(
  (statusValue) => ({ statusValue, isComplete: true })
);

// Checks existence BEFORE upserting, rather than trying to infer
// created-vs-matched from the upsert's own return value - this Mongoose
// version (^9.9.2) no longer returns the old MongoDB-driver-style
// {value, lastErrorObject} wrapper from `rawResult`, so that signal isn't
// available anymore. This is slightly less efficient (one extra read per
// entry) but unambiguous regardless of driver/Mongoose-version behavior.
const upsertOne = async (Model, query, update) => {
  const existed = await Model.exists(query);
  await Model.findOneAndUpdate(query, update, { upsert: true });
  return !existed;
};

const seedColumnMappings = async () => {
  let created = 0;
  let alreadyExisted = 0;
  for (const mapping of COLUMN_MAPPINGS) {
    const wasCreated = await upsertOne(
      ColumnMapping,
      { destinationField: mapping.destinationField },
      { alternativeNames: mapping.alternativeNames }
    );
    if (wasCreated) created++;
    else alreadyExisted++;
  }
  console.log(`[SEED] ColumnMapping: ${created} created, ${alreadyExisted} already existed (left as-is/re-synced).`);
};

const seedComplianceStatuses = async () => {
  let created = 0;
  let alreadyExisted = 0;
  for (const status of COMPLIANCE_STATUSES) {
    const wasCreated = await upsertOne(
      ComplianceStatus,
      { statusValue: status.statusValue },
      { isComplete: status.isComplete }
    );
    if (wasCreated) created++;
    else alreadyExisted++;
  }
  console.log(`[SEED] ComplianceStatus: ${created} created, ${alreadyExisted} already existed (left as-is/re-synced).`);
};

const run = async () => {
  let failed = false;
  try {
    await connectDB();
    await seedColumnMappings();
    await seedComplianceStatuses();
    console.log('[SEED] Done.');
  } catch (error) {
    failed = true;
    console.error('[SEED] ERROR:', error.message);
  } finally {
    await mongoose.connection.close();
  }
  process.exit(failed ? 1 : 0);
};

if (require.main === module) {
  run();
}

module.exports = { run };
