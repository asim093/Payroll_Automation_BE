const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { getSettings } = require('./settingsService');
const { findLatestLogiFormsCsvInShareFile, downloadFileContentById } = require('./sharefileService');
const { parseDateValue } = require('./payrollFileParserService');

const EXPECTED_HEADERS = {
  dateSubmitted: 'DateSubmitted',
  ein: 'EIN',
  ssn: 'SSN',
  status: 'Status',
};

const normalizeHeader = (header) => String(header ?? '').trim().toLowerCase();
const normalizeFein = (value) => String(value ?? '').replace(/[^0-9]/g, '');
const normalizeSsn = (value) => String(value ?? '').replace(/-/g, '').trim();

const parseLogiFormsCsv = (localFilePath, fein) => {
  if (!fs.existsSync(localFilePath)) {
    throw new Error(`LogiForms file not found: ${localFilePath}`);
  }

  const workbook = XLSX.readFile(localFilePath, { cellDates: true, raw: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error(`LogiForms file has no sheets: ${localFilePath}`);
  }

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], {
    header: 1,
    defval: null,
    raw: true,
  });
  if (rows.length === 0) {
    throw new Error(`LogiForms file is empty: ${localFilePath}`);
  }

  const normalizedFileHeaders = rows[0].map((header) => normalizeHeader(header));

  const columnIndex = {};
  for (const [field, expectedHeader] of Object.entries(EXPECTED_HEADERS)) {
    const index = normalizedFileHeaders.indexOf(normalizeHeader(expectedHeader));
    if (index === -1) {
      throw new Error(`LogiForms file is missing required column "${expectedHeader}": ${localFilePath}`);
    }
    columnIndex[field] = index;
  }

  const normalizedFein = normalizeFein(fein);
  const records = [];

  for (const rawRow of rows.slice(1)) {
    const einValue = rawRow[columnIndex.ein];
    if (normalizeFein(einValue) !== normalizedFein) continue;

    const dateSubmitted = parseDateValue(rawRow[columnIndex.dateSubmitted]);
    const ssn = normalizeSsn(rawRow[columnIndex.ssn]);
    const rawStatus = rawRow[columnIndex.status];
    const status = rawStatus === null || rawStatus === undefined ? '' : String(rawStatus).trim();

    if (!dateSubmitted || !ssn || !status) continue;

    records.push({ dateSubmitted, ssn, status, ein: normalizedFein });
  }

  records.sort((a, b) => b.dateSubmitted.getTime() - a.dateSubmitted.getTime());
  return records;
};

const fetchLogiFormsDataForClient = async (fein) => {
  const { logiFormsFolderPath } = await getSettings();
  if (!logiFormsFolderPath) {
    throw new Error('LogiForms folder path is not configured. Set "LogiForms Folder Path" on the Settings page first.');
  }

  const latestFile = await findLatestLogiFormsCsvInShareFile(logiFormsFolderPath);
  if (!latestFile) {
    throw new Error(`No LogiForms CSV file found in ShareFile folder "${logiFormsFolderPath}".`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logiforms-'));
  const localFilePath = path.join(tempDir, latestFile.fileName);

  try {
    const content = await downloadFileContentById(latestFile.fileId);
    fs.writeFileSync(localFilePath, content);
    return parseLogiFormsCsv(localFilePath, fein);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

module.exports = { fetchLogiFormsDataForClient, parseLogiFormsCsv };
