const ComplianceStatus = require('../models/ComplianceStatus');
const { normalizeToUtcCalendarDate } = require('../utils/dateOnly');

const getWeekEndingSunday = (value) => {
  const date = normalizeToUtcCalendarDate(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const dayOfWeek = date.getUTCDay();
  const daysUntilSunday = (7 - dayOfWeek) % 7;
  const weekEnding = new Date(date);
  weekEnding.setUTCDate(weekEnding.getUTCDate() + daysUntilSunday);
  return weekEnding;
};

const normalizeSsn = (value) => String(value ?? '').replace(/-/g, '').trim();

const normalizeStatusValue = (value) => String(value ?? '').trim().toLowerCase();

// Resolves duplicate SSNs by explicit MAX(DateSubmitted), not by "whichever
// row happens to be last in the array" — real LogiForms exports commonly
// have the same person submit multiple times (same status or a status
// change), and only the most recent submission's status is the confirmed
// business rule. This is order-independent: it doesn't matter what order
// logiFormsData arrives in. Rows with no parseable DateSubmitted (entryTime
// -Infinity) are only ever picked when nothing else exists for that SSN, so
// a genuinely-dated row always outranks one that failed to parse.
const calculateComplianceStatus = async (payrollRecords, logiFormsData) => {
  const logiFormsBySsn = new Map();
  for (const entry of logiFormsData || []) {
    const ssn = normalizeSsn(entry.ssn);
    const entryTime = entry.dateSubmitted instanceof Date && !Number.isNaN(entry.dateSubmitted.getTime())
      ? entry.dateSubmitted.getTime()
      : -Infinity;
    const existing = logiFormsBySsn.get(ssn);
    if (!existing || entryTime >= existing.dateSubmittedTime) {
      logiFormsBySsn.set(ssn, { status: entry.status, dateSubmittedTime: entryTime });
    }
  }

  const complianceStatuses = await ComplianceStatus.find().lean();
  const completeStatusValues = new Set(
    complianceStatuses.filter((entry) => entry.isComplete).map((entry) => normalizeStatusValue(entry.statusValue))
  );

  // Duplicate-SSN detection only (no merge/drop): some clients' payroll
  // exports legitimately have one row per job assignment for the same
  // person, others have real data-entry duplicates — telling those apart
  // isn't a rule this code can safely automate, so every row is kept as-is
  // and only flagged for a human to review. Single pass over the records
  // already in hand, no extra DB/network calls.
  const ssnCounts = new Map();
  for (const record of payrollRecords) {
    const ssn = normalizeSsn(record.ssn);
    if (!ssn) continue;
    ssnCounts.set(ssn, (ssnCounts.get(ssn) || 0) + 1);
  }

  return payrollRecords.map((record) => {
    const matchedStatus = logiFormsBySsn.get(normalizeSsn(record.ssn))?.status;

    const status = matchedStatus || 'Incomplete';
    const isComplete = matchedStatus ? completeStatusValues.has(normalizeStatusValue(matchedStatus)) : false;
    const duplicateSsnGroupSize = ssnCounts.get(normalizeSsn(record.ssn)) || 1;

    return {
      ...record,
      status,
      isComplete,
      weekEndingDate: getWeekEndingSunday(record.startDate),
      duplicateSsnGroupSize,
    };
  });
};

const summarizeByWeek = (records) => {
  const bucketsByKey = new Map();

  for (const record of records) {
    const key = record.weekEndingDate ? record.weekEndingDate.toISOString().slice(0, 10) : '__unknown__';
    if (!bucketsByKey.has(key)) {
      bucketsByKey.set(key, { weekEndingDate: record.weekEndingDate, total: 0, completed: 0, incomplete: 0 });
    }
    const bucket = bucketsByKey.get(key);
    bucket.total += 1;
    if (record.isComplete) bucket.completed += 1;
    else bucket.incomplete += 1;
  }

  return Array.from(bucketsByKey.values())
    .map((bucket) => ({
      ...bucket,
      completedPercentage: bucket.total > 0 ? Math.round((bucket.completed / bucket.total) * 10000) / 100 : 0,
    }))
    .sort((a, b) => {
      if (!a.weekEndingDate) return 1;
      if (!b.weekEndingDate) return -1;
      return a.weekEndingDate.getTime() - b.weekEndingDate.getTime();
    });
};

module.exports = { calculateComplianceStatus, summarizeByWeek, getWeekEndingSunday };
