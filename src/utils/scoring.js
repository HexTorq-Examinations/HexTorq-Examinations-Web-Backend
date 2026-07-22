const roundScore = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

const canonicalAnswer = (value) => String(value ?? '').trim().replace(/^(\d{1,2})\/(\d{1,2})$/, '$1-$2');

const answersMatch = (given, correct) => canonicalAnswer(given) === canonicalAnswer(correct);

const scoreAttemptSnapshot = (questions, answers, { negativeMarking = false, negativeMarkingRate = 0.25 } = {}) => {
  const total = questions.reduce((score, question) => {
    const given = answers[question.id];
    if (given === undefined || given === null || given === '') return score;
    if (answersMatch(given, question.correctAnswer)) return score + question.marks;
    return negativeMarking ? score - (question.marks * negativeMarkingRate) : score;
  }, 0);
  return roundScore(total);
};

module.exports = { answersMatch, canonicalAnswer, scoreAttemptSnapshot };
