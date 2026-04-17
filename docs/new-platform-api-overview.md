# DA Platform — New API Overview
**For:** api.dealeraddendums.com documentation page  
**New platform base URL:** `https://daplatform2026.dealeraddendums.com` *(update when DNS is live)*  
**Source:** Next.js 14 App Router — `/Users/allantone/Sites/da-platform`

---

## Authentication

All authenticated endpoints require a **Supabase JWT** session cookie (`sb-*-auth-token`), set automatically by the platform after login at `/login`.

Public endpoints (embed widgets and DMS webhooks) require **no auth**.

**Roles (least → most privileged):**  
`dealer_user` → `dealer_admin` → `group_admin` → `super_admin`

---

## Ported Legacy Endpoints
*Same URL paths as api.dealeraddendums.com — clients can switch base URL with no other changes.*

### Vehicle & VIN

#### `GET /api/vehicle`
**Auth:** Public  
**Params:** `vin` (required), `feature` (required: `button|pricing|both`), `stock` (required when feature=pricing or both)

| feature | Returns |
|---|---|
| `button` | `{"status":"success","feature":"button","vin":"...","addendum_url":"https://..."}` or `{"status":"fail","message":"Addendum does not exist for this VIN."}` |
| `pricing` | `{"status":"success","feature":"pricing","vin":"...","msrp":0,"internet_price":0,"options":[{"name":"...","description":"...","price":"..."}]}` |
| `both` | Combined pricing + addendum_url |

---

#### `GET /api/decode-vin`
**Auth:** JWT required  
**Params:** `vin` (required)  
**Returns:**
```json
{
  "status": "success",
  "vin": "1FD0W4HTXTED98308",
  "source": "NHTSA vPIC",
  "data": {
    "Make": "FORD",
    "Model": "F-450",
    "Model Year": "2026",
    "Body Class": "Incomplete - Chassis Cab (Double Cab)",
    "Drive Type": "4WD/4-Wheel Drive/4x4",
    "Fuel Type - Primary": "Diesel",
    "...": "all non-empty NHTSA fields"
  }
}
```

---

#### `GET /api/generate-button/{vin}/{theme}`
**Auth:** Public (HTML embed widget)  
**Params:** `text` (optional, default: "Download Addendum")  
**Returns:** `text/html`
```html
<div class="default">
  <a href="https://dealer-addendums.s3.amazonaws.com/VIN.pdf"
     class="dealer-addendums__button__download-button"
     target="_blank">Download Addendum</a>
</div>
```
Returns empty string (200) if no PDF exists for the VIN.

---

#### `GET /api/generate-addendum/{vin}/{theme}`
**Auth:** Public (HTML embed widget)  
**Params:** `feature` (optional: `button|pricing|both`), `stock` (required when feature=pricing|both), `text` (optional)  
**Returns:** `text/html` — download button, or pricing table + button when feature=pricing|both

---

### Dealer Data *(legacy key+username replaced by JWT)*

#### `GET /api/search`
**Auth:** JWT  
**Params:** `vin` (required), `dealership_id` (optional, super_admin only)  
**Returns:** Single `dealer_inventory` row or `{"status":"failed","message":"VIN Not Found."}`

---

#### `GET /api/getalldealerships`
**Auth:** JWT  
**Scoping:** super_admin → all; group_admin → own group; dealer_admin/user → own dealer  
**Returns:** Array of `dealer_dim` rows:
```json
[{
  "ACTIVE": "1", "OWNER": "...", "DEALER_GROUP": "...",
  "DEALER_ID": "...", "DEALER_NAME": "...",
  "PRIMARY_CONTACT": "...", "PRIMARY_CONTACT_EMAIL": "...",
  "DEALER_ADDRESS": "...", "DEALER_CITY": "...", "DEALER_STATE": "...",
  "DEALER_ZIP": "...", "DEALER_COUNTRY": "...", "DEALER_PHONE": "...",
  "BILLING_DATE": "...", "ACCOUNT_TYPE": "...", "FEED_SOURCE": "...", "REFERRED_BY": "..."
}]
```

---

#### `GET /api/getallvehicles`
**Auth:** JWT  
**Params:** `dealer` (optional, super_admin override)  
**Scoping:** dealer_admin/user auto-scoped to own dealer  
**Returns:** Array of active `dealer_inventory` rows (STATUS=1), ordered by DATE_IN_STOCK desc

---

#### `GET /api/getdealeroptions`
**Auth:** JWT  
**Params:** `from` (optional date), `to` (optional date)  
**Returns:** Array from `addendum_data`:
```json
[{
  "_ID": "...", "VEHICLE_ID": "...", "ITEM_NAME": "...",
  "ITEM_DESCRIPTION": "...", "ITEM_PRICE": "...", "ACTIVE": "1",
  "DEALER_ID": "...", "CREATION_DATE": "...", "VIN_NUMBER": "..."
}]
```

---

#### `GET /api/getdealerdefaults`
**Auth:** JWT  
**Returns:** Array from `addendum_defaults`:
```json
[{
  "DEALER_ID": "...", "ITEM_NAME": "...", "ITEM_DESCRIPTION": "...",
  "ITEM_PRICE": "...", "MODELS": "...", "TRIMS": "...",
  "BODY_STYLES": "...", "created_at": "..."
}]
```

---

#### `GET /api/getvehicleoptions`
**Auth:** JWT  
**Params:** `vin` (required)  
**Returns:** Array from `addendum_data` for that VIN

---

#### `GET /api/countoptions`
**Auth:** JWT  
**Params:** `option` (required — ITEM_NAME to count), `from` (optional), `to` (optional)  
**Returns:** `{"option": "Nitrogen Tires", "total_count": 142}`

---

#### `GET /api/countgroupoptions`
**Auth:** JWT  
**Params:** `option` (required), `from` (optional), `to` (optional)  
**Scoping:** Counts across all dealers sharing the same DEALER_GROUP in dealer_dim  
**Returns:** `{"option": "Nitrogen Tires", "total_count": 847}`

---

#### `GET /api/getdealernames`
**Auth:** JWT  
**Scoping:** super_admin → all active dealers; others → own dealer only  
**Returns:**
```json
[{ "_ID": "...", "DEALER_ID": "ABC123", "DEALER_NAME": "Springfield Ford" }]
```

---

### DMS Integration Webhooks *(public — called by external DMS systems)*

#### `GET /api/dealerdotcom`
**Auth:** Public  
**Params:** `vin` (required), `stock` (required)  
**Returns:**
```json
{
  "_ID": "...", "DEALER_ID": "...", "VIN_NUMBER": "...", "STOCK_NUMBER": "...",
  "MSRP": "45000", "INTERNET_PRICE": "43500",
  "options": [
    { "_ID": "...", "VEHICLE_ID": "...", "ITEM_NAME": "...",
      "ITEM_DESCRIPTION": "...", "ITEM_PRICE": "...", "ACTIVE": "1",
      "DEALER_ID": "...", "CREATION_DATE": "...", "VIN_NUMBER": "..." }
  ]
}
```

---

#### `GET /api/dealerdotcomWS`
**Auth:** Public  
**Params:** `vin` (required), `stock` (required)  
**Returns:** `text/plain` — `$43500.00`

---

#### `GET /api/dealeron`
**Auth:** Public  
**Params:** `vin` (required), `stock` (required)  
**Returns:** Same as `/dealerdotcom` but options have trimmed schema: `{ _ID, ITEM_NAME, ITEM_DESCRIPTION, ITEM_PRICE }`

---

#### `GET /api/dealeronWS`
**Auth:** Public  
**Params:** `vin` (required), `stock` (required)  
**Returns:** `text/plain` — `$43500.00`

---

## New Platform Endpoints
*No equivalents on legacy api.dealeraddendums.com.*

### Auth & Identity

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/auth/privilege` | authenticated | Returns current user's role, dealer_id, group_id |
| POST | `/api/auth/stop-impersonate` | authenticated | Ends impersonation session |

### Admin — Users (super_admin only)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/admin/users` | super_admin | List all platform users; filterable by dealer_id, role |
| GET | `/api/admin/users/[id]` | super_admin | Get a single user profile |
| PATCH | `/api/admin/users/[id]` | super_admin | Update user profile + sync auth metadata |
| POST | `/api/admin/users/[id]/impersonate` | super_admin | Assume another user's identity |

### Users

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/users` | dealer_admin+ | List users for the authenticated dealer |
| POST | `/api/users` | dealer_admin | Create a sub-user for the dealer |
| PATCH | `/api/users/[id]` | dealer_admin | Update sub-user profile |
| DELETE | `/api/users/[id]` | dealer_admin | Delete sub-user |
| POST | `/api/users/[id]/reset-password` | dealer_admin | Send password-reset email |

### Dealers

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/dealers` | authenticated | List dealers (role-scoped); supports `?q=`, `?page=`, `?per_page=` |
| POST | `/api/dealers` | super_admin | Create a new dealer record |
| GET | `/api/dealers/[id]` | authenticated | Get dealer by UUID |
| PATCH | `/api/dealers/[id]` | dealer_admin+ | Update dealer profile |
| DELETE | `/api/dealers/[id]` | super_admin | Delete dealer record |

### Groups

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/groups` | super_admin / group_admin | List groups |
| POST | `/api/groups` | super_admin | Create a group |
| GET | `/api/groups/[id]` | super_admin / group_admin | Get group by UUID |
| PATCH | `/api/groups/[id]` | super_admin / group_admin | Update group |
| DELETE | `/api/groups/[id]` | super_admin | Delete group |
| GET | `/api/groups/[id]/dealers` | super_admin / group_admin | List dealers in group |
| POST | `/api/groups/[id]/dealers` | super_admin / group_admin | Add dealer to group |
| DELETE | `/api/groups/[id]/dealers` | super_admin / group_admin | Remove dealer from group |

### Vehicle Inventory *(Aurora read-only)*

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/vehicles` | authenticated | Paginated vehicle list; params: `dealer_id`, `q`, `condition` (new/used/cpo/all), `status`, `page`, `per_page` |
| GET | `/api/vehicles/[id]` | authenticated | Full vehicle record including OPTIONS, DESCRIPTION, all photos |

### Settings & Templates *(Phase 5)*

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/settings` | dealer_admin+ | Get dealer settings (AI toggle, nudge margins, default template IDs) |
| PATCH | `/api/settings` | dealer_admin+ | Upsert dealer settings |
| GET | `/api/templates` | authenticated | List saved addendum/infosheet templates for dealer |
| POST | `/api/templates` | dealer_admin+ | Create a new template record |
| GET | `/api/templates/[id]` | authenticated | Get single template |
| PATCH | `/api/templates/[id]` | dealer_admin+ | Update template |
| DELETE | `/api/templates/[id]` | dealer_admin+ | Delete template |

---

## Common Error Shapes

```json
{ "error": "Unauthorized" }          // 401 — no valid session
{ "error": "Forbidden" }             // 403 — wrong role or wrong dealer
{ "error": "Invalid vehicle id" }    // 400 — bad param
{ "error": "Aurora connection failed" } // 503 — DB unavailable
```

Legacy-style errors (ported endpoints):
```json
{ "status": "failed", "message": "..." }  // 422 or 503
{ "status": "fail",   "message": "..." }  // 200 with logical failure
```

---

## Notes for the Documentation Page

- **Base URL swap:** Clients on `api.dealeraddendums.com` can migrate to the new platform by changing the base URL only — all ported endpoint paths are identical.
- **Auth migration:** Legacy `?key=&username=` params are dropped. Clients must obtain a Supabase JWT session via `/login` on the new platform.
- **Public endpoints** (`/api/vehicle`, `/api/generate-button/*`, `/api/generate-addendum/*`, `/api/dealerdotcom`, `/api/dealeron`, `/api/dealerdotcomWS`, `/api/dealeronWS`) work without any credentials — safe to call from dealer websites and DMS systems without code changes.
- **Aurora data source:** Ported endpoints query the same Aurora MySQL production DB (`dealer_inventory`, `addendum_data`, `addendum_defaults`, `dealer_dim`). Data is identical to the legacy API.
- **Test VIN with PDF:** `1FD0W4HTXTED98308`
