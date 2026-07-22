const path = require('path');
const ExcelJS = require('exceljs');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const supportedExtensions = new Set(['.xlsx', '.csv']);

const fileExtension = (filename = '') => path.extname(filename).toLowerCase();

const validateTabularExtension = (filename = '') => {
  const ext = fileExtension(filename);
  if (!supportedExtensions.has(ext)) {
    throw new Error('Only .xlsx or .csv files are allowed');
  }
  return ext;
};

const normalizeCell = (value) => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return `${value.getUTCMonth() + 1}/${value.getUTCDate()}`;
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((chunk) => chunk.text || '').join('');
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return normalizeCell(value.result);
    if (value.hyperlink !== undefined) return String(value.text || value.hyperlink);
  }
  return String(value);
};

const readCsvRows = (buffer) => parse(buffer.toString('utf8'), {
  bom: true,
  relax_column_count: true,
  skip_empty_lines: true,
});

const readXlsxRows = async (buffer) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];
  return worksheet.getSheetValues()
    .slice(1)
    .filter(Boolean)
    .map((row) => {
      const values = Array.isArray(row) ? row.slice(1) : [];
      return values.map(normalizeCell);
    });
};

const readRowsFromBuffer = async (buffer, filename) => {
  const ext = validateTabularExtension(filename);
  return ext === '.csv' ? readCsvRows(buffer) : readXlsxRows(buffer);
};

const aoaToXlsxBuffer = async (rows, sheetName) => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sheetName);
  rows.forEach((row) => worksheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
};

const aoaToCsvBuffer = (rows) => Buffer.from(stringify(rows));

const rowsToAoA = (rows) => {
  if (!rows.length) return [[]];
  const headers = Array.from(
    rows.reduce((keys, row) => {
      Object.keys(row || {}).forEach((key) => keys.add(key));
      return keys;
    }, new Set())
  );
  return [headers, ...rows.map((row) => headers.map((header) => row?.[header] ?? ''))];
};

const buildTableBuffer = async (rows, sheetName, format) => {
  if (format === 'csv') return aoaToCsvBuffer(rows);
  if (format === 'xlsx') return aoaToXlsxBuffer(rows, sheetName);
  throw new Error('Unsupported template format');
};

const buildJsonBuffer = async (rows, sheetName, format) => {
  if (format === 'csv') return Buffer.from(`\uFEFF${stringify(rows, { header: true })}`);
  if (format === 'xlsx') return aoaToXlsxBuffer(rowsToAoA(rows), sheetName);
  throw new Error('Unsupported export format');
};

module.exports = {
  buildJsonBuffer,
  buildTableBuffer,
  normalizeCell,
  readRowsFromBuffer,
  validateTabularExtension,
};
