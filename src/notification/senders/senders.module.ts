import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMAIL_SENDER, EmailSender } from './email-sender.interface';
import { SMS_SENDER, SmsSender } from './sms-sender.interface';
import { DevEmailSender } from './dev-email.sender';
import { ResendEmailSender } from './resend-email.sender';
import { DevSmsSender } from './dev-sms.sender';
import { TwilioSmsSender } from './twilio-sms.sender';

function buildEmailSender(configService: ConfigService): EmailSender {
  const provider = (
    configService.get<string>('EMAIL_PROVIDER') ?? 'dev'
  ).toLowerCase();

  switch (provider) {
    case 'dev':
      return new DevEmailSender(configService);
    case 'resend':
      return new ResendEmailSender(configService);
    default:
      throw new Error(`Unknown EMAIL_PROVIDER: ${provider}`);
  }
}

function buildSmsSender(configService: ConfigService): SmsSender {
  const provider = (
    configService.get<string>('SMS_PROVIDER') ?? 'dev'
  ).toLowerCase();

  switch (provider) {
    case 'dev':
      return new DevSmsSender();
    case 'twilio':
      return new TwilioSmsSender(configService);
    default:
      throw new Error(`Unknown SMS_PROVIDER: ${provider}`);
  }
}

@Module({
  providers: [
    {
      provide: EMAIL_SENDER,
      useFactory: buildEmailSender,
      inject: [ConfigService],
    },
    {
      provide: SMS_SENDER,
      useFactory: buildSmsSender,
      inject: [ConfigService],
    },
  ],
  exports: [EMAIL_SENDER, SMS_SENDER],
})
export class SendersModule {}
