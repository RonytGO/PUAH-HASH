const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");
const fs = require("fs").promises; // Use async file system operations
const path = require("path");

const app = express();

// Accept odd Pelecard payloads
app.use(bodyParser.text({ type: "*/*" }));
app.use(bodyParser.json());

/* ----------------------- helpers (unchanged) ----------------------- */
const toInt = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseInt(s.replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};

const getAmountMinor = (rd) => {
  const cand = [rd.DebitTotal, rd.TotalMinor, rd.AmountMinor, rd.Total];
  for (const c of cand) {
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
  if (rd.JParam) {
    const m = String(rd.JParam).match(/(\d{1,2})/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0) return n;
    }
  }
  return 1;
};

const unwrapSummit = (obj) => (obj && typeof obj === "object" && obj.Data ? obj.Data : obj || {});

const extractRegId = (rd) => {
  const raw = String(rd.AdditionalDetailsParamX || rd.ParamX || "").trim();
  if (!raw) return "";
  if (!raw.includes("|")) return raw;
  const parts = raw.split("|").filter(Boolean);
  return parts[1] || parts[0] || "";
};

/* ------------------- File-based storage for receipts and data ------------------- */
const RECEIPTS_DIR = path.join(__dirname, "receipts");

const writeTransactionData = async (regId, data) => {
  try {
    await fs.mkdir(RECEIPTS_DIR, { recursive: true });
    await fs.writeFile(path.join(RECEIPTS_DIR, `${regId}.json`), JSON.stringify(data));
  } catch (err) {
    console.error(`Failed to write transaction data for ${regId}:`, err);
  }
};

const readTransactionData = async (regId) => {
  try {
    const data = await fs.readFile(path.join(RECEIPTS_DIR, `${regId}.json`), "utf8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`Failed to read transaction data for ${regId}:`, err);
    }
    return {};
  }
};


/* --------------------- Routes & main logic --------------------- */

// simple ping (no DB)
app.get("/db-ping", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// 1) INIT PAYMENT (store registration info only in logs)
app.get("/", async (req, res) => {
  const {
    total = "6500",
    RegID = "",
    FAResponseID = "",
    CustomerName = "",
    CustomerEmail = "",
    phone = "",
    Course = ""
  } = req.query;

  // log registration data
  console.log("Registration received:", {
    RegID, FAResponseID, CustomerName, CustomerEmail, phone, Course, total
  });

  // Save all necessary data to a file
  await writeTransactionData(RegID, { CustomerName, CustomerEmail, Course });

  // Use only RegID for ParamX due to length limitations
  const paramX = `${RegID}`;
  const baseCallback = `https://${req.get("host")}/callback`;
  const serverCallback = `https://${req.get("host")}/pelecard-callback`;

  const commonQS =
    `?RegID=${encodeURIComponent(RegID)}` +
    `&FAResponseID=${encodeURIComponent(FAResponseID)}` +
    `&CustomerName=${encodeURIComponent(CustomerName)}` +
    `&CustomerEmail=${encodeURIComponent(CustomerEmail)}` +
    `&phone=${encodeURIComponent(phone)}` +
    `&Course=${encodeURIComponent(Course)}` +
    `&Total=${encodeURIComponent(total)}`;

  const payload = {
    terminal: process.env.PELE_TERMINAL,
    user: process.env.PELE_USER,
    password: process.env.PELE_PASSWORD,
    ActionType: "J4",
    Currency: "1",
    FreeTotal: "False",
    ShopNo: "001",
    Total: total,
    GoodURL: `${baseCallback}${commonQS}&Status=approved`,
    ErrorURL: `${baseCallback}${commonQS}&Status=failed`,
    NotificationGoodMail: "ronyt@puah.org.il",
    NotificationErrorMail: "ronyt@puah.org.il",
    ServerSideGoodFeedbackURL: serverCallback,
    ServerSideErrorFeedbackURL: serverCallback,
    ParamX: paramX,
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

// 2) PELECARD WEBHOOK
app.post("/pelecard-callback", async (req, res) => {
  try {
    // Normalize body
    let bodyObj;
    if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
      bodyObj = req.body;
    } else {
      const raw = String(req.body || "")
        .replace(/'/g, '"')
        .replace(/ResultData\s*:\s*\[([^\[\]]+?)\]/g, 'ResultData:{$1}');
      bodyObj = JSON.parse(raw);
    }
    const rd = bodyObj.ResultData || bodyObj.Result || bodyObj;

    const regId = extractRegId(rd);
    const txId = rd.TransactionId || null;
    const shva = rd.ShvaResult || rd.StatusCode || "";
    const status = (shva === "000" || shva === "0") ? "approved" : "failed";

    let amountMinor = getAmountMinor(rd);
    const payments = Math.max(1, getPayments(rd) || 1);
    const last4 = (rd.CreditCardNumber || "").split("*").pop() || "0000";
    const errorMsg = rd.ErrorMessage || bodyObj.ErrorMessage || rd.StatusMessage || "";

    // Log webhook payload
    console.log("Pelecard webhook:", { regId, txId, status, amountMinor, payments, last4, shva, errorMsg });

    // Read the data previously saved to a file
    const savedData = await readTransactionData(regId);
    
    // Create + email (approved only)
    if (txId && status === "approved") {
      // Use the data from the file
      const name    = (savedData.CustomerName || "Unknown").trim();
      const emailTo = (savedData.CustomerEmail || "unknown@puah.org.il").trim();
      const extId   = (savedData.FAResponseID || "").toString(); // This is still coming from Pelecard's direct response
      const courseRaw = (savedData.Course || "קורס");
      const courseClean = courseRaw.replace(/^[\\(]+|[\\)]+$/g, "") || "קורס";
      const amount = amountMinor / 100;

      const summitPayload = {
        Details: {
          Date: new Date().toISOString(),
          Customer: { ExternalIdentifier: extId, Name: name, EmailAddress: emailTo },
          SendByEmail: emailTo
            ? { EmailAddress: emailTo, Original: true, SendAsPaymentRequest: false }
            : undefined,
          Type: 1,
          Comments: `Pelecard Status: approved | Transaction: ${txId}`,
          ExternalReference: regId || txId,
          ClosingText: 'לכל שאלה / בירור, ניתן לפנות אלינו בדוא"ל לכתובת: hd@puah.org.il'
        },
        Items: [{
          Quantity: 1,
          UnitPrice: amount,
          TotalPrice: amount,
          Item: { Name: courseClean }
        }],
        Payments: [{
          Amount: amount,
          Type: 5,
          Details_CreditCard: {
            Last4Digits: last4,
            Payments: payments
          }
        }],
        VATIncluded: true,
        Credentials: {
          CompanyID: parseInt(process.env.SUMMIT_COMPANY_ID, 10),
          APIKey: process.env.SUMMIT_API_KEY
        }
      };

      const summitRes = await fetch(
        "https://app.sumit.co.il/accounting/documents/create/",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(summitPayload) }
      );

      const summitEnvelopeRaw = await summitRes.text();
      let summitEnvelope;
      try {
        summitEnvelope = JSON.parse(summitEnvelopeRaw);
      } catch {
        summitEnvelope = { raw: summitEnvelopeRaw };
      }
      const sd = unwrapSummit(summitEnvelope);

      const summitDocId = sd?.DocumentID || null;
      const receiptUrl = sd?.DocumentDownloadURL || null;

      // Store the receipt URL with the original data
      if (regId && receiptUrl) {
        await writeTransactionData(regId, { ...savedData, receiptUrl });
      }

      console.log("Summit create response:", {
        DocumentID: summitDocId,
        DocumentDownloadURL: receiptUrl
      });
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Pelecard Callback Error:", err);
    res.status(200).send("OK"); // avoid retries
  }
});

// 3) CLIENT REDIRECT
app.get("/callback", async (req, res) => {
  const { Status = "", RegID = "", FAResponseID = "", Total = "", phone = "", Course = "" } = req.query;

  console.log("Client redirect:", req.query);

  // Read the receipt URL from the file system
  const savedData = await readTransactionData(RegID);
  const receiptUrl = savedData.receiptUrl || "";

  const onward =
    `https://puah.tfaforms.net/38` +
    `?RegID=${encodeURIComponent(RegID)}` +
    `&FAResponseID=${encodeURIComponent(FAResponseID)}` +
    `&Total=${encodeURIComponent(Total)}` +
    `&Status=${encodeURIComponent(Status)}` +
    `&phone=${encodeURIComponent(phone)}` +
    `&Course=${encodeURIComponent(Course)}` +
    `&ReceiptURL=${encodeURIComponent(receiptUrl)}`;

  res.redirect(onward);
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Server running on port", port));
