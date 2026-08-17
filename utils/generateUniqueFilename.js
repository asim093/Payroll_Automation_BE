// Prefixes a filename with a timestamp so two attachments that happen to
// share the same original name never collide/overwrite each other:
// "payroll.csv" -> "2026-08-16_143022_payroll.csv" (format: YYYY-MM-DD_HHMMSS_originalname).
//
// Accepts an optional referenceDate so multiple destinations (local disk +
// Dropbox) can be given the exact same Date for the exact same attachment —
// callers that save to more than one place should generate one Date and
// pass it to every saveToDestinations()-style call, rather than letting
// each destination call `new Date()` independently, which could drift
// across a second boundary and produce two different (mismatched) names
// for what's supposed to be the same file.
const pad = (n) => String(n).padStart(2, '0');

const generateUniqueFilename = (originalName, referenceDate = new Date()) => {
  const d = referenceDate;
  const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timePart = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${datePart}_${timePart}_${originalName}`;
};

module.exports = { generateUniqueFilename };
