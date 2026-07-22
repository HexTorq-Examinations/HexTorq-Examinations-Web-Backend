require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { repairQuestionOptions } = require('../src/utils/questionOptionRepair');

const apply = process.argv.includes('--apply');

async function main() {
  const questions = await prisma.question.findMany({
    select: { id: true, text: true, options: true },
  });
  const changed = questions
    .map((question) => ({ question, repaired: repairQuestionOptions(question.options) }))
    .filter((item) => item.repaired.changed);

  if (apply) {
    for (const item of changed) {
      await prisma.question.update({
        where: { id: item.question.id },
        data: { options: item.repaired.options },
      });
    }
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    scanned: questions.length,
    changed: changed.length,
    samples: changed.slice(0, 10).map((item) => ({
      id: item.question.id,
      text: item.question.text.slice(0, 120),
      before: item.question.options,
      after: item.repaired.options,
    })),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
