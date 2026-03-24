import crypto from 'crypto';

/**
 * Timing-safe string comparison using HMAC.
 * HMAC produces fixed-length digests, so neither value length nor content
 * leaks through timing side-channels.
 */
export function safeCompare(supplied: string, expected: string): boolean {
  const key = crypto.randomBytes(32);
  const a = crypto.createHmac('sha256', key).update(supplied).digest();
  const b = crypto.createHmac('sha256', key).update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
