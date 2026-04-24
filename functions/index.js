const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const cors = require("cors");

admin.initializeApp();
const db = admin.firestore();

const PLAN_LIMITS = {
  free: 10,
  pro: 200
};

const USD_MONTHLY_PRICE = 29;
const USD_TO_INR_RATE = Number(process.env.USD_TO_INR_RATE || "83");
const PRO_INR_MONTHLY = Math.max(1, Math.round(USD_MONTHLY_PRICE * USD_TO_INR_RATE));

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const RAZORPAY_PLAN_ID = process.env.RAZORPAY_PLAN_ID || "";
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";

const razorpay = RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
  ? new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET
    })
  : null;

const app = express();

app.use(cors({ origin: true }));
app.use((req, res, next) => {
  if (req.path === "/api/payments/webhook") {
    express.raw({ type: "application/json" })(req, res, next);
    return;
  }
  express.json()(req, res, next);
});

async function requireUser(req, res, next) {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: "Invalid auth token" });
  }
}

function todayUtcString() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
}

function nextUtcResetTimestamp() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return admin.firestore.Timestamp.fromDate(next);
}

function creditsForPlan(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

async function ensureUserDoc(uid, profile) {
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    const defaultPlan = "free";
    const limit = creditsForPlan(defaultPlan);
    const now = admin.firestore.Timestamp.now();
    await ref.set({
      uid,
      email: profile.email || "",
      displayName: profile.name || "",
      photoURL: profile.picture || "",
      plan: defaultPlan,
      dailyCredits: limit,
      creditsUsedToday: 0,
      creditsResetAt: nextUtcResetTimestamp(),
      subscriptionStatus: "inactive",
      razorpayCustomerId: "",
      createdAt: now,
      updatedAt: now
    });
  }
  return ref;
}

app.post("/api/users/bootstrap", requireUser, async (req, res) => {
  try {
    const uid = req.user.uid;
    const ref = await ensureUserDoc(uid, req.user);
    const data = (await ref.get()).data();
    const remaining = Math.max(0, (data.dailyCredits || creditsForPlan(data.plan)) - (data.creditsUsedToday || 0));

    res.json({
      uid,
      plan: data.plan || "free",
      subscriptionStatus: data.subscriptionStatus || "inactive",
      dailyCredits: data.dailyCredits || creditsForPlan(data.plan),
      usedToday: data.creditsUsedToday || 0,
      remaining,
      resetAt: data.creditsResetAt ? data.creditsResetAt.toDate().toISOString() : null,
      price: {
        usdMonthly: USD_MONTHLY_PRICE,
        inrMonthly: PRO_INR_MONTHLY,
        usdToInrRate: USD_TO_INR_RATE
      }
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to bootstrap user", details: String(error.message || error) });
  }
});

app.post("/api/credits/consume", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const action = req.body?.action || "scan";
  const userRef = db.collection("users").doc(uid);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) {
        throw new Error("USER_NOT_FOUND");
      }

      const user = snap.data();
      const plan = user.plan || "free";
      const limit = creditsForPlan(plan);
      let usedToday = Number(user.creditsUsedToday || 0);
      let dailyCredits = Number(user.dailyCredits || limit);
      let resetAt = user.creditsResetAt || nextUtcResetTimestamp();

      const nowTs = admin.firestore.Timestamp.now();
      if (resetAt.toMillis() <= nowTs.toMillis()) {
        usedToday = 0;
        dailyCredits = limit;
        resetAt = nextUtcResetTimestamp();
      }

      if (usedToday >= dailyCredits) {
        return {
          allowed: false,
          remaining: 0,
          plan,
          resetAt: resetAt.toDate().toISOString()
        };
      }

      usedToday += 1;
      const remaining = Math.max(0, dailyCredits - usedToday);

      tx.update(userRef, {
        creditsUsedToday: usedToday,
        dailyCredits,
        creditsResetAt: resetAt,
        updatedAt: nowTs
      });

      const usageId = `${uid}_${todayUtcString()}`;
      const usageRef = db.collection("usage").doc(usageId);
      tx.set(
        usageRef,
        {
          uid,
          date: todayUtcString(),
          action,
          count: admin.firestore.FieldValue.increment(1),
          updatedAt: nowTs
        },
        { merge: true }
      );

      return {
        allowed: true,
        remaining,
        plan,
        resetAt: resetAt.toDate().toISOString()
      };
    });

    res.json(result);
  } catch (error) {
    if (String(error.message || "").includes("USER_NOT_FOUND")) {
      try {
        await ensureUserDoc(uid, req.user);
        res.status(409).json({ error: "User profile initialized. Retry request." });
      } catch (innerError) {
        res.status(500).json({ error: "Failed to create user profile", details: String(innerError.message || innerError) });
      }
      return;
    }

    res.status(500).json({ error: "Credit consumption failed", details: String(error.message || error) });
  }
});

app.post("/api/payments/create-subscription", requireUser, async (req, res) => {
  if (!razorpay || !RAZORPAY_PLAN_ID) {
    res.status(500).json({
      error: "Payment backend not configured",
      details: "Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, and RAZORPAY_PLAN_ID"
    });
    return;
  }

  const uid = req.user.uid;
  const userRef = await ensureUserDoc(uid, req.user);
  const userSnap = await userRef.get();
  const user = userSnap.data();

  try {
    let customerId = user.razorpayCustomerId || "";
    if (!customerId) {
      const customer = await razorpay.customers.create({
        name: user.displayName || req.user.name || "SecureX User",
        email: user.email || req.user.email || "",
        notes: { uid }
      });
      customerId = customer.id;
      await userRef.update({ razorpayCustomerId: customerId, updatedAt: admin.firestore.Timestamp.now() });
    }

    const subscription = await razorpay.subscriptions.create({
      plan_id: RAZORPAY_PLAN_ID,
      customer_notify: 1,
      total_count: 12,
      notes: {
        uid,
        plan: "pro",
        displayed_price: "$29/month",
        inr_equivalent: String(PRO_INR_MONTHLY)
      }
    });

    await db.collection("subscriptions").doc(subscription.id).set({
      uid,
      subscriptionId: subscription.id,
      plan: "pro",
      status: subscription.status,
      customerId,
      createdAt: admin.firestore.Timestamp.now(),
      raw: subscription
    });

    await userRef.update({
      subscriptionStatus: subscription.status || "created",
      updatedAt: admin.firestore.Timestamp.now()
    });

    res.json({
      key: RAZORPAY_KEY_ID,
      subscriptionId: subscription.id,
      amountInr: PRO_INR_MONTHLY,
      amountUsdDisplay: USD_MONTHLY_PRICE,
      currency: "INR"
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to create subscription", details: String(error.message || error) });
  }
});

app.post("/api/payments/verify", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const {
    razorpay_payment_id: paymentId,
    razorpay_subscription_id: subscriptionId,
    razorpay_signature: signature
  } = req.body || {};

  if (!paymentId || !subscriptionId || !signature) {
    res.status(400).json({ error: "Missing payment verification fields" });
    return;
  }

  if (!RAZORPAY_KEY_SECRET) {
    res.status(500).json({ error: "Razorpay secret not configured" });
    return;
  }

  const expected = crypto
    .createHmac("sha256", RAZORPAY_KEY_SECRET)
    .update(`${paymentId}|${subscriptionId}`)
    .digest("hex");

  if (expected !== signature) {
    res.status(400).json({ success: false, error: "Invalid signature" });
    return;
  }

  const now = admin.firestore.Timestamp.now();
  const userRef = db.collection("users").doc(uid);

  await userRef.set(
    {
      plan: "pro",
      dailyCredits: PLAN_LIMITS.pro,
      subscriptionStatus: "active",
      updatedAt: now
    },
    { merge: true }
  );

  await db.collection("payments").doc(paymentId).set({
    uid,
    paymentId,
    subscriptionId,
    status: "captured",
    verifiedBy: "signature",
    createdAt: now,
    updatedAt: now
  });

  await db.collection("subscriptions").doc(subscriptionId).set(
    {
      uid,
      status: "active",
      updatedAt: now
    },
    { merge: true }
  );

  res.json({ success: true, subscriptionStatus: "active", plan: "pro" });
});

app.post("/api/payments/webhook", async (req, res) => {
  if (!RAZORPAY_WEBHOOK_SECRET) {
    res.status(500).send("Webhook secret missing");
    return;
  }

  try {
    const signature = req.headers["x-razorpay-signature"];
    const payload = req.body;

    const expected = crypto
      .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
      .update(payload)
      .digest("hex");

    if (signature !== expected) {
      res.status(401).send("Invalid webhook signature");
      return;
    }

    const event = JSON.parse(payload.toString("utf8"));
    const eventType = event.event;
    const now = admin.firestore.Timestamp.now();

    if (eventType === "subscription.activated" || eventType === "subscription.charged") {
      const entity = event.payload?.subscription?.entity;
      const subscriptionId = entity?.id;
      const uid = entity?.notes?.uid;
      if (uid && subscriptionId) {
        await db.collection("users").doc(uid).set(
          {
            plan: "pro",
            subscriptionStatus: "active",
            dailyCredits: PLAN_LIMITS.pro,
            updatedAt: now
          },
          { merge: true }
        );
        await db.collection("subscriptions").doc(subscriptionId).set(
          { uid, status: "active", updatedAt: now, raw: event },
          { merge: true }
        );
      }
    }

    if (eventType === "subscription.cancelled" || eventType === "payment.failed") {
      const subscription = event.payload?.subscription?.entity;
      const payment = event.payload?.payment?.entity;
      const uid = subscription?.notes?.uid || payment?.notes?.uid;
      const subscriptionId = subscription?.id || payment?.subscription_id;

      if (uid) {
        await db.collection("users").doc(uid).set(
          {
            plan: "free",
            subscriptionStatus: eventType === "subscription.cancelled" ? "cancelled" : "past_due",
            dailyCredits: PLAN_LIMITS.free,
            updatedAt: now
          },
          { merge: true }
        );
      }

      if (subscriptionId) {
        await db.collection("subscriptions").doc(subscriptionId).set(
          { status: eventType, updatedAt: now, raw: event },
          { merge: true }
        );
      }
    }

    if (eventType === "payment.captured") {
      const payment = event.payload?.payment?.entity;
      if (payment?.id) {
        const uid = payment?.notes?.uid || "";
        await db.collection("payments").doc(payment.id).set(
          {
            uid,
            paymentId: payment.id,
            subscriptionId: payment.subscription_id || "",
            status: "captured",
            amount: payment.amount,
            currency: payment.currency,
            updatedAt: now,
            raw: event
          },
          { merge: true }
        );
      }
    }

    res.status(200).send("ok");
  } catch (error) {
    res.status(500).send(`Webhook processing failed: ${String(error.message || error)}`);
  }
});

app.get("/api/payments/history", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const snap = await db
    .collection("payments")
    .where("uid", "==", uid)
    .orderBy("updatedAt", "desc")
    .limit(10)
    .get();

  const items = snap.docs.map((d) => d.data()).map((p) => ({
    paymentId: p.paymentId || "",
    status: p.status || "unknown",
    currency: p.currency || "INR",
    amount: Number(p.amount || 0) / 100,
    updatedAt: p.updatedAt?.toDate?.()?.toISOString?.() || null
  }));

  res.json({ items });
});

exports.api = functions.https.onRequest(app);
