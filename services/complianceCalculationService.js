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

const calculateComplianceStatus = async (payrollRecords, logiFormsData) => {
  const logiFormsBySsn = new Map();
  for (const entry of logiFormsData || []) {
    logiFormsBySsn.set(normalizeSsn(entry.ssn), entry.status);
  }

  const complianceStatuses = await ComplianceStatus.find().lean();
  const completeStatusValues = new Set(
    complianceStatuses.filter((entry) => entry.isComplete).map((entry) => normalizeStatusValue(entry.statusValue))
  );

  return payrollRecords.map((record) => {
    const matchedStatus = logiFormsBySsn.get(normalizeSsn(record.ssn));

    const status = matchedStatus || 'Incomplete';
    const isComplete = matchedStatus ? completeStatusValues.has(normalizeStatusValue(matchedStatus)) : false;

    return {
      ...record,
      status,
      isComplete,
      weekEndingDate: getWeekEndingSunday(record.startDate),
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
