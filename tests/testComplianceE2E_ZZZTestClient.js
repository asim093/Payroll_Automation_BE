const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const connectDB = require('../config/db');
const Client = require('../models/Client');
const ComplianceReportLog = require('../models/ComplianceReportLog');
const { uploadFileToDropbox, deleteDropboxFolder, findLatestPayrollFile } = require('../services/dropboxService');

// Monkey-patch logiFormsService BEFORE the orchestrator is required, so the
// orchestrator's own `const { fetchLogiFormsDataForClient } = require(...)`
// destructures our stub off the (already-patched) cached module.exports
// object — no production file is edited on disk.
const logiFormsService = require('../services/logiFormsService');

const CLIENT_NAME = 'ZZZ Test Client';
const FEIN = '11-1111111';

const EMPLOYEES = [
  { ssn: '000000001', name: 'E2E Employee One' },
  { ssn: '000000002', name: 'E2E Employee Two' },
  { ssn: '000000003', name: 'E2E Employee Three' },
  { ssn: '000000004', name: 'E2E Employee Four' },
  { ssn: '000000005', name: 'E2E Employee Five' },
];

// 000000001-3 get a matching LogiForms record -> complete.
// 000000004 and 000000005 intentionally have NO LogiForms record -> Incomplete.
const FAKE_LOGIFORMS_DATA = [
  { ssn: '000000001', status: 'Certified', dateSubmitted: new Date('2026-08-04') },
  { ssn: '000000002', status: 'Certified', dateSubmitted: new Date('2026-08-06') },
  { ssn: '000000003', status: 'Certified', dateSubmitted: new Date('2026-08-12') },
];

logiFormsService.fetchLogiFormsDataForClient = async (fein) => {
  console.log(`[STUB] fetchLogiFormsDataForClient called with fein="${fein}" -> returning ${FAKE_LOGIFORMS_DATA.length} fake rows (real ShareFile LogiForms CSV NOT touched).`);
  return { records: FAKE_LOGIFORMS_DATA, skippedRows: [] };
};

const { generateComplianceReportForClient } = require('../services/complianceReportOrchestratorService');

const buildPayrollFile = () => {
  const rows = [
    ['Start Date', 'Employee Name', 'SSN', 'Email'],
    ...EMPLOYEES.map((e) => ['2026-08-01', e.name, e.ssn, `${e.name.replace(/\s/g, '.').toLowerCase()}@example.com`]),
  ];
  const filePath = path.join(os.tmpdir(), `e2e-zzz-test-client-payroll-${Date.now()}.xlsx`);
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Payroll');
  XLSX.writeFile(workbook, filePath);
  return filePath;
};

const run = async () => {
  let failed = false;
  const check = (label, pass, detail) => {
    console.log(`  ${pass ? '✅' : '❌'} ${label}${detail !== undefined ? ` -> ${detail}` : ''}`);
    if (!pass) failed = true;
  };

  let client = null;
  let payrollFilePath = null;

  try {
    await connectDB();

    console.log('=== Setup: fully self-contained — create disposable client + payroll file (no external fixture/script needed) ===');
    client = await Client.create({
      name: CLIENT_NAME,
      dropboxPath: CLIENT_NAME,
      fein: FEIN,
      status: 'active',
    });
    console.log(`  created client _id=${client._id}, fein=${client.fein}, dropboxPath="${client.dropboxPath}"`);

    payrollFilePath = buildPayrollFile();
    const fileBuffer = fs.readFileSync(payrollFilePath);
    await uploadFileToDropbox(CLIENT_NAME, 'payroll.xlsx', fileBuffer, new Date());
    console.log('  uploaded payroll file with 5 employees to Dropbox');

    const latestFile = await findLatestPayrollFile(CLIENT_NAME);
    check('Payroll file findable via findLatestPayrollFile', Boolean(latestFile));

    console.log('\n--- Calling real generateComplianceReportForClient(clientId) ---\n');
    const result = await generateComplianceReportForClient(client._id);
    console.log('Orchestrator result:', JSON.stringify(result, null, 2));

    check('Generation succeeded', result?.success === true);
    check('5 employees processed', result?.totalEmployees === 5, result?.totalEmployees);
    check('3 completed (matched LogiForms), 2 incomplete (no record)', result?.completedCount === 3 && result?.incompleteCount === 2, `completed=${result?.completedCount} incomplete=${result?.incompleteCount}`);

    console.log('\n--- ComplianceReportLog documents for this client ---');
    const logs = await ComplianceReportLog.find({ clientId: client._id }).lean();
    console.log(JSON.stringify(logs, null, 2));
    check('2 ComplianceReportLog entries (Admin + Client)', logs.length === 2, logs.length);
    check('Both entries succeeded', logs.every((log) => log.success === true));

    console.log(`\n${failed ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED'}`);
  } catch (error) {
    failed = true;
    console.error('FATAL ERROR:', error.message, error.stack);
  } finally {
    console.log('\n=== Cleanup ===');
    if (payrollFilePath) {
      try {
        fs.unlinkSync(payrollFilePath);
      } catch {}
    }
    try {
      await deleteDropboxFolder(CLIENT_NAME);
      console.log(`  deleted Dropbox folder for "${CLIENT_NAME}"`);
    } catch (error) {
      console.error(`  could not delete Dropbox folder for "${CLIENT_NAME}": ${error.message}`);
    }
    if (client) {
      await ComplianceReportLog.deleteMany({ clientId: client._id });
      await Client.deleteOne({ _id: client._id });
      console.log('  deleted test client and its log entries');
    }
    await mongoose.connection.close();
  }
  process.exit(failed ? 1 : 0);
};

run();
