/**
 * DigiPagos.io — Noah Integration Worker
 * ----------------------------------------
 * Handles:
 *  - Merchant signup/login (email + password, our own auth — separate from Noah)
 *  - Generating Hosted Onboarding sessions (identity verification, embedded in our iframe)
 *  - Creating a payment/checkout link for a merchant's customer to pay in crypto
 *  - Listing a merchant's transaction history
 *  - Receiving Noah webhooks (Customer + Transaction status updates)
 *
 * DESIGN: a merchant's email IS their Noah CustomerID. This ties signup,
 * identity verification, and payments together under one identifier.
 *
 * ENV VARS EXPECTED:
 *  - NOAH_API_KEY            (secret) -> X-Api-Key header for all Noah API calls
 *  - NOAH_API_BASE           (var)    -> defaults to sandbox below
 *  - NOAH_WEBHOOK_PUBLIC_KEY (var)    -> Noah's public key, verifies incoming webhooks
 *  - AUTH_SECRET             (secret) -> random string used to sign our own
 *                                        login session tokens (not related to Noah)
 *
 * KV NAMESPACE EXPECTED:
 *  - DIGIPAGOS_CUSTOMERS  -> stores merchant accounts, onboarding status,
 *                            and transaction history
 */

const NOAH_API_BASE_DEFAULT = "https://api.sandbox.noah.com/v1";

// Noah's CustomerID field rejects special characters (like @ and . in an
// email). We use this sanitized, deterministic version whenever we send
// a CustomerID to Noah, while the merchant still logs in with their real
// email. Example: "name@gmail.com" -> "name-gmail-com".
function toNoahCustomerId(email) {
  return email.trim().toLowerCase().replace(/[^a-z0-9]/g, "-");
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

      // Anything under /api/ that didn't match above is a real 404.
      if (path.startsWith("/api/")) {
        return new response404();
      }

      // Everything else (index.html, /assets/logo.png, etc.) is served
      // from the static assets bundled with this Worker (see [assets]
      // in wrangler.toml).
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
  const body = await request.json();

  // Expecting our own merchant to POST minimal info about their end
  // customer (the investor / payer being onboarded), e.g.:
  // { internalCustomerId, type: "Individual" | "Business", ...fields }

  const { internalCustomerId, type } = body;
  if (!internalCustomerId || !type) {
    return jsonResponse(
      { error: "missing_fields", message: "internalCustomerId and type are required" },
      400
    );
  }

  const noahBase = env.NOAH_API_BASE || NOAH_API_BASE_DEFAULT;

  // NOTE: exact payload shape depends on Type (Individual vs Business) —
  // see Noah docs (PUT /v1/customers/:CustomerID). Passing through
  // whatever fields the caller supplied beyond our two required ones.
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

  // Persist mapping in KV
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

  return jsonResponse({ ok: true, customer: noahData });
}

/* ------------------------------------------------------------------ */
/*  2. Generate a Hosted Onboarding session (for our iframe)           */
/* ------------------------------------------------------------------ */
async function handleCreateOnboardingSession(request, env) {
  const body = await request.json();
  const { internalCustomerId, returnUrl, fiatCurrency } = body;

  if (!internalCustomerId) {
    return jsonResponse({ error: "missing_fields", message: "internalCustomerId is required" }, 400);
  }

  const noahBase = env.NOAH_API_BASE || NOAH_API_BASE_DEFAULT;
  const noahCustomerId = toNoahCustomerId(internalCustomerId);

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

  // noahData is expected to include the hosted onboarding URL — the
  // exact field name should be confirmed against Noah's live response
  // (commonly something like `Url` or `OnboardingUrl`).
  return jsonResponse({ ok: true, onboarding: noahData });
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
  return jsonResponse({ ok: true, email });
}

/* ------------------------------------------------------------------ */
/*  5. Create a payment/checkout link (merchant's customer pays here)  */
/* ------------------------------------------------------------------ */
async function handleCreatePayment(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }

  const { amount, cryptoCurrency, returnUrl } = await request.json();

  if (!amount || Number(amount) <= 0) {
    return jsonResponse({ error: "invalid_input", message: "A positive amount is required" }, 400);
  }

  const noahBase = env.NOAH_API_BASE || NOAH_API_BASE_DEFAULT;
  const amountStr = Number(amount).toFixed(2);
  const noahCustomerId = toNoahCustomerId(email);
  const externalId = `pay-${crypto.randomUUID()}`;

  // NOTE: treating 1 unit of stablecoin ≈ $1 USD for this MVP (no live
  // FX conversion). "USDC_TEST" is the sandbox test-token code per
  // Noah's docs — switch to "USDC" when migrating to production.
  const payload = {
    CustomerID: noahCustomerId,
    CryptoCurrency: cryptoCurrency || "USDC_TEST",
    CryptoAmount: amountStr,
    ReturnURL: returnUrl || "https://digipagos.io/payment-complete",
    ExternalID: externalId,
    Nonce: crypto.randomUUID(),
    LineItems: [
      {
        Description: `Payment to ${email}`,
        Quantity: "1",
        UnitAmount: amountStr,
        TotalAmount: amountStr,
      },
    ],
  };

  const noahRes = await fetch(`${noahBase}/checkout/payin/crypto`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": env.NOAH_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const noahData = await safeJson(noahRes);

  if (!noahRes.ok) {
    return jsonResponse({ error: "noah_error", details: noahData }, noahRes.status);
  }

  // Record this as a pending "in" ledger entry — the webhook will update
  // its status to Settled (or Failed) once Noah confirms the outcome.
  await env.DIGIPAGOS_CUSTOMERS.put(
    `merchant-tx:${noahCustomerId}:${externalId}`,
    JSON.stringify({
      externalId,
      direction: "in",
      amount: Number(amountStr),
      status: "Pending",
      createdAt: new Date().toISOString(),
    })
  );

  return jsonResponse({ ok: true, checkout: noahData });
}

/* ------------------------------------------------------------------ */
/*  5b. Create a payout — merchant withdraws to their own bank account */
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
  const externalId = `payout-${crypto.randomUUID()}`;

  // NOTE: this is a hosted flow — Noah collects the merchant's bank
  // details itself in its own checkout page. We only tell it who's
  // withdrawing and how much. Field names are our best guess based on
  // the sibling payin/fiat endpoint's schema — adjust if Noah's actual
  // sandbox response/error names something differently.
  const payload = {
    PaymentMethodCategory: "Bank",
    FiatCurrency: fiatCurrency || "USD",
    CryptoCurrency: cryptoCurrency || "USDC_TEST",
    FiatAmount: amountStr,
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
    return jsonResponse({ error: "noah_error", details: noahData }, noahRes.status);
  }

  // Record this as a pending "out" ledger entry (reduces the estimated
  // balance once Settled).
  await env.DIGIPAGOS_CUSTOMERS.put(
    `merchant-tx:${noahCustomerId}:${externalId}`,
    JSON.stringify({
      externalId,
      direction: "out",
      amount: Number(amountStr),
      status: "Pending",
      createdAt: new Date().toISOString(),
    })
  );

  return jsonResponse({ ok: true, checkout: noahData });
}

/* ------------------------------------------------------------------ */
/*  5c. Estimated balance — OUR OWN calculation from settled ledger    */
/*      entries, never Noah's business-wide /balances endpoint (which */
/*      is shared across ALL merchants and would misrepresent funds). */
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

  let balance = 0;
  for (const r of records) {
    if (!r || r.status !== "Settled") continue;
    balance += r.direction === "out" ? -r.amount : r.amount;
  }

  return jsonResponse({ ok: true, estimatedBalance: Math.round(balance * 100) / 100 });
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

  return jsonResponse({ ok: true, transactions: transactions.filter(Boolean) });
}


async function handleNoahWebhook(request, env) {
  const rawBody = await request.text();

  // Noah signs every webhook with ITS OWN private key (ECDSA P-384 /
  // SHA-384) and sends the signature in the "Webhook-Signature" header
  // (base64). We verify it using Noah's PUBLIC key (not a secret —
  // safe to keep in wrangler.toml as a plain var). See:
  // https://docs.noah.com/api-concepts/webhooks/configuration
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

  // Customer events: update the merchant's onboarding/verification status
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

  // Transaction events: update our own ledger record (created at
  // create-payment/create-payout time) using the ExternalID we set
  // ourselves — this preserves the "direction" (in/out) we control,
  // rather than guessing it from Noah's payload. Falls back to storing
  // under TransactionID if ExternalID is missing (e.g. for a
  // transaction that wasn't created through our own flow).
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

  // Always acknowledge quickly so Noah doesn't retry unnecessarily
  return jsonResponse({ received: true });
}

/* ------------------------------------------------------------------ */
/*  4. Look up a customer's onboarding/transaction status              */
/* ------------------------------------------------------------------ */
async function handleGetCustomerStatus(request, env) {
  const url = new URL(request.url);
  const internalCustomerId = url.searchParams.get("id");

  if (!internalCustomerId || !env.DIGIPAGOS_CUSTOMERS) {
    return jsonResponse({ error: "missing_fields_or_kv" }, 400);
  }

  const record = await env.DIGIPAGOS_CUSTOMERS.get(`customer:${internalCustomerId}`);
  if (!record) {
    return jsonResponse({ error: "not_found" }, 404);
  }

  return jsonResponse({ ok: true, customer: JSON.parse(record) });
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */
function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*", // tighten to digipagos.io before prod
      "Access-Control-Allow-Credentials": "true",
      ...extraHeaders,
    },
  });
}

function sessionCookieHeader(token) {
  // 7-day session. Secure + HttpOnly so JS on the page can't read it;
  // SameSite=Lax is fine since this is same-site form submission.
  return {
    "Set-Cookie": `digipagos_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`,
  };
}

/* ------------------------------------------------------------------ */
/*  Password hashing (PBKDF2 via Web Crypto — no external deps)        */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/*  Session tokens: HMAC-SHA256 signed "<email>.<expiry>.<signature>"  */
/* ------------------------------------------------------------------ */
async function createSessionToken(email, secret) {
  const expiry = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  const payload = `${email}.${expiry}`;
  const signature = await hmacSign(payload, secret);
  return `${btoa(payload)}.${signature}`;
}

async function verifySessionToken(token, secret) {
  try {
    const [payloadB64, signature] = token.split(".");
    const payload = atob(payloadB64);
    const expectedSignature = await hmacSign(payload, secret);
    if (signature !== expectedSignature) return null;

    const [email, expiryStr] = payload.split(".");
    if (Date.now() > Number(expiryStr)) return null; // expired

    return email;
  } catch {
    return null;
  }
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
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Noah webhook signature verification (ECDSA P-384 / SHA-384)        */
/*  Docs: https://docs.noah.com/api-concepts/webhooks/configuration    */
/* ------------------------------------------------------------------ */
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
    const rawSignature = derToRawEcdsaSignature(derSignature, 48); // P-384 -> 48-byte r/s

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

// Converts a DER-encoded ECDSA signature (SEQUENCE of two INTEGERs, r and s)
// into the raw fixed-length r||s format that Web Crypto's verify() expects.
function derToRawEcdsaSignature(der, componentSize) {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error("Invalid DER signature (no SEQUENCE)");

  let seqLen = der[offset++];
  if (seqLen & 0x80) {
    offset += seqLen & 0x7f; // skip long-form length bytes
  }

  function readInt() {
    if (der[offset++] !== 0x02) throw new Error("Invalid DER signature (no INTEGER)");
    let len = der[offset++];
    let bytes = der.slice(offset, offset + len);
    offset += len;
    while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.slice(1); // strip leading zero
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
