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
 *  - RESEND_API_KEY          (secret, OPTIONAL) -> if set, enables real
 *      "forgot password" emails via Resend. Without it, reset tokens are
 *      still created but no email is sent (see handleForgotPassword).
 *  - RESEND_FROM_EMAIL       (var, OPTIONAL) -> defaults to
 *      "DigiPagos <support@digipagos.io>"; override if that mailbox isn't
 *      verified in Resend yet
 *  - VELAFI_API_KEY          (secret, OPTIONAL) -> X-BH-TOKEN header for
 *      VelaFi API calls. NOT SET YET as of this writing — VelaFi doesn't
 *      hand out sandbox credentials publicly; Daniel needs to request them
 *      (API Key + Secret, and confirmation of how X-BH-TOKEN is derived)
 *      from VelaFi support / Juan Felipe before this does anything real.
 *      Every VelaFi route below fails closed with a clear error until it's set.
 *  - VELAFI_API_BASE         (var, OPTIONAL) -> defaults to sandbox below
 *  - ADMIN_KEY               (secret, OPTIONAL) -> a single password that
 *      unlocks the internal master dashboard (/admin.html), showing every
 *      merchant and the settled volume they've moved. NOT a merchant
 *      account — its own short-lived signed cookie, separate from merchant
 *      sessions. Without it, /api/admin/* fails closed with 501.
 *
 * HYBRID CROSS-BORDER MODEL (Noah on-ramp + VelaFi off-ramp):
 *  For corridors where Noah's own local-currency payout is unavailable,
 *  disabled, or pricier (e.g. Argentina, Dominican Republic, China), the
 *  plan is: Noah converts the customer's fiat to stablecoin (on-ramp, as
 *  today), then DigiPagos calls Noah's `POST workflows/bank-deposit-to-
 *  onchain-address` to withdraw that stablecoin to the *same onboarded
 *  customer's own individual VelaFi wallet* (VelaFi auto-provisions one
 *  per merchant/KYB'd customer — confirmed with both Noah and VelaFi this
 *  satisfies Noah's rule that the DestinationAddress must belong to the
 *  onboarded individual, not a third party). VelaFi then completes the
 *  off-ramp to local currency via POST /v2/order/crypto_to_fiat.
 *  Network: USDC on Polygon (cheapest gas, supported by both sides).
 *  DigiPagos never custodies the stablecoin at any point in this chain.
 *
 * KV NAMESPACE EXPECTED:
 *  - DIGIPAGOS_CUSTOMERS  -> merchant accounts, onboarding status, ledger
 */

const NOAH_API_BASE_DEFAULT = "https://api.sandbox.noah.com/v1";
const VELAFI_API_BASE_DEFAULT = "https://api-test.velafi.com";

// Where the site root sends visitors. Change SIGNUP_PATH if your signup page
// lives at a different URL.
const SIGNUP_PATH = "/signup";
const DASHBOARD_PATH = "/dashboard.html";

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
      message: Currency ${currency} is not enabled yet. Enabled: ${allowed.join(", ")},
    },
    400
  );
}

// Optional KYC gate. Off unless env REQUIRE_KYC="true". Approved values come
// from env KYC_APPROVED_STATUSES (default "Approved") — confirm the real value
// in the Customer webhook logs before turning this on.
async function kycBlocked(env, noahCustomerId) {
  if (env.REQUIRE_KYC !== "true") return null;
  const raw = await env.DIGIPAGOS_CUSTOMERS.get(customer:${noahCustomerId});
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

      if (path === "/api/auth/forgot-password" && request.method === "POST") {
        return await handleForgotPassword(request, env);
      }

      if (path === "/api/auth/reset-password" && request.method === "POST") {
        return await handleResetPassword(request, env);
      }

      // --- Internal master dashboard: Daniel-only view across all merchants
      // and their transaction volume. Gated by a single ADMIN_KEY secret,
      // never a merchant account. See handleAdminLogin/handleAdminOverview.
      if (path === "/api/admin/login" && request.method === "POST") {
        return await handleAdminLogin(request, env);
      }

      if (path === "/api/admin/logout" && request.method === "POST") {
        return handleAdminLogout();
      }

      if (path === "/api/admin/overview" && request.method === "GET") {
        return await handleAdminOverview(request, env);
      }

      if (path.startsWith("/api/admin/merchant/") && request.method === "GET") {
        return await handleAdminMerchantDetail(request, env, path.slice("/api/admin/merchant/".length));
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

      if (path === "/api/noah/price" && request.method === "GET") {
        return await handleGetPrice(request, env);
      }

      if (path.startsWith("/api/noah/transaction/") && request.method === "GET") {
        return await handleGetTransactionById(request, env, path.slice("/api/noah/transaction/".length));
      }

      if (path === "/api/noah/business-prefill" && request.method === "POST") {
        return await handleBusinessPrefill(request, env);
      }

      // --- Hybrid cross-border: Noah on-ramp -> withdraw to the customer's
      // own VelaFi wallet -> VelaFi off-ramp to local currency. See the
      // HYBRID CROSS-BORDER MODEL note at the top of this file.
      if (path === "/api/noah/withdraw-to-wallet" && request.method === "POST") {
        return await handleWithdrawToWallet(request, env);
      }

      if (path === "/api/velafi/quote" && request.method === "GET") {
        return await handleVelafiQuote(request, env);
      }

      if (path === "/api/velafi/off-ramp" && request.method === "POST") {
        return await handleVelafiOffRamp(request, env);
      }

      if (path.startsWith("/api/velafi/order/") && request.method === "GET") {
        return await handleVelafiGetOrder(request, env, path.slice("/api/velafi/order/".length));
      }

      if (path === "/api/noah/create-virtual-account" && request.method === "POST") {
        return await handleCreateVirtualAccount(request, env);
      }

      if (path === "/api/noah/virtual-accounts" && request.method === "GET") {
        return await handleListVirtualAccounts(request, env);
      }

      if (path === "/api/noah/simulate-deposit" && request.method === "POST") {
        return await handleSimulateDeposit(request, env);
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

  const noahRes = await fetch(${noahBase}/customers/${encodeURIComponent(internalCustomerId)}, {
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
      customer:${internalCustomerId},
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
  const { returnUrl, fiatCurrency, accountType } = body;
  const customerType = accountType === "Business" ? "Business" : "Individual";

  const noahBase = env.NOAH_API_BASE || NOAH_API_BASE_DEFAULT;
  const noahCustomerId = toNoahCustomerId(email);

  const payload = {
    Metadata: {},
    ReturnURL: returnUrl || "https://digipagos.io/onboarding-complete",
    FiatOptions: [{ FiatCurrencyCode: fiatCurrency || "USD" }],
    CustomerType: customerType,
  };

  const noahRes = await fetch(
    ${noahBase}/onboarding/${encodeURIComponent(noahCustomerId)},
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
/*  4b. Real-time price quote (what a merchant's customer would pay/   */
/*      receive) before they commit to a payment.                     */
/* ------------------------------------------------------------------ */
async function handleGetPrice(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }

  const url = new URL(request.url);
  const sourceCurrency = url.searchParams.get("source");
  const destinationCurrency = url.searchParams.get("destination");
  const sourceAmount = url.searchParams.get("sourceAmount");
  const destinationAmount = url.searchParams.get("destinationAmount");

  if (!sourceCurrency || !destinationCurrency) {
    return jsonResponse({ error: "invalid_input", message: "source and destination currencies are required" }, 400);
  }
  if (sourceAmount && destinationAmount) {
    return jsonResponse({ error: "invalid_input", message: "Provide only one of sourceAmount or destinationAmount" }, 400);
  }

  const noahBase = env.NOAH_API_BASE || NOAH_API_BASE_DEFAULT;
  const qs = new URLSearchParams({ SourceCurrency: sourceCurrency, DestinationCurrency: destinationCurrency });
  if (sourceAmount) qs.set("SourceAmount", sourceAmount);
  if (destinationAmount) qs.set("DestinationAmount", destinationAmount);

  const noahRes = await fetch(${noahBase}/prices?${qs.toString()}, {
    headers: { "X-Api-Key": env.NOAH_API_KEY },
  });
  const noahData = await safeJson(noahRes);

  if (!noahRes.ok) {
    return jsonResponse({ error: "noah_error", details: noahData, message: formatNoahError(noahData) }, noahRes.status);
  }

  return jsonResponse({ ok: true, quote: noahData });
}

/* ------------------------------------------------------------------ */
/*  6b. Look up a single transaction by ID — lets the dashboard poll   */
/*      one payment's status right after creating it, instead of      */
/*      waiting on the full list or the webhook.                      */
/* ------------------------------------------------------------------ */
async function handleGetTransactionById(request, env, transactionId) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }
  if (!transactionId) {
    return jsonResponse({ error: "invalid_input", message: "transactionId is required" }, 400);
  }

  const noahBase = env.NOAH_API_BASE || NOAH_API_BASE_DEFAULT;
  const noahRes = await fetch(${noahBase}/transactions/${encodeURIComponent(transactionId)}, {
    headers: { "X-Api-Key": env.NOAH_API_KEY },
  });
  const noahData = await safeJson(noahRes);

  if (!noahRes.ok) {
    return jsonResponse({ error: "noah_error", details: noahData, message: formatNoahError(noahData) }, noahRes.status);
  }

  // Only return this transaction to its own owner.
  const noahCustomerId = toNoahCustomerId(email);
  if (noahData.CustomerID && noahData.CustomerID !== noahCustomerId) {
    return jsonResponse({ error: "forbidden" }, 403);
  }

  return jsonResponse({ ok: true, transaction: noahData });
}

/* ------------------------------------------------------------------ */
/*  6c. Hybrid cross-border: point Noah's bank-deposit-to-onchain-address */
/*      workflow at the customer's own individual VelaFi wallet, so any  */
/*      fiat that lands in their Noah virtual account auto-converts and  */
/*      forwards on-chain; VelaFi then completes the off-ramp to local   */
/*      currency.                                                        */
/*                                                                        */
/*  STATUS: scaffolded, not yet live (no VELAFI_API_KEY — VelaFi paused  */
/*  US onboarding). Noah's team has now confirmed the request contract   */
/*  for workflows/bank-deposit-to-onchain-address directly:            */
/*    Required: CustomerID, FiatCurrency, CryptoCurrency, Network,       */
/*      DestinationAddress as an OBJECT — { "Address": "..." } — never   */
/*      a bare string.                                                   */
/*    Optional: BusinessFees.                                            */
/*  There is no Amount/Currency field: this is not a one-off "withdraw   */
/*  $X now" call, it (re)points the workflow/virtual-account's auto-     */
/*  forward destination — the same call handleCreateVirtualAccount()     */
/*  above already makes correctly. Preconditions confirmed by Noah:      */
/*  the customer must already exist, Verifications.Status must be        */
/*  Approved for the fiat option being issued, and every required        */
/*  Agreements row must have Accepted: true — if OnboardingStatus is     */
/*  AgreementsRequired, the call will not create/update the account.     */
/*  USD virtual accounts are Standard Model only, which matches this     */
/*  integration.                                                         */
/* ------------------------------------------------------------------ */
async function handleWithdrawToWallet(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }

  const { destinationAddress, fiatCurrency, cryptoCurrency, network, businessFees } =
    await request.json().catch(() => ({}));
  const address = String(destinationAddress || "").trim();
  if (!address || !network || !cryptoCurrency) {
    return jsonResponse(
      { error: "invalid_input", message: "destinationAddress, network, and cryptoCurrency are required" },
      400
    );
  }

  const noahCustomerId = toNoahCustomerId(email);

  // Noah confirmed this call is a no-op (or outright fails) unless the
  // customer's verification is Approved and all required Agreements rows
  // are Accepted. kycBlocked() covers the Approved check; we don't have a
  // cheap local check for Agreements/OnboardingStatus, so Noah's own error
  // response is what ultimately gates this when REQUIRE_KYC is off.
  const blocked = await kycBlocked(env, noahCustomerId);
  if (blocked) return blocked;

  const noahBase = env.NOAH_API_BASE || NOAH_API_BASE_DEFAULT;
  const payload = {
    CustomerID: noahCustomerId,
    FiatCurrency: fiatCurrency || "USD",
    CryptoCurrency: cryptoCurrency,
    Network: network,
    DestinationAddress: { Address: address },
  };
  if (businessFees) payload.BusinessFees = businessFees;

  const noahRes = await fetch(${noahBase}/workflows/bank-deposit-to-onchain-address, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": env.NOAH_API_KEY },
    body: JSON.stringify(payload),
  });
  const noahData = await safeJson(noahRes);

  if (!noahRes.ok) {
    if (noahData && noahData.OnboardingStatus === "AgreementsRequired") {
      return jsonResponse(
        {
          error: "agreements_required",
          message: "Outstanding Provider agreements must be accepted before this account can be created.",
          details: noahData,
        },
        409
      );
    }
    return jsonResponse({ error: "noah_error", details: noahData, message: formatNoahError(noahData) }, noahRes.status);
  }

  return jsonResponse({ ok: true, withdrawal: noahData });
}

function velafiHeaders(env) {
  return { "X-BH-TOKEN": env.VELAFI_API_KEY, "Content-Type": "application/json" };
}

function velafiNotConfigured() {
  return jsonResponse(
    {
      error: "velafi_not_configured",
      message: "VELAFI_API_KEY is not set. Request sandbox credentials from VelaFi before using this route.",
    },
    501
  );
}

async function handleVelafiQuote(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }
  if (!env.VELAFI_API_KEY) {
    return velafiNotConfigured();
  }

  const url = new URL(request.url);
  const country = url.searchParams.get("country");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!country || !from || !to) {
    return jsonResponse({ error: "invalid_input", message: "country, from, and to are required" }, 400);
  }

  const velafiBase = env.VELAFI_API_BASE || VELAFI_API_BASE_DEFAULT;
  const qs = new URLSearchParams({ country, from, to });
  const velafiRes = await fetch(${velafiBase}/v2/user/crypto-quote?${qs.toString()}, {
    headers: velafiHeaders(env),
  });
  const velafiData = await safeJson(velafiRes);

  if (!velafiRes.ok) {
    return jsonResponse({ error: "velafi_error", details: velafiData }, velafiRes.status);
  }

  return jsonResponse({ ok: true, quote: velafiData });
}

async function handleVelafiOffRamp(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }
  if (!env.VELAFI_API_KEY) {
    return velafiNotConfigured();
  }

  const { crypto, cryptoAmount, country, fiat, userPaymentId, remark } = await request.json().catch(() => ({}));
  if (!crypto || !cryptoAmount || !country || !fiat || !userPaymentId) {
    return jsonResponse(
      { error: "invalid_input", message: "crypto, cryptoAmount, country, fiat, and userPaymentId are required" },
      400
    );
  }

  const velafiBase = env.VELAFI_API_BASE || VELAFI_API_BASE_DEFAULT;
  const velafiRes = await fetch(${velafiBase}/v2/order/crypto_to_fiat, {
    method: "POST",
    headers: velafiHeaders(env),
    body: JSON.stringify({ crypto, cryptoAmount, country, fiat, userPaymentId, remark, clientId: toNoahCustomerId(email) }),
  });
  const velafiData = await safeJson(velafiRes);

  if (!velafiRes.ok) {
    return jsonResponse({ error: "velafi_error", details: velafiData }, velafiRes.status);
  }

  return jsonResponse({ ok: true, order: velafiData });
}

async function handleVelafiGetOrder(request, env, orderId) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }
  if (!env.VELAFI_API_KEY) {
    return velafiNotConfigured();
  }
  if (!orderId) {
    return jsonResponse({ error: "invalid_input", message: "orderId is required" }, 400);
  }

  const url = new URL(request.url);
  const orderType = url.searchParams.get("orderType") || "crypto_to_fiat";

  const velafiBase = env.VELAFI_API_BASE || VELAFI_API_BASE_DEFAULT;
  const qs = new URLSearchParams({ orderId, orderType });
  const velafiRes = await fetch(${velafiBase}/v2/order/detail?${qs.toString()}, {
    headers: velafiHeaders(env),
  });
  const velafiData = await safeJson(velafiRes);

  if (!velafiRes.ok) {
    return jsonResponse({ error: "velafi_error", details: velafiData }, velafiRes.status);
  }

  return jsonResponse({ ok: true, order: velafiData });
}

/* ------------------------------------------------------------------ */
/*  2b. Prefill KYB data for a Business customer (optional; Noah still */
/*      requires the Hosted Onboarding session above for T&Cs).        */
/* ------------------------------------------------------------------ */
async function handleBusinessPrefill(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const required = ["companyName", "registrationCountry", "registrationNumber", "entityType"];
  for (const f of required) {
    if (!body[f]) return jsonResponse({ error: "missing_fields", message: ${f} is required }, 400);
  }

  const noahBase = env.NOAH_API_BASE || NOAH_API_BASE_DEFAULT;
  const noahCustomerId = toNoahCustomerId(email);

  const payload = {
    Type: "BusinessCustomerPrefill",
    CompanyName: body.companyName,
    RegistrationCountry: body.registrationCountry,
    RegistrationNumber: body.registrationNumber,
    EntityType: body.entityType,
  };
  if (body.incorporationDate) payload.IncorporationDate = body.incorporationDate;
  if (body.taxId) payload.TaxID = body.taxId;
  if (body.website) payload.PrimaryWebsite = body.website;
  if (body.legalAddress) payload.LegalAddress = body.legalAddress;

  const noahRes = await fetch(${noahBase}/onboarding/${encodeURIComponent(noahCustomerId)}/prefill, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": env.NOAH_API_KEY },
    body: JSON.stringify(payload),
  });
  const noahData = await safeJson(noahRes);

  if (!noahRes.ok) {
    return jsonResponse({ error: "noah_error", details: noahData, message: formatNoahError(noahData) }, noahRes.status);
  }

  return jsonResponse({ ok: true, result: noahData });
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
  const existing = await env.DIGIPAGOS_CUSTOMERS.get(merchant:${normalizedEmail});
  if (existing) {
    return jsonResponse({ error: "already_exists", message: "An account with this email already exists" }, 409);
  }

  const { hash, salt } = await hashPassword(password);

  await env.DIGIPAGOS_CUSTOMERS.put(
    merchant:${normalizedEmail},
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
  const record = await env.DIGIPAGOS_CUSTOMERS.get(merchant:${normalizedEmail});
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
/*  0c-bis. Forgot / reset password                                    */
/*                                                                      */
/*  Reset tokens are single-use, expire in 30 minutes, and are stored  */
/*  in KV keyed by a SHA-256 hash of the token (never the raw token)   */
/*  so a KV dump alone can't be used to take over an account. The      */
/*  forgot-password response is identical whether or not the email     */
/*  exists, to avoid leaking which emails have accounts.                */
/* ------------------------------------------------------------------ */
const RESET_TOKEN_TTL_SECONDS = 30 * 60;

async function handleForgotPassword(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const email = (body.email || "").trim().toLowerCase();
  const generic = { ok: true, message: "If an account exists for that email, a reset link has been sent." };

  if (!email) {
    return jsonResponse(generic, 200);
  }

  const record = await env.DIGIPAGOS_CUSTOMERS.get(merchant:${email});
  if (!record) {
    // Don't reveal whether the account exists.
    return jsonResponse(generic, 200);
  }

  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToBase64Url(tokenBytes);
  const tokenHash = await sha256Hex(token);

  await env.DIGIPAGOS_CUSTOMERS.put(
    reset:${tokenHash},
    JSON.stringify({ email, createdAt: new Date().toISOString() }),
    { expirationTtl: RESET_TOKEN_TTL_SECONDS }
  );

  const resetUrl = https://digipagos.io/reset-password.html?token=${encodeURIComponent(token)};

  if (env.RESEND_API_KEY) {
    try {
      await sendResetEmail(env, email, resetUrl);
    } catch (err) {
      // Never leak whether sending failed to the client, and never log the
      // raw email/token — a hash is enough to trace an incident in KV.
      console.log("Password reset email failed to send:", { emailHash: await sha256Hex(email) });
    }
  } else {
    // No email provider configured yet. Log a hash only (never the raw
    // email or token) so this is visible in tail logs without storing PII.
    console.log(
      "Password reset requested but RESEND_API_KEY is not set — no email sent.",
      { emailHash: await sha256Hex(email) }
    );
  }

  return jsonResponse(generic, 200);
}

async function handleResetPassword(request, env) {
  const { token, password } = await request.json();
  if (!token || !password || password.length < 8) {
    return jsonResponse(
      { error: "invalid_input", message: "token and a new password (8+ chars) are required" },
      400
    );
  }

  const tokenHash = await sha256Hex(token);
  const raw = await env.DIGIPAGOS_CUSTOMERS.get(reset:${tokenHash});
  if (!raw) {
    return jsonResponse({ error: "invalid_or_expired_token" }, 400);
  }

  const { email } = JSON.parse(raw);
  const merchantKey = merchant:${email};
  const merchantRaw = await env.DIGIPAGOS_CUSTOMERS.get(merchantKey);
  if (!merchantRaw) {
    await env.DIGIPAGOS_CUSTOMERS.delete(reset:${tokenHash});
    return jsonResponse({ error: "invalid_or_expired_token" }, 400);
  }

  const merchant = JSON.parse(merchantRaw);
  const { hash, salt } = await hashPassword(password);
  merchant.passwordHash = hash;
  merchant.passwordSalt = salt;
  merchant.passwordResetAt = new Date().toISOString();

  await env.DIGIPAGOS_CUSTOMERS.put(merchantKey, JSON.stringify(merchant));
  // Single-use: burn the token immediately so it can't be replayed.
  await env.DIGIPAGOS_CUSTOMERS.delete(reset:${tokenHash});

  const sessionToken = await createSessionToken(email, env.AUTH_SECRET);
  return jsonResponse({ ok: true, email }, 200, sessionCookieHeader(sessionToken));
}

async function sendResetEmail(env, email, resetUrl) {
  const fromAddress = env.RESEND_FROM_EMAIL || "DigiPagos <support@digipagos.io>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: Bearer ${env.RESEND_API_KEY},
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to: email,
      subject: "Reset your DigiPagos password",
      html: `
        <p>We received a request to reset your DigiPagos password.</p>
        <p><a href="${resetUrl}">Click here to choose a new password</a> (this link expires in 30 minutes).</p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `,
    }),
  });
  if (!res.ok) {
    throw new Error(Resend responded ${res.status});
  }
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
    sandbox: isSandbox(env),
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
          { Description: Payment to ${email}, Quantity: "1", UnitAmount: amountStr, TotalAmount: amountStr },
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
          { Description: Payment to ${email}, Quantity: "1", UnitAmount: amountStr, TotalAmount: amountStr },
        ],
      };

  const noahRes = await fetch(${noahBase}${endpoint}, {
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
    merchant-tx:${noahCustomerId}:${externalId},
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
        Description: Payout for ${email},
        Quantity: "1",
        UnitAmount: amountStr,
        TotalAmount: amountStr,
      },
    ],
    Nonce: crypto.randomUUID(),
  };

  const noahRes = await fetch(${noahBase}/checkout/payout/fiat, {
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
    merchant-tx:${noahCustomerId}:${externalId},
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
  const list = await env.DIGIPAGOS_CUSTOMERS.list({ prefix: merchant-tx:${noahCustomerId}: });
  const records = await Promise.all(
    list.keys.map(async (k) => {
      const val = await env.DIGIPAGOS_CUSTOMERS.get(k.name);
      return val ? JSON.parse(val) : null;
    })
  );

  // Noah confirmed: a Transaction's Status is exactly one of Pending,
  // Failed, Settled. "Completed" is a value of the separate RFI.Status
  // field and can appear while the transaction itself is still Pending —
  // it must never be treated as settled here.
  let balance = 0;
  const byCurrency = {};
  for (const r of records) {
    if (!r || String(r.status).toLowerCase() !== "settled") continue;
    // Bank deposits go straight to the merchant's own wallet, and records
    // without our own amount/direction can't be summed.
    if (r.kind === "bank-deposit") continue;
    if ((r.direction !== "in" && r.direction !== "out") || !Number.isFinite(r.amount)) continue;
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
  const list = await env.DIGIPAGOS_CUSTOMERS.list({ prefix: merchant-tx:${noahCustomerId}: });
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

/* ------------------------------------------------------------------ */
/*  6d. Internal master dashboard (Daniel-only): every merchant and the */
/*      settled volume they've moved, aggregated from the same KV data  */
/*      the merchant-facing dashboard already reads. Gated by a single  */
/*      ADMIN_KEY secret (env.ADMIN_KEY) — not a merchant login — kept   */
/*      in its own signed cookie (digipagos_admin_session) so a         */
/*      merchant session can never pass as an admin session.            */
/*                                                                       */
/*  Reads every merchant:* key via KV.list(), so it's an MVP fit for  */
/*  the current handful of sandbox merchants. If the merchant count     */
/*  grows into the hundreds, replace the per-key KV.get() fan-out below */
/*  with a proper index or a small D1/database table.                   */
/* ------------------------------------------------------------------ */
function adminSessionCookieHeader(token) {
  return {
    "Set-Cookie": digipagos_admin_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200,
  };
}

async function getAdminSession(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(/digipagos_admin_session=([^;]+)/);
  if (!match) return false;
  const subject = await verifySessionToken(match[1], env.AUTH_SECRET);
  return subject === "admin";
}

async function handleAdminLogin(request, env) {
  if (!env.ADMIN_KEY) {
    return jsonResponse(
      { error: "admin_not_configured", message: "Set ADMIN_KEY as a Worker secret to enable the master dashboard." },
      501
    );
  }

  const { adminKey } = await request.json().catch(() => ({}));
  if (!adminKey || !timingSafeEqual(String(adminKey), String(env.ADMIN_KEY))) {
    return jsonResponse({ error: "invalid_credentials" }, 401);
  }

  // 12-hour admin session, shorter-lived than a merchant session on purpose.
  const token = await createSessionToken("admin", env.AUTH_SECRET);
  return jsonResponse({ ok: true }, 200, adminSessionCookieHeader(token));
}

function handleAdminLogout() {
  return jsonResponse({ ok: true }, 200, {
    "Set-Cookie": "digipagos_admin_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
  });
}

async function handleAdminOverview(request, env) {
  const isAdmin = await getAdminSession(request, env);
  if (!isAdmin) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }

  const merchantList = await env.DIGIPAGOS_CUSTOMERS.list({ prefix: "merchant:" });
  const merchants = await Promise.all(
    merchantList.keys.map(async (k) => {
      const raw = await env.DIGIPAGOS_CUSTOMERS.get(k.name);
      if (!raw) return null;
      const merchant = JSON.parse(raw);
      const noahCustomerId = toNoahCustomerId(merchant.email);

      const [customerRaw, txList] = await Promise.all([
        env.DIGIPAGOS_CUSTOMERS.get(customer:${noahCustomerId}),
        env.DIGIPAGOS_CUSTOMERS.list({ prefix: merchant-tx:${noahCustomerId}: }),
      ]);
      const customer = customerRaw ? JSON.parse(customerRaw) : null;

      const txRecords = (
        await Promise.all(txList.keys.map((tk) => env.DIGIPAGOS_CUSTOMERS.get(tk.name)))
      )
        .filter(Boolean)
        .map((v) => JSON.parse(v));

      // Only "Settled" is a fully settled transaction status (see the note
      // in handleGetBalance) — "Completed" is an RFI.Status value, not a
      // transaction status, and must never be counted as settled volume here.
      const volumeByCurrency = {};
      let settledCount = 0;
      let pendingCount = 0;
      let failedCount = 0;
      let lastActivity = null;

      for (const tx of txRecords) {
        const status = String(tx.status || "").toLowerCase();
        if (status === "settled") {
          settledCount++;
          const cur = tx.currency || "USD";
          const amt = Number(tx.amount) || 0;
          volumeByCurrency[cur] = (volumeByCurrency[cur] || 0) + amt;
        } else if (status === "failed") {
          failedCount++;
        } else {
          pendingCount++;
        }
        const ts = tx.updatedAt || tx.createdAt;
        if (ts && (!lastActivity || ts > lastActivity)) lastActivity = ts;
      }

      return {
        email: merchant.email,
        noahCustomerId,
        createdAt: merchant.createdAt || null,
        verificationStatus: customer?.verificationStatus || "NotStarted",
        accountType: customer?.accountType || null,
        transactionCount: txRecords.length,
        settledCount,
        pendingCount,
        failedCount,
        volumeByCurrency,
        lastActivity,
      };
    })
  );

  const rows = merchants.filter(Boolean).sort((a, b) => String(b.lastActivity || b.createdAt || "").localeCompare(String(a.lastActivity || a.createdAt || "")));

  const totals = { merchantCount: rows.length, volumeByCurrency: {} };
  for (const r of rows) {
    for (const [cur, amt] of Object.entries(r.volumeByCurrency)) {
      totals.volumeByCurrency[cur] = (totals.volumeByCurrency[cur] || 0) + amt;
    }
  }

  return jsonResponse({ ok: true, merchants: rows, totals });
}

async function handleAdminMerchantDetail(request, env, noahCustomerId) {
  const isAdmin = await getAdminSession(request, env);
  if (!isAdmin) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }

  const id = decodeURIComponent(noahCustomerId || "");
  if (!id) return jsonResponse({ error: "invalid_input" }, 400);

  const [customerRaw, txList] = await Promise.all([
    env.DIGIPAGOS_CUSTOMERS.get(customer:${id}),
    env.DIGIPAGOS_CUSTOMERS.list({ prefix: merchant-tx:${id}: }),
  ]);

  const transactions = (
    await Promise.all(txList.keys.map((tk) => env.DIGIPAGOS_CUSTOMERS.get(tk.name)))
  )
    .filter(Boolean)
    .map((v) => JSON.parse(v))
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));

  return jsonResponse({
    ok: true,
    noahCustomerId: id,
    customer: customerRaw ? JSON.parse(customerRaw) : null,
    transactions,
  });
}

/* ------------------------------------------------------------------ */
/*  7. Virtual accounts (Noah Bank Onramp).                            */
/*     Customer deposits USD by ACH/wire to a dedicated account number; */
/*     Noah converts it and sends the crypto straight to the merchant's */
/*     own wallet. DigiPagos never holds the funds.                     */
/*     USD virtual accounts require the Standard Model KYC.             */
/* ------------------------------------------------------------------ */
function isSandbox(env) {
  return (env.NOAH_API_BASE || NOAH_API_BASE_DEFAULT).includes("sandbox");
}

async function handleCreateVirtualAccount(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const { cryptoCurrency, network, destinationAddress, fiatCurrency } = body;
  const address = String(destinationAddress || "").trim();

  if (!network || address.length < 20 || address.length > 100 || /\s/.test(address)) {
    return jsonResponse(
      { error: "invalid_input", message: "A network and a valid destination wallet address are required" },
      400
    );
  }

  const badCurrency = currencyError(env, fiatCurrency || "USD");
  if (badCurrency) return badCurrency;

  const noahCustomerId = toNoahCustomerId(email);
  const blocked = await kycBlocked(env, noahCustomerId);
  if (blocked) return blocked;

  const noahBase = env.NOAH_API_BASE || NOAH_API_BASE_DEFAULT;
  const payload = {
    CustomerID: noahCustomerId,
    FiatCurrency: fiatCurrency || "USD",
    CryptoCurrency: cryptoCurrency || "USDC_TEST",
    Network: network,
    DestinationAddress: { Address: address },
  };

  const noahRes = await fetch(${noahBase}/workflows/bank-deposit-to-onchain-address, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": env.NOAH_API_KEY },
    body: JSON.stringify(payload),
  });
  const noahData = await safeJson(noahRes);

  if (!noahRes.ok) {
    return jsonResponse({ error: "noah_error", details: noahData, message: formatNoahError(noahData) }, noahRes.status);
  }

  // Keep only our own routing metadata. Bank details are always re-fetched
  // from Noah when shown (Noah recommends not caching them).
  if (noahData.VirtualAccountID) {
    await env.DIGIPAGOS_CUSTOMERS.put(
      va:${noahCustomerId}:${noahData.VirtualAccountID},
      JSON.stringify({
        virtualAccountId: noahData.VirtualAccountID,
        network,
        cryptoCurrency: payload.CryptoCurrency,
        fiatCurrency: payload.FiatCurrency,
        destinationAddress: address,
        createdAt: new Date().toISOString(),
      })
    );
  }

  return jsonResponse({
    ok: true,
    virtualAccount: noahData,
    custody: NONCUSTODIAL.model,
    processor: NONCUSTODIAL.processor,
  });
}

async function fetchNoahVirtualAccounts(env, noahCustomerId) {
  const noahBase = env.NOAH_API_BASE || NOAH_API_BASE_DEFAULT;
  const res = await fetch(
    ${noahBase}/virtual-accounts?CustomerID=${encodeURIComponent(noahCustomerId)}&PageSize=50,
    { headers: { "X-Api-Key": env.NOAH_API_KEY } }
  );
  const data = await safeJson(res);
  return { res, data };
}

async function handleListVirtualAccounts(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }

  const noahCustomerId = toNoahCustomerId(email);
  const { res, data } = await fetchNoahVirtualAccounts(env, noahCustomerId);

  if (!res.ok) {
    return jsonResponse({ error: "noah_error", details: data, message: formatNoahError(data) }, res.status);
  }

  const items = await Promise.all(
    (data.Items || []).map(async (it) => {
      const raw = await env.DIGIPAGOS_CUSTOMERS.get(va:${noahCustomerId}:${it.VirtualAccountID});
      return { ...it, destination: raw ? JSON.parse(raw) : null };
    })
  );

  return jsonResponse({
    ok: true,
    sandbox: isSandbox(env),
    items,
    custody: NONCUSTODIAL.model,
  });
}

// Sandbox only: simulate a customer's bank deposit into one of the caller's
// own virtual accounts, to exercise the FiatDeposit / Transaction webhooks.
async function handleSimulateDeposit(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) {
    return jsonResponse({ error: "not_authenticated" }, 401);
  }
  if (!isSandbox(env)) {
    return jsonResponse({ error: "sandbox_only" }, 403);
  }

  const { paymentMethodId, amount } = await request.json().catch(() => ({}));
  if (!paymentMethodId || !amount || Number(amount) <= 0) {
    return jsonResponse({ error: "invalid_input", message: "paymentMethodId and a positive amount are required" }, 400);
  }

  // Only allow simulating into the caller's own virtual accounts.
  const { res: listRes, data: listData } = await fetchNoahVirtualAccounts(env, toNoahCustomerId(email));
  const owns =
    listRes.ok &&
    (listData.Items || []).some((v) => (v.PaymentMethods || []).some((pm) => pm.ID === paymentMethodId));
  if (!owns) {
    return jsonResponse({ error: "forbidden", message: "Payment method does not belong to this account" }, 403);
  }

  const noahBase = env.NOAH_API_BASE || NOAH_API_BASE_DEFAULT;
  const noahRes = await fetch(${noahBase}/sandbox/fiat-deposit/simulate, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": env.NOAH_API_KEY },
    body: JSON.stringify({
      PaymentMethodID: paymentMethodId,
      FiatAmount: Number(amount).toFixed(2),
      FiatCurrency: "USD",
    }),
  });
  const noahData = await safeJson(noahRes);

  if (!noahRes.ok) {
    return jsonResponse({ error: "noah_error", details: noahData, message: formatNoahError(noahData) }, noahRes.status);
  }
  return jsonResponse({ ok: true, result: noahData });
}

// Reduces a Noah webhook event to the fields useful for debugging, without
// the PII Noah includes on Customer events (FullName, DateOfBirth,
// Identities, PrimaryResidence, Agreements). Never log the raw event.
function summarizeWebhookEvent(event) {
  const d = event?.Data || {};
  const base = {
    EventType: event?.EventType,
    EventVersion: event?.EventVersion,
    Occurred: event?.Occurred,
    CustomerID: d.CustomerID || d.ID,
  };
  if (event?.EventType === "Customer") {
    return {
      ...base,
      Type: d.Type,
      VerificationStatus: d.Verifications?.Status,
    };
  }
  if (event?.EventType === "Transaction") {
    return {
      ...base,
      TransactionID: d.ID,
      Direction: d.Direction,
      Status: d.Status,
      SubStatus: d.SubStatus,
      CryptoCurrency: d.CryptoCurrency,
      Amount: d.Amount,
      Network: d.Network,
    };
  }
  if (event?.EventType === "FiatDeposit") {
    return {
      ...base,
      DepositID: d.ID,
      Status: d.Status,
      SubStatus: d.SubStatus,
      FiatCurrency: d.FiatCurrency,
      FiatAmount: d.FiatAmount,
      PaymentMethodType: d.PaymentMethodType,
    };
  }
  return base;
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

  // Log a redacted summary only. The raw payload carries PII (full name,
  // date of birth, government ID, home address) that must never sit in
  // plaintext logs once real customers are onboarding.
  console.log("Noah webhook received:", JSON.stringify(summarizeWebhookEvent(event)));

  if (event?.EventType === "Customer" && event?.Data?.CustomerID) {
    const key = customer:${event.Data.CustomerID};
    await env.DIGIPAGOS_CUSTOMERS.put(
      key,
      JSON.stringify({
        customerId: event.Data.CustomerID,
        verificationStatus: event.Data.Verifications?.Status || "Unknown",
        accountType: event.Data.Type || null,
        updatedAt: new Date().toISOString(),
      })
    );
  }

  if (event?.EventType === "FiatDeposit" && event?.Data?.ID) {
    const d = event.Data;
    if (d.CustomerID) {
      const key = merchant-tx:${d.CustomerID}:dep-${d.ID};
      const existingRaw = await env.DIGIPAGOS_CUSTOMERS.get(key);
      const existing = existingRaw ? JSON.parse(existingRaw) : {};
      const stale = existing.eventVersion && event.EventVersion && event.EventVersion < existing.eventVersion;
      if (!stale) {
        await env.DIGIPAGOS_CUSTOMERS.put(
          key,
          JSON.stringify({
            ...existing,
            externalId: dep-${d.ID},
            kind: "bank-deposit",
            direction: "in",
            amount: Number(d.FiatAmount),
            currency: d.FiatCurrency,
            status: d.Status || "Unknown",
            subStatus: d.SubStatus || null,
            rfiStatus: d.RFI?.Status || null,
            sender: d.Sender?.FullName || null,
            paymentMethodType: d.PaymentMethodType || null,
            createdAt: existing.createdAt || d.Created || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            eventVersion: event.EventVersion || null,
            custody: "noah",
          })
        );
      }
    } else {
      console.warn("FiatDeposit event missing CustomerID");
    }
  }

  if (event?.EventType === "Transaction" && event?.Data) {
    const noahCustomerId = event.Data.CustomerID;
    const externalId = event.Data.ExternalID;
    const transactionId = event.Data.TransactionID || event.Data.ID;
    const status = event.Data.Status || "Unknown";

    if (noahCustomerId && externalId) {
      const key = merchant-tx:${noahCustomerId}:${externalId};
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
          createdAt: existing.createdAt || event.Data.Created || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
      );
    } else if (noahCustomerId && transactionId) {
      await env.DIGIPAGOS_CUSTOMERS.put(
        merchant-tx:${noahCustomerId}:${transactionId},
        JSON.stringify({
          transactionId,
          status,
          direction: "unknown",
          noahData: event.Data,
          createdAt: event.Data.Created || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
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
  const record = await env.DIGIPAGOS_CUSTOMERS.get(customer:${toNoahCustomerId(email)});
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
    "Set-Cookie": digipagos_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800,
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
  let binary = "
