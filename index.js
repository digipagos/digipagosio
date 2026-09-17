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
 * ENV VARS EXPECTED (set as Worker secrets):
 *  - NOAH_API_KEY        -> X-Api-Key header for all Noah API calls
 *  - NOAH_API_BASE        (optional override; defaults to sandbox below)
 *  - NOAH_WEBHOOK_SECRET  -> shared secret Noah signs webhook payloads with
 *                            (confirm exact header/verification method with
 *                            Noah's team before going to production)
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

  // noahData is expected to include the hosted onboarding URL — the
  // exact field name should be confirmed against Noah's live response
  // (commonly something like `Url` or `OnboardingUrl`).
  return jsonResponse({ ok: true, onboarding: noahData });
}

/* ------------------------------------------------------------------ */
/*  3. Receive Noah webhooks (Transaction status updates)              */
/* ------------------------------------------------------------------ */
async function handleNoahWebhook(request, env) {
  const rawBody = await request.text();

  // TODO: confirm Noah's actual webhook signing/verification method
  // (header name + algorithm) with their technical team before
  // production. Placeholder check below assumes a shared-secret
  // header for illustration only — DO NOT rely on this as-is.
  const signatureHeader = request.headers.get("X-Noah-Signature");
  if (env.NOAH_WEBHOOK_SECRET && !signatureHeader) {
    console.warn("Webhook received without expected signature header");
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  console.log("Noah webhook received:", JSON.stringify(event));

  // Example: update KV record when a Transaction status changes
  if (event?.Transaction?.ID && env.DIGIPAGOS_CUSTOMERS) {
    const key = `transaction:${event.Transaction.ID}`;
    await env.DIGIPAGOS_CUSTOMERS.put(key, JSON.stringify(event.Transaction));
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
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*", // tighten to digipagos.io before prod
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
