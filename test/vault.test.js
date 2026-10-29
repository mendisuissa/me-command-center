'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vault = require('../site/vault');

const PASS = 'test-passphrase-0123456789-abcdef';
const data = { generatedAt: '2026-10-29T20:00:00.000Z', issues: [{ title: 'Private roadmap item' }] };

test('sealed data opens with the right passphrase and never contains plaintext', async () => {
  const envelope = await vault.seal(await vault.deriveKey(PASS), data);
  assert.equal(JSON.stringify(envelope).includes('Private roadmap'), false);
  assert.deepEqual(await vault.open(await vault.deriveKey(` ${PASS}\n`), envelope), data);
});

test('wrong passphrase, tampering and unknown formats are rejected without partial data', async () => {
  const key = await vault.deriveKey(PASS);
  const envelope = await vault.seal(key, data);
  await assert.rejects(vault.open(await vault.deriveKey(`${PASS}x`), envelope));
  const bytes = Buffer.from(envelope.data, 'base64'); bytes[0] ^= 1;
  await assert.rejects(vault.open(key, { ...envelope, data: bytes.toString('base64') }));
  await assert.rejects(vault.open(key, { ...envelope, v: 'me-cc-v0' }), /ENVELOPE_INVALID/);
  await assert.rejects(vault.open(key, { ...envelope, iterations: 1000 }), /ENVELOPE_INVALID/);
  await assert.rejects(vault.open(key, null), /ENVELOPE_INVALID/);
});

test('every seal uses a fresh IV', async () => {
  const key = await vault.deriveKey(PASS);
  const ivs = new Set();
  for (let i = 0; i < 20; i += 1) ivs.add((await vault.seal(key, data)).iv);
  assert.equal(ivs.size, 20);
});

test('large payloads round-trip (chunked base64)', async () => {
  const key = await vault.deriveKey(PASS);
  const big = { text: 'א'.repeat(300_000) };
  assert.deepEqual(await vault.open(key, await vault.seal(key, big)), big);
});
