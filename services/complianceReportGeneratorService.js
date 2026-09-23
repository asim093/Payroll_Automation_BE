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

// Reference formatting extracted from a real Excel-generated report file:
// header row solid #156082 / white bold centered, Total row solid #E8E8E8 /
// black bold centered, all cells thin-bordered #999999.
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF156082' } };
const HEADER_FONT = { color: { argb: 'FFFFFFFF' }, bold: true };
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
const TOTAL_FONT = { color: { argb: 'FF000000' }, bold: true };
const CENTER_ALIGNMENT = { horizontal: 'center' };
const THIN_BORDER_SIDE = { style: 'thin', color: { argb: 'FF999999' } };
const THIN_BORDER = { top: THIN_BORDER_SIDE, left: THIN_BORDER_SIDE, bottom: THIN_BORDER_SIDE, right: THIN_BORDER_SIDE };
const APPLICATION_TAB_COLOR = { argb: 'FFD9AAD4' };

const buildComplianceSummarySheet = (worksheet, weeklyStats) => {
  worksheet.columns = [
    { header: 'W/E Period', key: 'weekEnding', width: 12.55 },
    { header: 'Total Hires', key: 'totalHires', width: 12.55 },
    { header: 'Completed', key: 'completed', width: 14 },
    { header: 'Incomplete', key: 'incomplete', width: 14 },
    { header: 'Compliance %', key: 'compliancePercent', width: 12.55 },
  ];
  worksheet.getColumn('weekEnding').numFmt = 'mm/dd/yyyy';

  let totalHires = 0;
  let totalCompleted = 0;
  let totalIncomplete = 0;

  for (const week of weeklyStats) {
    worksheet.addRow({
      weekEnding: week.weekEndingDate || null,
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

  const headerRow = worksheet.getRow(1);
  headerRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = CENTER_ALIGNMENT;
  });

  const totalRow = worksheet.getRow(worksheet.rowCount);
  totalRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = TOTAL_FILL;
    cell.font = TOTAL_FONT;
    cell.alignment = CENTER_ALIGNMENT;
  });

  for (let rowNumber = 2; rowNumber < worksheet.rowCount; rowNumber += 1) {
    worksheet.getRow(rowNumber).eachCell({ includeEmpty: true }, (cell) => {
      cell.alignment = CENTER_ALIGNMENT;
    });
  }

  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    worksheet.getRow(rowNumber).eachCell({ includeEmpty: true }, (cell) => {
      cell.border = THIN_BORDER;
    });
  }
};

const APPLICATION_COLUMNS_ADMIN = [
  { header: 'Start Date', key: 'startDate', width: 14 },
  { header: 'Employee Name', key: 'employeeName', width: 22 },
  { header: 'SSN', key: 'ssn', width: 14 },
  { header: 'Email', key: 'email', width: 26 },
  { header: 'Completed', key: 'completedYN', width: 14 },
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
      const duplicateNote =
        record.duplicateSsnGroupSize > 1
          ? `Duplicate SSN — ${record.duplicateSsnGroupSize} records, review recommended`
          : '';
      row.notes = [record.notes, duplicateNote].filter(Boolean).join(' | ');
    }
    worksheet.addRow(row);
  }

  const headerRow = worksheet.getRow(1);
  headerRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = CENTER_ALIGNMENT;
  });

  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    worksheet.getRow(rowNumber).eachCell({ includeEmpty: true }, (cell) => {
      cell.border = THIN_BORDER;
    });
  }
};

const buildReportWorkbook = (clientName, calculatedRecords, weeklyStats, includeStatusAndNotes) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Payroll Automation - Compliance Report Generator';
  workbook.title = `Compliance Report - ${clientName}`;
  workbook.created = new Date();

  // Compliance Report tab intentionally keeps no tab color (default).
  buildComplianceSummarySheet(workbook.addWorksheet('Compliance Report'), weeklyStats);

  const allApplicationsSheet = workbook.addWorksheet('All Applications', { properties: { tabColor: APPLICATION_TAB_COLOR } });
  buildApplicationSheet(allApplicationsSheet, calculatedRecords, includeStatusAndNotes);

  const completedSheet = workbook.addWorksheet('Completed Applications', { properties: { tabColor: APPLICATION_TAB_COLOR } });
  buildApplicationSheet(
    completedSheet,
    calculatedRecords.filter((record) => record.isComplete),
    includeStatusAndNotes
  );

  const incompleteSheet = workbook.addWorksheet('Incomplete Applications', { properties: { tabColor: APPLICATION_TAB_COLOR } });
  buildApplicationSheet(
    incompleteSheet,
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
