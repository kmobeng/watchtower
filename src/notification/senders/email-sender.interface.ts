export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * Forwarded to providers that support it (Resend). Providers without an
   * idempotency mechanism ignore it.
   */
  idempotencyKey?: string;
}

export interface EmailSender {
  send(options: SendEmailOptions): Promise<void>;
}
