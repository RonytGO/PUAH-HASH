const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");
const fs = require("fs").promises;
const path = require("path");

const app = express();
app.use(bodyParser.text({ type: "*/*" }));
app.use(bodyParser.json());

/* ---------------- HELPERS ---------------- */

const toInt = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseInt(s.replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};

const getAmountMinor = (rd) => {
  for (const c of [rd.DebitTotal, rd.TotalMinor, rd.AmountMinor, rd.Total]) {
    const n = toInt(c);
    if (n !== null) return n;
  }
  return 0;
};

/* ---------------- FILE STORAGE ---------------- */

const RECEIPTS_DIR = path.join(__dirname, "receipts");

const writeTransactionData = async (regId, data) => {
  await fs.mkdir(RECEIPTS_DIR, { recursive: true });
  await fs.writeFile(path.join(RECEIPTS_DIR, `${regId}.json`), JSON.stringify(data));
};

const readTransactionData = async (regId) => {
  try {
    const data = await fs.readFile(path.join(RECEIPTS_DIR, `${regId}.json`), "utf8");
    return JSON.parse(data);
  } catch {
    return {};
  }
};

/* ---------------- ROUTES ---------------- */

// Ping
app.get("/db-ping", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// 1) INIT PAYMENT (OPEN AMOUNT)
app.get("/", async (req, res) => {
  const {
    RegID = "",
    CustomerName = "",
    CustomerEmail = ""
  } = req.query;

  if (!RegID) return res.status(400).send("Missing RegID");

  await writeTransactionData(RegID, { CustomerName, CustomerEmail });

  const baseCallback = `https://${req.get("host")}/callback`;
  const serverCallback = `https://${req.get("host")}/pelecard-callback`;

  const payload = {
    terminal: process.env.PELE_TERMINAL,
    user: process.env.PELE_USER,
    password: process.env.PELE_PASSWORD,

    ActionType: "J4",
    Currency: "1",

    // Open amount
    FreeTotal: "True",
    Total: 0,

    ShopNo: "001",

    // IMPORTANT: browser returns here
    GoodURL: baseCallback,
    ErrorURL: baseCallback,

    // Server-to-server webhook
    ServerSideGoodFeedbackURL: serverCallback,
    ServerSideErrorFeedbackURL: serverCallback,

    // This comes back in redirects as ParamX
    ParamX: RegID,

    MaxPayments: "10",
    MinPayments: "1"
  };

  try {
    const peleRes = await fetch("https://gateway21.pelecard.biz/PaymentGW/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await peleRes.json();
    if (data.URL) return res.redirect(data.URL);

    res.status(500).send("Pelecard error: " + JSON.stringify(data));
  } catch (err) {
    res.status(500).send("Server error: " + err.message);
  }
});

// 2) PELECARD WEBHOOK (STORE REAL AMOUNT)
app.post("/pelecard-callback", async (req, res) => {
  try {
    // Pelecard sometimes sends odd bodies; keep it tolerant
    let bodyObj;
    if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
      bodyObj = req.body;
    } else {
      const raw = String(req.body || "").replace(/'/g, '"');
      bodyObj = JSON.parse(raw);
    }

    const rd = bodyObj.ResultData || bodyObj.Result || bodyObj;

    const regId = String(rd.ParamX || "").trim();
    const txId = rd.TransactionId || null;
    const shva = rd.ShvaResult || rd.PelecardStatusCode || rd.StatusCode || "";
    const approved = (shva === "000" || shva === "0");

    if (!regId) return res.status(200).send("OK");

    // Only store amount when approved + has transaction id
    if (approved && txId) {
      const amountMinor = getAmountMinor(rd);
      const amount = amountMinor / 100;

      const saved = await readTransactionData(regId);
      await writeTransactionData(regId, { ...saved, amount, txId });

      console.log("Webhook stored:", { regId, txId, amount });
    } else {
      console.log("Webhook not approved:", { regId, txId, shva });
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).send("OK"); // prevent retries storm
  }
});

// 3) CLIENT REDIRECT (SEND TO FORM 38)
app.get("/callback", async (req, res) => {
  // Pelecard appends these to the redirect URL:
  // ParamX, PelecardStatusCode, ConfirmationKey, PelecardTransactionId, etc.
  const regId = String(req.query.ParamX || req.query.RegID || "").trim();
  const shva = String(req.query.PelecardStatusCode || req.query.ShvaResult || "").trim();

  const status = (shva === "000" || shva === "0") ? "approved" : "failed";

  if (!regId) {
    return res.redirect(`https://puah.tfaforms.net/38?Status=failed`);
  }

  // If failed, no need to wait for webhook
  if (status === "failed") {
    return res.redirect(
      `https://puah.tfaforms.net/38` +
      `?RegID=${encodeURIComponent(regId)}` +
      `&Status=failed` +
      `&Total=`
    );
  }

  // Approved: wait briefly for webhook to store amount
  let saved = {};
  const start = Date.now();

  while (Date.now() - start < 5000) {
    saved = await readTransactionData(regId);
    if (saved.amount) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // Even if amount is still missing, we still mark approved (user already paid).
  // Total may be empty in that rare race case.
  const total = saved.amount || "";

  return res.redirect(
    `https://puah.tfaforms.net/38` +
    `?RegID=${encodeURIComponent(regId)}` +
    `&Status=approved` +
    `&Total=${encodeURIComponent(total)}`
  );
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Server running on port", port));
