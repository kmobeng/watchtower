import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMAIL_SENDER } from './senders/email-sender.interface';
import type { EmailSender } from './senders/email-sender.interface';

@Processor('notification')
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);
  constructor(
    @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    const log = { jobId: job.id, jobName: job.name };
    this.logger.log(log, `Processing notification job ${job.name}`);

    switch (job.name) {
      case 'send-email-verification': {
        const { to, token } = job.data;

        const message = `Please verify your email using the following token: ${token}. This token will expire in 10 minutes.`;

        await this.emailSender.send({
          to,
          subject: 'Email Verification (Expired in 10 minutes)',
          text: message,
        });
        break;
      }
      case 'send-password-reset': {
        const { to, token } = job.data;

        const resetURL = `${this.configService.get('APP_URL')}/reset-password/${token}`;

        const message = `You requested a password reset. Please click on the following link to reset your password: ${resetURL}
     This link is valid for 10 minutes. If you did not request this, please ignore this email.`;

        await this.emailSender.send({
          to,
          subject: 'Password Reset Request (Expired in 10 minutes)',
          text: message,
        });
        break;
      }
      case 'send-email-change-notice': {
        const { to, newEmail } = job.data as { to: string; newEmail?: string };

        const message = `A request was made to change the email address on your account${
          newEmail ? ` to ${newEmail}` : ''
        }. If this was you, use the code sent to that inbox to finish the change. If this wasn't you, please reset your password immediately and contact support.`;

        await this.emailSender.send({
          to,
          subject: 'Email Change Requested',
          text: message,
        });
        break;
      }
      default:
        this.logger.warn(log, `No handler for job name: ${job.name}`);
    }
  }
}
