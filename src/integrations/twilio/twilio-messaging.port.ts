/**
 * Future Twilio SMS / voice integration — implement and register as a provider
 * without changing chat orchestration contracts.
 */
export abstract class TwilioMessagingPort {
  abstract sendTransactionalSms(_: { to: string; body: string }): Promise<void>;
}
