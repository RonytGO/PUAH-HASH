const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");
const fs = require("fs").promises;
const path = require("path");

const app = express();
app.use(bodyParser.text({ type: "*/*" }));
app.use(bodyParser.json());

const RECEIPTS_DIR = path.join(__dirname, "receipts");

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

/* ---------------- INIT PAYMENT ---------------- */

app.get("/", async (req, res) => {
  const { RegID = "", CustomerName = "", CustomerEmail = "" } = req.query;
  if (!RegID) return res.status(400).send("Missing RegID");

  await writeTransactionData(RegID, { CustomerName, CustomerEmail });

  const thankyou = `https://${req.get("host")}/thankyou`;
  const serverCallback = `https://${req.get("host")}/pelecard-callback`;

  const payload = {
    terminal: process.env.PELE_TERMINAL,
    user: process.env.PELE_USER,
    password: process.env.PELE_PASSWORD,
    ActionType: "J4",
    Currency: "1",
    FreeTotal: "True",
    Total: 0,
    ShopNo: "001",
    ParamX: RegID,
    GoodURL: thankyou,
    ErrorURL: thankyou,
    ServerSideGoodFeedbackURL: serverCallback,
    ServerSideErrorFeedbackURL: serverCallback,
    MaxPayments: "10",
    MinPayments: "1"
  };

  const peleRes = await fetch("https://gateway21.pelecard.biz/PaymentGW/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await peleRes.json();
  if (data.URL) return res.redirect(data.URL);
  res.status(500).send(JSON.stringify(data));
});

/* ---------------- THANK YOU PAGE ---------------- */

app.get("/thankyou", async (req, res) => {
  const regId = String(req.query.ParamX || "").trim();
  if (!regId) return res.send("Processing...");

  let saved = {};
  const start = Date.now();

  while (Date.now() - start < 5000) {
    saved = await readTransactionData(regId);
    if (saved.amount) break;
    await new Promise(r => setTimeout(r, 200));
  }

  if (!saved.amount) return res.send("Processing...");

  res.redirect(
    `https://puah.tfaforms.net/38?RegID=${encodeURIComponent(regId)}&Status=approved&Total=${encodeURIComponent(saved.amount)}`
  );
});

/* ---------------- PELECARD WEBHOOK ---------------- */

app.post("/pelecard-callback", async (req, res) => {
  try {
    const raw = typeof req.body === "object" ? JSON.stringify(req.body) : String(req.body || "");
    const body = JSON.parse(raw.replace(/'/g, '"'));
    const rd = body.ResultData || body.Result || body;

    const regId = String(rd.ParamX || "").trim();
    const txId = rd.TransactionId;
    const status = rd.ShvaResult === "000" || rd.ShvaResult === "0" ? "approved" : "failed";
    if (!txId || status !== "approved") return res.send("OK");

    const amount = getAmountMinor(rd) / 100;
    const saved = await readTransactionData(regId);

    await writeTransactionData(regId, { ...saved, amount });

    res.send("OK");
  } catch {
    res.send("OK");
  }
});

app.listen(process.env.PORT || 8080, () => console.log("Server running"));
