import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { ResendEmailSender } from './resend-email.sender';

const config = (values: Record<string, string>) =>
  ({
    get: jest.fn((key: string) => values[key]),
  }) as unknown as ConfigService;

describe('ResendEmailSender', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'email-1' }),
    });
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    (global as any).fetch = originalFetch;
  });

  it('posts the documented body with a bearer token and idempotency key', async () => {
    const sender = new ResendEmailSender(
      config({ RESEND_API_KEY: 're_x', EMAIL_FROM: 'WatchTower <a@b.c>' }),
    );

    await sender.send({
      to: 'jane@example.com',
      subject: 'Down',
      text: 'body',
      html: '<p>body</p>',
      idempotencyKey: 'inc-1:chan-1:0',
    });

    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer re_x',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'inc-1:chan-1:0',
      },
      body: JSON.stringify({
        from: 'WatchTower <a@b.c>',
        to: ['jane@example.com'],
        subject: 'Down',
        text: 'body',
        html: '<p>body</p>',
      }),
    });
  });

  it('omits the idempotency header when none is supplied', async () => {
    const sender = new ResendEmailSender(
      config({ RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@b.c' }),
    );

    await sender.send({ to: 'jane@example.com', subject: 'S', text: 'T' });

    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty(
      'Idempotency-Key',
    );
  });

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('invalid'),
    });
    const sender = new ResendEmailSender(
      config({ RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@b.c' }),
    );

    await expect(
      sender.send({ to: 'jane@example.com', subject: 'S', text: 'T' }),
    ).rejects.toThrow('Resend responded 422');
  });

  it('fails fast without an API key', () => {
    expect(
      () => new ResendEmailSender(config({ EMAIL_FROM: 'a@b.c' })),
    ).toThrow('RESEND_API_KEY');
  });
});
