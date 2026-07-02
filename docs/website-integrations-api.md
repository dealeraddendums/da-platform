# Website Integrations API — DA Platform

> Replaces the legacy Laravel API Portal (api.dealeraddendums.com) with a DA Platform endpoint.
> All existing Dealer.com widget installations continue working with zero changes via DNS cutover.

---

## Background

The legacy `/generate-addendum/{vin}/{theme}` endpoint on the API Portal is embedded in 1,600+ dealer websites. It returns HTML that a Dealer.com JavaScript snippet injects into the VDP to show:
1. The "Download Addendum" button (Magic Button)
2. A pricing stack showing MSRP, Internet Price, and addendum option line items

This rewrite moves the endpoint to DA Platform, adds per-dealer button customization, and reads from Supabase instead of Aurora directly.

---

## Migration number: 117

```sql
CREATE TABLE dealer_website_integrations (
  id           uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  dealer_id    text    NOT NULL REFERENCES dealers(dealer_id) ON DELETE CASCADE,
  provider     text    NOT NULL,                   -- 'dealer_com' | future: 'cargurus', etc.
  button_label text    NOT NULL DEFAULT 'Download Addendum',
  button_css   text,                               -- NULL = use platform default CSS
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now(),
  UNIQUE (dealer_id, provider)
);

CREATE INDEX idx_dwi_dealer_provider ON dealer_website_integrations (dealer_id, provider);
```

---

## New DA Platform Routes

Both routes live at the same paths as the legacy API Portal so DNS cutover is transparent.

### `GET /api/generate-button/[vin]/[theme]`
→ `app/api/generate-button/[vin]/[theme]/route.ts`

Button only. Checks S3 for `{VIN}.pdf`, returns the download anchor if found, empty body if not.

### `GET /api/generate-addendum/[vin]/[theme]`
→ `app/api/generate-addendum/[vin]/[theme]/route.ts`

Full widget: optional pricing block + button. **This is the primary route.**

#### Query parameters (same as legacy):
| Param    | Default          | Notes |
|----------|------------------|-------|
| `stock`  | —                | Stock number — required for pricing block to render |
| `feature`| `both`           | `button` \| `pricing` \| `both` |
| `text`   | *(see below)*    | Button label override — takes precedence over dealer setting |

#### Button label resolution order:
1. `?text=` query param (explicit override, used by legacy widget scripts already deployed)
2. Dealer's saved `dealer_website_integrations.button_label` for `provider='dealer_com'`
3. Platform default: `"Download Addendum"`

#### CSS resolution:
1. Dealer's saved `dealer_website_integrations.button_css` for `provider='dealer_com'`
2. Platform default CSS (see below)

#### Route logic:
```
1. Look up dealer_vehicles WHERE vin = {vin} AND status = '1' (+ stock_number if provided), get dealer_id
2. If no vehicle found → return empty 200 (Content-Type: text/html)
3. Look up dealer_website_integrations WHERE dealer_id = ? AND provider = 'dealer_com'
4. If feature includes 'pricing':
   a. Get vehicle MSRP + internet_price from dealer_vehicles row
   b. Query addendum_data WHERE vin_number = {vin} AND dealer_id = ? AND active = 'yes' ORDER BY order_by
5. If feature includes 'button':
   a. HEAD S3: dealer-addendums/{VIN}.pdf (using existing lib/addendum.ts checkPdfExists)
   b. s3Url = https://dealer-addendums.s3.us-west-1.amazonaws.com/{VIN}.pdf
6. If neither pricing data nor PDF exists → return empty 200
7. Build and return HTML
```

#### Response headers:
```
Content-Type: text/html; charset=utf-8
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, OPTIONS
Cache-Control: public, max-age=60
```

#### HTML output structure (same BEM convention as legacy):
```html
<div class="{theme}">
  <style>
    /* Dealer custom CSS or platform default */
    .dealer-addendums__button__download-button { ... }
  </style>

  <!-- Pricing block (if feature=pricing|both AND data exists) -->
  <div class="dealer-addendums__pricing">
    <ul class="dealer-addendums__pricing__list">
      <li class="dealer-addendums__pricing__msrp">
        <span class="dealer-addendums__pricing__label">MSRP</span>
        <span class="dealer-addendums__pricing__value">$45,000</span>
      </li>
      <li class="dealer-addendums__pricing__internet-price">
        <span class="dealer-addendums__pricing__label">Internet Price</span>
        <span class="dealer-addendums__pricing__value">$43,500</span>
      </li>
      <!-- One <li> per addendum option -->
      <li class="dealer-addendums__pricing__option">
        <span class="dealer-addendums__pricing__label">Nitrogen Tires</span>
        <span class="dealer-addendums__pricing__value">$299</span>
      </li>
    </ul>
  </div>

  <!-- Button (if feature=button|both AND PDF exists) -->
  <a href="{s3Url}"
     class="dealer-addendums__button__download-button"
     target="_blank">{buttonLabel}</a>
</div>
```

#### Platform default CSS:
```css
.dealer-addendums__button__download-button {
  display: inline-block;
  background-color: #1976d2;
  color: #ffffff;
  padding: 10px 20px;
  border-radius: 4px;
  text-decoration: none;
  font-family: sans-serif;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.dealer-addendums__button__download-button:hover {
  background-color: #1565c0;
}
.dealer-addendums__pricing { margin-bottom: 12px; }
.dealer-addendums__pricing__list { list-style: none; margin: 0; padding: 0; }
.dealer-addendums__pricing__list li {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-family: sans-serif;
  font-size: 14px;
}
```

---

## Settings UI — Website Integrations

**Location:** Dealer Settings page → new "Website Integrations" tab

**Tab structure** (provider tabs, expandable as new integrations are added):
- Dealer.com *(only tab for now)*

**Dealer.com tab fields:**
- **Enabled** toggle (default: on)
- **Button Label** — text input, placeholder "Download Addendum"
- **Button CSS** — textarea, pre-filled with platform default CSS, editable
- **Live Preview** — renders a real `<button>` element below the CSS field, live-updating as the user types

**API route:** `PATCH /api/settings/website-integrations` — upserts `dealer_website_integrations` for `provider='dealer_com'`

**Access:** `dealer_admin` and above (same as other settings fields).

---

## DNS Cutover Plan

When ready to go live:

1. Add `api.dealeraddendums.com` as an additional domain on the DA Platform ALB
2. Add Nginx server block on the DA Platform EC2 to accept `api.dealeraddendums.com` and proxy to Next.js (same as `app.dealeraddendums.com`)
3. Update DNS: point `api.dealeraddendums.com` from the legacy EC2 to the DA Platform ALB
4. The 1,600+ dealer sites with embedded widget scripts continue working with zero changes

The legacy API Portal server stays up until confident (can decommission after a few weeks of healthy traffic on the new endpoint).

---

## Security Fixes on Legacy Server (do before or alongside migration)

CC's audit found two issues on the legacy API Portal that need fixing regardless:

1. **Hardcoded OpenAI API key** in `app/Http/Controllers/ApiDataController.php:743` — rotate the key in the OpenAI dashboard immediately, then move to `.env`
2. **`.env` chmod 777** — fix to 600: `chmod 600 /var/www/api/.env`

---

## Implementation Order

1. **Migration 117** — create `dealer_website_integrations` table (Allan pastes SQL into Supabase)
2. **API routes** — build `generate-button` and `generate-addendum` on DA Platform
3. **Settings UI** — Website Integrations tab in dealer Settings
4. **Settings API** — `PATCH /api/settings/website-integrations`
5. **Fix legacy server security** — rotate OpenAI key + fix .env permissions
6. **Test** — verify HTML output matches legacy for a known VIN
7. **DNS cutover** — when confident

---

## Open Questions

- Should `api.dealeraddendums.com` redirect to `app.dealeraddendums.com/api/...` or should the ALB/Nginx serve both domains from the same Next.js process? (Recommended: same process, second server block in Nginx.)
- Do we want a per-dealer `enabled` toggle, or is having no row in `dealer_website_integrations` sufficient to indicate "not set up"? (Recommended: explicit `enabled` column so we can pre-populate rows for all dealers and toggle without deleting config.)
