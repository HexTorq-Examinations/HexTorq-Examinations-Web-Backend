const XLSX = require('xlsx');

const MAX_ROWS = 500;
const TEMPLATE_HEADERS = ['Name', 'RegisterNumber', 'Email', 'Phone', 'Password', 'Status'];
const TEMPLATE_ROWS = [
  ['Alice Johnson', 'ENR-2026-101', 'alice.johnson@example.com', '555-1001', 'securepass123', 'Active'],
  ['Bob Smith', 'ENR-2026-102', '', '555-1002', 'mathgenius', 'Active'],
  ['Charlie Davis', 'ENR-2026-103', 'charlie.davis@example.com', '555-1003', '', 'Active'],
];

const normalizeHeader = (h) => String(h || '').trim().toLowerCase().replace(/\s+/g, '');
const VALID_STATUSES = new Set(['active', 'inactive', 'suspended']);

// Parses an uploaded workbook buffer (.xlsx / .xls / .csv) into { students, errors }.
// The class the students land in comes from where the admin is importing (a specific
// Class in the academic hierarchy), not from a column in the file.
function parseStudentsWorkbook(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (err) {
    return { students: [], errors: [{ row: 0, error: 'The file could not be read. Make sure it is a valid .xlsx, .xls, or .csv file.' }] };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { students: [], errors: [{ row: 0, error: 'The file has no sheets/data.' }] };
  }
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });

  if (rows.length === 0) {
    return { students: [], errors: [{ row: 0, error: 'The file is empty.' }] };
  }

  const headerRow = rows[0].map(normalizeHeader);
  const colIndex = {
    name: headerRow.indexOf('name'),
    registerNumber: headerRow.indexOf('registernumber'),
    email: headerRow.indexOf('email'),
    phone: headerRow.indexOf('phone'),
    password: headerRow.indexOf('password'),
    status: headerRow.indexOf('status'),
  };

  const required = ['name', 'registerNumber', 'phone'];
  const missing = required.filter((key) => colIndex[key] === -1);
  if (missing.length > 0) {
    return {
      students: [],
      errors: [{
        row: 0,
        error: `The file must have a header row with at least: Name, RegisterNumber, Phone. Missing: ${missing.join(', ')}.`,
      }],
    };
  }

  const dataRows = rows.slice(1).slice(0, MAX_ROWS);
  if (rows.length - 1 > MAX_ROWS) {
    return { students: [], errors: [{ row: 0, error: `Too many rows. Maximum ${MAX_ROWS} students per import.` }] };
  }

  const students = [];
  const errors = [];
  const seenEmails = new Set();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  dataRows.forEach((row, i) => {
    const rowNum = i + 2; // 1-indexed, +1 for header row
    const name = String(row[colIndex.name] ?? '').trim();
    const registerNumber = String(row[colIndex.registerNumber] ?? '').trim();
    let email = colIndex.email !== -1 ? String(row[colIndex.email] ?? '').trim() : '';
    const phone = String(row[colIndex.phone] ?? '').trim();
    const password = colIndex.password !== -1 ? String(row[colIndex.password] ?? '').trim() : '';
    const rawStatus = colIndex.status !== -1 ? String(row[colIndex.status] ?? '').trim() : '';

    if (!name) return errors.push({ row: rowNum, error: 'Name is empty.' });
    if (!registerNumber) return errors.push({ row: rowNum, error: 'RegisterNumber is empty.' });
    if (!phone) return errors.push({ row: rowNum, error: 'Phone is empty.' });

    if (!email) {
      email = `${registerNumber.toLowerCase().replace(/[^a-z0-9]/g, '')}@student.hextorq.internal`;
    } else if (!emailRegex.test(email)) {
      return errors.push({ row: rowNum, error: `"${email}" is not a valid email address.` });
    }

    const emailLower = email.toLowerCase();
    if (seenEmails.has(emailLower)) {
      return errors.push({ row: rowNum, error: `Duplicate email "${email}" within this file.` });
    }
    seenEmails.add(emailLower);

    let status = 'Active';
    if (rawStatus) {
      if (!VALID_STATUSES.has(rawStatus.toLowerCase())) {
        return errors.push({ row: rowNum, error: `Status "${rawStatus}" must be Active, Inactive, or Suspended.` });
      }
      status = rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1).toLowerCase();
    }

    students.push({ name, registerNumber, email, phone, password, status });
  });

  return { students, errors };
}

function generateTemplateBuffer(format) {
  const worksheet = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, ...TEMPLATE_ROWS]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Students');

  const bookTypeMap = { xlsx: 'xlsx', xls: 'biff8', csv: 'csv' };
  const bookType = bookTypeMap[format];
  if (!bookType) throw new Error('Unsupported template format');

  return XLSX.write(workbook, { type: 'buffer', bookType });
}

module.exports = { parseStudentsWorkbook, generateTemplateBuffer, MAX_ROWS };
