const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs").promises;
const path = require("path");

const handleJ5 = require("./pelecardJ5");

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
  for (const c of [
    rd.TotalX100,
    rd.FreeTotalAmount,
    rd.DebitTotal,
    rd.TotalMinor,
    rd.AmountMinor,
    rd.Total,
    rd.Amount,
  ]) {
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

const getLast4 = (rd) => {
  const raw =
    rd.CreditCardNumber ||
    rd.CreditCard ||
    rd.CardNumber ||
    rd.cardNumber ||
    rd.cc ||
    "";
  const s = String(raw).trim();
  if (!s) return "";
  const m = s.match(/(\d{4})\D*$/);
  return m ? m[1] : "";
};

const unwrapSummit = (obj) => (obj && obj.Data ? obj.Data : obj || {});

/* ---------------- GET TRANSACTION FROM PELECARD ---------------- */

const getPelecardTransaction = async (transactionId) => {
  try {
    const payload = {
      terminal: process.env.PELE_TERMINAL,
      user: process.env.PELE_USER,
      password: process.env.PELE_PASSWORD,
      TransactionId: transactionId,
    };

    const response = await fetch(
      "https://gateway21.pelecard.biz/PaymentGW/GetTransaction",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

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
  const actionType = req.query.ActionType;

  if (actionType === "J5") {
    return handleJ5(req, res);
  }

  // -------- J4 FLOW (UNCHANGED) --------

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
    MinPayments: "1",
  };

  const peleRes = await fetch("https://gateway21.pelecard.biz/PaymentGW/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await peleRes.json();
  if (data.URL) return res.redirect(data.URL);
  res.status(500).send(JSON.stringify(data));
});

/* ---------------- WEBHOOK ---------------- */

app.post(
  "/pelecard-callback",
  bodyParser.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      console.log("Pelecard webhook received - RAW BODY:");
      console.log("Content-Type:", req.headers["content-type"]);
      console.log("Body keys:", Object.keys(req.body));

      for (const [key, value] of Object.entries(req.body)) {
        console.log(`${key}: ${value}`);
      }

      let rd = {};

      for (const [key, value] of Object.entries(req.body)) {
        if (
          typeof value === "string" &&
          (value.includes("{") || value.includes("TransactionId"))
        ) {
          try {
            const parsed = JSON.parse(value);
            if (parsed.TransactionId || parsed.ResultData) {
              rd = parsed.ResultData || parsed;
              break;
            }
          } catch {}
        }
      }

      if (!rd.TransactionId) {
        rd = req.body;
      }

      const txId = rd.TransactionId || rd.transactionId;
      const regId = String(rd.ParamX || rd.paramX || "").trim();

      if (txId) {
        const transactionDetails = await getPelecardTransaction(txId);
        if (transactionDetails && transactionDetails.ResultData) {
          rd = transactionDetails.ResultData;
        }
      }

      if (!txId || !regId) return res.send("OK");

      const ok = rd.ShvaResult === "000" || rd.ShvaResult === "0";
      if (!ok) return res.send("OK");

      const amountMinor = getAmountMinor(rd);
      const amount = amountMinor / 100;
      const payments = getPayments(rd);
      const last4 = getLast4(rd);

      const saved = await readTransactionData(regId);

      await writeTransactionData(regId, {
        ...saved,
        last4,
      });

      const summitPayload = {
        Details: {
          Date: new Date().toISOString(),
          Customer: {
            Name: saved.CustomerName || "Client",
            EmailAddress: saved.CustomerEmail || "hd@puah.org.il",
          },
          SendByEmail: {
            EmailAddress: saved.CustomerEmail || "hd@puah.org.il",
            Original: true,
          },
          Type: 1,
          ExternalReference: regId,
          Comments: `Pelecard ${txId}`,
        },
        Items: [
          {
            Quantity: 1,
            UnitPrice: amount,
            TotalPrice: amount,
            Item: { Name: "Registration" },
          },
        ],
        Payments: [
          {
            Amount: amount,
            Type: 5,
            Details_CreditCard: { Last4Digits: last4, Payments: payments },
          },
        ],
        VATIncluded: true,
        Credentials: {
          CompanyID: Number(process.env.SUMMIT_COMPANY_ID),
          APIKey: process.env.SUMMIT_API_KEY,
        },
      };

      const summitRes = await fetch(
        "https://app.sumit.co.il/accounting/documents/create/",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(summitPayload),
        }
      );

      const summit = unwrapSummit(await summitRes.json());

      if (summit.DocumentDownloadURL) {
        await writeTransactionData(regId, {
          ...(await readTransactionData(regId)),
          paidAmount: amount,
          receiptUrl: summit.DocumentDownloadURL,
        });
      } else {
        await writeTransactionData(regId, {
          ...(await readTransactionData(regId)),
          paidAmount: amount,
        });
      }

      res.send("OK");
    } catch (error) {
      console.error("Webhook error:", error);
      res.send("OK");
    }
  }
);

/* ---------------- CALLBACK ---------------- */

app.get("/callback", async (req, res) => {
  const Status = req.query.Status || "";
  const regId = req.query.RegID || "";
  const transactionId = req.query.PelecardTransactionId || "";

  if (!regId) return res.redirect("https://puah.tfaforms.net/38?Status=failed");

  const saved = await readTransactionData(regId);

  if (!saved.paidAmount && transactionId) {
    const transactionDetails = await getPelecardTransaction(transactionId);
    if (transactionDetails && transactionDetails.ResultData) {
      const rd = transactionDetails.ResultData;
      const amountMinor = getAmountMinor(rd);
      const amount = amountMinor / 100;
      const last4 = getLast4(rd);

      if (amount > 0 || last4) {
        await writeTransactionData(regId, {
          ...saved,
          ...(amount > 0 ? { paidAmount: amount } : {}),
          ...(last4 ? { last4 } : {}),
        });
      }
    }
  }

  const updatedSaved = await readTransactionData(regId);

  res.redirect(
    `https://puah.tfaforms.net/38` +
      `?RegID=${encodeURIComponent(regId)}` +
      `&Status=${encodeURIComponent(Status)}` +
      `&Total=${encodeURIComponent(updatedSaved.paidAmount || "")}` +
      `&ReceiptURL=${encodeURIComponent(updatedSaved.receiptUrl || "")}` +
      `&Last4=${encodeURIComponent(updatedSaved.last4 || "")}`
  );
});

app.listen(process.env.PORT || 8080, () => console.log("Server running"));
