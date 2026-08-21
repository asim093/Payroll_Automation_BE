const pad = (n) => String(n).padStart(2, '0');

const generateUniqueFilename = (originalName, referenceDate = new Date()) => {
  const d = referenceDate;
  const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timePart = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${datePart}_${timePart}_${originalName}`;
};

module.exports = { generateUniqueFilename };
