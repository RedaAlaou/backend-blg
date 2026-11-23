export const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-10';

/** An error whose message is safe to show the customer. */
export class PublicError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

let cachedToken = null; // { shop, token, expiresAt }

/**
 * Dev Dashboard apps don't show a permanent token: we exchange the client ID/secret
 * for a ~24h token (client credentials grant) and cache it while the function is warm.
 */
export async function getAccessToken(shop) {
  if (cachedToken && cachedToken.shop === shop && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID || '',
      client_secret: process.env.SHOPIFY_CLIENT_SECRET || '',
    }),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* handled below */ }
  if (!res.ok || !data?.access_token) {
    throw new Error(`Shopify token request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const ttl = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
  cachedToken = { shop, token: data.access_token, expiresAt: Date.now() + ttl * 1000 };
  return cachedToken.token;
}

export function clearTokenCache() {
  cachedToken = null;
}

export async function adminGraphql(shop, query, variables = {}) {
  const token = await getAccessToken(shop);
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 || res.status === 403) clearTokenCache();
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* handled below */ }
  if (!res.ok || !body || body.errors) {
    throw new Error(`Shopify GraphQL error (${res.status}): ${text.slice(0, 500)}`);
  }
  return body.data;
}
