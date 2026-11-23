# B.L.G COD backend

Receives the "B.L.G COD dynamique" form through Shopify's App Proxy and creates a real
**pending (cash on delivery)** order in Shopify.

```
Customer form ──POST /apps/cod-order──▶ Shopify App Proxy ──(signed)──▶ Vercel /api/cod-order ──▶ Shopify Admin API (orderCreate)
```

What it does on each submit:
- checks Shopify's proxy signature (rejects anything not coming through your store)
- validates name / phone (Moroccan numbers → +212…) / city / address
- reads the variant prices **from Shopify** (never trusts the browser)
- offer "2 + 1": the cheapest of the 3 pairs is set to 0 MAD
- creates the order: payment `PENDING`, stock decremented, tags `COD`, `Formulaire COD`
- the same submission sent twice returns the same order (no duplicate)
- always answers JSON `{ ok, order_name }` or `{ ok:false, error }` (French, shown to the customer)

## Setup

### 1. Deploy to Vercel
Push this folder to a GitHub repo → vercel.com → **Add New → Project** → import it → Deploy
(no build settings needed). Turn **off** Settings → Deployment Protection for Production,
otherwise Shopify gets a Vercel login page instead of JSON.

Your endpoint is `https://<project>.vercel.app/api/cod-order`.

### 2. Create the app in Shopify
Shopify admin → **Settings → Apps → Develop apps → Build apps using Dev Dashboard → Create app**.
Then **Versions → Create a version**:
- Access scopes: `write_orders`, `read_products`
- App proxy: prefix `apps`, subpath `cod-order`, URL `https://<project>.vercel.app/api/cod-order`
- Release the version, then **Install** the app on your store.

### 3. Environment variables (Vercel → Settings → Environment Variables)
| Name | Value |
|---|---|
| `SHOPIFY_CLIENT_ID` | Dev Dashboard → app → Settings → Client ID |
| `SHOPIFY_CLIENT_SECRET` | Dev Dashboard → app → Settings → Client secret |
| `SHOPIFY_SHOP` | `your-store.myshopify.com` |

Optional: `SHIPPING_PRICE` (adds a delivery line), `SHOPIFY_API_VERSION` (default `2026-10`).
Redeploy after adding them.

### 4. Check
Open `https://<your-store>/apps/cod-order` in the browser →
`{"ok":true,"message":"App Proxy COD connecté ✅"}`. Then place a test order with the form.

## Troubleshooting
| Symptom | Cause |
|---|---|
| Store "page not found" at `/apps/cod-order` | proxy not set / app not installed / subpath differs |
| `Requête non autorisée (signature…)` | wrong `SHOPIFY_CLIENT_SECRET` |
| `Configuration serveur incomplète` | env vars missing → add them and redeploy |
| `La commande n’a pas pu être enregistrée` | see Vercel → Logs (token or scope problem, e.g. missing `write_orders`) |

Tests (no network, Shopify mocked): `npm test`
