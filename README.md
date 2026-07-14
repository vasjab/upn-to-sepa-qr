# UPN → SEPA QR

**Live:** https://vasjab.github.io/upn-to-sepa-qr/

A tiny, mobile-first web app that scans a **Slovenian UPN payment QR code** (the one printed on _položnice_ / UPN bills that Slovenian bank apps read to pre-fill a payment) and turns it into a **SEPA EPC QR code** (a.k.a. _GiroCode_ / EPC069-12) — the standard that **N26**, **Wise**, **bunq** and most EU banking apps scan to pre-fill a SEPA transfer.

Why it's needed: a Slovenian UPN QR is its **own** format. Foreign fintech apps cannot read it. This app converts UPN → EPC so you can pay a Slovenian bill from a non-Slovenian account.

- **100% client-side.** Your payment data never leaves the device — no server, no tracking, no build step.
- Four ways to input a code: **scan with camera**, **capture screen**, **upload an image**, or **paste a screenshot** (⌘V / Ctrl V) — plus a raw-text fallback.
- Handles Slovenian characters (č/š/ž) correctly (UPN QR is ISO-8859-2).
- Editable fields — fix the amount on open-amount bills, tweak the reference — the QR updates live.
- IBAN checksum + basic validation, with plain-language warnings.

## Privacy & security

This app is designed so payment data physically cannot leave your device:

- **No network egress.** A strict `Content-Security-Policy` sets `connect-src 'none'`, blocking `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `sendBeacon`. Everything else is locked to `'self'`; there are no analytics, trackers, external scripts, fonts, or CDNs at runtime (the two QR libraries are vendored locally).
- **On-device processing.** Camera / screen-capture / image frames are decoded in-page with `jsQR`; the SEPA QR is generated in-page with `qrcode-generator`. Nothing is uploaded.
- **No inline code.** `script-src 'self'` and `style-src 'self'` (no `unsafe-inline`) shrink the XSS surface; all user-derived text is HTML-escaped before display.
- **Streams released immediately.** Camera and screen-capture `MediaStream`s are stopped the instant a code is found, the view is cancelled, or the tab is hidden — the camera/recording indicator never lingers.

For an even stronger guarantee when self-hosting, add these response headers (CSP `frame-ancestors` and friends can't be set from a `<meta>` tag):
`Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: geolocation=(), microphone=()`.

> **Screen capture** uses the browser's `getDisplayMedia` picker (desktop + Android Chrome; not iOS Safari). The button only appears where it's supported. Handy when the UPN QR is a PDF/e-bill on the same device's screen.

## App compatibility (important, verified July 2026)

| App | Scans this EPC QR? |
|---|---|
| **N26** | ✅ Yes, natively (under **Send → scan QR**). Reads IBAN, name, amount, reference. |
| **Wise, bunq**, and most EU banking apps | ✅ Standard EPC/GiroCode support |
| **Revolut** | ⚠️ **Not guaranteed.** Revolut's documented QR-bill scan is the *Swiss* QR-bill; general EPC scan-to-SEPA varies by app version/region. Try it — if it won't scan, use **Copy details** and paste into a manual transfer. |

> **The Slovenian reference (sklic)** — e.g. `SI12 1234…` — is a national format, **not** an ISO-11649 RF reference, so it can't ride in SEPA's structured-reference field. It's placed in the free-text remittance instead (where the payee's bank reads it). This is the standard, correct workaround. RF references pass through the same way.

Always double-check the recipient, IBAN and amount in your bank app before confirming.

## Run locally

Camera access needs a secure context (`https://` or `http://localhost`), so serve it — don't open `index.html` via `file://`:

```bash
cd "Slo QR code to Revolut QR code"
python3 -m http.server 8777
# then open http://localhost:8777 (on your phone: use your computer's LAN IP over https, or deploy)
```

## Deploy

It's pure static files — drop the folder on any static host:

- **Vercel:** `vercel deploy` (or drag-and-drop the folder in the dashboard). No config needed.
- **Netlify:** drag the folder onto the deploy area.
- **GitHub Pages / Cloudflare Pages:** push and point at the folder.

Any of these serves over HTTPS, so the camera works on a phone. You can also **Add to Home Screen** (a web manifest is included) to use it like an app.

## How it works

```
camera / photo / paste
        │  jsQR decodes the QR to bytes → decoded as ISO-8859-2 (UPN spec)
        ▼
   parse UPN (convert.js) ── 20 positional fields
        │  map recipient IBAN, name, amount (cents), purpose, sklic
        ▼
   build EPC payload (BCD / 002 / UTF-8 / SCT / … / EUR amount / remittance)
        │  ≤ 331 bytes, ECC level M
        ▼
   render EPC QR (qrcode-generator) → your bank app scans it
```

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup + layout, CSP, social/OpenGraph tags |
| `styles.css` | Mobile-first styles, light/dark |
| `app.js` | Camera / screen / photo / paste decode, live QR rendering, UI |
| `convert.js` | Pure UPN→EPC logic (no DOM) — the tested core |
| `sw.js` | Service worker — offline capability (network-first shell) |
| `test.js` | Node unit + round-trip tests: `node test.js` |
| `vendor/jsQR.js` | QR **decoding** (vendored) |
| `vendor/qrcode-generator.js` | QR **generation** (vendored) |
| `manifest.webmanifest` | PWA / Add-to-Home-Screen |
| `og.png` | 1200×630 social share image |
| `og-template.html` | Source for `og.png` (rendered via headless Chrome) |

### Third-party libraries (vendored, pinned)

Both QR libraries are checked into `vendor/` (no runtime CDN, no npm install needed) and pinned to long-stable, years-old releases:

| Library | Version | Published | License |
|---|---|---|---|
| [jsQR](https://github.com/cozmo/jsQR) | 1.4.0 | 2021-04-24 | Apache-2.0 |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | 1.4.4 | 2019-09-18 | MIT |

To refresh `og.png` after editing `og-template.html`:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --allow-file-access-from-files --force-device-scale-factor=1 --hide-scrollbars \
  --window-size=1200,630 --screenshot="$PWD/og.png" "file://$PWD/og-template.html"
```

### Offline (PWA)

`sw.js` caches the app for offline use. It's **network-first for the HTML shell** (so an online visit always gets the latest version — no stale-cache surprises) and cache-first only for the versioned assets (`app.js?v=…` etc.). Assets are cache-busted with a `?v=` query, so shipping an update is just a version bump. Combined with `manifest.webmanifest`, the app is installable via **Add to Home Screen**.

> Note: this is plain typed-by-hand JavaScript, not TypeScript — deliberately, given the size and zero-build, static-hosting goals.

## Tests

```bash
node test.js      # 50 assertions: parsing, amount, references, EPC mapping, byte cap, ISO-8859-2
```

The browser pipeline is also round-trip verified: a UPN QR is encoded, decoded with jsQR, converted, re-rendered as an EPC QR, and decoded again — confirming the output is scannable and carries the correct data.

## Disclaimer

This is a convenience tool. It does not move money — it only produces a QR code you scan in your own bank app, where you review and confirm the payment. Verify every payment before you send it.
