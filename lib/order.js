import { adminGraphql, PublicError } from './shopify.js';

const VARIANTS_QUERY = `
query CodVariants($ids: [ID!]!) {
  shop { currencyCode }
  nodes(ids: $ids) {
    __typename
    ... on ProductVariant {
      id
      title
      price
      availableForSale
      product { id title }
    }
  }
}`;

const EXISTING_ORDER_QUERY = `
query CodExisting($q: String!) {
  orders(first: 1, query: $q) { nodes { id name } }
}`;

const ORDER_CREATE_MUTATION = `
mutation CodOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    order { id name }
    userErrors { field message }
  }
}`;

const clean = (value, max) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** "06 12 34 56 78" → "+212612345678" for Morocco; other countries just get digits/+ kept. */
export function normalizePhone(raw, countryCode) {
  const input = String(raw ?? '').trim();
  let digits = input.replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = '+' + digits.slice(2);

  if (countryCode === 'MA') {
    let national = digits.replace(/^\+?212/, '');
    if (national.startsWith('0')) national = national.slice(1);
    if (!/^[5-7]\d{8}$/.test(national)) return null;
    return '+212' + national;
  }
  const count = digits.replace(/\D/g, '').length;
  return count >= 8 && count <= 15 ? digits : null;
}

export function splitName(fullName) {
  const parts = fullName.split(' ').filter(Boolean);
  if (parts.length === 1) return { firstName: '', lastName: parts[0] };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

const toNumericId = (value) => (/^\d{1,20}$/.test(String(value ?? '').trim()) ? String(value).trim() : null);

/** Reads and validates the form. Throws PublicError (French, customer-facing) on bad input. */
export function parseCodForm(form) {
  const get = (name) => (form.get(name) ?? '').toString();

  const fullName = clean(get('full_name'), 100);
  const city = clean(get('city'), 80);
  const address = clean(get('address'), 400);
  const countryCode = clean(get('country_code'), 2).toUpperCase() || 'MA';
  const offer = get('offer') === '3' ? 3 : get('offer') === '1' ? 1 : null;
  const productId = toNumericId(get('product_id'));
  const submissionId = get('submission_id').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);

  if (fullName.length < 2) throw new PublicError('Merci d’indiquer votre nom complet.');
  if (city.length < 2) throw new PublicError('Merci d’indiquer votre ville.');
  if (address.length < 4) throw new PublicError('Merci d’indiquer votre adresse de livraison.');
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new PublicError('Pays invalide.');
  const phone = normalizePhone(get('phone'), countryCode);
  if (!phone) throw new PublicError('Numéro de téléphone invalide. Exemple : 06 12 34 56 78.');
  if (!offer) throw new PublicError('Merci de choisir une offre.');
  if (!productId) throw new PublicError('Produit introuvable. Rechargez la page.');

  const variantIds = [];
  for (let i = 1; i <= offer; i++) {
    const id = toNumericId(get(`variant_${i}`));
    if (!id) throw new PublicError(`Merci de choisir la couleur / pointure de la paire ${i}.`);
    variantIds.push(id);
  }

  return { fullName, phone, city, address, countryCode, offer, productId, variantIds, submissionId };
}

/** Index of the cheapest pair (first one if tied) — that pair is free in the 2+1 offer. */
export function freePairIndex(prices) {
  let best = 0;
  prices.forEach((p, i) => { if (p < prices[best]) best = i; });
  return best;
}

const toCents = (amount) => Math.round(Number(amount) * 100);
const fromCents = (cents) => (cents / 100).toFixed(2);

export async function createCodOrder(shop, input) {
  // 1. Same submission already turned into an order? Return it instead of a duplicate.
  //    (Best effort: Shopify's order search can lag a few seconds behind.)
  if (input.submissionId) {
    const existing = await adminGraphql(shop, EXISTING_ORDER_QUERY, {
      q: `tag:"cod-${input.submissionId}"`,
    });
    const found = existing?.orders?.nodes?.[0];
    if (found) return { name: found.name, id: found.id, duplicate: true };
  }

  // 2. Load the chosen variants from Shopify — prices come from Shopify, never from the browser.
  const uniqueIds = [...new Set(input.variantIds)];
  const data = await adminGraphql(shop, VARIANTS_QUERY, {
    ids: uniqueIds.map((id) => `gid://shopify/ProductVariant/${id}`),
  });
  const currencyCode = data?.shop?.currencyCode;
  if (!currencyCode) throw new Error('Shop currency missing in Shopify response');

  const byId = new Map();
  for (const node of data.nodes || []) {
    if (node && node.__typename === 'ProductVariant') byId.set(node.id.split('/').pop(), node);
  }
  const productGid = `gid://shopify/Product/${input.productId}`;

  const variants = input.variantIds.map((id, i) => {
    const v = byId.get(id);
    if (!v || v.product?.id !== productGid) {
      throw new PublicError(`La paire ${i + 1} ne correspond pas à ce produit. Rechargez la page.`);
    }
    if (!v.availableForSale) {
      throw new PublicError(`« ${v.title} » n’est plus disponible. Choisissez une autre pointure ou couleur.`, 409);
    }
    return v;
  });

  // 3. Build the line items; in the 3-pair offer the cheapest pair is free.
  const prices = variants.map((v) => toCents(v.price));
  const freeIndex = input.offer === 3 ? freePairIndex(prices) : -1;

  const lineItems = variants.map((v, i) => {
    const free = i === freeIndex;
    const item = {
      variantId: v.id,
      quantity: 1,
      requiresShipping: true,
      priceSet: { shopMoney: { amount: fromCents(free ? 0 : prices[i]), currencyCode } },
    };
    if (free) {
      item.properties = [
        { name: 'Offre', value: '2 achetées + 1 offerte' },
        { name: 'Prix normal', value: `${fromCents(prices[i])} ${currencyCode}` },
      ];
    }
    return item;
  });

  const { firstName, lastName } = splitName(input.fullName);
  const mailingAddress = {
    firstName,
    lastName,
    address1: input.address,
    city: input.city,
    countryCode: input.countryCode,
    phone: input.phone,
  };

  const shippingLines = [];
  const shippingPrice = Number(process.env.SHIPPING_PRICE || 0);
  if (shippingPrice > 0) {
    shippingLines.push({
      title: process.env.SHIPPING_TITLE || 'Livraison',
      priceSet: { shopMoney: { amount: shippingPrice.toFixed(2), currencyCode } },
    });
  }

  const tags = ['COD', 'Formulaire COD'];
  if (input.offer === 3) tags.push('Offre 2+1');
  if (input.submissionId) tags.push(`cod-${input.submissionId}`);

  const order = {
    currency: currencyCode,
    financialStatus: 'PENDING', // cash on delivery: not paid yet
    lineItems,
    shippingAddress: mailingAddress,
    billingAddress: mailingAddress,
    note: [
      'Commande paiement à la livraison (formulaire COD)',
      `Client : ${input.fullName}`,
      `Téléphone : ${input.phone}`,
      `Ville : ${input.city}`,
      `Adresse : ${input.address}`,
      input.offer === 3 ? 'Offre : 2 achetées + 1 offerte' : 'Offre : 1 paire',
    ].join('\n'),
    tags,
  };
  if (input.submissionId) order.sourceIdentifier = input.submissionId;
  if (shippingLines.length) order.shippingLines = shippingLines;

  // 4. Create the order. DECREMENT_OBEYING_POLICY = take stock, refuse if out of stock
  //    (unless the product is set to "continue selling when out of stock").
  const result = await adminGraphql(shop, ORDER_CREATE_MUTATION, {
    order,
    options: {
      inventoryBehaviour: process.env.INVENTORY_BEHAVIOUR || 'DECREMENT_OBEYING_POLICY',
      sendReceipt: false,
      sendFulfillmentReceipt: false,
    },
  });

  const payload = result?.orderCreate;
  const errors = payload?.userErrors || [];
  if (errors.length || !payload?.order?.name) {
    const detail = errors.map((e) => `${(e.field || []).join('.')}: ${e.message}`).join(' | ');
    if (/inventory|stock/i.test(detail)) {
      throw new PublicError('Une des pointures choisies vient d’être épuisée. Choisissez-en une autre.', 409);
    }
    throw new Error(`orderCreate failed: ${detail || 'no order returned'}`);
  }
  return { name: payload.order.name, id: payload.order.id, duplicate: false };
}
