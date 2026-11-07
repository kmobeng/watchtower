import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsSender, SendSmsOptions } from './sms-sender.interface';

/**
 * Twilio HTTP adapter. Shapes confirmed against
 * https://www.twilio.com/docs/messaging/api/message-resource:
 * POST /2010-04-01/Accounts/{AccountSid}/Messages.json with
 * application/x-www-form-urlencoded and Basic auth.
 *
 * Twilio exposes no idempotency key, so a crash between provider-accept and
 * our own `SENT` write can duplicate an SMS. The delivery row narrows the
 * window; it cannot close it.
 */
@Injectable()
export class TwilioSmsSender implements SmsSender {
  private readonly logger = new Logger(TwilioSmsSender.name);
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly from: string;

  constructor(private readonly configService: ConfigService) {
    this.accountSid =
      this.configService.get<string>('TWILIO_ACCOUNT_SID') ?? '';
    this.authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN') ?? '';
    this.from = this.configService.get<string>('TWILIO_FROM_NUMBER') ?? '';

    if (!this.accountSid || !this.authToken || !this.from) {
      throw new Error(
        'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER are required when SMS_PROVIDER=twilio',
      );
    }
  }

  async send(options: SendSmsOptions): Promise<void> {
    const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const credentials = Buffer.from(
      `${this.accountSid}:${this.authToken}`,
    ).toString('base64');

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: options.to,
        From: this.from,
        Body: options.body,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.error(
        `Twilio rejected ${options.to} with ${response.status}: ${detail.slice(0, 200)}`,
      );
      throw new Error(`Twilio responded ${response.status}`);
    }

    const body = (await response.json().catch(() => ({}))) as { sid?: string };
    this.logger.log({ sid: body.sid }, 'Twilio accepted SMS');
  }
}
