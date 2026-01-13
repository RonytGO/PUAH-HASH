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

const getPayments = (rd) => {
  for (const f of ["TotalPayments", "NumberOfPayments", "Payments", "PaymentsNum"]) {
    const n = toInt(rd[f]);
    if (n && n > 0) return n;
  }
  return 1;
};

const unwrapSummit = (obj) => (obj && obj.Data ? obj.Data : obj || {});

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
  const { RegID = "", total = "6600", CustomerName = "", CustomerEmail = "", phone = "" } = req.query;
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
    FreeTotal: "False",
    ShopNo: "001",
    Total: total,
    NotificationGoodMail: "ronyt@puah.org.il", 
    NotificationErrorMail: "ronyt@puah.org.il",
    GoodURL: `${baseCallback}?Status=approved&Total=${encodeURIComponent(total)}`,
    ErrorURL: `${baseCallback}?Status=failed&Total=${encodeURIComponent(total)}`,
    ServerSideGoodFeedbackURL: serverCallback,
    ServerSideErrorFeedbackURL: serverCallback,
    ParamX: RegID,
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
    const payments = getPayments(rd);
    const last4 = (rd.CreditCardNumber || "").split("*").pop();

    const saved = await readTransactionData(regId);

    const summitPayload = {
      Details: {
        Date: new Date().toISOString(),
        Customer: { Name: saved.CustomerName || "Client", EmailAddress: saved.CustomerEmail || "hd@puah.org.il" },
        SendByEmail: { EmailAddress: saved.CustomerEmail || "hd@puah.org.il", Original: true },
        Type: 1,
        ExternalReference: regId,
        Comments: `Pelecard ${txId}`
      },
      Items: [{
        Quantity: 1,
        UnitPrice: amount,
        TotalPrice: amount,
        Item: { Name: "Registration" }
      }],
      Payments: [{
        Amount: amount,
        Type: 5,
        Details_CreditCard: { Last4Digits: last4, Payments: payments }
      }],
      VATIncluded: true,
      Credentials: {
        CompanyID: Number(process.env.SUMMIT_COMPANY_ID),
        APIKey: process.env.SUMMIT_API_KEY
      }
    };

    const summitRes = await fetch("https://app.sumit.co.il/accounting/documents/create/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summitPayload)
    });

    const summit = unwrapSummit(await summitRes.json());
    if (summit.DocumentDownloadURL) {
      await writeTransactionData(regId, { ...saved, receiptUrl: summit.DocumentDownloadURL });
    }

    res.send("OK");
  } catch {
    res.send("OK");
  }
});

/* ---------------- CLIENT REDIRECT ---------------- */
app.get("/callback", async (req, res) => {
  const Status = req.query.Status || "";
  const Total = req.query.Total || "";
  const regId = req.query.ParamX || "";

  if (!regId) return res.redirect("https://puah.tfaforms.net/35?Status=failed");

  const saved = await readTransactionData(regId);

  res.redirect(
    `https://puah.tfaforms.net/35` +
    `?RegID=${encodeURIComponent(regId)}` +
    `&Status=${encodeURIComponent(Status)}` +
    `&Total=${encodeURIComponent(Total)}` +
    `&ReceiptURL=${encodeURIComponent(saved.receiptUrl || "")}`
  );
});


app.listen(process.env.PORT || 8080, () => console.log("Server running"));
