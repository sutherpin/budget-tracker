var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/parser.js
var PURCHASE_PATTERN = /Pending charge for \$(?<amount>[\d,]+\.\d{2}) on (?<date>\d{2}\/\d{2}) (?<time>\d{2}:\d{2}) (?<tz>\w+) at (?<merchant>[^,]+),.*?ending in \*(?<last4>\d{4})/i;
var PAYMENT_PATTERN = /payment posted to your Credit card ending in \*(?<last4>\d{4}) for \$(?<amount>[\d,]+\.\d{2})/i;
var STATEMENT_PATTERN = /Your statement for/i;
function parseGesaSms(smsBody) {
  const text = smsBody.trim();
  if (STATEMENT_PATTERN.test(text)) {
    return {
      transactionType: "ignored",
      amount: 0,
      merchant: null,
      cardLast4: null,
      occurredAt: null,
      parsedSuccessfully: true
    };
  }
  const paymentMatch = text.match(PAYMENT_PATTERN);
  if (paymentMatch) {
    return {
      transactionType: "payment",
      amount: parseFloat(paymentMatch.groups.amount.replace(/,/g, "")),
      merchant: null,
      cardLast4: paymentMatch.groups.last4,
      occurredAt: (/* @__PURE__ */ new Date()).toISOString(),
      parsedSuccessfully: true
    };
  }
  const purchaseMatch = text.match(PURCHASE_PATTERN);
  if (purchaseMatch) {
    const { amount, date, time, merchant, last4 } = purchaseMatch.groups;
    const year = (/* @__PURE__ */ new Date()).getFullYear();
    const [month, day] = date.split("/");
    const occurredAt = `${year}-${month}-${day}T${time}:00`;
    return {
      transactionType: "purchase",
      amount: parseFloat(amount.replace(/,/g, "")),
      merchant: cleanMerchantName(merchant),
      cardLast4: last4,
      occurredAt,
      parsedSuccessfully: true
    };
  }
  return {
    transactionType: "unknown",
    amount: extractAnyDollarAmount(text),
    merchant: null,
    cardLast4: null,
    occurredAt: (/* @__PURE__ */ new Date()).toISOString(),
    parsedSuccessfully: false
  };
}
__name(parseGesaSms, "parseGesaSms");
function extractAnyDollarAmount(text) {
  const match = text.match(/\$([\d,]+\.\d{2})/);
  return match ? parseFloat(match[1].replace(/,/g, "")) : 0;
}
__name(extractAnyDollarAmount, "extractAnyDollarAmount");
function cleanMerchantName(raw) {
  return raw.trim().replace(/\s+/g, " ");
}
__name(cleanMerchantName, "cleanMerchantName");

// src/push.js
var EXPIRY = 12 * 60 * 60;
async function sendPushNotification(env, payload) {
  const { results } = await env.DB.prepare(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions"
  ).all();
  if (!results.length) return;
  await Promise.all(
    results.map((sub) => sendPush(env, sub, payload))
  );
}
__name(sendPushNotification, "sendPushNotification");
async function sendPush(env, subscription, payload) {
  const { endpoint, p256dh, auth } = subscription;
  const payloadStr = JSON.stringify(payload);
  try {
    const vapidHeaders = await buildVapidHeaders(
      env.VAPID_PUBLIC_KEY,
      env.VAPID_PRIVATE_KEY,
      env.VAPID_SUBJECT,
      endpoint
    );
    const encrypted = await encryptPayload(payloadStr, p256dh, auth);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...vapidHeaders,
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        "TTL": "86400"
      },
      body: encrypted
    });
    if (res.status === 410 || res.status === 404) {
      await env.DB.prepare(
        "DELETE FROM push_subscriptions WHERE endpoint = ?"
      ).bind(endpoint).run();
    } else if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      console.error(`Push send non-OK status ${res.status} for ${endpoint.slice(0, 60)}: ${bodyText}`);
    } else {
      console.log(`Push send OK (${res.status}) for ${endpoint.slice(0, 60)}`);
    }
  } catch (err) {
    console.error("Push send failed:", err);
  }
}
__name(sendPush, "sendPush");
async function notifyMacroDroid(env, text) {
  if (!env.MACRODROID_WEBHOOK_URL) return;
  try {
    const res = await fetch(env.MACRODROID_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: text
    });
    if (!res.ok) {
      console.error(`MacroDroid webhook non-OK status ${res.status}`);
    } else {
      console.log(`MacroDroid webhook notified OK (${res.status})`);
    }
  } catch (err) {
    console.error("MacroDroid webhook failed:", err);
  }
}
__name(notifyMacroDroid, "notifyMacroDroid");
async function buildVapidHeaders(publicKey, privateKey, subject, endpoint) {
  const origin = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1e3);
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64url(JSON.stringify({
    aud: origin,
    exp: now + EXPIRY,
    sub: subject
  }));
  const signingInput = `${header}.${claims}`;
  const keyData = base64ToBytes(privateKey);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    toPkcs8(keyData),
                                                  { name: "ECDSA", namedCurve: "P-256" },
                                                  false,
                                                  ["sign"]
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${bytesToB64url(new Uint8Array(signature))}`;
  return {
    "Authorization": `vapid t=${jwt}, k=${publicKey}`
  };
}
__name(buildVapidHeaders, "buildVapidHeaders");
async function encryptPayload(payload, p256dhBase64, authBase64) {
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(payload);
  const clientPublicKey = base64ToBytes(p256dhBase64);
  const authSecret = base64ToBytes(authBase64);
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"]
  );
  const serverPublicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", serverKeyPair.publicKey)
  );
  const clientKey = await crypto.subtle.importKey(
    "raw",
    clientPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: clientKey },
    serverKeyPair.privateKey,
    256
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(
    new Uint8Array(sharedBits),
                         authSecret,
                         buildInfo("auth", new Uint8Array(0), new Uint8Array(0)),
                         32
  );
  const contentKey = await hkdf(
    ikm,
    salt,
    buildInfo("aesgcm128", clientPublicKey, serverPublicKeyRaw),
                                16
  );
  const nonce = await hkdf(
    ikm,
    salt,
    buildInfo("nonce", clientPublicKey, serverPublicKeyRaw),
                           12
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    contentKey,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const padLen = 2;
  const padded = new Uint8Array(padLen + payloadBytes.length);
  padded.set(payloadBytes, padLen);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    aesKey,
    padded
  ));
  const header = new Uint8Array(21 + serverPublicKeyRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = serverPublicKeyRaw.length;
  header.set(serverPublicKeyRaw, 21);
  const result = new Uint8Array(header.length + encrypted.length);
  result.set(header, 0);
  result.set(encrypted, header.length);
  return result;
}
__name(encryptPayload, "encryptPayload");
async function hkdf(ikm, salt, info, length) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    ikm,
    { name: "HKDF" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    keyMaterial,
    length * 8
  );
  return new Uint8Array(bits);
}
__name(hkdf, "hkdf");
function buildInfo(type, clientKey, serverKey) {
  const encoder = new TextEncoder();
  const typeBytes = encoder.encode(`Content-Encoding: ${type}\0`);
  const info = new Uint8Array(typeBytes.length + 1 + 2 + clientKey.length + 2 + serverKey.length);
  let offset = 0;
  info.set(typeBytes, offset);
  offset += typeBytes.length;
  info[offset++] = 65;
  new DataView(info.buffer).setUint16(offset, clientKey.length, false);
  offset += 2;
  info.set(clientKey, offset);
  offset += clientKey.length;
  new DataView(info.buffer).setUint16(offset, serverKey.length, false);
  offset += 2;
  info.set(serverKey, offset);
  return info;
}
__name(buildInfo, "buildInfo");
function b64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
__name(b64url, "b64url");
function bytesToB64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
__name(bytesToB64url, "bytesToB64url");
function base64ToBytes(base64) {
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  return new Uint8Array(binary.length).map((_, i) => binary.charCodeAt(i));
}
__name(base64ToBytes, "base64ToBytes");
function toPkcs8(rawKey) {
  const prefix = new Uint8Array([
    48,
    65,
    2,
    1,
    0,
    48,
    19,
    6,
    7,
    42,
    134,
    72,
    206,
    61,
    2,
    1,
    6,
    8,
    42,
    134,
    72,
    206,
    61,
    3,
    1,
    7,
    4,
    39,
    48,
    37,
    2,
    1,
    1,
    4,
    32
  ]);
  const result = new Uint8Array(prefix.length + rawKey.length);
  result.set(prefix);
  result.set(rawKey, prefix.length);
  return result;
}
__name(toPkcs8, "toPkcs8");

// src/csv-parser.js
function parseCSVLine(line) {
  const values = [];
  let currentValue = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        currentValue += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(currentValue.trim());
      currentValue = "";
    } else {
      currentValue += char;
    }
  }
  values.push(currentValue.trim());
  return values;
}
__name(parseCSVLine, "parseCSVLine");
function isCreditCardPaymentDescription(description) {
  const d = (description || "").toLowerCase();
  return d.includes("credit card") && d.includes("payment") || d.includes("creditcard payment") || d.includes("card payment") || d.includes("epayment") || d.includes("e-payment") || d.includes("autopay") || d.includes("auto pay") || d.includes("cardmember serv") || d.includes("online pymt") || d.includes("card pymt") || d.includes("payment to") && d.includes("card");
}
__name(isCreditCardPaymentDescription, "isCreditCardPaymentDescription");
function parseTransactionFromCSV(row) {
  if (row.length < 6) {
    return null;
  }
  const [dateStr, description, , , amountStr] = row;
  const dateParts = dateStr.split("/");
  if (dateParts.length !== 3) {
    return null;
  }
  const month = dateParts[0].padStart(2, "0");
  const day = dateParts[1].padStart(2, "0");
  const year = dateParts[2];
  const occurredAt = `${year}-${month}-${day}T12:00:00`;
  const amount = parseFloat(amountStr.replace(/[$,]/g, ""));
  if (isNaN(amount)) {
    return null;
  }
  const absAmount = Math.abs(amount);
  let transactionType;
  if (isCreditCardPaymentDescription(description)) {
    transactionType = "payment";
  } else if (amount < 0) {
    transactionType = "purchase";
  } else {
    const descriptionLower = description.toLowerCase();
    const isLikelyDeposit = descriptionLower.includes("deposit") || descriptionLower.includes("transfer") || descriptionLower.includes("payroll") || descriptionLower.includes("direct deposit") || descriptionLower.includes("atm deposit") || descriptionLower.includes("mobile deposit") || descriptionLower.includes("salary") || descriptionLower.includes("interest") || descriptionLower.includes("credit") || descriptionLower.includes("payment");
    transactionType = isLikelyDeposit ? "deposit" : "purchase";
  }
  return {
    description: description || "Unknown",
    amount: absAmount,
    merchant: description || "Unknown",
    occurredAt,
    transactionType,
    rawData: row.join("|")
    // Use as deduplication key
  };
}
__name(parseTransactionFromCSV, "parseTransactionFromCSV");
async function findPotentialDuplicate(env, transaction) {
  const exactMatch = await env.DB.prepare(
    `SELECT id, merchant, amount, occurred_at FROM transactions
    WHERE merchant = ?
    AND amount = ?
    AND strftime('%Y-%m-%d', occurred_at) = strftime('%Y-%m-%d', ?)`
  ).bind(
    transaction.merchant,
    transaction.amount,
    transaction.occurredAt
  ).first();
  if (exactMatch) {
    return exactMatch;
  }
  const partialMatches = await env.DB.prepare(
    `SELECT id, merchant, amount, occurred_at FROM transactions
    WHERE amount = ?
    AND LENGTH(merchant) >= 8`
  ).bind(transaction.amount).all();
  for (const potentialMatch of partialMatches.results) {
    const matchMerchant = potentialMatch.merchant.toLowerCase();
    const newMerchant = transaction.merchant.toLowerCase();
    for (let i = 0; i <= matchMerchant.length - 8; i++) {
      const substring = matchMerchant.substring(i, i + 8);
      if (newMerchant.includes(substring)) {
        return potentialMatch;
      }
    }
  }
  return null;
}
__name(findPotentialDuplicate, "findPotentialDuplicate");
function isCurrentMonth(transactionDate) {
  const txnDate = new Date(transactionDate);
  const now = /* @__PURE__ */ new Date();
  return txnDate.getFullYear() === now.getFullYear() && txnDate.getMonth() === now.getMonth();
}
__name(isCurrentMonth, "isCurrentMonth");
var AUTO_CATEGORY_RULES = [
  { category: "Groceries", keywords: ["grocery outlet", "natural grocers", "winco", "yokes"] },
  { category: "Gas", keywords: ["chevron", "shell", "exxon", "mobil", "arco", "conoco", "phillips 66", "circle k", "texaco", "valero", "sinclair", "bp", "marathon", "speedway", "costco gas", "76"] },
  { category: "Digital Subscriptions", keywords: ["google", "anthropic", "claude", "apple"] },
  { category: "Communications", keywords: ["us mobile", "us moble", "spectrum"] }
];
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
__name(escapeRegExp, "escapeRegExp");
function matchAutoCategoryLabel(...texts) {
  const haystack = texts.filter(Boolean).join(" ").toLowerCase();
  if (!haystack) return null;
  for (const rule of AUTO_CATEGORY_RULES) {
    for (const keyword of rule.keywords) {
      const pattern = new RegExp(`\\b${escapeRegExp(keyword.toLowerCase())}\\b`);
      if (pattern.test(haystack)) return rule.category;
    }
  }
  return null;
}
__name(matchAutoCategoryLabel, "matchAutoCategoryLabel");
async function resolveCategoryIdByLabel(env, label) {
  const norm = label.trim().toLowerCase();
  const { results } = await env.DB.prepare(
    "SELECT id, name FROM categories WHERE is_active = 1"
  ).all();
  let match = results.find((c) => c.name.toLowerCase() === norm);
  if (!match) {
    match = results.find((c) => {
      const cname = c.name.toLowerCase();
      if (cname.includes(norm) || norm.includes(cname)) return true;
      return norm.split(/\s+/).some((word) => word.length > 3 && cname.includes(word));
    });
  }
  if (match) return match.id;
  const insert = await env.DB.prepare(
    "INSERT INTO categories (name) VALUES (?)"
  ).bind(label).run();
  return insert.meta.last_row_id;
}
__name(resolveCategoryIdByLabel, "resolveCategoryIdByLabel");
async function suggestCategoryId(env, merchant, rawText) {
  if (merchant) {
    const suggestion = await env.DB.prepare(
      "SELECT category_id FROM merchant_category_map WHERE merchant = ?"
    ).bind(merchant).first();
    if (suggestion) return suggestion.category_id;
  }
  const autoLabel = matchAutoCategoryLabel(merchant, rawText);
  if (autoLabel) return await resolveCategoryIdByLabel(env, autoLabel);
  return null;
}
__name(suggestCategoryId, "suggestCategoryId");
async function importTransactionsFromCSV(env, csvData, autoResolveDuplicates = true, approvedTransactions = null) {
  const lines = csvData.split("\n").filter((line) => line.trim() !== "");
  if (lines.length < 2) {
    return { success: false, error: "CSV file must have at least header and one data row" };
  }
  const transactionLines = lines.slice(1);
  let importedCount = 0;
  let duplicateCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const potentialDuplicates = [];
  const approvedTransactionIds = new Set(approvedTransactions?.map((t) => t.rawData) || []);
  for (const line of transactionLines) {
    try {
      if (!line.trim()) continue;
      const row = parseCSVLine(line);
      const transaction = parseTransactionFromCSV(row);
      if (!transaction) {
        errorCount++;
        continue;
      }
      if (!isCurrentMonth(transaction.occurredAt)) {
        skippedCount++;
        continue;
      }
      const potentialDuplicate = await findPotentialDuplicate(env, transaction);
      if (potentialDuplicate) {
        if (autoResolveDuplicates) {
          duplicateCount++;
          continue;
        } else {
          potentialDuplicates.push({
            transaction,
            existingTransaction: potentialDuplicate
          });
          continue;
        }
      }
      if (!autoResolveDuplicates && approvedTransactions && approvedTransactions.length > 0) {
        if (!approvedTransactionIds.has(transaction.rawData)) {
          continue;
        }
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      let suggestedCategoryId = null;
      if (transaction.transactionType === "purchase") {
        suggestedCategoryId = await suggestCategoryId(env, transaction.merchant, transaction.rawData);
      }
      const status = transaction.transactionType === "deposit" || transaction.transactionType === "payment" || suggestedCategoryId ? "categorized" : "pending";
      await env.DB.prepare(
        `INSERT INTO transactions
        (raw_sms, amount, merchant, card_last4, transaction_type, occurred_at, status, category_id, categorized_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        `CSV:${transaction.rawData}`,
        transaction.amount,
        transaction.merchant,
        null,
        transaction.transactionType,
        transaction.occurredAt,
        status,
        suggestedCategoryId,
        status === "categorized" ? now : null
      ).run();
      importedCount++;
    } catch (error) {
      console.error("Error importing transaction:", error);
      errorCount++;
    }
  }
  if (autoResolveDuplicates) {
    const totalTransactions = importedCount + duplicateCount + skippedCount;
    return {
      success: true,
      importedCount,
      duplicateCount,
      skippedCount,
      totalTransactions,
      // Add total transactions count
      errorCount,
      potentialDuplicates: [],
      message: `Import completed: ${importedCount} imported, ${duplicateCount} duplicates, ${skippedCount} not current month, ${errorCount} errors`
    };
  } else {
    const totalTransactions = transactionLines.length - errorCount;
    return {
      success: true,
      importedCount: 0,
      // No imports during scan
      duplicateCount: 0,
      // Don't count duplicates yet
      skippedCount,
      totalTransactions,
      // Add total transactions count
      errorCount,
      potentialDuplicates,
      message: `Scan completed: ${potentialDuplicates.length} potential duplicates found, ${skippedCount} not current month, ${errorCount} errors`
    };
  }
}
__name(importTransactionsFromCSV, "importTransactionsFromCSV");

// src/index.js
var currentOrigin = "*";
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";
    currentOrigin = origin;
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Budget-Secret"
          }
        });
      }
      if (url.pathname === "/api/sms" && request.method === "POST") {
        return await handleIncomingSms(request, env, ctx);
      }
      if (url.pathname === "/api/plaid/webhook" && request.method === "POST") {
        return await handlePlaidWebhook(request, env, ctx);
      }
      if (url.pathname === "/api/plaid/sync" && request.method === "POST") {
        return await handlePlaidManualSync(request, env, ctx);
      }
      if (url.pathname === "/api/plaid/sync-now" && request.method === "POST") {
        return await handlePlaidSyncNow(env, ctx);
      }
      if (url.pathname === "/api/plaid/balance" && request.method === "GET") {
        return await handlePlaidBalance(env);
      }
      if (url.pathname === "/api/plaid/balance/refresh" && request.method === "POST") {
        return await handleRefreshPlaidBalance(request, env);
      }
      if (url.pathname === "/api/duplicates" && request.method === "GET") {
        return await handleGetDuplicates(env);
      }
      if (/^\/api\/duplicates\/\d+\/dismiss$/.test(url.pathname) && request.method === "POST") {
        return await handleDismissDuplicate(request, env);
      }
      if (url.pathname === "/api/pending" && request.method === "GET") {
        return await handlePending(env);
      }
      if (url.pathname === "/api/categorize" && request.method === "POST") {
        return await handleCategorize(request, env);
      }
      if (url.pathname === "/api/categories" && request.method === "GET") {
        return await handleCategories(env);
      }
      if (url.pathname === "/api/categories" && request.method === "POST") {
        return await handleAddCategory(request, env);
      }
      if (url.pathname.startsWith("/api/categories/") && request.method === "DELETE") {
        return await handleDeleteCategory(request, env);
      }
      if (/^\/api\/categories\/\d+\/inclusion$/.test(url.pathname) && request.method === "PATCH") {
        return await handleToggleCategoryInclusion(request, env);
      }
      if (url.pathname.startsWith("/api/categories/") && request.method === "PATCH") {
        return await handleEditCategory(request, env);
      }
      if (url.pathname === "/api/budget" && request.method === "POST") {
        return await handleSaveBudget(request, env);
      }
      if (url.pathname === "/api/push-subscribe" && request.method === "POST") {
        return await handlePushSubscribe(request, env);
      }
      if (url.pathname === "/api/dashboard" && request.method === "GET") {
        return await handleDashboard(env, url);
      }
      if (url.pathname === "/api/recurring-transactions" && request.method === "POST") {
        return await handleAddRecurringTransaction(request, env);
      }
      if (url.pathname === "/api/recurring-transactions" && request.method === "GET") {
        return await handleGetRecurringTransactions(env);
      }
      if (url.pathname.startsWith("/api/recurring-transactions/") && request.method === "DELETE") {
        return await handleDeleteRecurringTransaction(request, env);
      }
      if (url.pathname === "/api/transactions/manual" && request.method === "POST") {
        return await handleAddManualTransaction(request, env);
      }
      if (url.pathname === "/api/transactions" && request.method === "GET") {
        return await handleGetTransactions(env, url);
      }
      if (/^\/api\/transactions\/\d+$/.test(url.pathname) && request.method === "GET") {
        return await handleGetSingleTransaction(env, url.pathname.split("/").pop());
      }
      if (/^\/api\/transactions\/\d+\/split$/.test(url.pathname) && request.method === "POST") {
        return await handleSplitTransaction(request, env);
      }
      if (/^\/api\/transactions\/\d+\/unsplit$/.test(url.pathname) && request.method === "POST") {
        return await handleUnsplitTransaction(request, env);
      }
      if (url.pathname.startsWith("/api/transactions/") && request.method === "PATCH") {
        return await handleUpdateTransactionNotes(request, env);
      }
      if (url.pathname.startsWith("/api/transactions/") && request.method === "DELETE") {
        return await handleDeleteTransaction(request, env);
      }
      if (url.pathname === "/api/export" && request.method === "GET") {
        return await handleExportDatabase(env);
      }
      if (url.pathname === "/api/import" && request.method === "POST") {
        return await handleImportDatabase(request, env);
      }
      if (url.pathname === "/api/transactions/csv" && request.method === "POST") {
        return await handleCSVTransactionImport(request, env);
      }
      if (url.pathname === "/api/test-db" && request.method === "GET") {
        return await handleTestDatabaseConnection(env);
      }
      if (url.pathname === "/api/test-transactions" && request.method === "GET") {
        return await handleTestTransactions(env);
      }
      if (url.pathname === "/api/test-dashboard-query" && request.method === "GET") {
        const month = url.searchParams.get("month") || (/* @__PURE__ */ new Date()).toISOString().slice(0, 7);
        const { results } = await env.DB.prepare(
          `SELECT
          c.id AS categoryId,
          c.name,
          c.icon,
          c.color,
          COALESCE(b.allotted_amount, 0) AS allotted,
                                                 COALESCE(SUM(CASE WHEN t.transaction_type = 'purchase' THEN t.amount ELSE 0 END), 0) AS spent
                                                 FROM categories c
                                                 LEFT JOIN budgets b ON b.category_id = c.id AND b.month = ?
                                                 LEFT JOIN transactions t ON t.category_id = c.id
                                                 AND t.status = 'categorized'
                                                 AND strftime('%Y-%m', t.occurred_at) = ?
                                                 WHERE c.is_active = 1 AND c.included_in_budget = 1
                                                 GROUP BY c.id
                                                 ORDER BY c.name`
        ).bind(month, month).all();
        return jsonResponse({ month, results });
      }
    } catch (err) {
      console.error("Worker error:", err);
      return jsonResponse({ error: "Internal error" }, 500);
    }
    const assetResponse = await env.ASSETS.fetch(request);
    const response = new Response(assetResponse.body, assetResponse);
    response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    return response;
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshPlaidBalanceCache(env).catch((err) => console.error("Scheduled balance refresh failed:", err)));
  }
};
async function handleIncomingSms(request, env, ctx) {
  const providedSecret = request.headers.get("X-Budget-Secret");
  if (!providedSecret || providedSecret !== env.MACRODROID_SHARED_SECRET) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  let smsBody;
  try {
    const url = new URL(request.url);
    const queryMessage = url.searchParams.get("message");
    if (queryMessage) {
      smsBody = queryMessage;
    } else {
      const body = await request.json();
      smsBody = body.message;
    }
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }
  if (!smsBody || typeof smsBody !== "string") {
    return jsonResponse({ error: "Missing 'message' field" }, 400);
  }
  const parsed = parseGesaSms(smsBody);
  if (parsed.transactionType === "ignored") {
    return jsonResponse({ success: true, action: "ignored" });
  }
  if (parsed.transactionType === "payment") {
    await env.DB.prepare(
      `INSERT INTO transactions
      (raw_sms, amount, merchant, card_last4, transaction_type, occurred_at, status, category_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      smsBody,
      parsed.amount,
      null,
      parsed.cardLast4,
      "payment",
      parsed.occurredAt,
      "categorized",
      null
    ).run();
    return jsonResponse({ success: true, action: "payment_recorded", amount: parsed.amount });
  }
  let suggestedCategoryId = null;
  if (parsed.merchant) {
    suggestedCategoryId = await suggestCategoryId(env, parsed.merchant, smsBody);
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const status = !parsed.parsedSuccessfully ? "needs_review" : suggestedCategoryId ? "categorized" : "pending";
  const insertResult = await env.DB.prepare(
    `INSERT INTO transactions
    (raw_sms, amount, merchant, card_last4, transaction_type, occurred_at, status, category_id, categorized_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    smsBody,
    parsed.amount,
    parsed.merchant,
    parsed.cardLast4,
    parsed.transactionType,
    parsed.occurredAt,
    status,
    suggestedCategoryId,
    status === "categorized" ? now : null
  ).run();
  const transactionId = insertResult.meta.last_row_id;
  ctx.waitUntil(sendPushNotification(env, {
    title: `New charge: ${parsed.merchant || "Unknown"}`,
    body: `$${parsed.amount.toFixed(2)} \u2014 tap to categorize`,
                                     transactionId
  }));
  ctx.waitUntil(notifyMacroDroid(env, `New charge: ${parsed.merchant || "Unknown"} \u2014 $${parsed.amount.toFixed(2)}`));
  return jsonResponse({ success: true, transactionId, parsed, suggestedCategoryId });
}
__name(handleIncomingSms, "handleIncomingSms");
var plaidWebhookKeyCache = /* @__PURE__ */ new Map();
function plaidBaseUrl(env) {
  return `https://${env.PLAID_ENV}.plaid.com`;
}
__name(plaidBaseUrl, "plaidBaseUrl");
async function plaidFetch(env, path, body) {
  const res = await fetch(`${plaidBaseUrl(env)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      ...body
    })
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`Plaid ${path} failed (${res.status}):`, data);
    throw new Error(data.error_message || `Plaid request to ${path} failed`);
  }
  return data;
}
__name(plaidFetch, "plaidFetch");
function base64UrlToBytes(b64url2) {
  const padded = b64url2.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url2.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
__name(base64UrlToBytes, "base64UrlToBytes");
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
async function verifyPlaidWebhook(env, request, rawBody) {
  try {
    const jwt = request.headers.get("Plaid-Verification");
    if (!jwt) return false;
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    if (!headerB64 || !payloadB64 || !sigB64) return false;
    const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerB64)));
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64)));
    if (header.alg !== "ES256") return false;
    const nowSeconds = Math.floor(Date.now() / 1e3);
    if (!payload.iat || Math.abs(nowSeconds - payload.iat) > 300) return false;
    let jwk = plaidWebhookKeyCache.get(header.kid);
    if (!jwk) {
      const { key } = await plaidFetch(env, "/webhook_verification_key/get", { key_id: header.kid });
      jwk = key;
      plaidWebhookKeyCache.set(header.kid, jwk);
    }
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const signatureValid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      base64UrlToBytes(sigB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
    if (!signatureValid) return false;
    const bodyHash = await sha256Hex(rawBody);
    return bodyHash === payload.request_body_sha256;
  } catch (err) {
    console.error("Plaid webhook verification failed:", err);
    return false;
  }
}
__name(verifyPlaidWebhook, "verifyPlaidWebhook");
function normalizeMerchant(merchant) {
  return (merchant || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
__name(normalizeMerchant, "normalizeMerchant");
async function findLikelyDuplicate(env, { merchant, amount, occurredAt }) {
  const { results } = await env.DB.prepare(
    `SELECT id, merchant FROM transactions
    WHERE amount = ? AND date(occurred_at) = date(?)`
  ).bind(amount, occurredAt).all();
  const incoming = normalizeMerchant(merchant);
  if (!incoming) return null;
  for (const row of results) {
    const existing = normalizeMerchant(row.merchant);
    if (!existing) continue;
    const shorter = incoming.length <= existing.length ? incoming : existing;
    const longer = incoming.length <= existing.length ? existing : incoming;
    if (shorter.length >= 7 && longer.includes(shorter.slice(0, 7))) {
      return row;
    }
  }
  return null;
}
__name(findLikelyDuplicate, "findLikelyDuplicate");
var PLAID_MIN_SYNC_DATE = "2026-07-01";
var DUPLICATE_CHECK_EXCLUDED_KEYWORDS = ["google", "grok", "xai", "anthropic", "claude"];
function isDuplicateCheckExcluded(merchant) {
  const haystack = (merchant || "").toLowerCase();
  return DUPLICATE_CHECK_EXCLUDED_KEYWORDS.some((keyword) => haystack.includes(keyword));
}
__name(isDuplicateCheckExcluded, "isDuplicateCheckExcluded");
async function syncPlaidTransactions(env, ctx, itemRow) {
  let cursor = itemRow.cursor;
  let hasMore = true;
  const added = [];
  const modified = [];
  const removed = [];
  while (hasMore) {
    const page = await plaidFetch(env, "/transactions/sync", {
      access_token: itemRow.access_token,
      cursor: cursor || void 0
    });
    added.push(...page.added);
    modified.push(...page.modified);
    removed.push(...page.removed);
    cursor = page.next_cursor;
    hasMore = page.has_more;
  }
  for (const tx of modified) {
    const merchant = tx.merchant_name || tx.name;
    await env.DB.prepare(
      "UPDATE transactions SET amount = ?, merchant = ?, occurred_at = ?, plaid_pending = ? WHERE plaid_transaction_id = ?"
    ).bind(Math.abs(tx.amount), merchant, tx.date, tx.pending ? 1 : 0, tx.transaction_id).run();
  }
  for (const tx of added) {
    if (tx.date < PLAID_MIN_SYNC_DATE) continue;
    const merchant = tx.merchant_name || tx.name;
    const amount = tx.amount;
    const transactionType = amount < 0 ? "deposit" : "purchase";

    // Plaid links a posted transaction back to the pending one it replaced
    // via pending_transaction_id. When that's present and we already have
    // the pending row, update it in place (new plaid_transaction_id, fresh
    // amount/date/pending flag) instead of inserting a new uncategorized
    // duplicate — this preserves whatever category/notes/status the user
    // already set while it was pending.
    if (tx.pending_transaction_id) {
      const priorRow = await env.DB.prepare(
        "SELECT id FROM transactions WHERE plaid_transaction_id = ?"
      ).bind(tx.pending_transaction_id).first();
      if (priorRow) {
        await env.DB.prepare(
          `UPDATE transactions SET plaid_transaction_id = ?, amount = ?, merchant = ?, occurred_at = ?, transaction_type = ?, plaid_pending = ? WHERE id = ?`
        ).bind(tx.transaction_id, Math.abs(amount), merchant, tx.date, transactionType, tx.pending ? 1 : 0, priorRow.id).run();
        console.log(`Linked posted transaction ${tx.transaction_id} to existing row ${priorRow.id} (was pending ${tx.pending_transaction_id})`);
        continue;
      }
    }

    const duplicate = isDuplicateCheckExcluded(merchant) ? null : await findLikelyDuplicate(env, { merchant, amount: Math.abs(amount), occurredAt: tx.date });
    const suggestedCategoryId = await suggestCategoryId(env, merchant, merchant);
    const status = suggestedCategoryId ? "categorized" : "pending";
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const insertResult = await env.DB.prepare(
      `INSERT OR IGNORE INTO transactions
      (raw_sms, amount, merchant, card_last4, transaction_type, occurred_at, status, category_id, categorized_at, plaid_transaction_id, plaid_pending)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      `Plaid: ${merchant}`,
      Math.abs(amount),
      merchant,
      null,
      transactionType,
      tx.date,
      status,
      suggestedCategoryId,
      status === "categorized" ? now : null,
      tx.transaction_id,
      tx.pending ? 1 : 0
    ).run();
    if (insertResult.meta.changes > 0) {
      const transactionId = insertResult.meta.last_row_id;
      if (duplicate) {
        console.log(`Flagging Plaid transaction ${tx.transaction_id} (row ${transactionId}) as a possible duplicate of transaction ${duplicate.id}`);
        await env.DB.prepare(
          "INSERT INTO duplicate_flags (transaction_id, matched_transaction_id) VALUES (?, ?)"
        ).bind(transactionId, duplicate.id).run();
      }
      ctx.waitUntil(sendPushNotification(env, {
        title: `New charge: ${merchant || "Unknown"}`,
        body: `$${Math.abs(amount).toFixed(2)} — tap to categorize`,
                                         transactionId
      }));
      ctx.waitUntil(notifyMacroDroid(env, `New charge: ${merchant || "Unknown"} — $${Math.abs(amount).toFixed(2)}`));
    }
  }
  for (const tx of removed) {
    await env.DB.prepare("DELETE FROM transactions WHERE plaid_transaction_id = ?").bind(tx.transaction_id).run();
  }
  await env.DB.prepare(
    "UPDATE plaid_items SET cursor = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(cursor, itemRow.id).run();
  return { added: added.length, modified: modified.length, removed: removed.length };
}
__name(syncPlaidTransactions, "syncPlaidTransactions");
async function handlePlaidWebhook(request, env, ctx) {
  const rawBody = await request.text();
  const verified = await verifyPlaidWebhook(env, request, rawBody);
  if (!verified) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  if (payload.webhook_type === "ITEM" && payload.webhook_code === "ERROR") {
    const itemRow2 = await env.DB.prepare(
      "SELECT * FROM plaid_items WHERE item_id = ?"
    ).bind(payload.item_id).first();
    const institutionName = itemRow2?.institution_name || "Unknown institution";
    const errorCode = payload.error?.error_code || "UNKNOWN_ERROR";
    console.error(`Plaid item error for ${institutionName} (${payload.item_id}): ${errorCode}`);
    ctx.waitUntil(sendPushNotification(env, {
      title: `Bank connection needs attention: ${institutionName}`,
      body: errorCode === "ITEM_LOGIN_REQUIRED"
        ? "Login expired — re-link via Plaid Link update mode to resume syncing."
        : `Plaid reported an error (${errorCode}) — transactions will stop syncing until this is fixed.`
    }));
    ctx.waitUntil(notifyMacroDroid(env, `⚠️ Plaid connection broken for ${institutionName}: ${errorCode}`));
    return jsonResponse({ success: true, action: "item_error_reported" });
  }
  if (payload.webhook_type !== "TRANSACTIONS" || !["SYNC_UPDATES_AVAILABLE", "INITIAL_UPDATE", "HISTORICAL_UPDATE"].includes(payload.webhook_code)) {
    return jsonResponse({ success: true, action: "ignored" });
  }
  const itemRow = await env.DB.prepare(
    "SELECT * FROM plaid_items WHERE item_id = ?"
  ).bind(payload.item_id).first();
  if (!itemRow) {
    console.error(`Plaid webhook for unknown item_id: ${payload.item_id}`);
    return jsonResponse({ success: true, action: "unknown_item" });
  }
  try {
    await syncPlaidTransactions(env, ctx, itemRow);
  } catch (err) {
    console.error("Plaid sync failed:", err);
    return jsonResponse({ error: "Sync failed" }, 500);
  }
  return jsonResponse({ success: true });
}
__name(handlePlaidWebhook, "handlePlaidWebhook");
async function handlePlaidManualSync(request, env, ctx) {
  const providedSecret = request.headers.get("X-Budget-Secret");
  if (!providedSecret || providedSecret !== env.MACRODROID_SHARED_SECRET) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const { results } = await env.DB.prepare("SELECT * FROM plaid_items").all();
  const summary = [];
  for (const itemRow of results) {
    try {
      const counts = await syncPlaidTransactions(env, ctx, itemRow);
      summary.push({ item_id: itemRow.item_id, success: true, ...counts });
    } catch (err) {
      console.error(`Manual Plaid sync failed for item ${itemRow.item_id}:`, err);
      summary.push({ item_id: itemRow.item_id, success: false, error: err.message });
    }
  }
  return jsonResponse({ success: true, results: summary });
}
__name(handlePlaidManualSync, "handlePlaidManualSync");
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
__name(sleep, "sleep");
async function handlePlaidSyncNow(env, ctx) {
  const { results } = await env.DB.prepare("SELECT * FROM plaid_items").all();
  let added = 0;
  const errors = [];
  for (const itemRow of results) {
    try {
      // /transactions/sync only reads Plaid's already-cached ledger — it
      // won't see anything the bank posted since Plaid's last background
      // refresh. /transactions/refresh asks Plaid to go check the
      // institution right now; give it a few seconds to land before syncing.
      await plaidFetch(env, "/transactions/refresh", { access_token: itemRow.access_token });
      await sleep(5000);
      const counts = await syncPlaidTransactions(env, ctx, itemRow);
      added += counts.added;
    } catch (err) {
      console.error(`UI-triggered Plaid sync failed for item ${itemRow.item_id}:`, err);
      errors.push({ item_id: itemRow.item_id, error: err.message });
    }
  }
  try {
    await refreshPlaidBalanceCache(env);
  } catch (err) {
    console.error("UI-triggered balance refresh failed:", err);
  }
  return jsonResponse({ success: errors.length === 0, added, errors });
}
__name(handlePlaidSyncNow, "handlePlaidSyncNow");
var BALANCE_ACCOUNT_MASKS = { checking: "2250", savings: "3735" };
async function refreshPlaidBalanceCache(env) {
  const { results } = await env.DB.prepare("SELECT * FROM plaid_items").all();
  const existing = await env.DB.prepare("SELECT checking, savings FROM balance_cache WHERE id = 1").first();
  let checking = existing?.checking ?? null;
  let savings = existing?.savings ?? null;
  for (const itemRow of results) {
    try {
      const data = await plaidFetch(env, "/accounts/balance/get", { access_token: itemRow.access_token });
      for (const account of data.accounts) {
        if (account.mask === BALANCE_ACCOUNT_MASKS.checking) {
          checking = account.balances.current;
        } else if (account.mask === BALANCE_ACCOUNT_MASKS.savings) {
          savings = account.balances.current;
        }
      }
    } catch (err) {
      console.error(`Balance fetch failed for item ${itemRow.item_id}:`, err);
    }
  }
  await env.DB.prepare(
    `INSERT INTO balance_cache (id, checking, savings, updated_at) VALUES (1, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET checking = excluded.checking, savings = excluded.savings, updated_at = excluded.updated_at`
  ).bind(checking, savings).run();
  return { checking, savings };
}
__name(refreshPlaidBalanceCache, "refreshPlaidBalanceCache");
async function handlePlaidBalance(env) {
  const row = await env.DB.prepare("SELECT checking, savings, updated_at FROM balance_cache WHERE id = 1").first();
  if (!row) {
    return jsonResponse({ checking: null, savings: null });
  }
  return jsonResponse({ checking: row.checking, savings: row.savings, asOf: row.updated_at });
}
__name(handlePlaidBalance, "handlePlaidBalance");
async function handleRefreshPlaidBalance(request, env) {
  const providedSecret = request.headers.get("X-Budget-Secret");
  if (!providedSecret || providedSecret !== env.MACRODROID_SHARED_SECRET) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const result = await refreshPlaidBalanceCache(env);
  return jsonResponse({ success: true, ...result });
}
__name(handleRefreshPlaidBalance, "handleRefreshPlaidBalance");
async function handleGetDuplicates(env) {
  const { results } = await env.DB.prepare(
    `SELECT
    df.id AS flagId,
    df.created_at AS flaggedAt,
    a.id AS aId, a.merchant AS aMerchant, a.amount AS aAmount, a.occurred_at AS aOccurredAt, a.plaid_transaction_id AS aPlaidId,
    b.id AS bId, b.merchant AS bMerchant, b.amount AS bAmount, b.occurred_at AS bOccurredAt, b.plaid_transaction_id AS bPlaidId
    FROM duplicate_flags df
    JOIN transactions a ON a.id = df.transaction_id
    JOIN transactions b ON b.id = df.matched_transaction_id
    WHERE df.resolved = 0
    ORDER BY df.created_at DESC`
  ).all();
  const duplicates = results.map((row) => ({
    flagId: row.flagId,
    flaggedAt: row.flaggedAt,
    a: { id: row.aId, merchant: row.aMerchant, amount: row.aAmount, occurredAt: row.aOccurredAt, source: row.aPlaidId ? "Plaid" : "Other" },
    b: { id: row.bId, merchant: row.bMerchant, amount: row.bAmount, occurredAt: row.bOccurredAt, source: row.bPlaidId ? "Plaid" : "Other" }
  }));
  return jsonResponse({ duplicates });
}
__name(handleGetDuplicates, "handleGetDuplicates");
async function handleDismissDuplicate(request, env) {
  const parts = new URL(request.url).pathname.split("/");
  const flagId = parts[parts.length - 2];
  await env.DB.prepare("UPDATE duplicate_flags SET resolved = 1 WHERE id = ?").bind(flagId).run();
  return jsonResponse({ success: true });
}
__name(handleDismissDuplicate, "handleDismissDuplicate");
async function handlePending(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, amount, merchant, card_last4, transaction_type, occurred_at, status, plaid_pending
    FROM transactions
    WHERE status IN ('pending', 'needs_review')
    ORDER BY occurred_at DESC`
  ).all();
  const withSuggestions = await Promise.all(
    results.map(async (txn) => {
      if (!txn.merchant) return { ...txn, suggestedCategoryId: null };
      const suggestion = await env.DB.prepare(
        "SELECT category_id FROM merchant_category_map WHERE merchant = ?"
      ).bind(txn.merchant).first();
      return {
        ...txn,
        suggestedCategoryId: suggestion ? suggestion.category_id : null
      };
    })
  );
  return jsonResponse({ transactions: withSuggestions });
}
__name(handlePending, "handlePending");
async function handleCategorize(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const { transactionId, categoryId } = body;
  if (!transactionId || !categoryId) {
    return jsonResponse({ error: "transactionId and categoryId required" }, 400);
  }
  const txn = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(transactionId).first();
  if (!txn) return jsonResponse({ error: "Transaction not found" }, 404);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(
    `UPDATE transactions
    SET category_id = ?, status = 'categorized', categorized_at = ?
    WHERE id = ?`
  ).bind(categoryId, now, transactionId).run();
  if (txn.merchant) {
    await env.DB.prepare(
      `INSERT INTO merchant_category_map (merchant, category_id, times_used, updated_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(merchant) DO UPDATE SET
      category_id = excluded.category_id,
      times_used = times_used + 1,
      updated_at = excluded.updated_at`
    ).bind(txn.merchant, categoryId, now).run();
  }
  return jsonResponse({ success: true });
}
__name(handleCategorize, "handleCategorize");
async function handleExportDatabase(env) {
  try {
    const categories = await env.DB.prepare("SELECT * FROM categories").all();
    const budgets = await env.DB.prepare("SELECT * FROM budgets").all();
    const transactions = await env.DB.prepare("SELECT * FROM transactions").all();
    const transactionNotes = await env.DB.prepare("SELECT * FROM transaction_notes").all();
    const merchantCategoryMap = await env.DB.prepare("SELECT * FROM merchant_category_map").all();
    const recurringTransactions = await env.DB.prepare("SELECT * FROM recurring_transactions").all();
    const csvData = [
      // Categories
      ["TABLE", "categories"],
      ["id", "name", "icon", "color", "is_active", "created_at"],
      ...categories.results.map((cat) => [
        cat.id,
        `"${cat.name.replace(/"/g, '""')}"`,
                                `"${cat.icon.replace(/"/g, '""')}"`,
                                cat.color,
                                cat.is_active,
                                cat.created_at
      ]),
      // Budgets
      ["TABLE", "budgets"],
      ["id", "category_id", "month", "allotted_amount"],
      ...budgets.results.map((b) => [
        b.id,
        b.category_id,
        b.month,
        b.allotted_amount
      ]),
      // Transactions
      ["TABLE", "transactions"],
      ["id", "raw_sms", "amount", "merchant", "card_last4", "transaction_type", "category_id", "occurred_at", "received_at", "categorized_at", "status"],
      ...transactions.results.map((t) => [
        t.id,
        `"${t.raw_sms.replace(/"/g, '""')}"`,
                                  t.amount,
                                  `"${t.merchant ? t.merchant.replace(/"/g, '""') : ""}"`,
                                  `"${t.card_last4 ? t.card_last4.replace(/"/g, '""') : ""}"`,
                                  t.transaction_type,
                                  t.category_id,
                                  t.occurred_at,
                                  t.received_at,
                                  t.categorized_at,
                                  t.status
      ]),
      // Transaction Notes
      ["TABLE", "transaction_notes"],
      ["transaction_id", "notes", "updated_at"],
      ...transactionNotes.results.map((n) => [
        n.transaction_id,
        `"${n.notes ? n.notes.replace(/"/g, '""') : ""}"`,
                                      n.updated_at
      ]),
      // Merchant Category Map
      ["TABLE", "merchant_category_map"],
      ["merchant", "category_id", "times_used", "updated_at"],
      ...merchantCategoryMap.results.map((m) => [
        `"${m.merchant.replace(/"/g, '""')}"`,
                                         m.category_id,
                                         m.times_used,
                                         m.updated_at
      ]),
      // Recurring Transactions
      ["TABLE", "recurring_transactions"],
      ["id", "name", "amount", "category_id", "day_of_month", "start_date", "end_date", "next_due", "created_at"],
      ...recurringTransactions.results.map((r) => [
        r.id,
        `"${r.name.replace(/"/g, '""')}"`,
                                           r.amount,
                                           r.category_id,
                                           r.day_of_month,
                                           r.start_date,
                                           r.end_date,
                                           r.next_due,
                                           r.created_at
      ])
    ];
    const csvString = csvData.map((row) => row.join(",")).join("\n");
    return new Response(csvString, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="budget-tracker-export.csv"',
        "Access-Control-Allow-Origin": currentOrigin
      }
    });
  } catch (err) {
    console.error("Export failed:", err);
    return jsonResponse({ error: "Export failed: " + err.message }, 500);
  }
}
__name(handleExportDatabase, "handleExportDatabase");
async function handleImportDatabase(request, env) {
  try {
    await env.DB.prepare("DELETE FROM transaction_notes").run();
    await env.DB.prepare("DELETE FROM transactions").run();
    await env.DB.prepare("DELETE FROM merchant_category_map").run();
    await env.DB.prepare("DELETE FROM recurring_transactions").run();
    await env.DB.prepare("DELETE FROM budgets").run();
    await env.DB.prepare("DELETE FROM categories WHERE id > 9").run();
    const csvData = await request.text();
    const lines = csvData.split("\n").filter((line) => line.trim() !== "");
    let currentTable = null;
    let headers = [];
    let dataRows = [];
    for (const line of lines) {
      const values = parseCSVLine2(line);
      if (values[0] === "TABLE") {
        if (currentTable && headers.length > 0) {
          await processTableData(env, currentTable, headers, dataRows);
          dataRows = [];
        }
        currentTable = values[1];
        headers = [];
      } else if (currentTable && headers.length === 0) {
        headers = values;
      } else if (currentTable && headers.length > 0) {
        dataRows.push(values);
      }
    }
    if (currentTable && headers.length > 0 && dataRows.length > 0) {
      await processTableData(env, currentTable, headers, dataRows);
    }
    return jsonResponse({ success: true, message: "Database imported successfully" });
  } catch (err) {
    console.error("Import failed:", err);
    return jsonResponse({ error: "Import failed: " + err.message }, 500);
  }
}
__name(handleImportDatabase, "handleImportDatabase");
function parseCSVLine2(line) {
  const values = [];
  let currentValue = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        currentValue += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(currentValue);
      currentValue = "";
    } else {
      currentValue += char;
    }
  }
  values.push(currentValue);
  return values;
}
__name(parseCSVLine2, "parseCSVLine");
async function processTableData(env, tableName, headers, dataRows) {
  if (dataRows.length === 0) return;
  switch (tableName) {
    case "categories":
      for (const row of dataRows) {
        const [id, name, icon, color, is_active, created_at] = row;
        const categoryId = parseInt(id);
        if (categoryId > 9) {
          await env.DB.prepare(
            `INSERT INTO categories (id, name, icon, color, is_active, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(id, name.replace(/^"|"$/g, ""), icon.replace(/^"|"$/g, ""), color, is_active, created_at).run();
        }
      }
      break;
    case "budgets":
      for (const row of dataRows) {
        const [id, category_id, month, allotted_amount] = row;
        await env.DB.prepare(
          `INSERT INTO budgets (id, category_id, month, allotted_amount)
          VALUES (?, ?, ?, ?)`
        ).bind(id, category_id, month, allotted_amount).run();
      }
      break;
    case "transactions":
      for (const row of dataRows) {
        const [id, raw_sms, amount, merchant, card_last4, transaction_type, category_id, occurred_at, received_at, categorized_at, status] = row;
        await env.DB.prepare(
          `INSERT INTO transactions (id, raw_sms, amount, merchant, card_last4, transaction_type, category_id, occurred_at, received_at, categorized_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          id,
          raw_sms.replace(/^"|"$/g, ""),
               amount,
               merchant.replace(/^"|"$/g, "") || null,
               card_last4.replace(/^"|"$/g, "") || null,
               transaction_type,
               category_id || null,
               occurred_at,
               received_at,
               categorized_at || null,
               status
        ).run();
      }
      break;
    case "transaction_notes":
      for (const row of dataRows) {
        const [transaction_id, notes, updated_at] = row;
        await env.DB.prepare(
          `INSERT INTO transaction_notes (transaction_id, notes, updated_at)
          VALUES (?, ?, ?)`
        ).bind(transaction_id, notes.replace(/^"|"$/g, "") || null, updated_at).run();
      }
      break;
    case "merchant_category_map":
      for (const row of dataRows) {
        const [merchant, category_id, times_used, updated_at] = row;
        await env.DB.prepare(
          `INSERT INTO merchant_category_map (merchant, category_id, times_used, updated_at)
          VALUES (?, ?, ?, ?)`
        ).bind(merchant.replace(/^"|"$/g, ""), category_id, times_used, updated_at).run();
      }
      break;
    case "recurring_transactions":
      for (const row of dataRows) {
        const id = row[0];
        const name = row[1];
        const amount = row[2];
        const category_id = row[3];
        const day_of_month = row[4];
        const start_date = row[5];
        const end_date = row[6];
        const next_due = row.length > 8 ? row[7] : null;
        const created_at = row.length > 8 ? row[8] : row[7];
        await env.DB.prepare(
          `INSERT INTO recurring_transactions (id, name, amount, category_id, day_of_month, start_date, end_date, next_due, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          id,
          name.replace(/^"|"$/g, ""),
               amount,
               category_id,
               day_of_month,
               start_date,
               end_date || null,
               next_due || null,
               created_at
        ).run();
      }
      break;
  }
}
__name(processTableData, "processTableData");
async function handleCategories(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, icon, color, included_in_budget FROM categories WHERE is_active = 1 ORDER BY name"
  ).all();
  return jsonResponse({ categories: results });
}
__name(handleCategories, "handleCategories");
async function handleDashboard(env, url) {
  const month = url.searchParams.get("month") || (/* @__PURE__ */ new Date()).toISOString().slice(0, 7);
  const { results } = await env.DB.prepare(
    `SELECT
    c.id AS categoryId,
    c.name,
    c.icon,
    c.color,
    COALESCE(b.allotted_amount, 0) AS allotted,
    COALESCE(SUM(spend.amount), 0) AS spent
    FROM categories c
    LEFT JOIN budgets b ON b.category_id = c.id AND b.month = (
      SELECT MAX(month) FROM budgets WHERE category_id = c.id AND month <= ?
    )
    LEFT JOIN (
      SELECT t.category_id AS category_id, t.amount AS amount
      FROM transactions t
      WHERE t.transaction_type = 'purchase' AND t.status = 'categorized' AND t.is_split = 0
        AND strftime('%Y-%m', t.occurred_at) = ?
      UNION ALL
      SELECT ts.category_id AS category_id, ts.amount AS amount
      FROM transaction_splits ts
      JOIN transactions t ON t.id = ts.transaction_id
      WHERE t.transaction_type = 'purchase' AND t.status = 'categorized'
        AND strftime('%Y-%m', t.occurred_at) = ?
    ) spend ON spend.category_id = c.id
    WHERE c.is_active = 1 AND c.included_in_budget = 1
    GROUP BY c.id
    ORDER BY c.name`
  ).bind(month, month, month).all();
  console.log("Raw dashboard results:", results);
  const summary = results.map((row) => ({
    ...row,
    remaining: row.allotted - row.spent
  }));
  return jsonResponse({ month, categories: summary });
}
__name(handleDashboard, "handleDashboard");
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": currentOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Budget-Secret"
    }
  });
}
__name(jsonResponse, "jsonResponse");
async function handleTestDatabaseConnection(env) {
  try {
    const { results } = await env.DB.prepare("SELECT * FROM categories LIMIT 1").all();
    return jsonResponse({ success: true, data: results });
  } catch (err) {
    console.error("Database connection test failed:", err);
    return jsonResponse({ error: "Database connection failed: " + err.message }, 500);
  }
}
__name(handleTestDatabaseConnection, "handleTestDatabaseConnection");
async function handleTestTransactions(env) {
  try {
    const { results } = await env.DB.prepare("SELECT * FROM transactions").all();
    return jsonResponse({ success: true, data: results });
  } catch (err) {
    console.error("Fetch transactions test failed:", err);
    return jsonResponse({ error: "Fetch transactions failed: " + err.message }, 500);
  }
}
__name(handleTestTransactions, "handleTestTransactions");
async function handleSaveBudget(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const { categoryId, month, amount } = body;
  if (!categoryId || !month || amount === void 0) {
    return jsonResponse({ error: "categoryId, month, and amount required" }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO budgets (category_id, month, allotted_amount)
    VALUES (?, ?, ?)
    ON CONFLICT(category_id, month) DO UPDATE SET allotted_amount = excluded.allotted_amount`
  ).bind(categoryId, month, amount).run();
  return jsonResponse({ success: true });
}
__name(handleSaveBudget, "handleSaveBudget");
async function handleAddCategory(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const { name, icon, color } = body;
  if (!name) return jsonResponse({ error: "name required" }, 400);
  await env.DB.prepare(
    `INSERT INTO categories (name, icon, color) VALUES (?, ?, ?)`
  ).bind(name, icon || "\u{1F4B3}", color || "#6366f1").run();
  return jsonResponse({ success: true });
}
__name(handleAddCategory, "handleAddCategory");
async function handleDeleteCategory(request, env) {
  const parts = new URL(request.url).pathname.split("/");
  const id = parts[parts.length - 1];
  if (!id) {
    return jsonResponse({ error: "ID is required" }, 400);
  }
  await env.DB.prepare("UPDATE categories SET is_active = 0 WHERE id = ?").bind(id).run();
  return jsonResponse({ success: true });
}
__name(handleDeleteCategory, "handleDeleteCategory");
async function handleToggleCategoryInclusion(request, env) {
  const parts = new URL(request.url).pathname.split("/");
  const id = parts[parts.length - 2];
  if (!id) {
    return jsonResponse({ error: "ID is required" }, 400);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const { includedInBudget } = body;
  if (typeof includedInBudget !== "boolean") {
    return jsonResponse({ error: "includedInBudget (boolean) is required" }, 400);
  }
  await env.DB.prepare(
    `UPDATE categories SET included_in_budget = ? WHERE id = ?`
  ).bind(includedInBudget ? 1 : 0, id).run();
  return jsonResponse({ success: true });
}
__name(handleToggleCategoryInclusion, "handleToggleCategoryInclusion");
async function handleEditCategory(request, env) {
  const parts = new URL(request.url).pathname.split("/");
  const id = parts[parts.length - 1];
  if (!id) {
    return jsonResponse({ error: "ID is required" }, 400);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const { name, icon, color } = body;
  if (!name) {
    return jsonResponse({ error: "name is required" }, 400);
  }
  await env.DB.prepare(
    `UPDATE categories
    SET name = ?, icon = ?, color = ?
    WHERE id = ?`
  ).bind(name, icon || "\u{1F4B3}", color || "#6366f1", id).run();
  return jsonResponse({ success: true });
}
__name(handleEditCategory, "handleEditCategory");
async function handleAddRecurringTransaction(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const { name, amount, categoryId, dayOfMonth, startDate, endDate } = body;
  if (!name || amount === void 0 || !categoryId || !dayOfMonth || !startDate) {
    return jsonResponse({ error: "name, amount, categoryId, dayOfMonth, and startDate are required" }, 400);
  }
  const startDateISO = `${startDate}T00:00:00`;
  const endDateISO = endDate ? `${endDate}T23:59:59` : null;
  const startDateObj = new Date(startDate);
  const today = /* @__PURE__ */ new Date();
  let nextDueDate;
  if (startDateObj > today) {
    nextDueDate = startDateObj;
  } else {
    const currentMonth = today.getMonth();
    const currentYear = today.getFullYear();
    const targetDay = dayOfMonth;
    let nextDue = new Date(currentYear, currentMonth, targetDay);
    if (nextDue < today) {
      nextDue = new Date(currentYear, currentMonth + 1, targetDay);
    }
    nextDueDate = nextDue;
  }
  const nextDueISO = nextDueDate.toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO recurring_transactions (name, amount, category_id, day_of_month, start_date, end_date, next_due)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(name, amount, categoryId, dayOfMonth, startDateISO, endDateISO, nextDueISO).run();
    return jsonResponse({ success: true });
  } catch (err) {
    console.error("Failed to add recurring transaction:", err);
    return jsonResponse({ error: "Database error: " + err.message }, 500);
  }
}
__name(handleAddRecurringTransaction, "handleAddRecurringTransaction");
async function handleGetRecurringTransactions(env) {
  const { results } = await env.DB.prepare(
    `SELECT rt.id, rt.name, rt.amount, rt.day_of_month, rt.start_date, rt.end_date, rt.category_id, c.name AS category_name, c.icon, c.color
    FROM recurring_transactions rt
    JOIN categories c ON rt.category_id = c.id
    ORDER BY rt.day_of_month, rt.name`
  ).all();
  return jsonResponse({ recurringTransactions: results });
}
__name(handleGetRecurringTransactions, "handleGetRecurringTransactions");
async function handleDeleteRecurringTransaction(request, env) {
  const parts = new URL(request.url).pathname.split("/");
  const id = parts[parts.length - 1];
  if (!id) {
    return jsonResponse({ error: "ID is required" }, 400);
  }
  await env.DB.prepare("DELETE FROM recurring_transactions WHERE id = ?").bind(id).run();
  return jsonResponse({ success: true });
}
__name(handleDeleteRecurringTransaction, "handleDeleteRecurringTransaction");
async function handleAddManualTransaction(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const { description, amount, categoryId, date, autoCategorize } = body;
  if (!description || amount === void 0 || !date) {
    return jsonResponse({ error: "description, amount, and date are required" }, 400);
  }
  const status = autoCategorize && categoryId ? "categorized" : "pending";
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const insertResult = await env.DB.prepare(
    `INSERT INTO transactions (raw_sms, amount, merchant, transaction_type, occurred_at, status, category_id, categorized_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    `Manual: ${description}`,
    amount,
    description,
    "purchase",
    date,
    status,
    categoryId || null,
    status === "categorized" ? now : null
  ).run();
  return jsonResponse({ success: true, transactionId: insertResult.meta.last_row_id });
}
__name(handleAddManualTransaction, "handleAddManualTransaction");
async function handlePushSubscribe(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const { endpoint, keys } = body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return jsonResponse({ error: "endpoint and keys required" }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth)
    VALUES (?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
    p256dh = excluded.p256dh,
    auth = excluded.auth`
  ).bind(endpoint, keys.p256dh, keys.auth).run();
  return jsonResponse({ success: true });
}
__name(handlePushSubscribe, "handlePushSubscribe");
async function attachSplits(env, transactions) {
  const splitIds = transactions.filter((t) => t.is_split).map((t) => t.id);
  if (!splitIds.length) return transactions;
  const placeholders = splitIds.map(() => "?").join(",");
  const { results: splitRows } = await env.DB.prepare(
    `SELECT ts.transaction_id, ts.category_id, ts.amount, c.name, c.icon, c.color
    FROM transaction_splits ts
    JOIN categories c ON c.id = ts.category_id
    WHERE ts.transaction_id IN (${placeholders})`
  ).bind(...splitIds).all();
  const byTxn = {};
  for (const row of splitRows) {
    (byTxn[row.transaction_id] ||= []).push({ categoryId: row.category_id, amount: row.amount, name: row.name, icon: row.icon, color: row.color });
  }
  return transactions.map((t) => t.is_split ? { ...t, splits: byTxn[t.id] || [] } : t);
}
__name(attachSplits, "attachSplits");
async function handleGetTransactions(env, url) {
  const month = url.searchParams.get("month");
  const categoryId = url.searchParams.get("categoryId");
  const params = [];
  let query;
  if (categoryId) {
    query = `
    SELECT t.id, t.amount, t.merchant, t.occurred_at, t.status, t.is_split, t.plaid_pending,
    COALESCE(n.notes, '') AS notes,
    c.id AS category_id, c.name AS category_name, c.icon, c.color
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN transaction_notes n ON t.id = n.transaction_id
    WHERE t.transaction_type = 'purchase' AND t.category_id = ? AND t.is_split = 0
    ${month ? "AND strftime('%Y-%m', t.occurred_at) = ?" : ""}
    UNION ALL
    SELECT t.id, ts.amount, t.merchant, t.occurred_at, t.status, t.is_split, t.plaid_pending,
    COALESCE(n.notes, '') AS notes,
    c.id AS category_id, c.name AS category_name, c.icon, c.color
    FROM transactions t
    JOIN transaction_splits ts ON ts.transaction_id = t.id
    JOIN categories c ON c.id = ts.category_id
    LEFT JOIN transaction_notes n ON t.id = n.transaction_id
    WHERE t.transaction_type = 'purchase' AND ts.category_id = ? AND t.is_split = 1
    ${month ? "AND strftime('%Y-%m', t.occurred_at) = ?" : ""}
    ORDER BY occurred_at DESC
    `;
    params.push(categoryId);
    if (month) params.push(month);
    params.push(categoryId);
    if (month) params.push(month);
  } else {
    query = `
    SELECT t.id, t.amount, t.merchant, t.occurred_at, t.status, t.is_split, t.plaid_pending,
    COALESCE(n.notes, '') AS notes,
    c.id AS category_id, c.name AS category_name, c.icon, c.color
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN transaction_notes n ON t.id = n.transaction_id
    WHERE t.transaction_type = 'purchase'
    ${month ? "AND strftime('%Y-%m', t.occurred_at) = ?" : ""}
    ORDER BY t.occurred_at DESC
    `;
    if (month) params.push(month);
  }
  const { results } = await env.DB.prepare(query).bind(...params).all();
  const transactions = categoryId ? results : await attachSplits(env, results);
  return jsonResponse({ transactions });
}
__name(handleGetTransactions, "handleGetTransactions");
async function handleGetSingleTransaction(env, transactionId) {
  const txn = await env.DB.prepare(
    `SELECT t.id, t.amount, t.merchant, t.occurred_at, t.status, t.is_split, t.plaid_pending,
    COALESCE(n.notes, '') AS notes,
    c.id AS category_id, c.name AS category_name, c.icon, c.color
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN transaction_notes n ON t.id = n.transaction_id
    WHERE t.id = ?`
  ).bind(transactionId).first();
  if (!txn) return jsonResponse({ error: "Transaction not found" }, 404);
  const [withSplits] = await attachSplits(env, [txn]);
  return jsonResponse(withSplits);
}
__name(handleGetSingleTransaction, "handleGetSingleTransaction");
async function handleUpdateTransactionNotes(request, env) {
  const parts = new URL(request.url).pathname.split("/");
  const transactionId = parts[parts.length - 1];
  if (!transactionId) {
    return jsonResponse({ error: "Transaction ID is required" }, 400);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const { notes, categoryId } = body;
  if (notes === void 0) {
    return jsonResponse({ error: "notes field is required" }, 400);
  }
  try {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (notes.trim() === "") {
      await env.DB.prepare(
        `DELETE FROM transaction_notes WHERE transaction_id = ?`
      ).bind(transactionId).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO transaction_notes (transaction_id, notes, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(transaction_id) DO UPDATE SET
        notes = excluded.notes,
        updated_at = excluded.updated_at`
      ).bind(transactionId, notes, now).run();
    }
    if (categoryId !== void 0) {
      const status = categoryId ? "categorized" : "pending";
      await env.DB.prepare("DELETE FROM transaction_splits WHERE transaction_id = ?").bind(transactionId).run();
      await env.DB.prepare(
        `UPDATE transactions SET category_id = ?, status = ?, categorized_at = ?, is_split = 0 WHERE id = ?`
      ).bind(categoryId || null, status, categoryId ? now : null, transactionId).run();
      if (categoryId) {
        const txn = await env.DB.prepare("SELECT merchant FROM transactions WHERE id = ?").bind(transactionId).first();
        if (txn?.merchant) {
          await env.DB.prepare(
            `INSERT INTO merchant_category_map (merchant, category_id, times_used, updated_at)
            VALUES (?, ?, 1, ?)
            ON CONFLICT(merchant) DO UPDATE SET
            category_id = excluded.category_id,
            times_used = merchant_category_map.times_used + 1,
            updated_at = excluded.updated_at`
          ).bind(txn.merchant, categoryId, now).run();
        }
      }
    }
    console.log(`Successfully saved notes for transaction ${transactionId}`);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error("Failed to save notes:", error.message);
    console.error("Full error object:", error);
    return jsonResponse({ error: `Failed to save notes: ${error.message}` }, 500);
  }
}
__name(handleUpdateTransactionNotes, "handleUpdateTransactionNotes");
async function handleSplitTransaction(request, env) {
  const parts = new URL(request.url).pathname.split("/");
  const transactionId = parts[parts.length - 2];
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const splits = body.splits;
  if (!Array.isArray(splits) || splits.length < 2 || splits.length > 3) {
    return jsonResponse({ error: "Provide 2 or 3 splits" }, 400);
  }
  for (const s of splits) {
    if (!s.categoryId || typeof s.amount !== "number" || s.amount <= 0) {
      return jsonResponse({ error: "Each split needs a categoryId and a positive amount" }, 400);
    }
  }
  const txn = await env.DB.prepare("SELECT amount FROM transactions WHERE id = ?").bind(transactionId).first();
  if (!txn) return jsonResponse({ error: "Transaction not found" }, 404);
  const total = splits.reduce((sum, s) => sum + s.amount, 0);
  if (Math.abs(total - txn.amount) > 0.01) {
    return jsonResponse({ error: `Splits must sum to ${txn.amount.toFixed(2)}, got ${total.toFixed(2)}` }, 400);
  }
  await env.DB.prepare("DELETE FROM transaction_splits WHERE transaction_id = ?").bind(transactionId).run();
  for (const s of splits) {
    await env.DB.prepare(
      "INSERT INTO transaction_splits (transaction_id, category_id, amount) VALUES (?, ?, ?)"
    ).bind(transactionId, s.categoryId, s.amount).run();
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(
    "UPDATE transactions SET is_split = 1, category_id = NULL, status = 'categorized', categorized_at = ? WHERE id = ?"
  ).bind(now, transactionId).run();
  return jsonResponse({ success: true });
}
__name(handleSplitTransaction, "handleSplitTransaction");
async function handleUnsplitTransaction(request, env) {
  const parts = new URL(request.url).pathname.split("/");
  const transactionId = parts[parts.length - 2];
  await env.DB.prepare("DELETE FROM transaction_splits WHERE transaction_id = ?").bind(transactionId).run();
  await env.DB.prepare(
    "UPDATE transactions SET is_split = 0, category_id = NULL, status = 'pending', categorized_at = NULL WHERE id = ?"
  ).bind(transactionId).run();
  return jsonResponse({ success: true });
}
__name(handleUnsplitTransaction, "handleUnsplitTransaction");
async function handleDeleteTransaction(request, env) {
  const parts = new URL(request.url).pathname.split("/");
  const transactionId = parts[parts.length - 1];
  if (!transactionId) {
    return jsonResponse({ error: "Transaction ID is required" }, 400);
  }
  await env.DB.prepare("DELETE FROM transaction_notes WHERE transaction_id = ?").bind(transactionId).run();
  await env.DB.prepare("DELETE FROM duplicate_flags WHERE transaction_id = ? OR matched_transaction_id = ?").bind(transactionId, transactionId).run();
  await env.DB.prepare("DELETE FROM transactions WHERE id = ?").bind(transactionId).run();
  return jsonResponse({ success: true });
}
__name(handleDeleteTransaction, "handleDeleteTransaction");
async function handleCSVTransactionImport(request, env) {
  try {
    const csvData = await request.text();
    if (!csvData || csvData.trim() === "") {
      return jsonResponse({ error: "No CSV data provided" }, 400);
    }
    const url = new URL(request.url);
    const scanOnly = url.searchParams.get("scanOnly") === "true";
    const result = await importTransactionsFromCSV(env, csvData, !scanOnly);
    if (!result.success) {
      return jsonResponse({ error: result.error || "CSV import failed" }, 400);
    }
    return jsonResponse({
      success: true,
      ...result
    });
  } catch (err) {
    console.error("CSV import failed:", err);
    console.error("Stack trace:", err.stack);
    return jsonResponse({ error: "CSV import failed: " + (err.message || String(err)) }, 500);
  }
}
__name(handleCSVTransactionImport, "handleCSVTransactionImport");
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
