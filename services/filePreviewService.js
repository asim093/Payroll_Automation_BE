const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { STORAGE_ROOT } = require('./fileStorage');
const { downloadDropboxFileBuffer } = require('./dropboxService');

const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
};

const TABLE_PREVIEW_EXTENSIONS = new Set(['.csv', '.xlsx', '.xls']);
const INLINE_PREVIEW_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_PREVIEW_ROWS = 200;

const getExtension = (filename) => path.extname(filename || '').toLowerCase();

const getMimeType = (filename) => MIME_TYPES[getExtension(filename)] || 'application/octet-stream';

const getPreviewKind = (filename) => {
  const ext = getExtension(filename);
  if (TABLE_PREVIEW_EXTENSIONS.has(ext)) return 'table';
  if (INLINE_PREVIEW_EXTENSIONS.has(ext)) return 'inline';
  return 'none';
};

const getFileBuffer = async (fileLog) => {
  if (fileLog.destination === 'dropbox') {
    return downloadDropboxFileBuffer(fileLog.destinationPath);
  }

  const resolvedPath = path.resolve(fileLog.destinationPath || '');
  const resolvedRoot = path.resolve(STORAGE_ROOT);
  if (!resolvedPath.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Refusing to read a file outside the storage folder.');
  }
  if (!fs.existsSync(resolvedPath)) {
    throw new Error('This file no longer exists on disk.');
  }
  return fs.readFileSync(resolvedPath);
};

const parseCsvPreview = (buffer) => {
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const [headerLine, ...bodyLines] = lines;
  const headers = headerLine ? headerLine.split(',') : [];
  const rows = bodyLines.slice(0, MAX_PREVIEW_ROWS).map((line) => line.split(','));
  return { headers, rows, totalRows: bodyLines.length, truncated: bodyLines.length > MAX_PREVIEW_ROWS };
};

const parseExcelPreview = async (buffer) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return { headers: [], rows: [], totalRows: 0, truncated: false };

  const allRows = [];
  worksheet.eachRow((row) => {
    const values = row.values.slice(1).map((cell) => (cell === null || cell === undefined ? '' : String(cell)));
    allRows.push(values);
  });

  const [headers, ...bodyRows] = allRows;
  return {
    headers: headers || [],
    rows: bodyRows.slice(0, MAX_PREVIEW_ROWS),
    totalRows: bodyRows.length,
    truncated: bodyRows.length > MAX_PREVIEW_ROWS,
  };
};

const parseTablePreview = async (buffer, filename) => {
  const ext = getExtension(filename);
  if (ext === '.csv') return parseCsvPreview(buffer);
  if (ext === '.xlsx' || ext === '.xls') return parseExcelPreview(buffer);
  return null;
};

module.exports = { getFileBuffer, getMimeType, getPreviewKind, parseTablePreview };
