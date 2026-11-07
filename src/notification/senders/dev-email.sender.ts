import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';
import { Logger } from '@nestjs/common';
import { EmailSender, SendEmailOptions } from './email-sender.interface';

/**
 * Development sender: hands mail to Mailpit over plain SMTP on localhost.
 * No credentials are read, so this must never be selected in production.
 */
@Injectable()
export class DevEmailSender implements EmailSender {
  private readonly logger = new Logger(DevEmailSender.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(private readonly configService: ConfigService) {
    this.from = this.configService.get<string>('EMAIL_FROM') ?? '';
    if (!this.from) {
      throw new Error('EMAIL_FROM is missing in environment variables');
    }

    this.transporter = nodemailer.createTransport({
      host: 'localhost',
      port: 1025,
      secure: false,
    });
  }

  async send(options: SendEmailOptions): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
      });
    } catch (err) {
      this.logger.error(`Failed to send email to ${options.to}`, err);
      throw new InternalServerErrorException('Failed to send email');
    }
  }
}
