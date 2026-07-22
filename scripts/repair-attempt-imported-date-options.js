require('dotenv').config();

const prisma = require('../src/lib/prisma');
const { repairQuestionOptions } = require('../src/utils/questionOptionRepair');
const { answersMatch } = require('../src/utils/scoring');

const repairSnapshot = (snapshot) => {
  if (!Array.isArray(snapshot)) return { snapshot, changed: false };
  let changed = false;
  const repaired = snapshot.map((question) => {
    const optionsRepair = repairQuestionOptions(question.options);
    const options = optionsRepair.options;
    const correctAnswer = options.find((option) => answersMatch(option, question.correctAnswer)) || question.correctAnswer;
    const next = { ...question, options, correctAnswer };
    changed = changed
      || optionsRepair.changed
      || correctAnswer !== question.correctAnswer;
    return next;
  });
  return { snapshot: repaired, changed };
};

const normalizeAnswer = (question, answer) => {
  if (answer === undefined || answer === null || answer === '') return answer;
  return question?.options?.find((option) => answersMatch(option, answer)) || answer;
};

const repairAnswerMap = (answers, snapshot) => {
  const entries = Object.entries(answers || {});
  let changed = false;
  const repaired = Object.fromEntries(entries.map(([questionId, answer]) => {
    const question = snapshot.find((item) => item.id === questionId);
    const normalized = normalizeAnswer(question, answer);
    changed = changed || normalized !== answer;
    return [questionId, normalized];
  }));
  return { answers: repaired, changed };
};

const main = async () => {
  const apply = process.argv.includes('--apply');
  const attempts = await prisma.examAttempt.findMany({
    select: {
      id: true,
      status: true,
      questionSnapshot: true,
      answers: true,
      answerRecords: { select: { id: true, questionId: true, selectedAnswer: true } },
    },
  });

  const changed = [];
  for (const attempt of attempts) {
    const snapshotRepair = repairSnapshot(attempt.questionSnapshot);
    const snapshot = Array.isArray(snapshotRepair.snapshot) ? snapshotRepair.snapshot : [];
    const legacyRepair = repairAnswerMap(attempt.answers || {}, snapshot);
    const recordRepairs = attempt.answerRecords
      .map((record) => {
        const question = snapshot.find((item) => item.id === record.questionId);
        const selectedAnswer = normalizeAnswer(question, record.selectedAnswer);
        return { ...record, selectedAnswer, changed: selectedAnswer !== record.selectedAnswer };
      })
      .filter((record) => record.changed);

    if (!snapshotRepair.changed && !legacyRepair.changed && recordRepairs.length === 0) continue;

    changed.push({
      id: attempt.id,
      status: attempt.status,
      snapshotChanged: snapshotRepair.changed,
      legacyAnswersChanged: legacyRepair.changed,
      answerRecordsChanged: recordRepairs.length,
    });

    if (apply) {
      await prisma.$transaction([
        ...(snapshotRepair.changed || legacyRepair.changed
          ? [prisma.examAttempt.update({
              where: { id: attempt.id },
              data: {
                ...(snapshotRepair.changed ? { questionSnapshot: snapshotRepair.snapshot } : {}),
                ...(legacyRepair.changed ? { answers: legacyRepair.answers } : {}),
              },
            })]
          : []),
        ...recordRepairs.map((record) => prisma.examAnswer.update({
          where: { id: record.id },
          data: { selectedAnswer: record.selectedAnswer },
        })),
      ]);
    }
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    scanned: attempts.length,
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
