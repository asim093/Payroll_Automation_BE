const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const formatDateUTC = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${month}/${day}/${year}`;
};

const buildComplianceSummarySheet = (worksheet, weeklyStats) => {
  worksheet.columns = [
    { header: 'Week Ending', key: 'weekEnding', width: 16 },
    { header: 'Total Hires', key: 'totalHires', width: 14 },
    { header: 'Completed', key: 'completed', width: 14 },
    { header: 'Incomplete', key: 'incomplete', width: 14 },
    { header: 'Compliance %', key: 'compliancePercent', width: 16 },
  ];

  let totalHires = 0;
  let totalCompleted = 0;
  let totalIncomplete = 0;

  for (const week of weeklyStats) {
    worksheet.addRow({
      weekEnding: formatDateUTC(week.weekEndingDate),
      totalHires: week.total,
      completed: week.completed,
      incomplete: week.incomplete,
      compliancePercent: week.completedPercentage,
    });
    totalHires += week.total;
    totalCompleted += week.completed;
    totalIncomplete += week.incomplete;
  }

  const overallPercent = totalHires > 0 ? Math.round((totalCompleted / totalHires) * 10000) / 100 : 0;
  worksheet.addRow({
    weekEnding: 'Total',
    totalHires,
    completed: totalCompleted,
    incomplete: totalIncomplete,
    compliancePercent: overallPercent,
  });
};

const APPLICATION_COLUMNS_ADMIN = [
  { header: 'Start Date', key: 'startDate', width: 14 },
  { header: 'Employee Name', key: 'employeeName', width: 22 },
  { header: 'SSN', key: 'ssn', width: 14 },
  { header: 'Email', key: 'email', width: 26 },
  { header: 'Completed Y/N', key: 'completedYN', width: 14 },
  { header: 'W/E Period', key: 'weekEndingDate', width: 14 },
  { header: 'Status', key: 'status', width: 16 },
  { header: 'Notes', key: 'notes', width: 24 },
];

const APPLICATION_COLUMNS_CLIENT = APPLICATION_COLUMNS_ADMIN.filter(
  (column) => column.key !== 'status' && column.key !== 'notes'
);

const buildApplicationSheet = (worksheet, records, includeStatusAndNotes) => {
  worksheet.columns = includeStatusAndNotes ? APPLICATION_COLUMNS_ADMIN : APPLICATION_COLUMNS_CLIENT;

  for (const record of records) {
    const row = {
      startDate: formatDateUTC(record.startDate),
      employeeName: record.employeeName,
      ssn: record.ssn,
      email: record.email,
      completedYN: record.isComplete ? 'Y' : 'N',
      weekEndingDate: formatDateUTC(record.weekEndingDate),
    };
    if (includeStatusAndNotes) {
      row.status = record.status;
      row.notes = record.notes || '';
    }
    worksheet.addRow(row);
  }
};

const buildReportWorkbook = (clientName, calculatedRecords, weeklyStats, includeStatusAndNotes) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Payroll Automation - Compliance Report Generator';
  workbook.title = `Compliance Report - ${clientName}`;
  workbook.created = new Date();

  buildComplianceSummarySheet(workbook.addWorksheet('Compliance Report'), weeklyStats);
  buildApplicationSheet(workbook.addWorksheet('All Applications'), calculatedRecords, includeStatusAndNotes);
  buildApplicationSheet(
    workbook.addWorksheet('Completed Applications'),
    calculatedRecords.filter((record) => record.isComplete),
    includeStatusAndNotes
  );
  buildApplicationSheet(
    workbook.addWorksheet('Incomplete Applications'),
    calculatedRecords.filter((record) => !record.isComplete),
    includeStatusAndNotes
  );

  return workbook;
};

const generateAdminReport = (clientName, calculatedRecords, weeklyStats) =>
  buildReportWorkbook(clientName, calculatedRecords, weeklyStats, true);

const generateClientReport = (clientName, calculatedRecords, weeklyStats) =>
  buildReportWorkbook(clientName, calculatedRecords, weeklyStats, false);

const formatDateForFileName = (date) => {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  return `${month}-${day}-${year}`;
};

const saveReportToFile = async (workbook, outputFolder, fileName) => {
  fs.mkdirSync(outputFolder, { recursive: true });
  const datedFileName = `${fileName} - ${formatDateForFileName(new Date())}.xlsx`;
  const fullPath = path.join(outputFolder, datedFileName);
  await workbook.xlsx.writeFile(fullPath);
  return fullPath;
};

module.exports = { generateAdminReport, generateClientReport, saveReportToFile };
