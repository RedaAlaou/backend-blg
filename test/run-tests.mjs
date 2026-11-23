// Local tests: no network, Shopify is mocked. Run with `npm test`.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SHOPIFY_CLIENT_ID = 'test-client-id';
process.env.SHOPIFY_CLIENT_SECRET = 'test-secret';
process.env.SHOPIFY_SHOP = 'blg-test.myshopify.com';

const { verifyProxySignature } = await import('../lib/proxy-signature.js');
const { normalizePhone, freePairIndex } = await import('../lib/order.js');
const { clearTokenCache } = await import('../lib/shopify.js');
const { GET, POST } = await import('../api/cod-order.js');

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('✓', name); }
  catch (e) { console.error('✗', name, '\n ', e); process.exitCode = 1; }
};

// ---------- Shopify's official signature examples ----------
await test('signature: Shopify doc example (logged-in customer)', () => {
  const q = new URLSearchParams('extra=1&extra=2&shop=shop-name.myshopify.com&logged_in_customer_id=1&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555&signature=4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb');
  assert.equal(verifyProxySignature(q, 'hush'), true);
});
await test('signature: Shopify doc example (anonymous customer)', () => {
  const q = new URLSearchParams('extra=1&extra=2&shop=shop-name.myshopify.com&logged_in_customer_id=&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555&signature=e072b6d7e6622d85912a5214b860d3100dc1e73d9bc29f43796ac8c9ff8093cb');
  assert.equal(verifyProxySignature(q, 'hush'), true);
});
await test('signature: tampered request rejected', () => {
  const q = new URLSearchParams('extra=1&extra=2&shop=evil.myshopify.com&logged_in_customer_id=1&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555&signature=4c68c8624d737112c91818c11017d24d334b524cb5c2b8ba08daa056f7395ddb');
  assert.equal(verifyProxySignature(q, 'hush'), false);
});

// ---------- helpers ----------
await test('phone normalisation (Morocco)', () => {
  assert.equal(normalizePhone('06 12 34 56 78', 'MA'), '+212612345678');
  assert.equal(normalizePhone('+212 7 12 34 56 78', 'MA'), '+212712345678');
  assert.equal(normalizePhone('00212612345678', 'MA'), '+212612345678');
  assert.equal(normalizePhone('0522 11 22 33', 'MA'), '+212522112233');
  assert.equal(normalizePhone('12345', 'MA'), null);
  assert.equal(normalizePhone('08 12 34 56 78', 'MA'), null);
});
await test('cheapest pair is the free one', () => {
  assert.equal(freePairIndex([19900, 19900, 19900]), 0);
  assert.equal(freePairIndex([24900, 19900, 22900]), 1);
});

// ---------- mocked Shopify ----------
const PRODUCT = 'gid://shopify/Product/111';
const VARIANTS = {
  'gid://shopify/ProductVariant/1': { __typename: 'ProductVariant', id: 'gid://shopify/ProductVariant/1', title: 'Noir / 40', price: '199.00', availableForSale: true, product: { id: PRODUCT, title: 'Sabot' } },
  'gid://shopify/ProductVariant/2': { __typename: 'ProductVariant', id: 'gid://shopify/ProductVariant/2', title: 'Blanc / 42', price: '249.00', availableForSale: true, product: { id: PRODUCT, title: 'Sabot' } },
  'gid://shopify/ProductVariant/3': { __typename: 'ProductVariant', id: 'gid://shopify/ProductVariant/3', title: 'Bleu / 44', price: '199.00', availableForSale: false, product: { id: PRODUCT, title: 'Sabot' } },
  'gid://shopify/ProductVariant/9': { __typename: 'ProductVariant', id: 'gid://shopify/ProductVariant/9', title: 'Autre', price: '10.00', availableForSale: true, product: { id: 'gid://shopify/Product/999', title: 'Autre' } },
};
let calls, createdOrders, existingTags, tokenRequests, orderCounter;
const reset = () => { calls = []; createdOrders = []; existingTags = new Map(); tokenRequests = 0; orderCounter = 1000; clearTokenCache(); };

globalThis.fetch = async (url, init) => {
  calls.push(url);
  if (url === 'https://blg-test.myshopify.com/admin/oauth/access_token') {
    tokenRequests++;
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'client_credentials');
    assert.equal(body.get('client_secret'), 'test-secret');
    return new Response(JSON.stringify({ access_token: 'shpat_mock', scope: 'write_orders,read_products', expires_in: 86399 }));
  }
  if (url.startsWith('https://blg-test.myshopify.com/admin/api/') && url.endsWith('/graphql.json')) {
    assert.equal(init.headers['X-Shopify-Access-Token'], 'shpat_mock');
    const { query, variables } = JSON.parse(init.body);
    if (query.includes('CodExisting')) {
      const tag = variables.q.match(/tag:"(.+)"/)[1];
      const found = existingTags.get(tag);
      return Response.json({ data: { orders: { nodes: found ? [found] : [] } } });
    }
    if (query.includes('CodVariants')) {
      return Response.json({ data: { shop: { currencyCode: 'MAD' }, nodes: variables.ids.map((id) => VARIANTS[id] || null) } });
    }
    if (query.includes('CodOrderCreate')) {
      createdOrders.push(variables);
      const name = `#${++orderCounter}`;
      const sid = variables.order.tags.find((t) => t.startsWith('cod-'));
      if (sid) existingTags.set(sid, { id: 'gid://shopify/Order/1', name });
      return Response.json({ data: { orderCreate: { order: { id: 'gid://shopify/Order/1', name }, userErrors: [] } } });
    }
  }
  throw new Error('Unexpected fetch ' + url);
};

const sign = (params) => {
  const grouped = new Map();
  for (const [k, v] of params) { if (!grouped.has(k)) grouped.set(k, []); grouped.get(k).push(v); }
  const msg = [...grouped].map(([k, v]) => `${k}=${v.join(',')}`).sort().join('');
  params.set('signature', crypto.createHmac('sha256', 'test-secret').update(msg).digest('hex'));
  return params;
};
const proxyUrl = ({ shop = 'blg-test.myshopify.com', timestamp = Math.floor(Date.now() / 1000), badSig = false } = {}) => {
  const p = sign(new URLSearchParams({ shop, logged_in_customer_id: '', path_prefix: '/apps/cod-order', timestamp: String(timestamp) }));
  if (badSig) p.set('signature', '0'.repeat(64));
  return 'https://blg-cod.vercel.app/api/cod-order?' + p.toString();
};
// Exactly what the patched theme sends: URL-encoded FormData.
const formBody = (overrides = {}) => new URLSearchParams({
  full_name: 'Reda Alaoui', phone: '06 12 34 56 78', city: 'Fès', address: 'Quartier Atlas, rue 5, n°12',
  offer: '1', variant_1: '1', product_id: '111', country_code: 'MA', submission_id: crypto.randomUUID(),
  ...overrides,
});
const post = (body, urlOpts) => POST(new Request(proxyUrl(urlOpts), {
  method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
}));

// ---------- end-to-end handler tests ----------
await test('GET through proxy says connected', async () => {
  reset();
  const res = await GET(new Request(proxyUrl()));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal((await res.json()).ok, true);
});

await test('1 pair → pending COD order at Shopify price', async () => {
  reset();
  const res = await post(formBody());
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.deepEqual(data, { ok: true, order_name: '#1001' });
  const { order, options } = createdOrders[0];
  assert.equal(order.financialStatus, 'PENDING');
  assert.equal(order.currency, 'MAD');
  assert.equal(order.lineItems.length, 1);
  assert.equal(order.lineItems[0].priceSet.shopMoney.amount, '199.00');
  assert.equal(order.lineItems[0].requiresShipping, true);
  assert.equal(order.shippingAddress.phone, '+212612345678');
  assert.equal(order.shippingAddress.firstName, 'Reda');
  assert.equal(order.shippingAddress.lastName, 'Alaoui');
  assert.equal(order.shippingAddress.city, 'Fès');
  assert.equal(options.inventoryBehaviour, 'DECREMENT_OBEYING_POLICY');
});

await test('3 pairs → cheapest one free, total = 199 + 249 = 448 MAD', async () => {
  reset();
  const res = await post(formBody({ offer: '3', variant_1: '2', variant_2: '1', variant_3: '2' }));
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  const items = createdOrders[0].order.lineItems;
  assert.deepEqual(items.map((i) => i.priceSet.shopMoney.amount), ['249.00', '0.00', '249.00']);
  assert.ok(items[1].properties.some((p) => p.value === '2 achetées + 1 offerte'));
  assert.ok(createdOrders[0].order.tags.includes('Offre 2+1'));
});

await test('3 identical pairs at 199 → 398 MAD', async () => {
  reset();
  await post(formBody({ offer: '3', variant_1: '1', variant_2: '1', variant_3: '1' }));
  const sum = createdOrders[0].order.lineItems.reduce((a, i) => a + Number(i.priceSet.shopMoney.amount), 0);
  assert.equal(sum, 398);
});

await test('same submission sent twice → one order only', async () => {
  reset();
  const body = formBody();
  const a = await (await post(body)).json();
  const b = await (await post(new URLSearchParams(body))).json();
  assert.equal(a.order_name, b.order_name);
  assert.equal(createdOrders.length, 1);
});

await test('token is reused between orders', async () => {
  reset();
  await post(formBody());
  await post(formBody());
  assert.equal(tokenRequests, 1);
});

await test('unavailable variant refused (409, French message)', async () => {
  reset();
  const res = await post(formBody({ variant_1: '3' }));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /plus disponible/);
  assert.equal(createdOrders.length, 0);
});

await test('variant from another product refused', async () => {
  reset();
  const res = await post(formBody({ variant_1: '9' }));
  assert.equal(res.status, 400);
  assert.equal(createdOrders.length, 0);
});

await test('offer 3 with a missing pair refused', async () => {
  reset();
  const res = await post(formBody({ offer: '3', variant_1: '1', variant_2: '1' }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /paire 3/);
});

await test('bad phone refused', async () => {
  reset();
  const res = await post(formBody({ phone: '1234' }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /téléphone/);
});

await test('bad signature → 401 JSON, no Shopify call', async () => {
  reset();
  const res = await post(formBody(), { badSig: true });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).ok, false);
  assert.equal(calls.length, 0);
});

await test('old timestamp (replay) → 401', async () => {
  reset();
  const res = await post(formBody(), { timestamp: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal(res.status, 401);
});

await test('other shop → 403', async () => {
  reset();
  const res = await post(formBody(), { shop: 'other.myshopify.com' });
  assert.equal(res.status, 403);
});

await test('multipart body also accepted', async () => {
  reset();
  const fd = new FormData();
  for (const [k, v] of formBody()) fd.append(k, v);
  const res = await POST(new Request(proxyUrl(), { method: 'POST', body: fd }));
  assert.equal(res.status, 200);
});

console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}`);
