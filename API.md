# Railway worker API

All `/api/*` routes need `Authorization: Bearer <cPanel login token>` (+ optional `X-Device-Id`). Railway asks cPanel `GET /api/auth/verify` (cached 60 s). Rate limit 120/min; linking 10 per 10 min.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/health` | | public, no details |
| GET | `/api/whatsapp/status` | | `state`: `DISCONNECTED / CONNECTING / QR_READY / PAIRING_CODE_READY / CONNECTED / RECONNECTING`; `qrDataUrl`, `pairingCode`, `phoneMasked`, `lastError`. Never credentials |
| POST | `/api/whatsapp/link/qr` | | start QR linking |
| POST | `/api/whatsapp/link/pair` | `{phone}` | returns 8-char `pairingCode` |
| POST | `/api/whatsapp/disconnect` | | logout + delete stored session |
| GET | `/api/automation/status` | | settings + live WhatsApp state + `runningNow` + `queuedForRetry` |
| POST | `/api/automation/start` | `{intervalMinutes?, importInitialEntries?}` | 409 `WHATSAPP_NOT_LINKED` if never linked |
| POST | `/api/automation/stop` | | |
| PUT | `/api/automation/interval` | `{intervalMinutes}` or `{value, unit:"minutes"|"hours"}` | 5 min … 24 h |
| PUT | `/api/automation/settings` | `{importInitialEntries}` | |
| POST | `/api/automation/run-now` | | 202; 409/429 if busy / not connected / too soon |
| GET | `/api/automation/logs?limit=` | | from MySQL |

Cycle: `Hi` → menu → *Get Mini Statement* → ignore "Please wait while we fetch…" → parse → outbox (volume) → cPanel ingest → job complete.
Unofficial Baileys client: not an official WhatsApp/SBI API; accounts may be restricted.

## Tests
`npm install && npm test` runs parser unit tests. For the integration test set `CPANEL_TEST_URL` + `SERVICE_SECRET` (a throw-away cPanel PHP + MySQL `fp_test` DB; see `test/integration.test.js` header).
