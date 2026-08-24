export interface ResolvedTurnAnswer {
  answer: string;
  usedEmptyFallback: boolean;
}

export function resolveTurnAnswer(input: {
  answer: string;
  attachmentCount: number;
  emptyAnswer: string;
}): ResolvedTurnAnswer {
  if (!input.answer.trim() && input.attachmentCount === 0) {
    return { answer: input.emptyAnswer, usedEmptyFallback: true };
  }
  return { answer: input.answer, usedEmptyFallback: false };
}
