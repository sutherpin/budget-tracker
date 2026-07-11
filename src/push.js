// src/push.js
// Sends Web Push notifications using VAPID auth and the Web Crypto API.
// No external libraries needed — uses the Workers runtime's built-in crypto.

const EXPIRY = 12 * 60 * 60; // 12 hours in seconds

/**
 * Send a push notification to all stored subscriptions.
 * @param {Object} env - Worker environment (needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, DB)
 * @param {Object} payload - { title, body, transactionId }
 */
export async function sendPushNotification(env, payload) {
  const { results } = await env.DB.prepare(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions'
  ).all();

  if (!results.length) return;

  await Promise.all(
    results.map((sub) => sendPush(env, sub, payload))
  );
}

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
      method: 'POST',
      headers: {
        ...vapidHeaders,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL': '86400',
      },
      body: encrypted,
    });

    if (res.status === 410 || res.status === 404) {
      // Subscription expired — remove it from DB
      await env.DB.prepare(
        'DELETE FROM push_subscriptions WHERE endpoint = ?'
      ).bind(endpoint).run();
    } else if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      console.error(`Push send non-OK status ${res.status} for ${endpoint.slice(0, 60)}: ${bodyText}`);
    } else {
      console.log(`Push send OK (${res.status}) for ${endpoint.slice(0, 60)}`);
    }
  } catch (err) {
    console.error('Push send failed:', err);
  }
}

// ============================================================
// VAPID JWT signing
// ============================================================
async function buildVapidHeaders(publicKey, privateKey, subject, endpoint) {
  const origin = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);

  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({
    aud: origin,
    exp: now + EXPIRY,
    sub: subject,
  }));

  const signingInput = `${header}.${claims}`;

  const keyData = base64ToBytes(privateKey);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    toPkcs8(keyData),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const jwt = `${signingInput}.${bytesToB64url(new Uint8Array(signature))}`;

  return {
    'Authorization': `vapid t=${jwt}, k=${publicKey}`,
  };
}

// ============================================================
// Payload encryption (RFC 8291 / aes128gcm)
// ============================================================
async function encryptPayload(payload, p256dhBase64, authBase64) {
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(payload);

  // Decode subscription keys
  const clientPublicKey = base64ToBytes(p256dhBase64);
  const authSecret = base64ToBytes(authBase64);

  // Generate server ECDH key pair
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );

  const serverPublicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', serverKeyPair.publicKey)
  );

  // Import client public key
  const clientKey = await crypto.subtle.importKey(
    'raw',
    clientPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  // Derive shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientKey },
    serverKeyPair.privateKey,
    256
  );

  // HKDF to derive content encryption key and nonce
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(new Uint8Array(sharedBits), authSecret,
    buildInfo('auth', new Uint8Array(0), new Uint8Array(0)), 32);

  const contentKey = await hkdf(ikm, salt,
    buildInfo('aesgcm128', clientPublicKey, serverPublicKeyRaw), 16);

  const nonce = await hkdf(ikm, salt,
    buildInfo('nonce', clientPublicKey, serverPublicKeyRaw), 12);

  // Import content encryption key
  const aesKey = await crypto.subtle.importKey(
    'raw', contentKey, { name: 'AES-GCM' }, false, ['encrypt']
  );

  // Pad payload (minimum 2 bytes padding)
  const padLen = 2;
  const padded = new Uint8Array(padLen + payloadBytes.length);
  padded.set(payloadBytes, padLen);

  // Encrypt
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    aesKey,
    padded
  ));

  // Build aes128gcm content encoding header
  const header = new Uint8Array(21 + serverPublicKeyRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false); // record size
  header[20] = serverPublicKeyRaw.length;
  header.set(serverPublicKeyRaw, 21);

  // Combine header + encrypted
  const result = new Uint8Array(header.length + encrypted.length);
  result.set(header, 0);
  result.set(encrypted, header.length);
  return result;
}

// ============================================================
// HKDF helper
// ============================================================
async function hkdf(ikm, salt, info, length) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', ikm, { name: 'HKDF' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    keyMaterial,
    length * 8
  );
  return new Uint8Array(bits);
}

function buildInfo(type, clientKey, serverKey) {
  const encoder = new TextEncoder();
  const typeBytes = encoder.encode(`Content-Encoding: ${type}\0`);
  const info = new Uint8Array(typeBytes.length + 1 + 2 + clientKey.length + 2 + serverKey.length);
  let offset = 0;
  info.set(typeBytes, offset); offset += typeBytes.length;
  info[offset++] = 0x41; // 'A' for P-256
  new DataView(info.buffer).setUint16(offset, clientKey.length, false); offset += 2;
  info.set(clientKey, offset); offset += clientKey.length;
  new DataView(info.buffer).setUint16(offset, serverKey.length, false); offset += 2;
  info.set(serverKey, offset);
  return info;
}

// ============================================================
// Crypto utilities
// ============================================================
function b64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function bytesToB64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64ToBytes(base64) {
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized);
  return new Uint8Array(binary.length).map((_, i) => binary.charCodeAt(i));
}

function toPkcs8(rawKey) {
  // Wrap raw 32-byte EC private key in PKCS#8 DER structure for P-256
  const prefix = new Uint8Array([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06,
    0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
    0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01,
    0x01, 0x04, 0x20,
  ]);
  const result = new Uint8Array(prefix.length + rawKey.length);
  result.set(prefix);
  result.set(rawKey, prefix.length);
  return result;
}
