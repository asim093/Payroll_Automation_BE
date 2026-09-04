const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
const US_SLASH_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/;

const utcCalendarDate = (year, month1To12, day) => {
  const date = new Date(Date.UTC(year, month1To12 - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
};

const parseDateOnlyString = (raw) => {
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  const iso = trimmed.match(ISO_DATE_PATTERN);
  if (iso) return utcCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const usSlash = trimmed.match(US_SLASH_DATE_PATTERN);
  if (usSlash) return utcCalendarDate(Number(usSlash[3]), Number(usSlash[1]), Number(usSlash[2]));

  const fallback = new Date(trimmed);
  if (Number.isNaN(fallback.getTime())) return null;
  return utcCalendarDate(fallback.getFullYear(), fallback.getMonth() + 1, fallback.getDate());
};

const normalizeToUtcCalendarDate = (value) => {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const serialDay = Math.floor(value);
    const date = new Date(EXCEL_EPOCH_UTC_MS + serialDay * MS_PER_DAY);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return utcCalendarDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }

  return parseDateOnlyString(value);
};

module.exports = { normalizeToUtcCalendarDate, parseDateOnlyString, EXCEL_EPOCH_UTC_MS, MS_PER_DAY };
