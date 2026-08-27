/**
 * Compliance Report Generator — Phase 3. Cross-references Phase-2's parsed
 * payroll records against LogiForms status data (mocked for now - real
 * LogiForms API integration is Phase 4) to determine each employee's
 * compliance status and week-ending period, then summarizes by week.
 *
 * No report-generation/output logic here yet - just the calculation.
 */
const ComplianceStatus = require('../models/ComplianceStatus');

// "W/E Period" = the Sunday that ENDS the work-week containing startDate,
// i.e. the standard US-payroll Monday-through-Sunday week. ASSUMPTION
// (couldn't verify against the actual Excel formula, only the plain-
// English description "agla Sunday nikaalo start-date se"): if startDate
// IS ALREADY a Sunday, that same date is its own week-ending date - it
// does NOT roll forward to the following Sunday. Worth double-checking
// against the real spreadsheet if that assumption turns out wrong for an
// edge case.
//
// Deliberately uses UTC getters/setters, not local-time ones. Payroll
// dates are calendar dates with no meaningful time-of-day/timezone
// component ("March 15, 2024" means the same day everywhere) - but the
// Date objects arriving here are NOT timezone-neutral in practice:
// xlsx's cellDates:true (Phase 2) constructs Excel-cell dates using UTC
// components, and ISO date-strings ("2024-01-10") parse as UTC-midnight
// per the JS spec. Using local getDay()/setDate() here would read those
// UTC-anchored values through whatever timezone the server happens to be
// running in, silently shifting the calculated day (and, near a week
// boundary, potentially the whole week-ending date) by one day.
const getWeekEndingSunday = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const dayOfWeek = date.getUTCDay(); // 0 = Sunday, 1 = Monday, ... 6 = Saturday
  const daysUntilSunday = (7 - dayOfWeek) % 7; // 0 if already Sunday
  const weekEnding = new Date(date);
  weekEnding.setUTCDate(weekEnding.getUTCDate() + daysUntilSunday);
  return weekEnding;
};

const normalizeSsn = (value) => String(value ?? '').replace(/-/g, '').trim();

// @param payrollRecords - Phase-2's parsePayrollFile() output:
//   Array<{startDate, employeeName, ssn, email}>
// @param logiFormsData - Array<{ssn, status}> - mocked for now, will come
//   from the real LogiForms API in Phase 4. SSNs are normalized the same
//   way payroll SSNs are (dashes stripped) before matching, so either side
//   can be dashed or not.
// @returns Promise<Array<{...payrollRecord, status, isComplete, weekEndingDate}>>
const calculateComplianceStatus = async (payrollRecords, logiFormsData) => {
  const logiFormsBySsn = new Map();
  for (const entry of logiFormsData || []) {
    logiFormsBySsn.set(normalizeSsn(entry.ssn), entry.status);
  }

  const complianceStatuses = await ComplianceStatus.find().lean();
  const completeStatusValues = new Set(
    complianceStatuses.filter((entry) => entry.isComplete).map((entry) => entry.statusValue)
  );

  return payrollRecords.map((record) => {
    const matchedStatus = logiFormsBySsn.get(normalizeSsn(record.ssn));

    // No LogiForms record at all for this SSN -> explicitly "Incomplete".
    // A matched status that isn't in ComplianceStatus's known-complete set
    // (e.g. a status LogiForms returns that hasn't been added to that
    // collection yet) is NOT silently treated as "Incomplete" text-wise -
    // the real status is preserved, only isComplete is false, so a report
    // reader can see exactly what LogiForms said instead of a generic label.
    const status = matchedStatus || 'Incomplete';
    const isComplete = matchedStatus ? completeStatusValues.has(matchedStatus) : false;

    return {
      ...record,
      status,
      isComplete,
      weekEndingDate: getWeekEndingSunday(record.startDate),
    };
  });
};

// @param records - calculateComplianceStatus()'s output
// @returns Array<{weekEndingDate, total, completed, incomplete, completedPercentage}>
//   sorted by weekEndingDate ascending. Records with no weekEndingDate
//   (e.g. an unparseable startDate) are grouped under a null-date bucket
//   at the end rather than silently dropped.
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
