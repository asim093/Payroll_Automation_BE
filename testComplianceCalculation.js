/**
 * Compliance Report Generator — Phase 3 unit-test script for
 * services/complianceCalculationService.js. Uses the REAL, Phase-1-seeded
 * ComplianceStatus collection (not a mock) so this also validates the
 * actual DB integration, not just in-memory logic.
 *
 * Requires ComplianceStatus to already be seeded
 * (scripts/seedColumnMappingAndStatuses.js).
 *
 * Run with: node testComplianceCalculation.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { calculateComplianceStatus, summarizeByWeek, getWeekEndingSunday } = require('./services/complianceCalculationService');

const run = async () => {
  let failed = false;
  const check = (label, pass) => {
    console.log(`  ${pass ? '✅' : '❌'} ${label}`);
    if (!pass) failed = true;
  };

  try {
    await connectDB();

    // ============================================================
    // TEST 1 - W/E Period calculation, specific dates
    // ============================================================
    console.log('=== TEST 1: week-ending (next-Sunday) calculation ===');
    // UTC-anchored on purpose (Date.UTC, not the local-time Date(y,m,d)
    // constructor) - matches how real payroll dates actually arrive via
    // Phase 2's xlsx parsing (cellDates:true) and ISO date-strings, so
    // this test reflects real usage instead of this machine's local
    // timezone.
    const monday = new Date(Date.UTC(2024, 0, 8)); // Mon Jan 8 2024
    const sunday = new Date(Date.UTC(2024, 0, 14)); // Sun Jan 14 2024
    const saturday = new Date(Date.UTC(2024, 0, 13)); // Sat Jan 13 2024
    const tuesday = new Date(Date.UTC(2024, 0, 9)); // Tue Jan 9 2024
    const expectedWeekEnding = '2024-01-14';

    check('Monday -> following Sunday (Jan 8 -> Jan 14)', getWeekEndingSunday(monday)?.toISOString().slice(0, 10) === expectedWeekEnding);
    check('Sunday -> itself (Jan 14 -> Jan 14)', getWeekEndingSunday(sunday)?.toISOString().slice(0, 10) === expectedWeekEnding);
    check('Saturday -> next day (Jan 13 -> Jan 14)', getWeekEndingSunday(saturday)?.toISOString().slice(0, 10) === expectedWeekEnding);
    check('Tuesday -> that week\'s Sunday (Jan 9 -> Jan 14)', getWeekEndingSunday(tuesday)?.toISOString().slice(0, 10) === expectedWeekEnding);
    check('Invalid/null date -> null (no throw)', getWeekEndingSunday(null) === null);

    // ============================================================
    // TEST 2 - Complete vs Incomplete classification
    // ============================================================
    console.log('\n=== TEST 2: complete vs incomplete classification ===');
    // Deliberately spans 4 scenarios: matched+known-complete-status (x2),
    // no LogiForms record at all, and matched-but-UNRECOGNIZED status
    // (not in the ComplianceStatus collection) - all 4 land on the same
    // week-ending date on purpose, to make TEST 3's summary meaningful.
    const payrollRecords = [
      { startDate: monday, employeeName: 'Jane Doe', ssn: '111-11-1111', email: 'jane@example.com' },
      { startDate: sunday, employeeName: 'John Smith', ssn: '222222222', email: 'john@example.com' },
      { startDate: saturday, employeeName: 'No Match Person', ssn: '333333333', email: 'nomatch@example.com' },
      { startDate: tuesday, employeeName: 'Unknown Status Person', ssn: '444444444', email: 'unknown@example.com' },
    ];
    const logiFormsData = [
      { ssn: '111111111', status: 'Certified' }, // known-complete (Phase-1 seed)
      { ssn: '222222222', status: 'New' }, // known-complete (Phase-1 seed)
      // 333333333 intentionally has no LogiForms record -> Incomplete
      { ssn: '444444444', status: 'SomeStatusNotInOurList' }, // matched but unrecognized
    ];

    const results = await calculateComplianceStatus(payrollRecords, logiFormsData);
    console.log('Results:', JSON.stringify(results, null, 2));

    check('Jane Doe (SSN match, "Certified") -> isComplete true', results[0]?.status === 'Certified' && results[0]?.isComplete === true);
    check('John Smith (SSN match, "New") -> isComplete true', results[1]?.status === 'New' && results[1]?.isComplete === true);
    check('No Match Person (no LogiForms record) -> status "Incomplete", isComplete false', results[2]?.status === 'Incomplete' && results[2]?.isComplete === false);
    check('Unknown Status Person (matched, unrecognized status) -> status preserved, isComplete false', results[3]?.status === 'SomeStatusNotInOurList' && results[3]?.isComplete === false);
    // Jane Doe's payroll SSN is dashed ('111-11-1111') but LogiForms's
    // record for her is dashless ('111111111') - this only passes if the
    // matching step normalizes both sides before comparing. Note: Phase 3
    // does NOT rewrite the record's own `ssn` field to match - that
    // formatting is Phase 2's job (payrollFileParserService.js already
    // strips dashes at parse time); here it's deliberately still dashed to
    // prove the match itself is dash-insensitive regardless of formatting.
    check('SSN matching is dash-insensitive (dashed payroll SSN matched a dashless LogiForms SSN)', results[0]?.isComplete === true);

    // ============================================================
    // TEST 3 - Week-wise summary + percentage
    // ============================================================
    console.log('\n=== TEST 3: summarizeByWeek ===');
    const summary = summarizeByWeek(results);
    console.log('Summary:', JSON.stringify(summary, null, 2));

    check('Exactly 1 week bucket (all 4 records land on the same week-ending)', summary.length === 1);
    check('Total = 4', summary[0]?.total === 4);
    check('Completed = 2', summary[0]?.completed === 2);
    check('Incomplete = 2', summary[0]?.incomplete === 2);
    check('Percentage = 50', summary[0]?.completedPercentage === 50);

    console.log(`\n${failed ? '❌ SOME CHECKS FAILED' : '✅ ALL CHECKS PASSED'}`);
  } catch (error) {
    failed = true;
    console.error('TEST SCRIPT ERROR:', error.message);
  } finally {
    await mongoose.connection.close();
  }
  process.exit(failed ? 1 : 0);
};

run();
