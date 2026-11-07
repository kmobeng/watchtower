import { Injectable, Logger } from '@nestjs/common';
import { SmsSender, SendSmsOptions } from './sms-sender.interface';

/**
 * Development sender: logs the message instead of spending money. The
 * destination is deliberately included so the live run can be asserted from
 * the app log.
 */
@Injectable()
export class DevSmsSender implements SmsSender {
  private readonly logger = new Logger(DevSmsSender.name);

  send(options: SendSmsOptions): Promise<void> {
    this.logger.log(
      { to: options.to, body: options.body },
      'SMS sent via development sender',
    );
    return Promise.resolve();
  }
}
