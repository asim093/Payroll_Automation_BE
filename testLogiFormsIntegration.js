require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { fetchLogiFormsDataForClient } = require('./services/logiFormsService');
const { calculateComplianceStatus, summarizeByWeek } = require('./services/complianceCalculationService');

const run = async () => {
  let failed = false;
  const check = (label, pass) => {
    console.log(`  ${pass ? '✅' : '❌'} ${label}`);
    if (!pass) failed = true;
  };

  try {
    await connectDB();
    process.env.LOGIFORMS_MOCK_MODE = 'true';

    console.log('=== TEST 1: fetchLogiFormsDataForClient filters by FEIN ===');
    const feinRecordsDashless = await fetchLogiFormsDataForClient('123456789', 'https://fake.logiforms.example/api', '');
    const feinRecordsDashed = await fetchLogiFormsDataForClient('12-3456789', 'https://fake.logiforms.example/api', '');
    console.log('Records for FEIN 12-3456789:', JSON.stringify(feinRecordsDashless, null, 2));

    check('Returned exactly 5 records', feinRecordsDashless.length === 5);
    check('All returned records belong to the requested FEIN', feinRecordsDashless.every((record) => record.ein === '12-3456789'));
    check('Dashless and dashed FEIN input return the same records', feinRecordsDashless.length === feinRecordsDashed.length);

    console.log('\n=== TEST 2: end-to-end - Phase 2 shape -> Phase 3 calculation -> Phase 4 LogiForms ===');
    const monday = new Date(Date.UTC(2024, 0, 8));
    const payrollRecords = [
      { startDate: monday, employeeName: 'Employee One', ssn: '111-11-1111', email: 'one@example.com' },
      { startDate: monday, employeeName: 'Employee Two', ssn: '111111112', email: 'two@example.com' },
      { startDate: monday, employeeName: 'Employee Three', ssn: '111-11-1113', email: 'three@example.com' },
      { startDate: monday, employeeName: 'Employee Four', ssn: '111111114', email: 'four@example.com' },
      { startDate: monday, employeeName: 'Employee Five', ssn: '111-11-1115', email: 'five@example.com' },
      { startDate: monday, employeeName: 'Employee Six', ssn: '999999999', email: 'six@example.com' },
    ];

    const results = await calculateComplianceStatus(payrollRecords, feinRecordsDashless);
    console.log('End-to-end results:', JSON.stringify(results, null, 2));

    check('Employee One (New) -> isComplete true', results[0].status === 'New' && results[0].isComplete === true);
    check('Employee Two (DNQ) -> isComplete true', results[1].status === 'DNQ' && results[1].isComplete === true);
    check('Employee Three (Qualified) -> isComplete true', results[2].status === 'Qualified' && results[2].isComplete === true);
    check('Employee Four (empty LogiForms status) -> status "Incomplete", isComplete false', results[3].status === 'Incomplete' && results[3].isComplete === false);
    check('Employee Five (Processed) -> isComplete true', results[4].status === 'Processed' && results[4].isComplete === true);
    check('Employee Six (no LogiForms record at all) -> status "Incomplete", isComplete false', results[5].status === 'Incomplete' && results[5].isComplete === false);

    const summary = summarizeByWeek(results);
    console.log('\nWeek summary:', JSON.stringify(summary, null, 2));
    check('1 week bucket', summary.length === 1);
    check('Total = 6', summary[0]?.total === 6);
    check('Completed = 4', summary[0]?.completed === 4);
    check('Incomplete = 2', summary[0]?.incomplete === 2);
    check('Percentage = 66.67', summary[0]?.completedPercentage === 66.67);

    console.log(`\n${failed ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED'}`);
  } catch (error) {
    failed = true;
    console.error('TEST SCRIPT ERROR:', error.message);
  } finally {
    await mongoose.connection.close();
  }
  process.exit(failed ? 1 : 0);
};

run();
