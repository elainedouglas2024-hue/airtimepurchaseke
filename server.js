// server.js (Statum-first receipts + Paycenta status + Retry Queue)
import express from "express";
import cors from "cors";
import axios from "axios";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({ origin: "https://etopup.onrender.com" })); // change to your frontend in prod

// ===== Replace with real credentials =====
const API_KEY = "hmp_keozjmAk6bEwi0J2vaDB063tGwKkagHJtmnykFEh";
const USER_EMAIL = "kipkoechabel69@gmail.com";
const PAYMENT_LINK_CODE = "PNT_366813";

const STATUM_KEY = "18885957c3a6cd14410aa9bfd7c16ba5273";
const STATUM_SECRET = "sqPzmmybSXtQm7BJQIbz188vUR8P";

// ===== Config =====
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 40;
const AUTO_CLEAN_MS = 10 * 60 * 1000;

if (!fs.existsSync("logs")) fs.mkdirSync("logs");

const pending = new Map();
const retryQueue = [];

// retry loop every 1 minute
setInterval(async () => {
  if (retryQueue.length === 0) return;
  console.log("🔄 Retrying failed airtime queue:", retryQueue.length);

  const job = retryQueue.shift();
  const { phone, amount, ref } = job;

  const { ok, result, retry } = await sendAirtime(phone, amount, ref);
  if (ok) {
    console.log(`✅ Retry succeeded for ${ref}`);
    if (pending.has(ref)) {
      const entry = pending.get(ref);
      entry.airtime = "success";
      entry.statumResult = result;
      pending.set(ref, entry);
    }
  } else if (retry) {
    console.log(`⚠️ Float still low for ${ref}, requeueing`);
    retryQueue.push(job);
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
      result?.description?.toLowerCase().includes("insufficient") ||
      result?.message?.toLowerCase().includes("balance");

    if (insufficientFloat) {
      return { ok: false, result, retry: true };
    }

    return { ok, result };
  } catch (err) {
    console.error("❌ Statum call error:", err?.message || err);
    return { ok: false, result: { error: String(err?.message || err) } };
  }
}

// === Poll PayNecta until payment success, then send airtime ===
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
      clearInterval(entry.intervalId);

      // call Statum - use airtimeNumber if provided, otherwise fallback to payment number
      const targetNumber = entry.airtimeNumber || entry.paymentNumber;
      const { ok, result, retry } = await sendAirtime(targetNumber, entry.amount, ref);

      if (retry) {
        entry.airtime = "failed";
        entry.statumResult = result;
        pending.set(ref, entry);
        retryQueue.push({ phone: targetNumber, amount: entry.amount, ref });
      } else {
        entry.airtime = ok ? "success" : "failed";
        entry.statumResult = result;
        pending.set(ref, entry);
      }

      setTimeout(() => pending.delete(ref), AUTO_CLEAN_MS);
    }

    if (["failed", "cancelled"].includes(normalized)) {
      clearInterval(entry.intervalId);
      entry.airtime = "failed";
      pending.set(ref, entry);
      setTimeout(() => pending.delete(ref), AUTO_CLEAN_MS);
    }

    if (entry.attempts >= MAX_POLL_ATTEMPTS) {
      clearInterval(entry.intervalId);
      pending.set(ref, entry);
      setTimeout(() => pending.delete(ref), AUTO_CLEAN_MS);
    }
  } catch (err) {
    console.error("❌ Poll error:", err?.message);
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
        intervalId: setInterval(() => pollTransaction(transaction_reference), POLL_INTERVAL_MS),
        startedAt: Date.now()
      };
      pending.set(transaction_reference, entry);
    }

    res.json({ success: true, reference: transaction_reference, data: init.data?.data });
  } catch (err) {
    console.error("❌ Init error:", err?.message);
    res.json({ success: false, message: "Failed to init payment", error: err?.message });
  }
});

// === Status endpoint: return both Paycenta + Statum results ===
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
      statum: entry.statumResult || null
    });
  }
  res.json({ success: false, message: "Reference not found" });
});

// === Debug + health ===
app.get("/pending", (req, res) => {
  res.json({ success: true, pending: Array.from(pending.entries()) });
});
app.get("/", (req, res) => res.json({ message: "✅ backend running" }));

app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
