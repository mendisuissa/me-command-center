'use strict';

// Passphrase encryption shared by the build (Node WebCrypto) and the browser, so both sides run
// the same code. AES-256-GCM with a PBKDF2-SHA256 key; the version string is bound as AAD.
(function (root) {
  const VERSION = 'me-cc-v1';
  const ITERATIONS = 600000;
  // A fixed, app-specific salt lets a browser keep the derived key between deployments. Offline
  // guessing is still bounded by the passphrase, which the build requires to be long and random.
  const SALT = 'modern-endpoint-command-center/v1';
  const encoder = new TextEncoder();

  function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function deriveKey(passphrase) {
    const material = await root.crypto.subtle.importKey('raw', encoder.encode(String(passphrase).trim()),
      'PBKDF2', false, ['deriveKey']);
    return root.crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(SALT), iterations: ITERATIONS },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function seal(key, value) {
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const data = await root.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(VERSION) },
      key, encoder.encode(JSON.stringify(value)));
    return { v: VERSION, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, iv: toBase64(iv),
      data: toBase64(new Uint8Array(data)) };
  }

  // Throws on a wrong key, a tampered envelope or an unknown format; never returns partial data.
  async function open(key, envelope) {
    if (!envelope || envelope.v !== VERSION || envelope.iterations !== ITERATIONS ||
        typeof envelope.iv !== 'string' || typeof envelope.data !== 'string') {
      throw new Error('ENVELOPE_INVALID');
    }
    const plain = await root.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: encoder.encode(VERSION) },
      key, fromBase64(envelope.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  const api = Object.freeze({ VERSION, ITERATIONS, deriveKey, seal, open });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MeVault = api;
})(globalThis);
