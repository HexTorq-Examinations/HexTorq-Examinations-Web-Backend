require('dotenv').config();

const prisma = require('../src/lib/prisma');

const MONTH_DAY_SLASH_RE = /^([1-9]|1[0-2])\/([1-9]|[12]\d|3[01])$/;

const convertValue = (value) => {
  const text = String(value ?? '').trim();
  return text.replace(MONTH_DAY_SLASH_RE, '$1-$2');
};

const repairValues = (values) => {
  if (!Array.isArray(values)) return { values, changed: false };
  const repaired = values.map(convertValue);
  return {
    values: repaired,
    changed: repaired.some((value, index) => value !== values[index]),
  };
};

const main = async () => {
  const apply = process.argv.includes('--apply');
  const questions = await prisma.question.findMany({ select: { id: true, text: true, options: true } });
  const changed = [];

  for (const question of questions) {
    const repaired = repairValues(question.options);
    if (!repaired.changed) continue;
    changed.push({ id: question.id, text: question.text, before: question.options, after: repaired.values });
    if (apply) {
      await prisma.question.update({
        where: { id: question.id },
        data: { options: repaired.values },
      });
    }
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    scanned: questions.length,
    changed: changed.length,
    samples: changed.slice(0, 20),
  }, null, 2));
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
