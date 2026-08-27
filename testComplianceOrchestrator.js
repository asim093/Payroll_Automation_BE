require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const connectDB = require('./config/db');
const Client = require('./models/Client');
const ComplianceReportLog = require('./models/ComplianceReportLog');
const { uploadFileToDropbox, deleteDropboxFolder, findLatestPayrollFile } = require('./services/dropboxService');
const { generateComplianceReportsForMultipleClients } = require('./services/complianceReportOrchestratorService');

const TEST_CLIENTS = [
  {
    name: 'ZZZ Test Compliance Client One',
    fein: '12-3456789',
    employees: [
      { ssn: '111-11-1111', name: 'Jane Doe', startDate: '2024-01-08' },
      { ssn: '111-11-1112', name: 'John Smith', startDate: '2024-01-08' },
      { ssn: '111-11-1113', name: 'Alice Jones', startDate: '2024-01-08' },
      { ssn: '111-11-1114', name: 'Bob Brown', startDate: '2024-01-08' },
      { ssn: '111-11-1115', name: 'Carol White', startDate: '2024-01-08' },
    ],
  },
  {
    name: 'ZZZ Test Compliance Client Two',
    fein: '98-7654321',
    employees: [
      { ssn: '222-22-2221', name: 'Dave Green', startDate: '2024-01-08' },
      { ssn: '222-22-2222', name: 'Eve Black', startDate: '2024-01-08' },
      { ssn: '222-22-2223', name: 'Frank Gray', startDate: '2024-01-08' },
      { ssn: '222-22-2224', name: 'Grace Blue', startDate: '2024-01-08' },
      { ssn: '222-22-2225', name: 'Henry Red', startDate: '2024-01-08' },
    ],
  },
];

const buildDummyPayrollFile = (employees) => {
  const rows = [
    ['HireDate', 'Employee Name', 'SSN', 'Email'],
    ...employees.map((employee) => [employee.startDate, employee.name, employee.ssn, `${employee.name.replace(/\s/g, '.').toLowerCase()}@example.com`]),
  ];
  const filePath = path.join(os.tmpdir(), `orchestrator-test-payroll-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Payroll');
  XLSX.writeFile(workbook, filePath);
  return filePath;
};

const run = async () => {
  let failed = false;
  const check = (label, pass) => {
    console.log(`  ${pass ? '✅' : '❌'} ${label}`);
    if (!pass) failed = true;
  };

  const createdClientIds = [];
  const tempPayrollFiles = [];

  try {
    await connectDB();
    process.env.LOGIFORMS_MOCK_MODE = 'true';

    console.log('=== Setup: creating dummy clients and uploading dummy payroll files to Dropbox ===');
    for (const testClient of TEST_CLIENTS) {
      const client = await Client.create({
        name: testClient.name,
        dropboxPath: testClient.name,
        fein: testClient.fein,
        status: 'active',
      });
      createdClientIds.push(client._id);

      const payrollFilePath = buildDummyPayrollFile(testClient.employees);
      tempPayrollFiles.push(payrollFilePath);
      const fileBuffer = fs.readFileSync(payrollFilePath);
      await uploadFileToDropbox(testClient.name, 'payroll.xlsx', fileBuffer, new Date());
      console.log(`  Client "${testClient.name}" created and payroll file uploaded.`);
    }

    console.log('\n=== TEST 1: confirm the uploaded payroll files are findable via findLatestPayrollFile ===');
    for (const testClient of TEST_CLIENTS) {
      const latestFile = await findLatestPayrollFile(testClient.name);
      check(`Latest payroll file found for "${testClient.name}"`, Boolean(latestFile));
    }

    console.log('\n=== TEST 2: generateComplianceReportsForMultipleClients() - real run ===');
    const results = await generateComplianceReportsForMultipleClients(createdClientIds.map(String));
    console.log('Orchestrator results:', JSON.stringify(results, null, 2));

    check('Returned exactly 2 results', results.length === 2);
    check('Client One succeeded', results[0]?.success === true);
    check('Client Two succeeded', results[1]?.success === true);
    check('Client One: 5 employees processed', results[0]?.totalEmployees === 5);
    check('Client One: 4 completed, 1 incomplete (empty LogiForms status)', results[0]?.completedCount === 4 && results[0]?.incompleteCount === 1);
    check('Client Two: 5 employees processed', results[1]?.totalEmployees === 5);
    check('Client Two: 4 completed, 1 incomplete (empty LogiForms status)', results[1]?.completedCount === 4 && results[1]?.incompleteCount === 1);
    check('Email was skipped (no complianceReportEmailDistribution configured)', results[0]?.emailStatus === 'Skipped-No-Email' && results[1]?.emailStatus === 'Skipped-No-Email');

    console.log('\n=== TEST 3: confirm ComplianceReportLog entries were created ===');
    const logs = await ComplianceReportLog.find({ clientId: { $in: createdClientIds } }).lean();
    console.log(`Found ${logs.length} log entries.`);
    check('4 log entries total (2 clients x Admin+Client)', logs.length === 4);
    check('All log entries have success:true', logs.every((log) => log.success === true));
    check('Both Admin and Client reportTypes are represented', logs.some((log) => log.reportType === 'Admin') && logs.some((log) => log.reportType === 'Client'));
    check('All log entries have a filePath', logs.every((log) => Boolean(log.filePath)));

    console.log('\n=== TEST 4: confirm reports were actually uploaded to the "Compliance Reports" Dropbox subfolder ===');
    for (const testClient of TEST_CLIENTS) {
      const reportsFolder = `${testClient.name}/Compliance Reports`;
      const uploadedReport = await findLatestPayrollFile(reportsFolder);
      check(`A file exists in "${reportsFolder}"`, Boolean(uploadedReport));
    }

    console.log(`\n${failed ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED'}`);
  } catch (error) {
    failed = true;
    console.error('TEST SCRIPT ERROR:', error.message);
  } finally {
    console.log('\n=== Cleanup ===');
    tempPayrollFiles.forEach((filePath) => {
      try {
        fs.unlinkSync(filePath);
      } catch {}
    });
    for (const testClient of TEST_CLIENTS) {
      try {
        await deleteDropboxFolder(testClient.name);
        console.log(`  Deleted Dropbox folder for "${testClient.name}".`);
      } catch (error) {
        console.error(`  Could not delete Dropbox folder for "${testClient.name}": ${error.message}`);
      }
    }
    if (createdClientIds.length > 0) {
      await ComplianceReportLog.deleteMany({ clientId: { $in: createdClientIds } });
      await Client.deleteMany({ _id: { $in: createdClientIds } });
      console.log('  Deleted dummy clients and their log entries.');
    }
    await mongoose.connection.close();
  }
  process.exit(failed ? 1 : 0);
};

run();
