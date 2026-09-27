# Mana Nellore Backend

The single source of truth for all four Mana Nellore apps — **customer, restaurant, rider, admin**.
One shared PostgreSQL database, one API. A price change in the restaurant portal is read
live by the customer app: no sync jobs, no duplication.

**Stack:** Node.js + Express + PostgreSQL (`pg`), JWT auth, bcrypt. Minimal dependencies:
`express`, `pg`, `jsonwebtoken`, `bcryptjs`, `cors`, `dotenv`.

**Money:** every amount is stored and computed in **paise (integers)**. No floats anywhere.

## Deploy to Railway (exact steps)

1. **Create the project** — log in at [railway.app](https://railway.app), click **New Project → Deploy from Repo**
   (or **Empty Project** if you push this folder), and connect this repository/folder.
2. **Add PostgreSQL** — in the project canvas click **New → Database → Add PostgreSQL**.
3. **Set environment variables** — open the backend service → **Variables**, add:
   - `DATABASE_URL` → click **New Variable → Add Reference → postgres.DATABASE_URL`
     (this auto-links the database; do NOT type it by hand)
   - `JWT_SECRET` → a long random string (generate: `openssl rand -hex 32`)
   - `ADMIN_PHONE` → e.g. `9000000001` (your admin login number)
   - `ADMIN_PASSWORD` → a strong password
   - `DEV_OTP` → `true` while testing (OTP is returned in the API response);
     set to `false` in production once the SMS provider is wired
   - `PORT` → Railway injects this automatically; leave unset unless needed
4. **Deploy** — Railway builds the `Dockerfile` and starts `node src/index.js`.
   On boot the app runs `src/schema.sql` and seeds the admin user + pricing rows.
5. **Verify** — open `https://<your-service>.up.railway.app/api/health`
   → `{"ok": true, "service": "mana-nellore-backend", ...}`.
6. **Admin login** — `POST /api/auth/admin-login` with `{ phone, password }`
   → use the returned JWT as `Authorization: Bearer <token>` for `/api/admin/*`.

## API overview

| Area | Base | Auth |
|---|---|---|
| OTP login / admin login | `/api/auth` | public |
| Restaurant discovery (public) | `/api/restaurants` | public |
| Restaurant owner portal | `/api/owner` | JWT, role `restaurant_owner` (own restaurant only) |
| Customer profile | `/api/customer` | JWT, role `customer` |
| Orders | `/api/orders` | JWT, role `customer` |
| Rider portal | `/api/rider` | JWT, role `rider` (own deliveries only) |
| Admin / operations | `/api/admin` | JWT, role `admin` |
| Health | `/api/health` | public |

### Key flows

- **OTP login:** `POST /api/auth/send-otp {phone}` → `POST /api/auth/verify-otp {phone, code, name?, role?}`
  → returns `{ token, user }`. New users are created on first verify; riders get a rider profile row.
- **Place order:** `POST /api/orders { restaurant_id, address_id, items:[{menu_item_id, qty, instructions?}], coupon_code?, payment_method? }`.
  The server re-prices everything from the live menu + `pricing_config` and returns the breakdown.
- **Pay:** `POST /api/orders/:id/pay` marks payment successful. **This simulates the gateway —
  replace with the Razorpay webhook verification before going live.**
- **Order lifecycle:** `placed → accepted → preparing → ready → picked_up → on_way → delivered`
  (restaurant drives the first half, rider the second; every step appends to `timeline`).
- **Delivery OTP:** generated when the rider marks `picked-up`, sent to the customer's
  notifications (`GET /api/customer/notifications`). The rider completes with
  `POST /api/rider/deliveries/:id/complete { otp }`. **In production, send this OTP via
  SMS instead of (or as well as) the in-app notification.**
- **COD:** orders with `payment_method: "cod"` stay `payment_status: "pending"` until the
  rider completes delivery, then flip to `paid`.

### Pricing engine (`src/lib/pricing.js`)

- Distance via haversine on restaurant ↔ delivery-address coordinates.
- **Delivery fee (marginal tiers):** 0–3 km ₹10/km, 3–8 km ₹9/km, 8+ km ₹8/km.
- **Rider payout:** 0–5 km ₹8/km; 5–8 km ₹9/km on the full distance; 8+ km = first 8 km @ ₹8/km + extra @ ₹10/km.
- **Platform fee:** ₹8 (from `pricing_config`).
- **Commission:** per-restaurant `commission_pct` (default 12%).
- **Free delivery:** ₹499+ up to 3 km, ₹899+ up to 5 km, ₹1299+ up to 8 km.
- All tiers live in the `pricing_config` table — `PUT /api/admin/pricing` edits apply
  to new orders instantly across all four apps.

### Role isolation

- Restaurant owners: every `/api/owner/*` query filters by the restaurant whose
  `owner_id` matches the JWT — they can never see another restaurant.
- Riders: every `/api/rider/*` query filters by their own rider id.
- Customers: orders/addresses/notifications filtered by their user id.
- Admins: full visibility + every mutating action written to `audit_logs`.

## Local development

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL etc.
npm start              # runs on http://localhost:8080
```

## Production checklist (before launch)

- [ ] Set `DEV_OTP=false` and wire the SMS provider in `POST /api/auth/send-otp`.
- [ ] Replace `POST /api/orders/:id/pay` with real Razorpay webhook verification.
- [ ] Send the delivery OTP via SMS, not just the in-app notification.
- [ ] Use a strong `JWT_SECRET` and rotate `ADMIN_PASSWORD`.
- [ ] Restrict CORS origins in `src/index.js` to your app domains.
