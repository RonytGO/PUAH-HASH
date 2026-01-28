module.exports = async function handleJ2(req, res) {
  const { RegID = "", ReturnURL = "" } = req.query;

  if (!RegID || !ReturnURL) {
    return res.status(400).send("Missing RegID or ReturnURL");
  }

  const payload = {
    terminal: process.env.PELE_TERMINAL,
    user: process.env.PELE_USER,
    password: process.env.PELE_PASSWORD,

    ActionType: "J2",
    CreateToken: "True",

    Currency: "1",
    Total: 0,
    ShopNo: "001",

    // VERY IMPORTANT FOR SALESFORCE FLOW
    FeedbackDataTransferMethod: "GET",

    GoodURL:
      `${ReturnURL}` +
      `?Status=approved` +
      `&RegID=${encodeURIComponent(RegID)}`,

    ErrorURL:
      `${ReturnURL}` +
      `?Status=failed` +
      `&RegID=${encodeURIComponent(RegID)}`,

    // this comes back as ParamX in the redirect
    ParamX: RegID,
  };

  try {
    const peleRes = await fetch(
      "https://gateway21.pelecard.biz/PaymentGW/init",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    const data = await peleRes.json();

    if (!data || !data.URL) {
      console.error("Pelecard J2 init failed:", data);
      return res.status(500).send("Pelecard J2 init failed");
    }

    // Redirect user to Pelecard card registration page
    return res.redirect(data.URL);
  } catch (err) {
    console.error("J2 init error:", err);
    return res.status(500).send("J2 init error");
  }
};
