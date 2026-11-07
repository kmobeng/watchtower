import {
  escalationDeadline,
  parseEscalationSteps,
  tryParseEscalationSteps,
} from './escalation-steps';

describe('escalation steps', () => {
  const valid = [
    { afterMinutes: 5, notifyChannelId: 'chan-1' },
    { afterMinutes: 15, notifyChannelId: 'chan-2' },
  ];

  describe('parseEscalationSteps', () => {
    it('normalizes a valid ordered list', () => {
      expect(parseEscalationSteps(valid)).toEqual(valid);
    });

    it.each([
      ['a non-array', {}],
      ['an empty list', []],
      [
        'more than ten steps',
        Array.from({ length: 11 }, (_, i) => ({
          afterMinutes: i + 1,
          notifyChannelId: 'chan',
        })),
      ],
      ['a non-object entry', ['nope']],
      [
        'a non-integer afterMinutes',
        [{ afterMinutes: 1.5, notifyChannelId: 'c' }],
      ],
      ['a zero afterMinutes', [{ afterMinutes: 0, notifyChannelId: 'c' }]],
      ['a missing channel', [{ afterMinutes: 5 }]],
      ['an empty channel', [{ afterMinutes: 5, notifyChannelId: '' }]],
    ])('rejects %s', (_label, value) => {
      expect(() => parseEscalationSteps(value)).toThrow();
    });

    it('rejects non-increasing afterMinutes', () => {
      expect(() =>
        parseEscalationSteps([
          { afterMinutes: 10, notifyChannelId: 'a' },
          { afterMinutes: 10, notifyChannelId: 'b' },
        ]),
      ).toThrow();
      expect(() =>
        parseEscalationSteps([
          { afterMinutes: 10, notifyChannelId: 'a' },
          { afterMinutes: 5, notifyChannelId: 'b' },
        ]),
      ).toThrow();
    });
  });

  describe('tryParseEscalationSteps', () => {
    it('returns null instead of throwing on malformed data', () => {
      expect(tryParseEscalationSteps({ nope: true })).toBeNull();
      expect(tryParseEscalationSteps(valid)).toEqual(valid);
    });
  });

  describe('escalationDeadline', () => {
    it('offsets from startedAt by the step afterMinutes', () => {
      const startedAt = new Date('2026-01-01T00:00:00Z');

      expect(escalationDeadline(startedAt, valid, 0)?.toISOString()).toBe(
        '2026-01-01T00:05:00.000Z',
      );
      expect(escalationDeadline(startedAt, valid, 1)?.toISOString()).toBe(
        '2026-01-01T00:15:00.000Z',
      );
    });

    it('returns null past the last step', () => {
      expect(escalationDeadline(new Date(), valid, 2)).toBeNull();
    });
  });
});
