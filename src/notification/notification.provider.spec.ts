import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NotificationProcessor } from './notification.provider';

describe('NotificationProcessor auth emails', () => {
  let processor: NotificationProcessor;
  let emailSender: { send: jest.Mock };

  beforeEach(() => {
    emailSender = { send: jest.fn().mockResolvedValue(undefined) };
    const config = {
      get: jest.fn((key: string) =>
        key === 'APP_URL' ? 'http://localhost:3000' : undefined,
      ),
    } as unknown as ConfigService;

    processor = new NotificationProcessor(emailSender, config);
  });

  it('sends the verification email through the sender interface', async () => {
    await processor.process({
      name: 'send-email-verification',
      data: { to: 'jane@example.com', token: '123456' },
    } as any);

    expect(emailSender.send).toHaveBeenCalledWith({
      to: 'jane@example.com',
      subject: 'Email Verification (Expired in 10 minutes)',
      text: expect.stringContaining('123456'),
    });
  });

  it('builds the reset link from APP_URL', async () => {
    await processor.process({
      name: 'send-password-reset',
      data: { to: 'jane@example.com', token: 'tok' },
    } as any);

    expect(emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'jane@example.com',
        text: expect.stringContaining(
          'http://localhost:3000/reset-password/tok',
        ),
      }),
    );
  });

  it('sends the email-change notice', async () => {
    await processor.process({
      name: 'send-email-change-notice',
      data: { to: 'jane@example.com', newEmail: 'new@example.com' },
    } as any);

    expect(emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'jane@example.com',
        text: expect.stringContaining('new@example.com'),
      }),
    );
  });

  it('warns instead of sending for an unknown job', async () => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    (processor as any).logger = logger;

    await processor.process({ name: 'nope', data: {} } as any);

    expect(emailSender.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
