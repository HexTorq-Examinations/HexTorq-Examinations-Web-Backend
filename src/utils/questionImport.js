const { buildTableBuffer, readRowsFromBuffer } = require('./tabularFiles');

const MAX_ROWS = 500;
const TEMPLATE_HEADERS = ['Question', 'Type', 'Marks', 'Difficulty', 'Option1', 'Option2', 'Option3', 'Option4', 'Answer'];
const TEMPLATE_ROWS = [
  ['What is the capital of France?', 'Multiple Choice', 1, 'Easy', 'Berlin', 'Madrid', 'Paris', 'Rome', 'Paris'],
  ['Water boils at 100 degrees Celsius.', 'True/False', 1, 'Medium', '', '', '', '', 'True'],
  ['Explain the significance of the Turing Test.', 'Descriptive', 5, 'Hard', '', '', '', '', ''],
];

const normalizeHeader = (h) => String(h || '').trim().toLowerCase().replace(/\s+/g, '');

// Parses an uploaded workbook buffer (.xlsx / .csv) into { questions, errors }.
// `defaults` supplies subject/marks/difficulty/type when the sheet doesn't provide its own columns.
async function parseQuestionsWorkbook(buffer, filename, defaults) {
  let rows;
  try {
    rows = await readRowsFromBuffer(buffer, filename);
  } catch (err) {
    return { questions: [], errors: [{ row: 0, error: 'The file could not be read. Make sure it is a valid .xlsx or .csv file.' }] };
  }

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

  if (colIndex.question === -1) {
    return {
      questions: [],
      errors: [{
        row: 0,
        error: 'The file must have a header row with at least the "Question" column.',
      }],
    };
  }

  const dataRows = rows.slice(1, MAX_ROWS + 1);
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

    const parsedType = (colIndex.type !== -1 && row[colIndex.type]) ? String(row[colIndex.type]).trim() : defaults.type;
    const parsedSubject = (colIndex.subject !== -1 && row[colIndex.subject]) ? String(row[colIndex.subject]).trim() : defaults.subject;
    const parsedMarks = (colIndex.marks !== -1 && row[colIndex.marks]) ? Number(row[colIndex.marks]) || defaults.marks : defaults.marks;
    const parsedDifficulty = (colIndex.difficulty !== -1 && row[colIndex.difficulty]) ? String(row[colIndex.difficulty]).trim() : defaults.difficulty;

    if (!text) {
      errors.push({ row: rowNum, error: 'Question text is empty.' });
      return;
    }

    let finalOptions = [];
    let finalCorrectAnswer = 0;

    if (parsedType === 'Descriptive') {
      finalOptions = [];
      finalCorrectAnswer = 0;
    } else if (parsedType === 'True/False') {
      finalOptions = ['True', 'False'];
      if (!rawAnswer) {
        errors.push({ row: rowNum, error: 'Answer is required for True/False questions (True or False).' });
        return;
      }
      const ansLower = rawAnswer.toLowerCase();
      if (ansLower === 'true' || ansLower === 't') {
        finalCorrectAnswer = 0;
      } else if (ansLower === 'false' || ansLower === 'f') {
        finalCorrectAnswer = 1;
      } else {
        errors.push({ row: rowNum, error: `Answer "${rawAnswer}" must be True or False.` });
        return;
      }
    } else {
      // Default to Multiple Choice
      finalOptions = options;
      if (finalOptions.length < 2) {
        errors.push({ row: rowNum, error: 'At least 2 non-empty options are required for Multiple Choice questions.' });
        return;
      }
      if (colIndex.answer === -1) {
        errors.push({ row: rowNum, error: 'An Answer column is required for Multiple Choice questions.' });
        return;
      }
      if (!rawAnswer) {
        errors.push({ row: rowNum, error: 'Answer is empty.' });
        return;
      }

      finalCorrectAnswer = -1;
      // 1) exact text match against an option (case-insensitive)
      finalCorrectAnswer = finalOptions.findIndex((opt) => opt.toLowerCase() === rawAnswer.toLowerCase());
      // 2) letter form: A/B/C/D
      if (finalCorrectAnswer === -1 && /^[a-zA-Z]$/.test(rawAnswer)) {
        const letterIdx = rawAnswer.toUpperCase().charCodeAt(0) - 65;
        if (letterIdx >= 0 && letterIdx < finalOptions.length) finalCorrectAnswer = letterIdx;
      }
      // 3) numeric form: 1/2/3/4 (1-indexed)
      if (finalCorrectAnswer === -1 && /^\d+$/.test(rawAnswer)) {
        const numIdx = parseInt(rawAnswer, 10) - 1;
        if (numIdx >= 0 && numIdx < finalOptions.length) finalCorrectAnswer = numIdx;
      }

      if (finalCorrectAnswer === -1) {
        errors.push({ row: rowNum, error: `Answer "${rawAnswer}" does not match any option, letter (A-D), or option number.` });
        return;
      }
    }

    questions.push({
      text,
      options: finalOptions,
      correctAnswer: finalCorrectAnswer,
      subject: parsedSubject,
      marks: parsedMarks,
      difficulty: parsedDifficulty,
      type: parsedType,
    });
  });

  return { questions, errors };
}

// Generates a downloadable template file in the requested format.
function generateTemplateBuffer(format) {
  return buildTableBuffer([TEMPLATE_HEADERS, ...TEMPLATE_ROWS], 'Questions', format);
}

module.exports = { parseQuestionsWorkbook, generateTemplateBuffer, MAX_ROWS };
