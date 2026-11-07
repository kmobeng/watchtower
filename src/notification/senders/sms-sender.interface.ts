export const SMS_SENDER = Symbol('SMS_SENDER');

export interface SendSmsOptions {
  to: string;
  body: string;
}

export interface SmsSender {
  send(options: SendSmsOptions): Promise<void>;
}
