const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs").promises;
const path = require("path");

const app = express();
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
  for (const c of [rd.TotalX100, rd.FreeTotalAmount, rd.DebitTotal, rd.TotalMinor, rd.AmountMinor, rd.Total, rd.Amount]) {
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

/* ---------------- GET TRANSACTION FROM PELECARD ---------------- */

const getPelecardTransaction = async (transactionId) => {
  try {
    const payload = {
      terminal: process.env.PELE_TERMINAL,
      user: process.env.PELE_USER,
      password: process.env.PELE_PASSWORD,
      TransactionId: transactionId
    };

    const response = await fetch("https://gateway21.pelecard.biz/PaymentGW/GetTransaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log("GetTransaction response:", data);
    return data;
  } catch (error) {
    console.error("GetTransaction error:", error);
    return null;
  }
};

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

app.post("/pelecard-callback", bodyParser.urlencoded({ extended: true }), async (req, res) => {
  try {
    console.log("Pelecard webhook received - RAW BODY:");
    console.log("Content-Type:", req.headers['content-type']);
    console.log("Body keys:", Object.keys(req.body));
    
    // Log ALL form data
    for (const [key, value] of Object.entries(req.body)) {
      console.log(`${key}: ${value}`);
    }
    
    // Try different parsing approaches
    let rd = {};
    
    // Approach 1: Check if there's a JSON string in any field
    for (const [key, value] of Object.entries(req.body)) {
      if (typeof value === 'string' && (value.includes('{') || value.includes('TransactionId'))) {
        try {
          const parsed = JSON.parse(value);
          if (parsed.TransactionId || parsed.ResultData) {
            rd = parsed.ResultData || parsed;
            console.log("Found JSON in field:", key);
            break;
          }
        } catch (e) {
          // Not valid JSON
        }
      }
    }
    
    // Approach 2: Use the form data directly
    if (!rd.TransactionId) {
      rd = req.body;
      console.log("Using form data directly");
    }
    
    console.log("Parsed rd keys:", Object.keys(rd));
    console.log("Transaction ID:", rd.TransactionId || rd.transactionId);
    console.log("ShvaResult:", rd.ShvaResult || rd.shvaResult);
    
    // If we have a transaction ID, get full details from Pelecard
    const txId = rd.TransactionId || rd.transactionId;
    const regId = String(rd.ParamX || rd.paramX || "").trim();
    
    if (txId) {
      console.log("Fetching transaction details for:", txId);
      const transactionDetails = await getPelecardTransaction(txId);
      
      if (transactionDetails && transactionDetails.ResultData) {
        rd = transactionDetails.ResultData;
        console.log("Got transaction details from GetTransaction API");
      }
    }
    
    if (!txId || !regId) {
      console.log("Missing transaction ID or RegID");
      return res.send("OK");
    }
    
    const ok = rd.ShvaResult === "000" || rd.ShvaResult === "0";
    if (!ok) {
      console.log("Transaction failed:", rd.ShvaResult);
      return res.send("OK");
    }

    const amountMinor = getAmountMinor(rd);
    const amount = amountMinor / 100;
    const payments = getPayments(rd);
    const last4 = (rd.CreditCardNumber || "").split("*").pop();

    console.log("Transaction details:", {
      amountMinor,
      amount,
      payments,
      last4,
      regId,
      txId
    });

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
      console.log("Saved receipt for", regId, "amount:", amount);
    } else {
      console.log("No receipt URL from Summit");
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
  const transactionId = req.query.PelecardTransactionId || "";

  console.log("Callback received:", { Status, regId, transactionId });

  if (!regId) return res.redirect("https://puah.tfaforms.net/38?Status=failed");

  const saved = await readTransactionData(regId);

  // If we don't have the amount yet, try to get it from Pelecard
  if (!saved.paidAmount && transactionId) {
    console.log("No amount in storage, fetching from Pelecard for:", transactionId);
    const transactionDetails = await getPelecardTransaction(transactionId);
    
    if (transactionDetails && transactionDetails.ResultData) {
      const rd = transactionDetails.ResultData;
      const amountMinor = getAmountMinor(rd);
      const amount = amountMinor / 100;
      
      if (amount > 0) {
        await writeTransactionData(regId, { ...saved, paidAmount: amount });
        console.log("Got amount from GetTransaction:", amount);
      }
    }
  }

  const updatedSaved = await readTransactionData(regId);

  res.redirect(
    `https://puah.tfaforms.net/38` +
    `?RegID=${encodeURIComponent(regId)}` +
    `&Status=${encodeURIComponent(Status)}` +
    `&Total=${encodeURIComponent(updatedSaved.paidAmount || "")}` +
    `&ReceiptURL=${encodeURIComponent(updatedSaved.receiptUrl || "")}`
  );
});

app.listen(process.env.PORT || 8080, () => console.log("Server running"));
