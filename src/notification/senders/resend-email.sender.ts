import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailSender, SendEmailOptions } from './email-sender.interface';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

type ResendResponse = {
  id?: string;
  message?: string;
};

@Injectable()
export class ResendEmailSender implements EmailSender {
  private readonly logger = new Logger(ResendEmailSender.name);
  private readonly apiKey: string;
  private readonly from: string;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('RESEND_API_KEY') ?? '';
    this.from = this.configService.get<string>('EMAIL_FROM') ?? '';

    if (!this.apiKey) {
      throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
    }
    if (!this.from) {
      throw new Error('EMAIL_FROM is missing in environment variables');
    }
  }

  async send(options: SendEmailOptions): Promise<void> {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...(options.idempotencyKey
          ? { 'Idempotency-Key': options.idempotencyKey.slice(0, 256) }
          : {}),
      },
      body: JSON.stringify({
        from: this.from,
        to: [options.to],
        subject: options.subject,
        text: options.text,
        ...(options.html ? { html: options.html } : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.error(
        `Resend rejected ${options.to} with ${response.status}: ${detail.slice(0, 200)}`,
      );
      throw new Error(`Resend responded ${response.status}`);
    }

    const body = (await response.json().catch(() => ({}))) as ResendResponse;
    this.logger.log({ id: body.id }, 'Resend accepted email');
  }
}
