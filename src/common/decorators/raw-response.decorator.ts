import { SetMetadata } from '@nestjs/common';

/**
 * Marks a handler that writes its own response (e.g. a server-sent-event stream). The global
 * JSON envelope and post-handler header writes are skipped for it.
 */
export const RAW_RESPONSE = 'amqur:raw-response';
export const RawResponse = () => SetMetadata(RAW_RESPONSE, true);

export function isRawResponse(handler: unknown): boolean {
  return (
    typeof handler === 'function' &&
    Reflect.getMetadata(RAW_RESPONSE, handler) === true
  );
}
