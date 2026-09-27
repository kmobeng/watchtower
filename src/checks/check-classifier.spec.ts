import { classifyCheck } from './check-classifier';

describe('classifyCheck', () => {
  it.each([200, 201, 204, 301, 302, 399])(
    'treats %i as up',
    (statusCode) => {
      expect(classifyCheck(statusCode)).toBe(true);
    },
  );

  it.each([400, 404, 500, 502, 503])('treats %i as down', (statusCode) => {
    expect(classifyCheck(statusCode)).toBe(false);
  });

  it('treats a missing response (timeout/network) as down', () => {
    expect(classifyCheck(null)).toBe(false);
  });
});
