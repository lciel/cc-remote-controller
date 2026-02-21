import crypto from 'crypto';

export function safeCompare(supplied: string, expected: string): boolean {
  const bufSupplied = Buffer.from(supplied, 'utf-8');
  const bufExpected = Buffer.from(expected, 'utf-8');
  if (bufSupplied.length !== bufExpected.length) {
    crypto.timingSafeEqual(bufExpected, bufExpected);
    return false;
  }
  return crypto.timingSafeEqual(bufSupplied, bufExpected);
}
