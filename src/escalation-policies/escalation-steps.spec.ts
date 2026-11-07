import {
  escalationDeadline,
  parseEscalationSteps,
  tryParseEscalationSteps,
} from './escalation-steps';

const CHAN_1 = '11111111-1111-4111-8111-111111111111';
const CHAN_2 = '22222222-2222-4222-8222-222222222222';

describe('escalation steps', () => {
  const valid = [
    { afterMinutes: 5, notifyChannelId: CHAN_1 },
    { afterMinutes: 15, notifyChannelId: CHAN_2 },
  ];

  describe('parseEscalationSteps', () => {
    it('normalizes a valid ordered list', () => {
      expect(parseEscalationSteps(valid)).toEqual(valid);
    });

    it('accepts an immediate first step', () => {
      expect(
        parseEscalationSteps([{ afterMinutes: 0, notifyChannelId: CHAN_1 }]),
      ).toEqual([{ afterMinutes: 0, notifyChannelId: CHAN_1 }]);
    });

    it.each([
      ['a non-array', {}],
      ['an empty list', []],
      [
        'more than ten steps',
        Array.from({ length: 11 }, (_, i) => ({
          afterMinutes: i + 1,
          notifyChannelId: CHAN_1,
        })),
      ],
      ['a non-object entry', ['nope']],
      [
        'a non-integer afterMinutes',
        [{ afterMinutes: 1.5, notifyChannelId: CHAN_1 }],
      ],
      [
        'a negative afterMinutes',
        [{ afterMinutes: -1, notifyChannelId: CHAN_1 }],
      ],
      ['a missing channel', [{ afterMinutes: 5 }]],
      ['a non-UUID channel', [{ afterMinutes: 5, notifyChannelId: 'chan-1' }]],
    ])('rejects %s', (_label, value) => {
      expect(() => parseEscalationSteps(value)).toThrow();
    });

    it('rejects non-increasing afterMinutes', () => {
      expect(() =>
        parseEscalationSteps([
          { afterMinutes: 10, notifyChannelId: CHAN_1 },
          { afterMinutes: 10, notifyChannelId: CHAN_2 },
        ]),
      ).toThrow();
      expect(() =>
        parseEscalationSteps([
          { afterMinutes: 10, notifyChannelId: CHAN_1 },
          { afterMinutes: 5, notifyChannelId: CHAN_2 },
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

    it('returns startedAt for an immediate step', () => {
      const startedAt = new Date('2026-01-01T00:00:00Z');
      const immediate = [{ afterMinutes: 0, notifyChannelId: CHAN_1 }];

      expect(escalationDeadline(startedAt, immediate, 0)?.getTime()).toBe(
        startedAt.getTime(),
      );
    });

    it('returns null past the last step', () => {
      expect(escalationDeadline(new Date(), valid, 2)).toBeNull();
    });
  });
});
