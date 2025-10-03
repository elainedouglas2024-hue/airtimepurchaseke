// server.js (Statum only Airtime)
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({ origin: "https://graceful-meringue-ad7720.netlify.app" })); // change in prod

// ===== Statum credentials =====
const STATUM_KEY = "18885957c3a6cd14410aa9bfd7c16ba5273";
const STATUM_SECRET = "sqPzmmybSXtQm7BJQIbz188vUR8P";

// ===== Config =====
const AUTO_CLEAN_MS = 10 * 60 * 1000;
if (!fs.existsSync("logs")) fs.mkdirSync("logs");

// Track requests in memory
const pending = new Map();

// === helpers ===
function logToFile(filename, data) {
  const logEntry = { timestamp: new Date().toISOString(), ...data };
  fs.appendFileSync(`logs/${filename}`, JSON.stringify(logEntry) + "\n", "utf8");
}

function getAuthHeader() {
  return `Basic ${Buffer.from(`${STATUM_KEY}:${STATUM_SECRET}`).toString("base64")}`;
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

    return { ok, result };
  } catch (err) {
    console.error("❌ Statum call error:", err?.message || err);
    return { ok: false, result: { error: String(err?.message || err) } };
  }
}

// === Purchase endpoint (direct Statum) ===
app.post("/purchase", async (req, res) => {
  let { phone_number, amount } = req.body;
  if (!phone_number || !amount) {
    return res.status(400).json({ success: false, message: "phone_number and amount required" });
  }
  if (phone_number.startsWith("0")) {
    phone_number = "254" + phone_number.slice(1);
  }

  const reference = `REF_${Date.now()}`;

  try {
    const { ok, result } = await sendAirtime(phone_number, amount, reference);

    const entry = {
      mobile: phone_number,
      amount,
      airtime: ok ? "success" : "failed",
      statumResult: result,
      startedAt: Date.now()
    };
    pending.set(reference, entry);

    setTimeout(() => pending.delete(reference), AUTO_CLEAN_MS);

    res.json({ success: ok, reference, data: result });
  } catch (err) {
    console.error("❌ Purchase error:", err?.message);
    res.json({ success: false, message: "Failed to send airtime", error: err?.message });
  }
});

// === Status endpoint ===
app.get("/api/status/:reference", (req, res) => {
  const { reference } = req.params;
  if (pending.has(reference)) {
    const entry = pending.get(reference);
    return res.json({ success: true, reference, ...entry });
  }
  res.json({ success: false, message: "Reference not found" });
});

// === Debug + health ===
app.get("/pending", (req, res) => {
  res.json({ success: true, pending: Array.from(pending.entries()) });
});
app.get("/", (req, res) => res.json({ message: "✅ backend running (Statum only)" }));

app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
