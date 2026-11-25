# Threat model

_Last reviewed: 2026-11-02_

The dashboard is a small Node.js server that a customer runs on their own machine or network. It holds one DeepL Admin API key per account and shows combined usage in a browser.

## Assets

| Asset | Value | Why |
| --- | --- | --- |
| Admin API keys | **High** | An admin key can create and deactivate the account's API keys and change usage limits, not just read analytics. A leaked key can take a customer's production integration offline. |
| Dashboard access token | Medium | Gives read access to usage data for every configured account, and lets the holder trigger Admin API calls. |
| Usage data | Medium | Character and minute volumes per account and day. Business-sensitive (it shows volume and growth), but holds no translated content and no personal data. |
| Availability of the customer's Admin API quota | Low–medium | Unbounded calls from the dashboard can hit DeepL rate limits for the account. |

## Trust boundaries

```
Browser ──HTTP──▶ server.js ──HTTPS──▶ api.deepl.com / api-us / api-jp
   │                  │
   │                  └── reads config.json + environment (keys, token)
   └── loads Chart.js from cdn.jsdelivr.net (SRI-pinned)
```

1. **Browser ↔ server.** Untrusted input: path, query string, `Host`, `Authorization`, other headers.
2. **Server ↔ filesystem and environment.** Holds the secrets.
3. **Server ↔ DeepL API.** Trusted endpoint, over TLS. Responses are parsed as JSON and rendered (escaped) in the browser.
4. **Browser ↔ CDN.** Third-party script, pinned with Subresource Integrity.

## Threat actors

| Actor | Can reach | Main concern |
| --- | --- | --- |
| A. Malicious website open in the operator's browser | `localhost` via the browser (cross-site requests, DNS rebinding) | Reading usage data; making the server call the API or use memory |
| B. Someone on the same network | The server port, if bound beyond loopback | Reading usage data; guessing the token; DoS |
| C. Another user on the same machine | The config file, process environment, loopback port | Reading keys from `config.json` |
| D. Compromised CDN / supply chain | The Chart.js file | Running script in the dashboard page |
| E. Insider with the dashboard token | Everything the dashboard shows | Reading usage data (by design); trying to get the keys |
| F. Someone with access to the host or its logs | Process memory, env, logs, git checkout | Keys (out of scope: whoever controls the host controls the keys) |

## Controls and what they cover

| Threat | Control | Status |
| --- | --- | --- |
| Keys reach the browser | Keys used only in the outbound `Authorization` header; responses carry only aggregated daily totals | In place |
| Keys in logs | Only the account name and error message are logged | In place |
| Keys committed to git | `config.json` gitignored; Secret Detection in CI | In place |
| Keys readable by other local users (C) | Setup writes mode `600`; startup warning on looser modes; `admin_api_key_env` keeps keys out of the file | In place |
| Network exposure without auth (B) | Non-loopback bind refuses to start without a token; HTTP Basic auth | In place |
| DNS rebinding (A) | `Host` allowlist when no token is set; malformed `Host` values rejected | In place |
| Token guessing (B) | Minimum 24-character token; 20 failed logins per minute per client address, then `429` | In place (behind a reverse proxy, the limit is shared by all viewers) |
| Cross-site triggering of API calls (A) | `/api/*` rejects requests a browser marks as cross-site (`Sec-Fetch-Site`) | In place |
| Exhausting memory or the Admin API rate limit (A, B, E) | Cache capped at 50 ranges; concurrent identical requests share one fetch; Refresh throttled to once per 10 s; impossible dates rejected | In place |
| Path traversal | Resolved path must stay inside `public/` | In place, tested |
| XSS from account names or API errors | All dynamic values escaped; CSP blocks inline script | In place |
| Malicious or tampered Chart.js (D) | SRI hash; CSP allows only that one file URL | In place |
| Clickjacking | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | In place |
| Token sniffed in transit (B) | README requires HTTPS (reverse proxy) for shared use; startup notice when bound beyond loopback | Documentation and warning only; the server itself has no TLS |
| Over-privileged admin keys | — | Accepted for now: no read-only analytics key scope exists in the product |

## Out of scope

- Compromise of the host the dashboard runs on (actor F).
- The DeepL API's own security.
- Per-viewer permissions: everyone with the token sees every account, by design.
