const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { parse } = require('csv-parse/sync');
const { getSettings } = require('./settingsService');
const { findLatestLogiFormsCsvInShareFile, downloadFileContentByIdToPath } = require('./sharefileService');

const EXPECTED_HEADERS = {
  dateSubmitted: 'DateSubmitted',
  ein: 'EIN',
  ssn: 'SSN',
  status: 'Status',
};

const normalizeHeader = (header) => String(header ?? '').trim().toLowerCase();
const normalizeFein = (value) => String(value ?? '').replace(/[^0-9]/g, '');
const normalizeSsn = (value) => String(value ?? '').replace(/-/g, '').trim();

// DateSubmitted needs real sub-day precision — unlike hire dates/week-ending
// dates elsewhere in the app (calendar-only by design), same-day/same-minute
// duplicate LogiForms submissions for the same SSN are common in real data,
// and calculateComplianceStatus's duplicate-SSN resolution depends on being
// able to tell which submission actually happened last. Real production
// exports use "M/D/YY H:MM:SS AM/PM" (e.g. "5/1/25 12:08:00 AM") — parsed
// explicitly here rather than via the shared parseDateValue/
// normalizeToUtcCalendarDate (which truncates to midnight on purpose) or via
// a bare `new Date(string)` on this exact format, since non-ISO string
// parsing is implementation-defined by spec.
const DATE_SUBMITTED_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i;
const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const parseDateSubmittedTimestamp = (value) => {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number') {
    // Excel serial date-time (whole + fractional day) — only reachable if a
    // real spreadsheet-typed cell ever slips in; not expected for a plain
    // .csv, which is what production actually uses (confirmed directly).
    if (!Number.isFinite(value)) return null;
    const date = new Date(EXCEL_EPOCH_UTC_MS + value * MS_PER_DAY);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const trimmed = String(value).trim();
  if (!trimmed) return null;

  const match = trimmed.match(DATE_SUBMITTED_PATTERN);
  if (match) {
    const [, monthStr, dayStr, yearStr, hourStr, minuteStr, secondStr, meridiem] = match;
    const year = yearStr.length === 2 ? Number(yearStr) + 2000 : Number(yearStr);
    const month = Number(monthStr);
    const day = Number(dayStr);
    let hour = Number(hourStr) % 12;
    if (meridiem.toUpperCase() === 'PM') hour += 12;
    const minute = Number(minuteStr);
    const second = Number(secondStr);
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // Fallback for any other format (e.g. an ISO datetime string) — only
  // reached when the known real format above didn't match.
  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
};

// Parses one already-read line into either a data row ({ein, ssn, status,
// dateSubmitted}, or null if a required field is missing/unparseable) or a
// skipped-row record (structured CSV parse failure, with best-effort EIN
// attribution) — shared by readAllLogiFormsRows (in-memory, legacy path) and
// logiFormsIngestService.js (streaming into Mongo) so the parsing/dedup-key
// rules can never drift between the two.
const parseLogiFormsLine = (rawLine, lineNumber, headerColumns) => {
  const line = lineNumber === 1 ? rawLine.replace(/^﻿/, '') : rawLine;
  if (!line.trim()) return { type: 'blank' };

  let fields;
  try {
    [fields] = parse(line, { relax_column_count: true });
  } catch (strictError) {
    // Fallback ONLY reached after the strict parse above has already
    // failed — investigation found every real failure in this file is a
    // lone, un-doubled `"` inside a quoted field (a nickname, an apostrophe
    // typed as `"`, a quoted apartment/street letter), never an ambiguous
    // row. relax_quotes tells the library to treat such a stray quote as
    // literal text instead of a syntax error.
    //
    // Safety check: relax_quotes can also silently MERGE two adjacent
    // fields into one when the stray quote sits right at a field boundary
    // (e.g. a trailing quote right after a Zip value swallows the next
    // column too) — that shifts every later column's position, which would
    // silently corrupt tracked fields like SSN/DateSubmitted rather than
    // just fixing an untracked one. Only trust the relaxed result if it
    // produced the SAME number of columns as the header — a genuine
    // literal-quote fix never changes the column count, so this rejects
    // exactly the corrupting cases while accepting the safe ones. If the
    // column count doesn't match, this falls through to the original
    // skipped-row path unchanged.
    let relaxedFields = null;
    try {
      const [attempt] = parse(line, { relax_column_count: true, relax_quotes: true });
      if (headerColumns && attempt.length === headerColumns.length) {
        relaxedFields = attempt;
      }
    } catch {
      // relax_quotes still couldn't parse it — falls through to skipped.
    }

    if (relaxedFields) {
      console.warn(
        `[LOGIFORMS-PARSE] Recovered line ${lineNumber} via relax_quotes fallback (stray literal quote inside a field) — column count matched the header, so this is trusted.`
      );
      fields = relaxedFields;
    } else {
      // Best-effort EIN attribution for a row that failed structured CSV
      // parsing: EIN is a short numeric column, so a naive split on commas
      // almost always still isolates it correctly even when a DIFFERENT
      // column (e.g. an unbalanced quote in a name/address field) is what
      // actually broke the parser. Only usable once the header (and so the
      // EIN column's position) is known; a malformed header line itself
      // can't be attributed and gets einGuess: null.
      let einGuess = null;
      if (headerColumns) {
        const einColumnIndex = headerColumns.indexOf(normalizeHeader(EXPECTED_HEADERS.ein));
        if (einColumnIndex !== -1) {
          const looseFields = line.split(',');
          einGuess = normalizeFein(looseFields[einColumnIndex]) || null;
        }
      }
      return {
        type: 'skipped',
        skippedRow: {
          lineNumber,
          snippet: line.length > 200 ? `${line.slice(0, 200)}…` : line,
          error: strictError.message,
          einGuess,
        },
      };
    }
  }

  if (lineNumber === 1) {
    const parsedHeaderColumns = fields.map((header) => normalizeHeader(header));
    for (const [, expectedHeader] of Object.entries(EXPECTED_HEADERS)) {
      if (!parsedHeaderColumns.includes(normalizeHeader(expectedHeader))) {
        return { type: 'invalid_header', missingHeader: expectedHeader };
      }
    }
    return { type: 'header', headerColumns: parsedHeaderColumns };
  }

  const columnIndex = (field) => headerColumns.indexOf(normalizeHeader(EXPECTED_HEADERS[field]));
  const ein = normalizeFein(fields[columnIndex('ein')]);
  const dateSubmitted = parseDateSubmittedTimestamp(fields[columnIndex('dateSubmitted')]);
  const ssn = normalizeSsn(fields[columnIndex('ssn')]);
  const rawStatus = fields[columnIndex('status')];
  const status = rawStatus === null || rawStatus === undefined ? '' : String(rawStatus).trim();

  if (!dateSubmitted || !ssn || !status) return { type: 'incomplete' };

  return { type: 'data', row: { ein, ssn, status, dateSubmitted } };
};

const readAllLogiFormsRows = (localFilePath) =>
  new Promise((resolve, reject) => {
    if (!fs.existsSync(localFilePath)) {
      reject(new Error(`LogiForms file not found: ${localFilePath}`));
      return;
    }

    const bestByKey = new Map();
    const skippedRows = [];
    let lineNumber = 0;
    let headerColumns = null;
    let sawAnyDataLine = false;

    const rl = readline.createInterface({
      input: fs.createReadStream(localFilePath),
      crlfDelay: Infinity,
    });

    rl.on('line', (rawLine) => {
      lineNumber += 1;
      const parsed = parseLogiFormsLine(rawLine, lineNumber, headerColumns);

      if (parsed.type === 'blank' || parsed.type === 'incomplete') return;

      if (parsed.type === 'skipped') {
        skippedRows.push(parsed.skippedRow);
        return;
      }

      if (parsed.type === 'invalid_header') {
        rl.close();
        reject(new Error(`LogiForms file is missing required column "${parsed.missingHeader}": ${localFilePath}`));
        return;
      }

      if (parsed.type === 'header') {
        headerColumns = parsed.headerColumns;
        return;
      }

      sawAnyDataLine = true;
      const { ein, ssn, status, dateSubmitted } = parsed.row;
      const key = `${ein}:${ssn}`;
      const existing = bestByKey.get(key);
      if (!existing || dateSubmitted.getTime() >= existing.dateSubmitted.getTime()) {
        bestByKey.set(key, { dateSubmitted, status });
      }
    });

    rl.on('error', (error) => reject(error));

    rl.on('close', () => {
      if (!headerColumns) {
        reject(new Error(`LogiForms file is empty: ${localFilePath}`));
        return;
      }
      if (!sawAnyDataLine && skippedRows.length === 0) {
        reject(new Error(`LogiForms file is empty: ${localFilePath}`));
        return;
      }
      // Diagnostic only (Part 1c) — measures the real unique-row count after
      // existing MAX(DateSubmitted)-per-SSN+EIN dedup, against real
      // production files, to decide whether caching the parsed result is
      // safe under the ~512MB memory ceiling before any caching is built.
      console.log(
        `[LOGIFORMS-DIAGNOSTIC] Parsed "${localFilePath}": ${lineNumber} lines read, bestByKey.size (unique EIN+SSN records after dedup) = ${bestByKey.size}, skippedRows = ${skippedRows.length}, process RSS = ${(process.memoryUsage().rss / (1024 * 1024)).toFixed(1)}MB`
      );
      // Sort kept purely to preserve the existing "sorted desc" output
      // contract (testLogiFormsIntegration.js asserts this) — correctness no
      // longer depends on it, since duplicates are already resolved above.
      const records = Array.from(bestByKey.entries(), ([key, value]) => {
        const separatorIndex = key.indexOf(':');
        return {
          ein: key.slice(0, separatorIndex),
          ssn: key.slice(separatorIndex + 1),
          status: value.status,
          dateSubmitted: value.dateSubmitted,
        };
      });
      records.sort((a, b) => b.dateSubmitted.getTime() - a.dateSubmitted.getTime());
      if (skippedRows.length > 0) {
        // Data quality notice, NOT a failure — the parse above already
        // succeeded using every other row; this is purely visibility into a
        // source-file formatting issue, previously only surfaced as a
        // frontend toast count with nothing logged server-side at all.
        console.warn(
          `[LOGIFORMS-PARSE] Data quality notice (not a failure): ${skippedRows.length} row(s) in "${localFilePath}" had a formatting problem and were skipped; report generation continued using all other valid rows. Line numbers: ${skippedRows.map((row) => row.lineNumber).join(', ')}`
        );
      }
      resolve({ records, skippedRows });
    });
  });

// Splits a file-wide skippedRows list (from readAllLogiFormsRows) into the
// rows that best-effort attribute to ONE client's FEIN vs. rows that don't
// attribute to any FEIN at all (a malformed header line, or the EIN column
// itself being the corrupted field) — the latter is a genuine file-level
// issue, not something any single client's warning should claim.
const attributeSkippedRows = (skippedRows, fein) => {
  const normalizedFein = normalizeFein(fein);
  const relevantSkippedRows = [];
  const unattributableSkippedRows = [];
  for (const row of skippedRows) {
    if (row.einGuess === normalizedFein) relevantSkippedRows.push(row);
    else if (!row.einGuess) unattributableSkippedRows.push(row);
  }
  return { relevantSkippedRows, unattributableSkippedRows };
};

// Existing per-client contract — unchanged return shape (ein on each record
// is the normalized TARGET fein, not necessarily the row's own, matching the
// original behavior relied on by testLogiFormsIntegration.js). Now async
// (the streaming read underneath it is inherently asynchronous); every
// caller already awaits or returns this from an async function.
const parseLogiFormsCsv = async (localFilePath, fein) => {
  const normalizedFein = normalizeFein(fein);
  const { records: allRecords, skippedRows } = await readAllLogiFormsRows(localFilePath);
  const records = allRecords
    .filter((record) => record.ein === normalizedFein)
    .map((record) => ({ ...record, ein: normalizedFein }));
  const { relevantSkippedRows, unattributableSkippedRows } = attributeSkippedRows(skippedRows, fein);
  return { records, skippedRows, relevantSkippedRows, unattributableSkippedRows };
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
    await downloadFileContentByIdToPath(latestFile.fileId, localFilePath);
    // Explicitly awaited (not just `return parseLogiFormsCsv(...)`) — now
    // that parsing streams the file asynchronously, an un-awaited return
    // would let `finally` delete tempDir out from under the still-reading
    // stream, since `finally` runs as soon as control leaves the try block,
    // not once the returned promise settles.
    return await parseLogiFormsCsv(localFilePath, fein);
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
    await downloadFileContentByIdToPath(latestFile.fileId, localFilePath);
    // Explicitly awaited — see the same note in fetchLogiFormsDataForClient:
    // an un-awaited return here would let `finally` delete tempDir before
    // the streaming read finishes with it.
    return await readAllLogiFormsRows(localFilePath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

module.exports = {
  fetchLogiFormsDataForClient,
  fetchAllLogiFormsRecords,
  filterLogiFormsRecordsByFein,
  parseLogiFormsCsv,
  attributeSkippedRows,
  parseLogiFormsLine,
  normalizeFein,
  normalizeSsn,
  EXPECTED_HEADERS,
};
