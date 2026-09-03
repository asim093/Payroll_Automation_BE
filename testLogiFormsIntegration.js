require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { parseLogiFormsCsv } = require('./services/logiFormsService');
const { calculateComplianceStatus, summarizeByWeek } = require('./services/complianceCalculationService');

const CSV_CONTENT = [
  'DateSubmitted,EIN,SSN,Status,Notes',
  '2024-01-05,12-3456789,111-11-1111,New,ignored column',
  '2024-01-06,12-3456789,111-11-1112,DNQ,',
  '2024-01-07,12-3456789,111-11-1113,Qualified,',
  '2024-01-08,12-3456789,111-11-1114,,missing status - should be dropped',
  ',12-3456789,111-11-1116,New,missing date - should be dropped',
  '2024-01-08,12-3456789,,New,missing ssn - should be dropped',
  '2024-01-09,12-3456789,111-11-1115,Processed,',
  '2024-01-10,98-7654321,222-22-2221,Certified,different EIN - should be excluded',
].join('\n');

const run = async () => {
  let failed = false;
  const check = (label, pass) => {
    console.log(`  ${pass ? '✅' : '❌'} ${label}`);
    if (!pass) failed = true;
  };

  let tempDir;
  try {
    await connectDB();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logiforms-test-'));
    const csvPath = path.join(tempDir, 'logiforms-test.csv');
    fs.writeFileSync(csvPath, CSV_CONTENT);

    console.log('=== TEST 1: parseLogiFormsCsv filters by FEIN, drops incomplete rows, strips SSN dashes, sorts desc ===');
    const dashlessRecords = parseLogiFormsCsv(csvPath, '123456789');
    const dashedRecords = parseLogiFormsCsv(csvPath, '12-3456789');
    console.log('Records for FEIN 12-3456789:', JSON.stringify(dashlessRecords, null, 2));

    check('Returned exactly 4 records (5 valid rows minus 3 dropped for missing fields, 1 excluded by EIN)', dashlessRecords.length === 4);
    check('All returned records belong to the requested FEIN', dashlessRecords.every((record) => record.ein === '123456789'));
    check('Dashless and dashed FEIN input return the same records', dashlessRecords.length === dashedRecords.length);
    check('SSN dashes stripped', dashlessRecords.every((record) => !record.ssn.includes('-')));
    check('Sorted by DateSubmitted descending (newest first)', dashlessRecords[0].ssn === '111111115' && dashlessRecords[3].ssn === '111111111');

    console.log('\n=== TEST 2: end-to-end - Phase 2 shape -> Phase 3 calculation -> Phase 4 LogiForms ===');
    const monday = new Date(Date.UTC(2024, 0, 8));
    const payrollRecords = [
      { startDate: monday, employeeName: 'Employee One', ssn: '111-11-1111', email: 'one@example.com' },
      { startDate: monday, employeeName: 'Employee Two', ssn: '111111112', email: 'two@example.com' },
      { startDate: monday, employeeName: 'Employee Three', ssn: '111-11-1113', email: 'three@example.com' },
      { startDate: monday, employeeName: 'Employee Five', ssn: '111-11-1115', email: 'five@example.com' },
      { startDate: monday, employeeName: 'Employee Six', ssn: '999999999', email: 'six@example.com' },
    ];

    const results = await calculateComplianceStatus(payrollRecords, dashlessRecords);
    console.log('End-to-end results:', JSON.stringify(results, null, 2));

    check('Employee One (New) -> isComplete true', results[0].status === 'New' && results[0].isComplete === true);
    check('Employee Two (DNQ) -> isComplete true', results[1].status === 'DNQ' && results[1].isComplete === true);
    check('Employee Three (Qualified) -> isComplete true', results[2].status === 'Qualified' && results[2].isComplete === true);
    check('Employee Five (Processed) -> isComplete true', results[3].status === 'Processed' && results[3].isComplete === true);
    check('Employee Six (no LogiForms record at all) -> status "Incomplete", isComplete false', results[4].status === 'Incomplete' && results[4].isComplete === false);

    const summary = summarizeByWeek(results);
    console.log('\nWeek summary:', JSON.stringify(summary, null, 2));
    check('1 week bucket', summary.length === 1);
    check('Total = 5', summary[0]?.total === 5);
    check('Completed = 4', summary[0]?.completed === 4);
    check('Incomplete = 1', summary[0]?.incomplete === 1);

    console.log(`\n${failed ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED'}`);
  } catch (error) {
    failed = true;
    console.error('TEST SCRIPT ERROR:', error.message);
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    await mongoose.connection.close();
  }
  process.exit(failed ? 1 : 0);
};

run();
