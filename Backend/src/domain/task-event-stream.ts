export type TaskEventCursorParseResult =
  | { ok: true; cursor: number }
  | { ok: false };

export type TaskEventResumeDecision =
  | { kind: 'resume'; cursor: number }
  | { kind: 'reset'; cursor: number; reason: 'cursor_not_found' | 'resume_window_expired' };

export function parseTaskEventCursor(
  lastEventId: string | undefined,
  after: string | undefined,
): TaskEventCursorParseResult {
  const headerCursor = parseCursorValue(lastEventId);
  const queryCursor = parseCursorValue(after);
  if (headerCursor === null || queryCursor === null) return { ok: false };
  return { ok: true, cursor: Math.max(headerCursor, queryCursor) };
}

export function decideTaskEventResume(input: {
  cursor: number;
  cursorOccurredAt: Date | null;
  latestEventId: number;
  now: Date;
  resumeWindowSeconds: number;
}): TaskEventResumeDecision {
  if (input.cursor === 0) return { kind: 'resume', cursor: 0 };
  if (!input.cursorOccurredAt) {
    return { kind: 'reset', cursor: input.latestEventId, reason: 'cursor_not_found' };
  }
  const resumeCutoff = input.now.getTime() - input.resumeWindowSeconds * 1_000;
  if (input.cursorOccurredAt.getTime() < resumeCutoff) {
    return { kind: 'reset', cursor: input.latestEventId, reason: 'resume_window_expired' };
  }
  return { kind: 'resume', cursor: input.cursor };
}

function parseCursorValue(value: string | undefined): number | null {
  if (value === undefined || value === '') return 0;
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : null;
}
