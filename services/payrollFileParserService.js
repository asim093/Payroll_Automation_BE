const fs = require('fs');
const XLSX = require('xlsx');
const ColumnMapping = require('../models/ColumnMapping');

const DESTINATION_FIELDS = ['StartDate', 'EmployeeName', 'SSN', 'Email'];

const FIELD_TO_PROPERTY = {
  StartDate: 'startDate',
  EmployeeName: 'employeeName',
  SSN: 'ssn',
  Email: 'email',
};

const normalizeHeader = (header) => String(header ?? '').trim().toLowerCase();

const findMatchingColumnIndex = (alternativeNames, normalizedFileHeaders) => {
  for (const alternativeName of alternativeNames) {
    const idx = normalizedFileHeaders.indexOf(normalizeHeader(alternativeName));
    if (idx !== -1) return idx;
  }
  return -1;
};

const normalizeSsn = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).replace(/-/g, '').trim();
};

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;
const US_SLASH_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/;

const parseDateString = (rawString) => {
  const trimmed = rawString.trim();
  if (!trimmed) return null;

  const isoMatch = trimmed.match(ISO_DATE_PATTERN);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  }

  const usMatch = trimmed.match(US_SLASH_DATE_PATTERN);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  }

  const fallbackParsed = new Date(trimmed);
  if (Number.isNaN(fallbackParsed.getTime())) return null;
  return new Date(Date.UTC(fallbackParsed.getFullYear(), fallbackParsed.getMonth(), fallbackParsed.getDate()));
};

const parseDateValue = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const converted = new Date(EXCEL_EPOCH_MS + Math.round(value * 24 * 60 * 60 * 1000));
    return Number.isNaN(converted.getTime()) ? null : converted;
  }
  return parseDateString(String(value));
};

const isMappedRowEmpty = (mappedRow) =>
  Object.values(mappedRow).every(
    (value) => value === null || value === undefined || String(value).trim() === ''
  );

const parsePayrollFile = async (filePath) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Payroll file not found: ${filePath}`);
  }

  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error(`Payroll file has no sheets: ${filePath}`);
  }

  const rows = XLSX.utils.sheet_to_json(firstSheetName ? workbook.Sheets[firstSheetName] : undefined, {
    header: 1,
    defval: null,
    raw: true,
  });

  if (rows.length === 0) {
    throw new Error(`Payroll file is empty: ${filePath}`);
  }

  const fileHeaders = rows[0].map((header) => String(header ?? ''));
  const normalizedFileHeaders = fileHeaders.map(normalizeHeader);
  const dataRows = rows.slice(1);

  const mappings = await ColumnMapping.find({ destinationField: { $in: DESTINATION_FIELDS } }).lean();
  const mappingByField = new Map(mappings.map((mapping) => [mapping.destinationField, mapping]));

  const columnIndexByField = {};
  for (const field of DESTINATION_FIELDS) {
    const mapping = mappingByField.get(field);
    const alternativeNames = mapping?.alternativeNames || [];
    if (!mapping || alternativeNames.length === 0) {
      throw new Error(
        `No ColumnMapping configured for "${field}" - run scripts/seedColumnMappingAndStatuses.js first.`
      );
    }

    const columnIndex = findMatchingColumnIndex(alternativeNames, normalizedFileHeaders);
    if (columnIndex === -1) {
      throw new Error(`Missing required column: ${field}. Checked for: ${alternativeNames.join(', ')}`);
    }
    columnIndexByField[field] = columnIndex;
  }

  const parsedRows = [];
  for (const rawRow of dataRows) {
    const mappedRow = {};
    for (const field of DESTINATION_FIELDS) {
      const rawValue = rawRow[columnIndexByField[field]];
      const property = FIELD_TO_PROPERTY[field];

      if (field === 'SSN') {
        mappedRow[property] = normalizeSsn(rawValue);
      } else if (field === 'StartDate') {
        mappedRow[property] = parseDateValue(rawValue);
      } else {
        mappedRow[property] = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();
      }
    }

    if (isMappedRowEmpty(mappedRow)) continue;
    parsedRows.push(mappedRow);
  }

  return parsedRows;
};

module.exports = { parsePayrollFile, parseDateValue };
