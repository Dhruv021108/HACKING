# SecureX Production Setup (Firebase + Razorpay)

This project now includes:
- Google authentication (required for all scan actions)
- Daily server-enforced credits by plan
  - Free: 10/day
  - Pro: 200/day
- Razorpay Pro subscription flow
  - Displayed: $29/month
  - Charged: INR equivalent (configured on backend)
- Verified payment webhook handling to upgrade/downgrade plan state

## 1) Install tools
- Node.js 20+
- Firebase CLI (`npm i -g firebase-tools`)

## 2) Firebase project
1. Create/select Firebase project.
2. Enable Authentication -> Google provider.
3. Create Firestore database.
4. Add web app in Firebase console and copy config.
5. Copy `securex.config.example.js` to `securex.config.js` and fill values.
6. Required frontend keys in `securex.config.js`:
   - `apiKey`
   - `authDomain`
   - `projectId`
   - `appId`

These values come from Firebase Console -> Project settings -> General -> Your apps -> Web app -> SDK setup and configuration.

## 3) Functions environment
In `functions/`, install dependencies:

```bash
npm install
```

Set env vars for deployment runtime:

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_PLAN_ID` (monthly plan created in Razorpay dashboard)
- `RAZORPAY_WEBHOOK_SECRET`
- `USD_TO_INR_RATE` (example: 83)

If using Firebase v2 env or secret manager, map them to process.env values used in `functions/index.js`.

## 4) Firestore indexes
Create index for payment history query:
- Collection: `payments`
- Fields: `uid` ASC, `updatedAt` DESC

## 5) Deploy
From project root:

```bash
firebase login
firebase use <your-project-id>
firebase deploy
```

This deploys:
- Hosting (frontend)
- Function: `api` (all `/api/*` endpoints)

## GitHub Pages workflow note
The repository workflow now opts into Node 24 for JavaScript-based actions to avoid the current Node 20 deprecation warning shown by GitHub Actions runners.

## 6) Razorpay webhook
In Razorpay dashboard webhook settings:
- URL: `https://<your-domain>/api/payments/webhook`
- Secret: same as `RAZORPAY_WEBHOOK_SECRET`
- Events:
  - `payment.captured`
  - `payment.failed`
  - `subscription.activated`
  - `subscription.cancelled`
  - `subscription.charged`

## 7) Merchant settlement note
Payments are processed and settled by Razorpay to your linked merchant settlement account/bank. This is the authorized flow for recurring subscriptions.

## API Endpoints implemented
- `POST /api/users/bootstrap`
- `POST /api/credits/consume`
- `POST /api/payments/create-subscription`
- `POST /api/payments/verify`
- `POST /api/payments/webhook`
- `GET /api/payments/history`
