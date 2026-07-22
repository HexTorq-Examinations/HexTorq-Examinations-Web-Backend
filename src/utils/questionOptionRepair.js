const JS_DATE_OPTION_RE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT[+-]\d{4} /;

const MONTHS = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

const simplifyImportedDateOption = (value) => {
  const text = String(value || '').trim();
  const match = text.match(JS_DATE_OPTION_RE);
  if (!match) return text;
  const [, , monthName, dayRaw, yearRaw, hourRaw, minuteRaw, secondRaw] = match;
  const month = MONTHS[monthName];
  const day = Number(dayRaw);
  const year = Number(yearRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);

  if (year === 1899 && month === 12 && day === 30) {
    return `${hour}:${String(minute + (second >= 30 ? 1 : 0)).padStart(2, '0')}`;
  }
  return `${month}-${day}`;
};

const repairQuestionOptions = (options) => {
  if (!Array.isArray(options)) return { options, changed: false };
  const repaired = options.map(simplifyImportedDateOption);
  return {
    options: repaired,
    changed: repaired.some((option, index) => option !== options[index]),
  };
};

module.exports = {
  JS_DATE_OPTION_RE,
  simplifyImportedDateOption,
  repairQuestionOptions,
};
