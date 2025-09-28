// server.js
// Paycenta + Statum + single scheduler + retry queue
// Added: bonus airtime, rewards/points system, hidden fee handling

import express from "express";
import cors from "cors";
import axios from "axios";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({ origin: "https://etopup.onrender.com" })); // change to your frontend in prod

// ===== Replace with real credentials or set in env =====
const API_KEY = process.env.PAYMENT_API_KEY || "hmp_keozjmAk6bEwi0J2vaDB063tGwKkagHJtmnykFEh";
const USER_EMAIL = process.env.USER_EMAIL || "kipkoechabel69@gmail.com";
const PAYMENT_LINK_CODE = process.env.PAYMENT_LINK_CODE || "PNT_366813";

const STATUM_KEY = process.env.STATUM_KEY || "18885957c3a6cd14410aa9bfd7c16ba5273";
const STATUM_SECRET = process.env.STATUM_SECRET || "sqPzmmybSXtQm7BJQIbz188vUR8P";

// ===== Config (tweak these) =====
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 40;
const RETRY_LIMIT = 5;
const AUTO_CLEAN_MS = 10 * 60 * 1000;

// Business config:
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 2.5); // hidden fee % taken by system
const BONUS_PERCENT = Number(process.env.BONUS_PERCENT || 5); // % of amount given as bonus airtime
const POINTS_PER_KES = Number(process.env.POINTS_PER_KES || 0.01); // points per KES spent (0.01 -> 1 point per 100 KES)
const REDEEM_RATE = Number(process.env.REDEEM_RATE || 10); // KES of airtime per 100 points (see logic below)

// ===== storage (in-memory) =====
if (!fs.existsSync("logs")) fs.mkdirSync("logs");

const pending = new Map(); // transaction_reference -> entry
const retryQueue = []; // jobs: { phone, amount, ref, retries }
const users = new Map(); // phone -> { points: Number, history: [] }

// --- Scheduler Loop (poll all pending refs) ---
setInterval(async () => {
  for (const [ref, entry] of pending.entries()) {
    if (!entry.processed && entry.attempts < MAX_POLL_ATTEMPTS) {
      await pollTransaction(ref);
    }
  }
}, POLL_INTERVAL_MS);

// --- Retry Loop (every 1 min) ---
setInterval(async () => {
  if (retryQueue.length === 0) return;
  console.log("🔄 Retrying failed airtime queue:", retryQueue.length);

  const job = retryQueue.shift();
  const { phone, amount, ref, retries = 0 } = job;

  const { ok, result, retry } = await sendAirtime(phone, amount, ref);

  if (ok) {
    console.log(`✅ Retry succeeded for ${ref}`);
    if (pending.has(ref)) {
      const entry = pending.get(ref);
      entry.airtime = "success";
      entry.statumResult = result;
      pending.set(ref, entry);
    }
  } else if (retry && retries < RETRY_LIMIT) {
    console.log(`⚠️ Float still low for ${ref}, requeueing (attempt ${retries + 1})`);
    retryQueue.push({ phone, amount, ref, retries: retries + 1 });
  } else {
    console.log(`❌ Retry failed permanently for ${ref}`);
    if (pending.has(ref)) {
      const entry = pending.get(ref);
      entry.airtime = "failed";
      entry.statumResult = result;
      pending.set(ref, entry);
    }
  }
}, 60 * 1000);

// === helpers ===
function logToFile(filename, data) {
  const logEntry = { timestamp: new Date().toISOString(), ...data };
  fs.appendFileSync(`logs/${filename}`, JSON.stringify(logEntry) + "\n", "utf8");
}

function getAuthHeader() {
  return `Basic ${Buffer.from(`${STATUM_KEY}:${STATUM_SECRET}`).toString("base64")}`;
}

function normalizeStatus(status) {
  if (!status) return "pending";
  const s = String(status).toLowerCase();
  if (["success", "successful", "paid", "completed"].includes(s)) return "success";
  if (["failed", "fail", "declined"].includes(s)) return "failed";
  if (["cancelled", "canceled"].includes(s)) return "cancelled";
  return "pending";
}

function ensureUser(phone) {
  if (!users.has(phone)) users.set(phone, { points: 0, history: [] });
  return users.get(phone);
}

// === Statum airtime ===
async function sendAirtime(phoneNumber, amount, reference) {
  try {
    const payload = { phone_number: phoneNumber, amount: String(amount) };
    console.log("➡️  Calling Statum:", payload);
    logToFile("airtime_attempt.log", { reference, payload });

    const resp = await fetch("https://api.statum.co.ke/api/v2/airtime", {
      method: "POST",
      headers: {
        "Authorization": getAuthHeader(),
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload),
    });

    const result = await resp.json();
    console.log("⬅️ Statum response:", result);
    logToFile("airtime_requests.log", { reference, request: payload, response: result });

    const ok =
      (result?.status_code && Number(result.status_code) === 200) ||
      result?.success === true;

    const insufficientFloat =
      String(result?.description || "").toLowerCase().includes("insufficient") ||
      String(result?.message || "").toLowerCase().includes("balance");

    if (insufficientFloat) {
      return { ok: false, result, retry: true };
    }

    return { ok, result };
  } catch (err) {
    console.error("❌ Statum call error:", err?.message || err);
    return { ok: false, result: { error: String(err?.message || err) } };
  }
}

// === Poll PayNecta until payment success, then send airtime + bonus + points ===
async function pollTransaction(ref) {
  const entry = pending.get(ref);
  if (!entry || entry.processed) return;

  try {
    const resp = await axios.get(
      `https://paynecta.co.ke/api/v1/payment/status?transaction_reference=${encodeURIComponent(ref)}`,
      { headers: { "X-API-Key": API_KEY, "X-User-Email": USER_EMAIL } }
    );

    const payStatus = resp.data;
    const rawStatus = payStatus?.data?.status || payStatus?.status;
    const normalized = normalizeStatus(rawStatus);

    entry.attempts = (entry.attempts || 0) + 1;
    entry.status = normalized;
    entry.paycentaResult = payStatus;

    if (normalized === "success" && !entry.processed) {
      entry.processed = true;

      // compute hidden fee and final airtime to send
      const originalAmount = Number(entry.amount);
      const feeAmount = Number(((originalAmount * FEE_PERCENT) / 100).toFixed(2));
      // airtime we actually send after deducting fee (ensure at least 1)
      const airtimeToSend = Math.max(1, Math.floor(originalAmount - feeAmount));

      entry._internal = entry._internal || {};
      entry._internal.fee = feeAmount; // stored internally but WILL NOT be returned in /api/status
      entry._internal.airtimeToSend = airtimeToSend;

      // call Statum - use airtimeNumber if provided, otherwise fallback to payment number
      const targetNumber = entry.airtimeNumber || entry.paymentNumber;
      const { ok, result, retry } = await sendAirtime(targetNumber, airtimeToSend, ref);

      if (retry) {
        entry.airtime = "failed";
        entry.statumResult = result;
        pending.set(ref, entry);
        retryQueue.push({ phone: targetNumber, amount: airtimeToSend, ref, retries: 0 });
      } else {
        entry.airtime = ok ? "success" : "failed";
        entry.statumResult = result;
        pending.set(ref, entry);
      }

      // award rewards points (based on originalAmount)
      try {
        const userPhone = entry.paymentNumber;
        const u = ensureUser(userPhone);
        const pointsEarned = Math.floor(originalAmount * POINTS_PER_KES); // e.g., 0.01 => 1 point per 100 KES
        if (pointsEarned > 0) {
          u.points += pointsEarned;
          u.history.push({ type: "earn", points: pointsEarned, ref, amount: originalAmount, at: Date.now() });
        }

        // bonus airtime: a percentage of originalAmount (rounded down), sent separately
        const bonusAmount = Math.floor((originalAmount * BONUS_PERCENT) / 100);
        if (bonusAmount > 0) {
          // store bonus info then attempt to send bonus airtime
          entry._internal.bonusAmount = bonusAmount;
          entry._internal.bonusTarget = targetNumber;
          const bonusRes = await sendAirtime(targetNumber, bonusAmount, `${ref}-bonus`);
          if (bonusRes.ok) {
            entry.bonusSent = true;
            logToFile("bonus_sent.log", { ref, phone: targetNumber, bonusAmount, result: bonusRes.result });
          } else {
            entry.bonusSent = false;
            logToFile("bonus_failed.log", { ref, phone: targetNumber, bonusAmount, result: bonusRes.result });
            // retry bonus via retryQueue (counts towards same RETRY_LIMIT)
            if (bonusRes.retry) retryQueue.push({ phone: targetNumber, amount: bonusAmount, ref: `${ref}-bonus`, retries: 0 });
          }
        }
      } catch (e) {
        console.error("❌ Reward/bonus processing error:", e?.message || e);
      }

      setTimeout(() => pending.delete(ref), AUTO_CLEAN_MS);
    }

    if (["failed", "cancelled"].includes(normalized)) {
      entry.airtime = "failed";
      pending.set(ref, entry);
      setTimeout(() => pending.delete(ref), AUTO_CLEAN_MS);
    }

    if (entry.attempts >= MAX_POLL_ATTEMPTS) {
      pending.set(ref, entry);
      setTimeout(() => pending.delete(ref), AUTO_CLEAN_MS);
    }
  } catch (err) {
    console.error("❌ Poll error:", err?.message);
    // store lastError for debugging (not exposed to user-facing status, but kept internally)
    if (entry) {
      entry._internal = entry._internal || {};
      entry._internal.lastError = String(err?.message || err);
      pending.set(ref, entry);
    }
  }
}

// === Purchase endpoint ===
app.post("/purchase", async (req, res) => {
  let { payment_number, airtime_number, amount } = req.body;

  if (!payment_number || !amount) {
    return res.status(400).json({ success: false, message: "payment_number and amount required" });
  }

  // normalize numbers
  if (payment_number.startsWith("0")) {
    payment_number = "254" + payment_number.slice(1);
  }
  if (airtime_number && airtime_number.startsWith("0")) {
    airtime_number = "254" + airtime_number.slice(1);
  }

  try {
    // initialize payment using Paycenta with Safaricom number
    const init = await axios.post(
      "https://paynecta.co.ke/api/v1/payment/initialize",
      { code: PAYMENT_LINK_CODE, mobile_number: payment_number, amount },
      { headers: { "X-API-Key": API_KEY, "X-User-Email": USER_EMAIL } }
    );

    const transaction_reference =
      init?.data?.data?.transaction_reference ||
      init?.data?.data?.CheckoutRequestID;

    if (transaction_reference && !pending.has(transaction_reference)) {
      const entry = {
        paymentNumber: payment_number,
        airtimeNumber: airtime_number || null,
        amount,
        attempts: 0,
        status: "pending",
        processed: false,
        airtime: "pending",
        paycentaResult: null,
        statumResult: null,
        startedAt: Date.now(),
        // internal details that won't be exposed to clients (hidden fee etc)
        _internal: {
          feePercent: FEE_PERCENT,
          bonusPercent: BONUS_PERCENT
        }
      };
      pending.set(transaction_reference, entry);
    }

    // NOTE: we intentionally do not add fee info to the returned payload (fee is hidden)
    res.json({ success: true, reference: transaction_reference, data: init.data?.data });
  } catch (err) {
    console.error("❌ Init error:", err?.message);
    res.json({ success: false, message: "Failed to init payment", error: err?.message });
  }
});

// === Rewards: Redeem points for airtime ===
// POST /reward/redeem { phone, points, airtime_number(optional) }
// converts points -> airtime KES using a simple conversion and sends airtime
app.post("/reward/redeem", async (req, res) => {
  let { phone, points, airtime_number } = req.body;
  if (!phone || !points) return res.status(400).json({ success: false, message: "phone and points required" });

  if (phone.startsWith("0")) phone = "254" + phone.slice(1);
  if (airtime_number && airtime_number.startsWith("0")) airtime_number = "254" + airtime_number.slice(1);

  const u = ensureUser(phone);
  points = Number(points);
  if (isNaN(points) || points <= 0) return res.status(400).json({ success: false, message: "points must be a positive number" });

  if (u.points < points) return res.status(400).json({ success: false, message: "not enough points" });

  // conversion: let's use REDEEM_RATE KES per 100 points
  // airtimeKES = Math.floor(points / 100) * REDEEM_RATE
  const bundlesOf100 = Math.floor(points / 100);
  if (bundlesOf100 <= 0) return res.status(400).json({ success: false, message: "minimum 100 points to redeem" });

  const airtimeKES = bundlesOf100 * REDEEM_RATE;
  const pointsUsed = bundlesOf100 * 100;

  // deduct points
  u.points -= pointsUsed;
  u.history.push({ type: "redeem", points: -pointsUsed, ref: `redeem-${Date.now()}`, amount: airtimeKES, at: Date.now() });

  // send airtime to target (airtime_number or the phone used)
  const target = airtime_number || phone;
  const ref = `redeem-${Date.now()}`;
  const { ok, result, retry } = await sendAirtime(target, airtimeKES, ref);

  if (ok) {
    logToFile("redeem.log", { ref, phone: target, airtimeKES, pointsUsed, result });
    return res.json({ success: true, message: "Airtime redeemed and sent", airtimeKES, pointsUsed });
  } else {
    // if insufficient float, put into retry queue and inform user it's queued (but don't expose fee)
    if (retry) {
      retryQueue.push({ phone: target, amount: airtimeKES, ref, retries: 0 });
      logToFile("redeem_retry.log", { ref, phone: target, airtimeKES, pointsUsed, result });
      return res.json({ success: true, message: "Airtime redemption queued (awaiting float)", airtimeKES, pointsUsed });
    } else {
      // failure: refund points back to user
      u.points += pointsUsed;
      u.history.push({ type: "redeem_refund", points: pointsUsed, ref, at: Date.now() });
      return res.status(500).json({ success: false, message: "Failed to send airtime, points refunded" });
    }
  }
});

// === User points status (internal) ===
// GET /rewards/:phone -> { points, history } (phone must be in normalized form or will be auto-normalized)
app.get("/rewards/:phone", (req, res) => {
  let phone = req.params.phone;
  if (phone.startsWith("0")) phone = "254" + phone.slice(1);
  const u = users.get(phone) || { points: 0, history: [] };
  res.json({ success: true, phone, points: u.points, history: u.history.slice(-20) });
});

// === Status endpoint: return both Paycenta + Statum results ===
// NOTE: we intentionally do NOT return internal fee details in this response (fee hidden)
app.get("/api/status/:reference", (req, res) => {
  const { reference } = req.params;
  if (pending.has(reference)) {
    const entry = pending.get(reference);

    return res.json({
      success: true,
      reference,
      paymentNumber: entry.paymentNumber,
      airtimeNumber: entry.airtimeNumber,
      amount: entry.amount,
      airtime: entry.airtime,
      paycenta: {
        status: entry.status,
        attempts: entry.attempts,
        raw: entry.paycentaResult || null
      },
      statum: entry.statumResult || null,
      bonusSent: entry.bonusSent || false,
      // Do NOT include entry._internal.fee or airtimeToSend here (hidden)
    });
  }
  res.json({ success: false, message: "Reference not found" });
});

// === Debug + health (careful: exposes internal data) ===
app.get("/pending", (req, res) => {
  // show sanitized pending for debugging (include internal for admin)
  const list = Array.from(pending.entries()).map(([ref, entry]) => {
    return [ref, {
      paymentNumber: entry.paymentNumber,
      amount: entry.amount,
      status: entry.status,
      airtime: entry.airtime,
      startedAt: entry.startedAt,
      _internal: entry._internal || null // internal visible here for debugging
    }];
  });
  res.json({ success: true, pending: list });
});
app.get("/", (req, res) => res.json({ message: "✅ backend running" }));

app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
