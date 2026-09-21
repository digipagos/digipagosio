/**
 * DigiPagos.io — Noah Integration Worker
 * ----------------------------------------
 * NON-CUSTODIAL DESIGN
 * DigiPagos is a software interface only. It is not a bank, wallet,
 * money transmitter balance sheet, or custodian.
 *
 * - Merchants authenticate with DigiPagos (email + password).
 * - Customer payments and merchant payouts are created as Noah hosted
 *   checkout sessions. Funds move on Noah’s rails, not DigiPagos’.
 * - DigiPagos never collects bank details, never stores a live wallet,
 *   and never calls Noah’s business-wide /balances as if it were the
 *   merchant’s money.
 * - The “estimated balance” is our own sum of Settled ledger rows we
 *   recorded when creating pay-ins / payouts. It is not funds in custody.
 *
 * Handles:
 *  - Merchant signup/login (email + password, our own auth — separate from Noah)
 *  - Generating Hosted Onboarding sessions (identity verification, embedded in our iframe)
 *  - Creating a payment/checkout link for a merchant's customer to pay
 *  - Creating a hosted payout link (merchant enters bank details on Noah)
 *  - Listing a merchant's transaction history
 *  - Receiving Noah webhooks (Customer + Transaction status updates)
 *
 * DESIGN: a merchant's email IS their Noah CustomerID (sanitized).
 * This ties signup, identity verification, and payments together.
 *
 * ENV VARS EXPECTED:
 *  - NOAH_API_KEY            (secret) -> X-Api-Key header for all Noah API calls
 *  - NOAH_API_BASE           (var)    -> defaults to sandbox below
 *  - NOAH_WEBHOOK_PUBLIC_KEY (var)    -> Noah's public key, verifies incoming webhooks
 *  - AUTH_SECRET             (secret) -> signs our own login session tokens
 *
 * KV NAMESPACE EXPECTED:
 *  - DIGIPAGOS_CUSTOMERS  -> merchant accounts, onboarding status, ledger
 */

const NOAH_API_BASE_DEFAULT = "https://api.sandbox.noah.com/v1";

// Where the site root sends visitors. Change SIGNUP_PATH if your signup page
// lives at a different URL.
const SIGNUP_PATH = "/signup";
const DASHBOARD_PATH = "/dashboard";

const NONCUSTODIAL = {
  model: "non_custodial",
  operator: "DigiPagos",
  processor: "Noah",
  disclaimer:
    "DigiPagos does not hold, store, or take custody of funds. Payments and payouts are processed and settled by Noah. Any balance shown here is DigiPagos’ own estimate from settled records, not a live wallet.",
  paymentDisclaimer:
    "This link opens Noah’s hosted checkout. The customer pays Noah directly. DigiPagos does not collect or hold the payment.",
  payoutDisclaimer:
    "This link opens Noah’s hosted payout page. Enter bank details only on Noah. DigiPagos never receives those details and never holds the payout.",
};

// Noah's CustomerID field rejects special characters (like @ and . in an
// email). We use this sanitized, deterministic version whenever we send
// a CustomerID to Noah, while the merchant still logs in with their real
// email. Example: "name@gmail.com" -> "name-gmail-com".
function toNoahCustomerId(email) {
  return email.trim().toLowerCase().replace(/[^a-z0-9]/g, "-");
}

// Fiat currencies enabled on our Noah account. Noah silently settles other
// currencies in USD, so we reject them here. Override with env ALLOWED_FIAT
// (comma separated, e.g. "USD,MXN") once Noah enables more channels.
function allowedFiat(env) {
  return (env.ALLOWED_FIAT || "USD").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
}

function currencyError(env, currency) {
  const allowed = allowedFiat(env);
  if (allowed.includes(String(currency).toUpperCase())) return null;
  return jsonResponse(
    {
      error: "currency_not_enabled",
      message: `Currency ${currency} is not enabled yet. Enabled: ${allowed.join(", ")}`,
    },
    400
  );
}

// Optional KYC gate. Off unless env REQUIRE_KYC="true". Approved values come
// from env KYC_APPROVED_STATUSES (default "Approved") — confirm the real value
// in the Customer webhook logs before turning this on.
async function kycBlocked(env, noahCustomerId) {
  if (env.REQUIRE_KYC !== "true") return null;
  const raw = await env.DIGIPAGOS_CUSTOMERS.get(`customer:${noahCustomerId}`);
  const status = raw ? JSON.parse(raw).verificationStatus : null;
  const approved = (env.KYC_APPROVED_STATUSES || "Approved")
    .split(",").map((v) => v.trim().toLowerCase());
  if (status && approved.includes(String(status).toLowerCase())) return null;
  return jsonResponse(
    { error: "kyc_required", message: "Identity verification must be completed first", verificationStatus: status || "NotStarted" },
    403
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- CORS (adjust origin once digipagos.io is live) ---
    if (request.method === "OPTIONS") {
      return corsResponse();
    }

    try {
      // digipagos.io -> straight to signup (or dashboard if already logged in)
      if (path === "/" && (request.method === "GET" || request.method === "HEAD")) {
        const sessionEmail = await getSessionEmail(request, env);
        const target = new URL(sessionEmail ? DASHBOARD_PATH : SIGNUP_PATH, url);
        return Response.redirect(target.toString(), 302);
      }

      if (path === "/api/auth/signup" && request.method === "POST") {
        return await handleSignup(request, env);
      }

      if (path === "/api/auth/login" && request.method === "POST") {
        return await handleLogin(request, env);
      }

      if (path === "/api/auth/logout" && request.method === "POST") {
        return handleLogout();
      }

      if (path === "/api/auth/me" && request.method === "GET") {
        return await handleAuthMe(request, env);
      }

      if (path === "/api/noah/customer" && request.method === "POST") {
        return await handleCreateCustomer(request, env);
      }

      if (path === "/api/noah/onboarding-session" && request.method === "POST") {
        return await handleCreateOnboardingSession(request, env);
      }

      if (path === "/api/noah/create-payment" && request.method === "POST") {
        return await handleCreatePayment(request, env);
      }

      if (path === "/api/noah/create-payout" && request.method === "POST") {
        return await handleCreatePayout(request, env);
      }

      if (path === "/api/noah/balance" && request.method === "GET") {
        return await handleGetBalance(request, env);
      }

      if (path === "/api/noah/transactions" && request.method === "GET") {
        return await handleListTransactions(request, env);
      }

      if (path === "/api/noah/webhook" && request.method === "POST") {
        return await handleNoahWebhook(request, env);
      }

      if (path === "/api/noah/customer-status" && request.method === "GET") {
        return await handleGetCustomerStatus(request, env);
      }

      if (path.startsWith("/api/")) {
        return new response404();
      }

      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }

      return new response404();
    } catch (err) {
      console.error("Unhandled error:", err);
      return jsonResponse({ error: "internal_error", message: err.message }, 500);
    }
  },
};

/* ------------------------------------------------------------------ */
/*  1. Create a Customer in Noah (Standard Model)                      */
/* ------------------------------------------------------------------ */
async function handleCreateCustomer(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }

  const body = await request.json();

  // The customer ID always comes from the logged-in session, never from the body.
  const internalCustomerId = toNoahCustomerId(email);
  const { type } = body;
  if (!type) {
    return jsonResponse({ error: "missing_fields", message: "type is required" }, 400);
  }

  const noahBase = env.NOAH_API_BASE || NOAH_API_BASE_DEFAULT;
  const noahPayload = { Type: type, ...body.fields };

  const noahRes = await fetch(`${noahBase}/customers/${encodeURIComponent(internalCustomerId)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": env.NOAH_API_KEY,
    },
    body: JSON.stringify(noahPayload),
  });

  const noahData = await safeJson(noahRes);

  if (!noahRes.ok) {
    return jsonResponse({ error: "noah_error", details: noahData }, noahRes.status);
  }

  if (env.DIGIPAGOS_CUSTOMERS) {
    await env.DIGIPAGOS_CUSTOMERS.put(
      `customer:${internalCustomerId}`,
      JSON.stringify({
        noahCustomerId: internalCustomerId,
        type,
        status: "created",
        createdAt: new Date().toISOString(),
      })
    );
  }

  return jsonResponse({
    ok: true,
    customer: noahData,
    custody: NONCUSTODIAL.model,
    note: "Customer record lives with Noah. DigiPagos stores only a mapping.",
  });
}

/* ------------------------------------------------------------------ */
/*  2. Generate a Hosted Onboarding session (for our iframe)           */
/* ------------------------------------------------------------------ */
async function handleCreateOnboardingSession(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const { returnUrl, fiatCurrency } = body;

  const noahBase = env.NOAH_API_BASE || NOAH_API_BASE_DEFAULT;
  const noahCustomerId = toNoahCustomerId(email);

  const payload = {
    Metadata: {},
    ReturnURL: returnUrl || "https://digipagos.io/onboarding-complete",
    FiatOptions: [{ FiatCurrencyCode: fiatCurrency || "USD" }],
  };

  const noahRes = await fetch(
    `${noahBase}/onboarding/${encodeURIComponent(noahCustomerId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": env.NOAH_API_KEY,
      },
      body: JSON.stringify(payload),
    }
  );

  const noahData = await safeJson(noahRes);

  if (!noahRes.ok) {
    return jsonResponse({ error: "noah_error", details: noahData }, noahRes.status);
  }

  return jsonResponse({
    ok: true,
    onboarding: noahData,
    custody: NONCUSTODIAL.model,
    note: "Identity verification is hosted by Noah. DigiPagos only embeds or links to that session.",
  });
}

/* ------------------------------------------------------------------ */
/*  0a. Merchant signup (our own auth, separate from Noah)             */
/* ------------------------------------------------------------------ */
async function handleSignup(request, env) {
  const { email, password } = await request.json();

  if (!email || !password || password.length < 8) {
    return jsonResponse(
      { error: "invalid_input", message: "email and a password (8+ chars) are required" },
      400
    );
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await env.DIGIPAGOS_CUSTOMERS.get(`merchant:${normalizedEmail}`);
  if (existing) {
    return jsonResponse({ error: "already_exists", message: "An account with this email already exists" }, 409);
  }

  const { hash, salt } = await hashPassword(password);

  await env.DIGIPAGOS_CUSTOMERS.put(
    `merchant:${normalizedEmail}`,
    JSON.stringify({
      email: normalizedEmail,
      passwordHash: hash,
      passwordSalt: salt,
      createdAt: new Date().toISOString(),
    })
  );

  const token = await createSessionToken(normalizedEmail, env.AUTH_SECRET);
  return jsonResponse({ ok: true, email: normalizedEmail }, 200, sessionCookieHeader(token));
}

/* ------------------------------------------------------------------ */
/*  0b. Merchant login                                                  */
/* ------------------------------------------------------------------ */
async function handleLogin(request, env) {
  const { email, password } = await request.json();
  if (!email || !password) {
    return jsonResponse({ error: "invalid_input" }, 400);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const record = await env.DIGIPAGOS_CUSTOMERS.get(`merchant:${normalizedEmail}`);
  if (!record) {
    return jsonResponse({ error: "invalid_credentials" }, 401);
  }

  const merchant = JSON.parse(record);
  const valid = await verifyPassword(password, merchant.passwordHash, merchant.passwordSalt);
  if (!valid) {
    return jsonResponse({ error: "invalid_credentials" }, 401);
  }

  const token = await createSessionToken(normalizedEmail, env.AUTH_SECRET);
  return jsonResponse({ ok: true, email: normalizedEmail }, 200, sessionCookieHeader(token));
}

function handleLogout() {
  return jsonResponse({ ok: true }, 200, {
    "Set-Cookie": "digipagos_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
  });
}

/* ------------------------------------------------------------------ */
/*  0c. Check current session (used by dashboard.html on load)         */
/* ------------------------------------------------------------------ */
async function handleAuthMe(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }
  return jsonResponse({
    ok: true,
    email,
    custody: NONCUSTODIAL.model,
    disclaimer: NONCUSTODIAL.disclaimer,
  });
}

/* ------------------------------------------------------------------ */
/*  5. Create a payment/checkout link (merchant's customer pays here)  */
/* ------------------------------------------------------------------ */
async function handleCreatePayment(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }

  const { amount, method, cryptoCurrency, fiatCurrency, paymentMethodCategory, returnUrl } =
    await request.json();

  if (!amount || Number(amount) <= 0) {
    return jsonResponse({ error: "invalid_input", message: "A positive amount is required" }, 400);
  }

  const noahBase = env.NOAH_API_BASE || NOAH_API_BASE_DEFAULT;
  const amountStr = Number(amount).toFixed(2);
  const noahCustomerId = toNoahCustomerId(email);
  const externalId = crypto.randomUUID();

  const isFiat = method === "fiat";

  if (isFiat) {
    const badCurrency = currencyError(env, fiatCurrency || "USD");
    if (badCurrency) return badCurrency;
  }
  const blocked = await kycBlocked(env, noahCustomerId);
  if (blocked) return blocked;
  const endpoint = isFiat ? "/checkout/payin/fiat" : "/checkout/payin/crypto";

  const payload = isFiat
    ? {
        PaymentMethodCategory: paymentMethodCategory || "Bank",
        FiatCurrency: fiatCurrency || "USD",
        CryptoCurrency: cryptoCurrency || "USDC_TEST",
        FiatAmount: amountStr,
        ReturnURL: returnUrl || "https://digipagos.io/payment-complete",
        ExternalID: externalId,
        CustomerID: noahCustomerId,
        LineItems: [
          { Description: `Payment to ${email}`, Quantity: "1", UnitAmount: amountStr, TotalAmount: amountStr },
        ],
        Nonce: crypto.randomUUID(),
      }
    : {
        CustomerID: noahCustomerId,
        CryptoCurrency: cryptoCurrency || "USDC_TEST",
        CryptoAmount: amountStr,
        ReturnURL: returnUrl || "https://digipagos.io/payment-complete",
        ExternalID: externalId,
        Nonce: crypto.randomUUID(),
        LineItems: [
          { Description: `Payment to ${email}`, Quantity: "1", UnitAmount: amountStr, TotalAmount: amountStr },
        ],
      };

  const noahRes = await fetch(`${noahBase}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": env.NOAH_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const noahData = await safeJson(noahRes);

  if (!noahRes.ok) {
    return jsonResponse({ error: "noah_error", details: noahData, message: formatNoahError(noahData) }, noahRes.status);
  }

  await env.DIGIPAGOS_CUSTOMERS.put(
    `merchant-tx:${noahCustomerId}:${externalId}`,
    JSON.stringify({
      externalId,
      direction: "in",
      amount: Number(amountStr),
      currency: isFiat ? fiatCurrency || "USD" : cryptoCurrency || "USDC_TEST",
      status: "Pending",
      createdAt: new Date().toISOString(),
      custody: "noah",
    })
  );

  return jsonResponse({
    ok: true,
    checkout: noahData,
    custody: NONCUSTODIAL.model,
    processor: NONCUSTODIAL.processor,
    disclaimer: NONCUSTODIAL.paymentDisclaimer,
  });
}

/* ------------------------------------------------------------------ */
/*  5b. Create a payout — merchant withdraws on Noah hosted page       */
/* ------------------------------------------------------------------ */
async function handleCreatePayout(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }

  const { amount, cryptoCurrency, fiatCurrency, returnUrl } = await request.json();

  if (!amount || Number(amount) <= 0) {
    return jsonResponse({ error: "invalid_input", message: "A positive amount is required" }, 400);
  }

  const noahBase = env.NOAH_API_BASE || NOAH_API_BASE_DEFAULT;
  const amountStr = Number(amount).toFixed(2);
  const noahCustomerId = toNoahCustomerId(email);
  const externalId = crypto.randomUUID();

  const badCurrency = currencyError(env, fiatCurrency || "USD");
  if (badCurrency) return badCurrency;
  const blocked = await kycBlocked(env, noahCustomerId);
  if (blocked) return blocked;

  // Hosted flow: Noah collects bank details. DigiPagos never sees them.
  const payload = {
    PaymentMethodCategory: "Bank",
    FiatCurrency: fiatCurrency || "USD",
    CryptoCurrency: cryptoCurrency || "USDC_TEST",
    FiatAmount: amountStr,
    CryptoAuthorizedAmount: amountStr,
    ReturnURL: returnUrl || "https://digipagos.io/payout-complete",
    ExternalID: externalId,
    CustomerID: noahCustomerId,
    LineItems: [
      {
        Description: `Payout for ${email}`,
        Quantity: "1",
        UnitAmount: amountStr,
        TotalAmount: amountStr,
      },
    ],
    Nonce: crypto.randomUUID(),
  };

  const noahRes = await fetch(`${noahBase}/checkout/payout/fiat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": env.NOAH_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const noahData = await safeJson(noahRes);

  if (!noahRes.ok) {
    return jsonResponse({ error: "noah_error", details: noahData, message: formatNoahError(noahData) }, noahRes.status);
  }

  await env.DIGIPAGOS_CUSTOMERS.put(
    `merchant-tx:${noahCustomerId}:${externalId}`,
    JSON.stringify({
      externalId,
      direction: "out",
      amount: Number(amountStr),
      currency: fiatCurrency || "USD",
      status: "Pending",
      createdAt: new Date().toISOString(),
      custody: "noah",
    })
  );

  return jsonResponse({
    ok: true,
    checkout: noahData,
    custody: NONCUSTODIAL.model,
    processor: NONCUSTODIAL.processor,
    disclaimer: NONCUSTODIAL.payoutDisclaimer,
  });
}

/* ------------------------------------------------------------------ */
/*  5c. Estimated balance — OUR OWN calculation from settled ledger    */
/*      Never treat this as funds DigiPagos holds.                     */
/*      Do not use Noah’s business-wide /balances (shared across all   */
/*      merchants and would misrepresent custody).                     */
/* ------------------------------------------------------------------ */
async function handleGetBalance(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }

  const noahCustomerId = toNoahCustomerId(email);
  const list = await env.DIGIPAGOS_CUSTOMERS.list({ prefix: `merchant-tx:${noahCustomerId}:` });
  const records = await Promise.all(
    list.keys.map(async (k) => {
      const val = await env.DIGIPAGOS_CUSTOMERS.get(k.name);
      return val ? JSON.parse(val) : null;
    })
  );

  // Confirm the real completed-status string in sandbox webhook logs.
  const SETTLED = ["settled", "completed"];
  let balance = 0;
  const byCurrency = {};
  for (const r of records) {
    if (!r || !SETTLED.includes(String(r.status).toLowerCase())) continue;
    const signed = r.direction === "out" ? -r.amount : r.amount;
    balance += signed;
    const cur = r.currency || "UNKNOWN";
    byCurrency[cur] = Math.round(((byCurrency[cur] || 0) + signed) * 100) / 100;
  }

  return jsonResponse({
    ok: true,
    estimatedBalance: Math.round(balance * 100) / 100,
    byCurrency,
    isLiveWallet: false,
    heldByDigiPagos: false,
    custody: NONCUSTODIAL.model,
    processor: NONCUSTODIAL.processor,
    disclaimer: NONCUSTODIAL.disclaimer,
  });
}

/* ------------------------------------------------------------------ */
/*  6. List a merchant's transaction history                           */
/* ------------------------------------------------------------------ */
async function handleListTransactions(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }

  const noahCustomerId = toNoahCustomerId(email);
  const list = await env.DIGIPAGOS_CUSTOMERS.list({ prefix: `merchant-tx:${noahCustomerId}:` });
  const transactions = await Promise.all(
    list.keys.map(async (k) => {
      const val = await env.DIGIPAGOS_CUSTOMERS.get(k.name);
      return val ? JSON.parse(val) : null;
    })
  );

  const mapped = transactions.filter(Boolean).map((tx) => ({
    ...tx,
    Created: tx.createdAt || tx.Created || tx.CreatedAt || "-",
    CreatedAt: tx.createdAt || tx.CreatedAt || tx.Created || "-",
    FiatAmount: tx.amount ?? tx.FiatAmount ?? tx.Amount,
    Amount: tx.amount ?? tx.Amount ?? tx.FiatAmount,
    Status: tx.status || tx.Status || "-",
  }));

  mapped.sort((a, b) => String(b.CreatedAt).localeCompare(String(a.CreatedAt)));

  return jsonResponse({
    ok: true,
    transactions: mapped,
    custody: NONCUSTODIAL.model,
    note: "Statuses are recorded from Noah webhooks. DigiPagos displays them only.",
  });
}

async function handleNoahWebhook(request, env) {
  const rawBody = await request.text();

  const signatureHeader = request.headers.get("Webhook-Signature");

  if (!signatureHeader) {
    console.warn("Webhook received without Webhook-Signature header");
    return jsonResponse({ error: "missing_signature" }, 401);
  }

  const publicKeyPem = env.NOAH_WEBHOOK_PUBLIC_KEY;
  if (!publicKeyPem) {
    console.error("NOAH_WEBHOOK_PUBLIC_KEY is not configured");
    return jsonResponse({ error: "server_misconfigured" }, 500);
  }

  const isValid = await verifyNoahSignature(rawBody, signatureHeader, publicKeyPem);
  if (!isValid) {
    console.warn("Webhook signature verification failed");
    return jsonResponse({ error: "invalid_signature" }, 401);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  console.log("Noah webhook received:", JSON.stringify(event));

  if (event?.EventType === "Customer" && event?.Data?.CustomerID) {
    const key = `customer:${event.Data.CustomerID}`;
    await env.DIGIPAGOS_CUSTOMERS.put(
      key,
      JSON.stringify({
        customerId: event.Data.CustomerID,
        verificationStatus: event.Data.Verifications?.Status || "Unknown",
        updatedAt: new Date().toISOString(),
      })
    );
  }

  if (event?.EventType === "Transaction" && event?.Data) {
    const noahCustomerId = event.Data.CustomerID;
    const externalId = event.Data.ExternalID;
    const transactionId = event.Data.TransactionID || event.Data.ID;
    const status = event.Data.Status || "Unknown";

    if (noahCustomerId && externalId) {
      const key = `merchant-tx:${noahCustomerId}:${externalId}`;
      const existingRaw = await env.DIGIPAGOS_CUSTOMERS.get(key);
      const existing = existingRaw ? JSON.parse(existingRaw) : {};
      await env.DIGIPAGOS_CUSTOMERS.put(
        key,
        JSON.stringify({
          ...existing,
          externalId,
          transactionId,
          status,
          noahData: event.Data,
          updatedAt: new Date().toISOString(),
        })
      );
    } else if (noahCustomerId && transactionId) {
      await env.DIGIPAGOS_CUSTOMERS.put(
        `merchant-tx:${noahCustomerId}:${transactionId}`,
        JSON.stringify({ transactionId, status, direction: "unknown", noahData: event.Data })
      );
    } else {
      console.warn("Transaction event missing CustomerID — check field names", JSON.stringify(event.Data));
    }
  }

  return jsonResponse({ received: true });
}

async function handleGetCustomerStatus(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }
  if (!env.DIGIPAGOS_CUSTOMERS) {
    return jsonResponse({ error: "missing_fields_or_kv" }, 400);
  }

  // Session email only; any ?id= in the URL is ignored.
  const record = await env.DIGIPAGOS_CUSTOMERS.get(`customer:${toNoahCustomerId(email)}`);
  if (!record) {
    return jsonResponse({ error: "not_found" }, 404);
  }

  return jsonResponse({ ok: true, customer: JSON.parse(record) });
}

function formatNoahError(noahData) {
  if (!noahData) return "";
  return (
    noahData.Detail ||
    noahData.detail ||
    noahData.message ||
    noahData.Message ||
    noahData.error ||
    ""
  );
}

// Wildcard origin is rejected by browsers when credentials are allowed.
const ALLOWED_ORIGIN = "https://digipagos.io";

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Credentials": "true",
      "Vary": "Origin",
      ...extraHeaders,
    },
  });
}

function sessionCookieHeader(token) {
  return {
    "Set-Cookie": `digipagos_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`,
  };
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hashBytes = await pbkdf2(password, salt);
  return { hash: bytesToBase64(hashBytes), salt: bytesToBase64(salt) };
}

async function verifyPassword(password, storedHashB64, storedSaltB64) {
  const salt = base64ToBytes(storedSaltB64);
  const hashBytes = await pbkdf2(password, salt);
  return bytesToBase64(hashBytes) === storedHashB64;
}

async function pbkdf2(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function createSessionToken(email, secret) {
  const expiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = `${email}.${expiry}`;
  const signature = await hmacSign(payload, secret);
  return `${btoa(payload)}.${signature}`;
}

async function verifySessionToken(token, secret) {
  try {
    const [payloadB64, signature] = token.split(".");
    const payload = atob(payloadB64);
    const expectedSignature = await hmacSign(payload, secret);
    if (!timingSafeEqual(signature, expectedSignature)) return null;

    // Payload is "<email>.<expiry>". The email itself contains dots, so split
    // on the LAST dot only.
    const lastDot = payload.lastIndexOf(".");
    if (lastDot === -1) return null;
    const email = payload.slice(0, lastDot);
    const expiry = Number(payload.slice(lastDot + 1));
    if (!Number.isFinite(expiry) || Date.now() > expiry) return null;

    return email;
  } catch {
    return null;
  }
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSign(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToBase64(new Uint8Array(sigBytes));
}

async function getSessionEmail(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(/digipagos_session=([^;]+)/);
  if (!match) return null;
  return await verifySessionToken(match[1], env.AUTH_SECRET);
}

function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    },
  });
}

async function verifyNoahSignature(rawBody, signatureHeaderB64, publicKeyPem) {
  try {
    const keyData = pemToArrayBuffer(publicKeyPem);
    const publicKey = await crypto.subtle.importKey(
      "spki",
      keyData,
      { name: "ECDSA", namedCurve: "P-384" },
      false,
      ["verify"]
    );

    const derSignature = base64ToBytes(signatureHeaderB64);
    const rawSignature = derToRawEcdsaSignature(derSignature, 48);

    const bodyBytes = new TextEncoder().encode(rawBody);

    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-384" },
      publicKey,
      rawSignature,
      bodyBytes
    );
  } catch (err) {
    console.error("Signature verification error:", err);
    return false;
  }
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  return base64ToBytes(b64).buffer;
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function derToRawEcdsaSignature(der, componentSize) {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error("Invalid DER signature (no SEQUENCE)");

  let seqLen = der[offset++];
  if (seqLen & 0x80) {
    offset += seqLen & 0x7f;
  }

  function readInt() {
    if (der[offset++] !== 0x02) throw new Error("Invalid DER signature (no INTEGER)");
    let len = der[offset++];
    let bytes = der.slice(offset, offset + len);
    offset += len;
    while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.slice(1);
    return bytes;
  }

  const r = readInt();
  const s = readInt();

  function pad(bytes) {
    const out = new Uint8Array(componentSize);
    out.set(bytes, componentSize - bytes.length);
    return out;
  }

  const raw = new Uint8Array(componentSize * 2);
  raw.set(pad(r), 0);
  raw.set(pad(s), componentSize);
  return raw;
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

class response404 extends Response {
  constructor() {
    super(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
}
