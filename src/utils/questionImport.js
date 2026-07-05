const XLSX = require('xlsx');

const MAX_ROWS = 500;
const TEMPLATE_HEADERS = ['Question', 'Option1', 'Option2', 'Option3', 'Option4', 'Answer'];
const TEMPLATE_ROWS = [
  ['What is the capital of France?', 'Berlin', 'Madrid', 'Paris', 'Rome', 'Paris'],
  ['Which planet is known as the Red Planet?', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Mars'],
  ['2 + 2 * 2 = ?', '4', '6', '8', '10', '6'],
];

const normalizeHeader = (h) => String(h || '').trim().toLowerCase().replace(/\s+/g, '');

// Parses an uploaded workbook buffer (.xlsx / .xls / .csv) into { questions, errors }.
// `defaults` supplies subject/marks/difficulty/type when the sheet doesn't provide its own columns.
function parseQuestionsWorkbook(buffer, defaults) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (err) {
    return { questions: [], errors: [{ row: 0, error: 'The file could not be read. Make sure it is a valid .xlsx, .xls, or .csv file.' }] };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { questions: [], errors: [{ row: 0, error: 'The file has no sheets/data.' }] };
  }
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });

  if (rows.length === 0) {
    return { questions: [], errors: [{ row: 0, error: 'The file is empty.' }] };
  }

  const headerRow = rows[0].map(normalizeHeader);
  const colIndex = {
    question: headerRow.indexOf('question'),
    answer: headerRow.indexOf('answer'),
    subject: headerRow.indexOf('subject'),
    marks: headerRow.indexOf('marks'),
    difficulty: headerRow.indexOf('difficulty'),
    type: headerRow.indexOf('type'),
  };
  const optionIndices = [];
  for (let i = 1; i <= 10; i++) {
    const idx = headerRow.indexOf(`option${i}`);
    if (idx !== -1) optionIndices.push(idx);
  }

  if (colIndex.question === -1 || optionIndices.length < 2 || colIndex.answer === -1) {
    return {
      questions: [],
      errors: [{
        row: 0,
        error: 'The file must have a header row with at least: Question, Option1, Option2, ..., Answer.',
      }],
    };
  }

  const dataRows = rows.slice(1).slice(0, MAX_ROWS);
  if (rows.length - 1 > MAX_ROWS) {
    return { questions: [], errors: [{ row: 0, error: `Too many rows. Maximum ${MAX_ROWS} questions per import.` }] };
  }

  const questions = [];
  const errors = [];

  dataRows.forEach((row, i) => {
    const rowNum = i + 2; // 1-indexed, +1 for header row
    const text = String(row[colIndex.question] ?? '').trim();
    const options = optionIndices
      .map((idx) => String(row[idx] ?? '').trim())
      .filter((opt) => opt.length > 0);
    const rawAnswer = String(row[colIndex.answer] ?? '').trim();

    if (!text) {
      errors.push({ row: rowNum, error: 'Question text is empty.' });
      return;
    }
    if (options.length < 2) {
      errors.push({ row: rowNum, error: 'At least 2 non-empty options are required.' });
      return;
    }
    if (!rawAnswer) {
      errors.push({ row: rowNum, error: 'Answer is empty.' });
      return;
    }

    let correctAnswer = -1;
    // 1) exact text match against an option (case-insensitive)
    correctAnswer = options.findIndex((opt) => opt.toLowerCase() === rawAnswer.toLowerCase());
    // 2) letter form: A/B/C/D
    if (correctAnswer === -1 && /^[a-zA-Z]$/.test(rawAnswer)) {
      const letterIdx = rawAnswer.toUpperCase().charCodeAt(0) - 65;
      if (letterIdx >= 0 && letterIdx < options.length) correctAnswer = letterIdx;
    }
    // 3) numeric form: 1/2/3/4 (1-indexed)
    if (correctAnswer === -1 && /^\d+$/.test(rawAnswer)) {
      const numIdx = parseInt(rawAnswer, 10) - 1;
      if (numIdx >= 0 && numIdx < options.length) correctAnswer = numIdx;
    }

    if (correctAnswer === -1) {
      errors.push({ row: rowNum, error: `Answer "${rawAnswer}" does not match any option, letter (A-D), or option number.` });
      return;
    }

    questions.push({
      text,
      options,
      correctAnswer,
      subject: (colIndex.subject !== -1 && row[colIndex.subject]) ? String(row[colIndex.subject]).trim() : defaults.subject,
      marks: (colIndex.marks !== -1 && row[colIndex.marks]) ? Number(row[colIndex.marks]) || defaults.marks : defaults.marks,
      difficulty: (colIndex.difficulty !== -1 && row[colIndex.difficulty]) ? String(row[colIndex.difficulty]).trim() : defaults.difficulty,
      type: (colIndex.type !== -1 && row[colIndex.type]) ? String(row[colIndex.type]).trim() : defaults.type,
    });
  });

  return { questions, errors };
}

// Generates a downloadable template file in the requested format.
function generateTemplateBuffer(format) {
  const worksheet = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, ...TEMPLATE_ROWS]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Questions');

  const bookTypeMap = { xlsx: 'xlsx', xls: 'biff8', csv: 'csv' };
  const bookType = bookTypeMap[format];
  if (!bookType) throw new Error('Unsupported template format');

  return XLSX.write(workbook, { type: 'buffer', bookType });
}

module.exports = { parseQuestionsWorkbook, generateTemplateBuffer, MAX_ROWS };
