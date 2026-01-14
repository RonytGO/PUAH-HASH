const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs").promises;
const path = require("path");

const app = express();

// Handle JSON and text for other endpoints
app.use(bodyParser.text({ type: "*/*" }));
app.use(bodyParser.json());

const RECEIPTS_DIR = path.join(__dirname, "receipts");

/* ---------------- STORAGE ---------------- */

const writeTransactionData = async (RegID, data) => {
  try {
    await fs.mkdir(RECEIPTS_DIR, { recursive: true });
    await fs.writeFile(
      path.join(RECEIPTS_DIR, `${RegID}.json`),
      JSON.stringify(data)
    );
  } catch (err) {
    console.error("WRITE FAIL", RegID, err);
  }
};

const readTransactionData = async (RegID) => {
  try {
    const data = await fs.readFile(
      path.join(RECEIPTS_DIR, `${RegID}.json`),
      "utf8"
    );
    return JSON.parse(data);
  } catch {
    return {};
  }
};

/* ---------------- HELPERS ---------------- */

const toInt = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseInt(s.replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};

const getAmountMinor = (rd) => {
  // First check FreeTotalAmount - might be in shekels with decimals
  if (rd.FreeTotalAmount) {
    const freeTotalStr = String(rd.FreeTotalAmount);
    // If it contains a decimal point (e.g., "150.00")
    if (freeTotalStr.includes('.')) {
      const shekels = parseFloat(freeTotalStr);
      if (!isNaN(shekels)) {
        return Math.round(shekels * 100); // Convert to agorot
      }
    }
    // Otherwise try as integer
    const n = toInt(rd.FreeTotalAmount);
    if (n !== null) {
      // If small number (< 100), assume it's in shekels
      if (n > 0 && n < 100) {
        return n * 100;
      }
      return n;
    }
  }
  
  // Check other amount fields
  for (const c of [rd.TotalX100, rd.DebitTotal, rd.TotalMinor, rd.AmountMinor, rd.Total, rd.Amount]) {
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

/* ---------------- INIT ---------------- */

app.get("/", async (req, res) => {
  const { RegID = "", CustomerName = "", CustomerEmail = "" } = req.query;
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
    FreeTotal: "True",
    ShopNo: "001",
    Total: 0,
    GoodURL: `${baseCallback}?Status=approved&RegID=${encodeURIComponent(RegID)}`,
    ErrorURL: `${baseCallback}?Status=failed&RegID=${encodeURIComponent(RegID)}`,
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

/* ---------------- WEBHOOK ---------------- */

// IMPORTANT: Pelecard sends application/x-www-form-urlencoded, not JSON
app.post("/pelecard-callback", bodyParser.urlencoded({ extended: true }), async (req, res) => {
  try {
    console.log("Pelecard webhook received");
    
    let rd = {};
    const body = req.body;
    
    // Pelecard can send data in two formats:
    // 1. As a JSON string in a specific field (if resultDataKeyName was set)
    // 2. As form-encoded key-value pairs
    
    // Check if we have a JSON string in the body
    let jsonFound = false;
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string' && value.includes('TransactionId')) {
        try {
          rd = JSON.parse(value);
          jsonFound = true;
          console.log("Parsed JSON from field:", key);
          break;
        } catch (e) {
          // Not JSON, continue
        }
      }
    }
    
    // If no JSON string found, use the body as-is
    if (!jsonFound) {
      rd = body;
      console.log("Using form data directly");
    }
    
    console.log("Transaction ID:", rd.TransactionId);
    console.log("ShvaResult:", rd.ShvaResult);
    console.log("FreeTotalAmount:", rd.FreeTotalAmount);
    console.log("All amount fields:", {
      FreeTotalAmount: rd.FreeTotalAmount,
      DebitTotal: rd.DebitTotal,
      TotalX100: rd.TotalX100,
      Total: rd.Total,
      Amount: rd.Amount
    });

    const regId = String(rd.ParamX || "").trim();
    const txId = rd.TransactionId;
    const ok = rd.ShvaResult === "000" || rd.ShvaResult === "0";
    
    if (!regId) {
      console.log("Missing RegID");
      return res.send("OK");
    }
    
    if (!txId || !ok) {
      console.log("Transaction failed or missing:", { txId, ok });
      return res.send("OK");
    }

    const amountMinor = getAmountMinor(rd);
    const amount = amountMinor / 100;
    const payments = getPayments(rd);
    const last4 = (rd.CreditCardNumber || "").split("*").pop();

    console.log("Calculated:", { amountMinor, amount, payments, last4 });

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
      await writeTransactionData(regId, { ...saved, paidAmount: amount, receiptUrl: summit.DocumentDownloadURL });
      console.log("Saved receipt URL for", regId);
    } else {
      console.log("No receipt URL from Summit for", regId);
    }

    res.send("OK");
  } catch (error) {
    console.error("Webhook error:", error);
    res.send("OK");
  }
});

/* ---------------- CALLBACK ---------------- */

app.get("/callback", async (req, res) => {
  const Status = req.query.Status || "";
  const regId = req.query.RegID || "";

  if (!regId) return res.redirect("https://puah.tfaforms.net/38?Status=failed");

  const saved = await readTransactionData(regId);

  res.redirect(
    `https://puah.tfaforms.net/38` +
    `?RegID=${encodeURIComponent(regId)}` +
    `&Status=${encodeURIComponent(Status)}` +
    `&Total=${encodeURIComponent(saved.paidAmount || "")}` +
    `&ReceiptURL=${encodeURIComponent(saved.receiptUrl || "")}`
  );
});

app.listen(process.env.PORT || 8080, () => console.log("Server running"));
