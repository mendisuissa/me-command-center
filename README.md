# Modern Endpoint Command Center (encrypted static dashboard)

A read-only, mobile-friendly dashboard of open tasks, pull requests and CI for a private repository, published on GitHub Pages at no cost.

**Everything published here is encrypted.** Every 30 minutes a GitHub Actions run:

1. reads the private repository with a read-only token;
2. encrypts the result with AES-256-GCM, using a key derived from a passphrase (PBKDF2-SHA256, 600,000 iterations);
3. deploys the static page and the encrypted `data.json`.

The browser decrypts locally after the passphrase is entered. Without the passphrase, the page shows only the lock screen.

## Secrets (repository → Settings → Secrets and variables → Actions)

| Secret | Value |
|---|---|
| `CC_SOURCE_TOKEN` | Fine-grained token for the source repository only, read-only: Issues, Pull requests, Actions |
| `CC_SOURCE_REPO` | `owner/name` of the source repository |
| `CC_PASSPHRASE` | Random passphrase, 24 characters or more (the build refuses shorter ones) |

## Security notes

- The ciphertext is public, so the passphrase is the whole defence. Use a generated random value, not a memorable one.
- "Remember on this device" stores a non-extractable WebCrypto key in IndexedDB. **Lock** deletes it.
- Rotating `CC_PASSPHRASE` locks every device out from the next deploy.
- The workflow has no `pull_request` trigger, actions are pinned to commit SHAs, and logs contain status codes only.
- The page sets a strict CSP and renders data with `textContent` only.

## Tests

```sh
node --test 'test/*.test.js'
```
