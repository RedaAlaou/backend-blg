// Shopify App Proxy target:  https://<store>/apps/cod-order  →  https://<this-project>.vercel.app/api/cod-order
import { verifyProxySignature, isFreshTimestamp } from '../lib/proxy-signature.js';
import { parseCodForm, createCodOrder } from '../lib/order.js';
import { PublicError } from '../lib/shopify.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Checks config + Shopify signature. Returns the shop domain, or a Response to send back. */
function authenticate(request) {
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret || !process.env.SHOPIFY_CLIENT_ID) {
    console.error('Missing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env vars');
    return json({ ok: false, error: 'Configuration serveur incomplète.' }, 500);
  }
  const params = new URL(request.url).searchParams;
  if (!verifyProxySignature(params, secret)) {
    return json({ ok: false, error: 'Requête non autorisée (signature Shopify invalide).' }, 401);
  }
  if (!isFreshTimestamp(params)) {
    return json({ ok: false, error: 'Requête expirée. Rechargez la page et réessayez.' }, 401);
  }
  const shop = (params.get('shop') || '').toLowerCase();
  const allowed = (process.env.SHOPIFY_SHOP || '').toLowerCase();
  if (!SHOP_RE.test(shop) || (allowed && shop !== allowed)) {
    return json({ ok: false, error: 'Boutique non autorisée.' }, 403);
  }
  return shop;
}

/** Visit https://<store>/apps/cod-order in a browser to check the proxy is wired up. */
export async function GET(request) {
  const shop = authenticate(request);
  if (shop instanceof Response) return shop;
  return json({ ok: true, message: 'App Proxy COD connecté ✅', shop });
}

export async function POST(request) {
  const shop = authenticate(request);
  if (shop instanceof Response) return shop;

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'Formulaire illisible. Rechargez la page et réessayez.' }, 400);
  }

  try {
    const input = parseCodForm(form);
    const order = await createCodOrder(shop, input);
    console.log(`COD order ${order.name}${order.duplicate ? ' (duplicate submit)' : ''} for ${shop}`);
    return json({ ok: true, order_name: order.name });
  } catch (err) {
    if (err instanceof PublicError) return json({ ok: false, error: err.message }, err.status);
    console.error('COD order failed:', err);
    return json(
      { ok: false, error: 'La commande n’a pas pu être enregistrée. Réessayez dans un instant ou contactez-nous.' },
      502,
    );
  }
}
