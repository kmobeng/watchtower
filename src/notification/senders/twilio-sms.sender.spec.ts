import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { TwilioSmsSender } from './twilio-sms.sender';

const config = (values: Record<string, string>) =>
  ({
    get: jest.fn((key: string) => values[key]),
  }) as unknown as ConfigService;

describe('TwilioSmsSender', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sid: 'SM123' }),
    });
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    (global as any).fetch = originalFetch;
  });

  it('posts form-encoded params with basic auth', async () => {
    const sender = new TwilioSmsSender(
      config({
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'token',
        TWILIO_FROM_NUMBER: '+15550001111',
      }),
    );

    await sender.send({ to: '+15551234567', body: 'Down' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json',
    );
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from('AC123:token').toString('base64')}`,
    );

    const body = init.body as URLSearchParams;
    expect(body.get('To')).toBe('+15551234567');
    expect(body.get('From')).toBe('+15550001111');
    expect(body.get('Body')).toBe('Down');
  });

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('bad request'),
    });
    const sender = new TwilioSmsSender(
      config({
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'token',
        TWILIO_FROM_NUMBER: '+15550001111',
      }),
    );

    await expect(
      sender.send({ to: '+15551234567', body: 'Down' }),
    ).rejects.toThrow('Twilio responded 400');
  });

  it('fails fast without credentials', () => {
    expect(
      () =>
        new TwilioSmsSender(
          config({ TWILIO_ACCOUNT_SID: 'AC123', TWILIO_FROM_NUMBER: 'x' }),
        ),
    ).toThrow('TWILIO_ACCOUNT_SID');
  });
});
