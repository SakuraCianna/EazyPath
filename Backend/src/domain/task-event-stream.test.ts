import { describe, expect, it } from 'vitest';
import { decideTaskEventResume, parseTaskEventCursor } from './task-event-stream.js';

describe('task event stream cursor', () => {
  it('uses the newest valid header or query cursor', () => {
    expect(parseTaskEventCursor('12', '9')).toEqual({ ok: true, cursor: 12 });
    expect(parseTaskEventCursor(undefined, undefined)).toEqual({ ok: true, cursor: 0 });
  });

  it('rejects ambiguous, negative, decimal, and unsafe cursors', () => {
    expect(parseTaskEventCursor('1e3', undefined)).toEqual({ ok: false });
    expect(parseTaskEventCursor('-1', undefined)).toEqual({ ok: false });
    expect(parseTaskEventCursor(undefined, '1.5')).toEqual({ ok: false });
    expect(parseTaskEventCursor('9007199254740992', undefined)).toEqual({ ok: false });
  });

  it('resumes a cursor that belongs to the task and remains in the window', () => {
    expect(decideTaskEventResume({
      cursor: 8,
      cursorOccurredAt: new Date('2026-08-11T00:59:59.000Z'),
      latestEventId: 12,
      now: new Date('2026-08-11T01:00:00.000Z'),
      resumeWindowSeconds: 86_400,
    })).toEqual({ kind: 'resume', cursor: 8 });
  });

  it('resets missing or expired cursors to the latest task event', () => {
    expect(decideTaskEventResume({
      cursor: 8,
      cursorOccurredAt: null,
      latestEventId: 12,
      now: new Date('2026-08-11T01:00:00.000Z'),
      resumeWindowSeconds: 86_400,
    })).toEqual({ kind: 'reset', cursor: 12, reason: 'cursor_not_found' });
    expect(decideTaskEventResume({
      cursor: 8,
      cursorOccurredAt: new Date('2026-08-09T00:00:00.000Z'),
      latestEventId: 12,
      now: new Date('2026-08-11T01:00:00.000Z'),
      resumeWindowSeconds: 86_400,
    })).toEqual({ kind: 'reset', cursor: 12, reason: 'resume_window_expired' });
  });
});
