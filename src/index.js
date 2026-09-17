/**
 * DigiPagos.io — Noah Integration Worker
 * ----------------------------------------
 * Handles:
 *  - Creating Business/Individual Customers in Noah
 *  - Generating Hosted Onboarding sessions (embedded in our iframe)
 *  - Receiving Noah webhooks (Transaction status updates)
 *  - Basic merchant record storage in KV (mirrors the MERCHANTS pattern
 *    used in the prdigipagos-worker for Triple-A)
 *
 * ENV VARS EXPECTED:
 *  - NOAH_API_KEY            (secret) -> X-Api-Key header for all Noah API calls
 *  - NOAH_API_BASE           (var)    -> defaults to sandbox below
 *  - NOAH_WEBHOOK_PUBLIC_KEY (var)    -> Noah's public key, used to verify
 *                                        incoming webhook signatures
 *
 * KV NAMESPACE EXPECTED:
 *  - DIGIPAGOS_CUSTOMERS  -> maps our internal customer/merchant IDs to
 *                            Noah CustomerIDs and onboarding status
 */

const NOAH_API_BASE_DEFAULT = "https://api.sandbox.noah.com/v1";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- CORS (adjust origin once digipagos.io is live) ---
    if (request.method === "OPTIONS") {
      return corsResponse();
    }

    try {
      if (path === "/api/noah/customer" && request.method === "POST") {
        return await handleCreateCustomer(request, env);
      }

      if (path === "/api/noah/onboarding-session" && request.method === "POST") {
        return await handleCreateOnboardingSession(request, env);
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

  const { internalCustomerId, type } = body;
  if (!internalCustomerId || !type) {
    return jsonResponse(
      { error: "missing_fields", message: "internalCustomerId and type are required" },
      400
    );
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

  const payload = {
    Metadata: {},
    ReturnURL: returnUrl || "https://digipagos.io/onboarding-complete",
    FiatOptions: [{ FiatCurrencyCode: fiatCurrency || "USD" }],
  };

  const noahRes = await fetch(
    `${noahBase}/onboarding/${encodeURIComponent(internalCustomerId)}`,
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

  const onboardingUrl = noahData.Url || noahData.OnboardingUrl;

  return jsonResponse({ ok: true, onboarding: noahData });
}

/* ------------------------------------------------------------------ */
/*  3. Receive Noah webhooks (Transaction status updates)              */
/* ------------------------------------------------------------------ */
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

  if (event?.Transaction?.ID && env.DIGIPAGOS_CUSTOMERS) {
    const key = `transaction:${event.Transaction.ID}`;
    await env.DIGIPAGOS_CUSTOMERS.put(key, JSON.stringify(event.Transaction));
  }

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
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
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
