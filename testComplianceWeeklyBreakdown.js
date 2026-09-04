require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Client = require('./models/Client');
const ComplianceReportLog = require('./models/ComplianceReportLog');
const { calculateComplianceStatus, summarizeByWeek } = require('./services/complianceCalculationService');

let PASS = 0;
let FAIL = 0;
const check = (label, pass, detail) => {
  if (pass) {
    PASS += 1;
    console.log(`  PASS  ${label}`);
  } else {
    FAIL += 1;
    console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ''}`);
  }
};

const run = async () => {
  await connectDB();
  const client = await Client.create({ name: 'ZZ Weekly Breakdown Test Client', status: 'active' });

  try {
    console.log('=== TEST 1: model - default:undefined, valid shape, required subfields ===');
    const noBreakdown = new ComplianceReportLog({ clientId: client._id, reportType: 'Admin', success: true });
    check('doc with no weeklyBreakdown -> value is undefined', noBreakdown.weeklyBreakdown === undefined);
    check('doc with no weeklyBreakdown -> absent from toObject()', !('weeklyBreakdown' in noBreakdown.toObject()));

    const withBreakdown = new ComplianceReportLog({
      clientId: client._id,
      reportType: 'Admin',
      success: true,
      weeklyBreakdown: [{ weekEndingDate: new Date('2026-08-09T00:00:00Z'), total: 4, completed: 1, incomplete: 3, completedPercentage: 25 }],
    });
    check('doc with a valid weeklyBreakdown entry validates', !withBreakdown.validateSync());

    const missingRequired = new ComplianceReportLog({
      clientId: client._id,
      reportType: 'Admin',
      success: true,
      weeklyBreakdown: [{ weekEndingDate: new Date() }],
    });
    check('a weeklyBreakdown entry missing required fields (total/completed/incomplete/completedPercentage) fails validation', Boolean(missingRequired.validateSync()));

    const nullWeekEndingDate = new ComplianceReportLog({
      clientId: client._id,
      reportType: 'Admin',
      success: true,
      weeklyBreakdown: [{ weekEndingDate: null, total: 1, completed: 0, incomplete: 1, completedPercentage: 0 }],
    });
    check('weekEndingDate is NOT required (the "unknown date" bucket from summarizeByWeek)', !nullWeekEndingDate.validateSync());

    console.log('\n=== TEST 2: orchestrator wiring shape - real calc pipeline -> Admin gets it, Client does not ===');
    const payroll = [
      { ssn: '900-00-0001', employeeName: 'A', email: 'a@zz-test.local', startDate: new Date('2026-08-06T00:00:00Z') },
      { ssn: '900-00-0002', employeeName: 'B', email: 'b@zz-test.local', startDate: new Date('2026-08-13T00:00:00Z') },
    ];
    const calculatedRecords = await calculateComplianceStatus(payroll, []);
    const weeklyStats = summarizeByWeek(calculatedRecords);
    check('summarizeByWeek produced 2 week buckets for 2 different weeks', weeklyStats.length === 2, `got ${weeklyStats.length}`);

    const adminLog = await ComplianceReportLog.create({
      clientId: client._id,
      generatedAt: new Date(),
      reportType: 'Admin',
      totalEmployees: calculatedRecords.length,
      completedCount: calculatedRecords.filter((r) => r.isComplete).length,
      incompleteCount: calculatedRecords.filter((r) => !r.isComplete).length,
      emailStatus: 'Skipped-No-Email',
      success: true,
      weeklyBreakdown: weeklyStats,
    });
    const clientLog = await ComplianceReportLog.create({
      clientId: client._id,
      generatedAt: new Date(),
      reportType: 'Client',
      totalEmployees: calculatedRecords.length,
      completedCount: calculatedRecords.filter((r) => r.isComplete).length,
      incompleteCount: calculatedRecords.filter((r) => !r.isComplete).length,
      emailStatus: 'Skipped-No-Email',
      success: true,
    });

    console.log('\n=== TEST 3: API-shape read-back (mirrors getClientProfile\'s plain .find().lean()) ===');
    const found = await ComplianceReportLog.find({ clientId: client._id }).sort({ generatedAt: -1 }).lean();
    const adminBack = found.find((l) => String(l._id) === String(adminLog._id));
    const clientBack = found.find((l) => String(l._id) === String(clientLog._id));
    check('Admin row: weeklyBreakdown present and matches summarizeByWeek output', 'weeklyBreakdown' in adminBack && JSON.stringify(adminBack.weeklyBreakdown.map((w) => ({ ...w, weekEndingDate: w.weekEndingDate?.toISOString() }))) === JSON.stringify(weeklyStats.map((w) => ({ ...w, weekEndingDate: w.weekEndingDate?.toISOString() }))));
    check('Client row: weeklyBreakdown absent', !('weeklyBreakdown' in clientBack));

    console.log(`\n${FAIL ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED'} (${PASS} passed, ${FAIL} failed)`);
  } finally {
    const deleted = await ComplianceReportLog.deleteMany({ clientId: client._id });
    await Client.deleteOne({ _id: client._id });
    console.log(`cleanup: ${deleted.deletedCount} ComplianceReportLog rows + test client removed`);
    await mongoose.disconnect();
  }
  process.exit(FAIL ? 1 : 0);
};

run().catch((error) => {
  console.error('TEST SCRIPT ERROR:', error);
  process.exit(1);
});
