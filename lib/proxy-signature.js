import crypto from 'node:crypto';

/**
 * Verifies the `signature` Shopify adds to every App Proxy request.
 * Algorithm (shopify.dev › Authenticate app proxies):
 *  1. take all query params except `signature`
 *  2. join repeated keys' values with ","
 *  3. format "key=value", sort, concatenate with no separator
 *  4. HMAC-SHA256 with the app's client secret, hex, constant-time compare
 */
export function verifyProxySignature(searchParams, secret) {
  const signature = searchParams.get('signature');
  if (!signature || !secret) return false;

  const grouped = new Map();
  for (const [key, value] of searchParams) {
    if (key === 'signature') continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(value);
  }
  const message = [...grouped]
    .map(([key, values]) => `${key}=${values.join(',')}`)
    .sort()
    .join('');

  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Rejects replayed requests: Shopify's `timestamp` must be recent (default 15 min). */
export function isFreshTimestamp(searchParams, maxAgeSeconds = 900, now = Date.now()) {
  const ts = Number(searchParams.get('timestamp'));
  if (!Number.isFinite(ts)) return false;
  return Math.abs(now / 1000 - ts) <= maxAgeSeconds;
}
