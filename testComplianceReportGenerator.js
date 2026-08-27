require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const connectDB = require('./config/db');
const { fetchLogiFormsDataForClient } = require('./services/logiFormsService');
const { calculateComplianceStatus, summarizeByWeek } = require('./services/complianceCalculationService');
const { generateAdminReport, generateClientReport, saveReportToFile } = require('./services/complianceReportGeneratorService');

const run = async () => {
  let failed = false;
  const check = (label, pass) => {
    console.log(`  ${pass ? '✅' : '❌'} ${label}`);
    if (!pass) failed = true;
  };

  const outputFolder = path.join(os.tmpdir(), `compliance-report-test-${Date.now()}`);
  const savedPaths = [];

  try {
    await connectDB();
    process.env.LOGIFORMS_MOCK_MODE = 'true';

    console.log('=== Building combined Phase 2/3/4 output ===');
    const monday = new Date(Date.UTC(2024, 0, 8));
    const payrollRecords = [
      { startDate: monday, employeeName: 'Employee One', ssn: '111-11-1111', email: 'one@example.com' },
      { startDate: monday, employeeName: 'Employee Two', ssn: '111111112', email: 'two@example.com' },
      { startDate: monday, employeeName: 'Employee Three', ssn: '111-11-1113', email: 'three@example.com' },
      { startDate: monday, employeeName: 'Employee Four', ssn: '111111114', email: 'four@example.com' },
      { startDate: monday, employeeName: 'Employee Five', ssn: '111-11-1115', email: 'five@example.com' },
      { startDate: monday, employeeName: 'Employee Six', ssn: '999999999', email: 'six@example.com' },
    ];
    const feinRecords = await fetchLogiFormsDataForClient('12-3456789', 'https://fake.logiforms.example/api', '');
    const calculatedRecords = await calculateComplianceStatus(payrollRecords, feinRecords);
    const weeklyStats = summarizeByWeek(calculatedRecords);
    console.log(`Built ${calculatedRecords.length} calculated records across ${weeklyStats.length} week(s).`);

    console.log('\n=== TEST 1: generate + save Admin and Client reports ===');
    const clientName = 'Acme Corp';
    const adminWorkbook = generateAdminReport(clientName, calculatedRecords, weeklyStats);
    const clientWorkbook = generateClientReport(clientName, calculatedRecords, weeklyStats);

    const adminPath = await saveReportToFile(adminWorkbook, outputFolder, `Compliance Report ${clientName} (Admin)`);
    const clientPath = await saveReportToFile(clientWorkbook, outputFolder, `Compliance Report ${clientName} (Client)`);
    savedPaths.push(adminPath, clientPath);

    console.log('Admin report saved to:', adminPath);
    console.log('Client report saved to:', clientPath);

    check('Admin report file name matches "Compliance Report [ClientName] - MM-DD-YYYY.xlsx" pattern', /Compliance Report Acme Corp \(Admin\) - \d{2}-\d{2}-\d{4}\.xlsx$/.test(adminPath));
    check('Admin report file exists on disk', fs.existsSync(adminPath));
    check('Client report file exists on disk', fs.existsSync(clientPath));

    console.log('\n=== TEST 2: re-read Admin report and verify structure ===');
    const readAdminWorkbook = new ExcelJS.Workbook();
    await readAdminWorkbook.xlsx.readFile(adminPath);

    const adminSheetNames = readAdminWorkbook.worksheets.map((sheet) => sheet.name);
    console.log('Admin report sheet names:', adminSheetNames);
    check('Admin report has exactly 4 sheets', adminSheetNames.length === 4);
    check('Sheet "Compliance Report" present', adminSheetNames.includes('Compliance Report'));
    check('Sheet "All Applications" present', adminSheetNames.includes('All Applications'));
    check('Sheet "Completed Applications" present', adminSheetNames.includes('Completed Applications'));
    check('Sheet "Incomplete Applications" present', adminSheetNames.includes('Incomplete Applications'));

    const adminComplianceSheet = readAdminWorkbook.getWorksheet('Compliance Report');
    const adminComplianceHeaders = adminComplianceSheet.getRow(1).values.filter(Boolean);
    console.log('Compliance Report sheet headers:', adminComplianceHeaders);
    check(
      'Compliance Report headers match spec',
      JSON.stringify(adminComplianceHeaders) === JSON.stringify(['Week Ending', 'Total Hires', 'Completed', 'Incomplete', 'Compliance %'])
    );
    const adminComplianceLastRow = adminComplianceSheet.getRow(adminComplianceSheet.rowCount).values.filter(Boolean);
    console.log('Compliance Report last row (should be Total):', adminComplianceLastRow);
    check('Last row of Compliance Report sheet is the Total row', adminComplianceLastRow[0] === 'Total');
    check('Total row total-hires = 6', adminComplianceLastRow[1] === 6);
    check('Total row completed = 4', adminComplianceLastRow[2] === 4);
    check('Total row incomplete = 2', adminComplianceLastRow[3] === 2);

    const adminAllSheet = readAdminWorkbook.getWorksheet('All Applications');
    const adminAllHeaders = adminAllSheet.getRow(1).values.filter(Boolean);
    console.log('All Applications headers (Admin):', adminAllHeaders);
    check('Admin "All Applications" has Status column', adminAllHeaders.includes('Status'));
    check('Admin "All Applications" has Notes column', adminAllHeaders.includes('Notes'));
    check('Admin "All Applications" has 6 data rows', adminAllSheet.rowCount - 1 === 6);

    const adminCompletedSheet = readAdminWorkbook.getWorksheet('Completed Applications');
    check('Admin "Completed Applications" has 4 data rows', adminCompletedSheet.rowCount - 1 === 4);
    const adminIncompleteSheet = readAdminWorkbook.getWorksheet('Incomplete Applications');
    check('Admin "Incomplete Applications" has 2 data rows', adminIncompleteSheet.rowCount - 1 === 2);

    console.log('\n=== TEST 3: re-read Client report and verify Status/Notes are absent ===');
    const readClientWorkbook = new ExcelJS.Workbook();
    await readClientWorkbook.xlsx.readFile(clientPath);

    const clientSheetNames = readClientWorkbook.worksheets.map((sheet) => sheet.name);
    check('Client report also has exactly 4 sheets', clientSheetNames.length === 4);

    const clientAllSheet = readClientWorkbook.getWorksheet('All Applications');
    const clientAllHeaders = clientAllSheet.getRow(1).values.filter(Boolean);
    console.log('All Applications headers (Client):', clientAllHeaders);
    check('Client "All Applications" does NOT have Status column', !clientAllHeaders.includes('Status'));
    check('Client "All Applications" does NOT have Notes column', !clientAllHeaders.includes('Notes'));
    check(
      'Client "All Applications" still has the shared columns',
      ['Start Date', 'Employee Name', 'SSN', 'Email', 'Completed Y/N', 'W/E Period'].every((column) => clientAllHeaders.includes(column))
    );
    check('Client "All Applications" has 6 data rows', clientAllSheet.rowCount - 1 === 6);

    const clientComplianceSheet = readClientWorkbook.getWorksheet('Compliance Report');
    const clientComplianceHeaders = clientComplianceSheet.getRow(1).values.filter(Boolean);
    check(
      'Client "Compliance Report" summary sheet is identical to Admin\'s',
      JSON.stringify(clientComplianceHeaders) === JSON.stringify(adminComplianceHeaders)
    );

    console.log(`\n${failed ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED'}`);
  } catch (error) {
    failed = true;
    console.error('TEST SCRIPT ERROR:', error.message);
  } finally {
    savedPaths.forEach((filePath) => {
      try {
        fs.unlinkSync(filePath);
      } catch {}
    });
    try {
      fs.rmdirSync(outputFolder);
    } catch {}
    await mongoose.connection.close();
  }
  process.exit(failed ? 1 : 0);
};

run();
