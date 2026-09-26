# Mana Nellore

Food delivery platform for Nellore — four portals, one backend.

## Structure

| Folder | Description | Deploys to |
|---|---|---|
| `mana-nellore-backend/` | Node.js + PostgreSQL API (single source of truth) | Railway (Root Directory: `mana-nellore-backend`) |
| `frontend-customer/` | Customer app — browse, order, track | Vercel |
| `frontend-restaurant/` | Restaurant app — orders, menu, payouts | Vercel |
| `frontend-rider/` | Rider app — deliveries, earnings | Vercel |
| `frontend-admin/` | Admin console — everything | Vercel |

## Backend

```bash
cd mana-nellore-backend
npm install
# set DATABASE_URL and JWT_SECRET, then:
npm start
```

The schema (`src/schema.sql`) auto-creates on first boot, including seed data
(default delivery zone, pricing config, admin user).

## Frontends

Each frontend is a static vanilla-JS app (`index.html` + `app.js` + `styles.css`).
They call the backend URL defined in `app.js` (`API` constant). Deploy by
uploading the folder to Vercel, or connect the repo with the folder as the
project root.

## Live

- Customer: https://frontend-customer-zeta.vercel.app/
- Restaurant: https://frontend-restaurant-gamma.vercel.app/
- Rider: https://frontend-rider-theta.vercel.app/
- Admin: https://frontend-admin-topaz-six.vercel.app/
- API: https://mana-nellore-mana-nellore.up.railway.app
