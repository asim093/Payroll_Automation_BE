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

// Parses every valid row in the file regardless of EIN, each keeping its own
// normalized ein — the basis for both parseLogiFormsCsv (single-FEIN,
// existing per-client contract, untouched) and fetchAllLogiFormsRecords
// (whole-file, fetched once per generation batch instead of once per client).
const readAllLogiFormsRows = (localFilePath) => {
  if (!fs.existsSync(localFilePath)) {
    throw new Error(`LogiForms file not found: ${localFilePath}`);
  }

  const workbook = XLSX.readFile(localFilePath);
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

  const records = [];
  for (const rawRow of rows.slice(1)) {
    const ein = normalizeFein(rawRow[columnIndex.ein]);
    const dateSubmitted = parseDateValue(rawRow[columnIndex.dateSubmitted]);
    const ssn = normalizeSsn(rawRow[columnIndex.ssn]);
    const rawStatus = rawRow[columnIndex.status];
    const status = rawStatus === null || rawStatus === undefined ? '' : String(rawStatus).trim();

    if (!dateSubmitted || !ssn || !status) continue;

    records.push({ dateSubmitted, ssn, status, ein });
  }

  records.sort((a, b) => b.dateSubmitted.getTime() - a.dateSubmitted.getTime());
  return records;
};

// Existing per-client contract — unchanged return shape (ein on each record
// is the normalized TARGET fein, not necessarily the row's own, matching the
// original behavior relied on by testLogiFormsIntegration.js).
const parseLogiFormsCsv = (localFilePath, fein) => {
  const normalizedFein = normalizeFein(fein);
  return readAllLogiFormsRows(localFilePath)
    .filter((record) => record.ein === normalizedFein)
    .map((record) => ({ ...record, ein: normalizedFein }));
};

// Pure in-memory filter, reusing rows already fetched once for a whole batch
// via fetchAllLogiFormsRecords — same output shape as parseLogiFormsCsv.
const filterLogiFormsRecordsByFein = (allRecords, fein) => {
  const normalizedFein = normalizeFein(fein);
  return allRecords.filter((record) => record.ein === normalizedFein).map((record) => ({ ...record, ein: normalizedFein }));
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

// Same download as fetchLogiFormsDataForClient but parses ALL rows (every
// EIN) instead of filtering to one — meant to be called ONCE per multi-client
// generation batch, with filterLogiFormsRecordsByFein() then applied per
// client from the shared result, instead of every client re-downloading and
// re-parsing the identical file.
const fetchAllLogiFormsRecords = async () => {
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
    return readAllLogiFormsRows(localFilePath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

module.exports = {
  fetchLogiFormsDataForClient,
  fetchAllLogiFormsRecords,
  filterLogiFormsRecordsByFein,
  parseLogiFormsCsv,
};
