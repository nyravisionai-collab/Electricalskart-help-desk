# Electricalskart Help Desk

Electricalskart Help Desk is **one unified full-stack PWA** for public customer support and an authenticated Owner/Agent call-center dashboard.

| Route | Access | Purpose |
|---|---|---|
| `/` | Public | Start/resume a customer chat and request an incoming browser call |
| `/login` | Public form | Owner/Agent authentication |
| `/dashboard` | Authenticated Owner/Agent | Live chat, takeover, calls, customers, and history |

There is no PSTN, SIP, SIM, phone number, Twilio, or outgoing dialler. Voice is browser-to-browser WebRTC audio; only a customer can request a support call.

## Architecture

- **Client:** React 18, React Router, Tailwind CSS, Vite
- **Server:** Node.js, Express, Socket.IO
- **Persistence:** `sql.js` SQLite file
- **Staff authentication:** short-lived signed JWT plus live database role/status checks
- **Customer authentication:** opaque 256-bit session secret; only its SHA-256 hash is stored
- **Realtime:** authenticated Socket.IO channels
- **Voice:** WebRTC audio with authenticated SDP/ICE relay
- **PWA:** generated manifest/service worker; static assets only are cached
- **AI:** grounded response layer plus an optional OpenAI-compatible drafting provider

The production server serves the React build, API, and Socket.IO endpoint from the same origin. The current embedded database and global call lane are designed for a **single server process**. Horizontal scaling requires a shared transactional database and Socket.IO adapter.

## Customer flow

1. The customer opens `/` without registering.
2. They enter a name and requirement.
3. The server creates an opaque customer session and an `AI_ACTIVE` conversation.
4. AI responses use only active, Owner-verified knowledge entries.
5. Missing verified information changes the conversation to `HUMAN_REQUIRED` and alerts staff.
6. An Owner/Agent can take over without losing chat history.
7. The customer can request a browser call. If another call is active, the request enters the persistent queue.
8. The accepting Agent and customer exchange audio over WebRTC.

A customer token is never accepted as a customer/conversation identifier. Every REST and Socket.IO operation resolves the token server-side and verifies conversation ownership.

## Owner/Agent flow

1. Staff sign in through `/login`.
2. The server validates the password hash, signed token, current account status, and database role.
3. The dashboard monitors active conversations and call state in real time.
4. Staff can take over AI chats, reply, request an AI draft, and edit it before sending.
5. All staff see incoming calls. The first successful accept atomically owns the call; other ringing interfaces close through `call:taken`.
6. An unrelated Agent disconnect does not alter another Agent's call.

The Owner-only agent and knowledge-management APIs are server-authorized. Agent tokens cannot access them.

## Secure configuration

Copy the template and set all required values before first startup:

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Required configuration for an empty database:

```dotenv
JWT_SECRET=<at-least-32-byte-cryptographically-random-secret>
OWNER_NAME=<owner display name>
OWNER_EMAIL=<owner login email>
OWNER_PASSWORD=<12-to-128-character strong password>
```

There are **no default production credentials or JWT fallback secrets**. Startup fails clearly when `JWT_SECRET` is missing, weak, or a known placeholder. On an empty database, startup also fails unless the first Owner credentials are explicitly configured. The password is bcrypt-hashed and is never logged.

Once the Owner exists in the persisted database, `OWNER_*` values are not used to overwrite it.

### Environment variables

| Variable | Required | Description |
|---|---:|---|
| `NODE_ENV` | Production | Set to `production` for the built single-origin app |
| `PORT` | No | HTTP port; default `3001` |
| `DB_FILE` | No | Persisted SQLite file; default `./data/helpdesk.sqlite` |
| `JWT_SECRET` | Yes | Random staff-token signing secret, minimum 32 bytes |
| `SESSION_TTL_HOURS` | No | Staff token lifetime, 1–168 hours; default `12` |
| `OWNER_NAME` | First startup | First Owner display name |
| `OWNER_EMAIL` | First startup | First Owner email |
| `OWNER_PASSWORD` | First startup | First Owner password, 12–128 characters |
| `CORS_ORIGIN` | Cross-origin only | Comma-separated allowed origins; leave blank for same-origin production |
| `BUSINESS_KNOWLEDGE_FILE` | No | JSON file containing verified knowledge entries |
| `AI_PROVIDER` | No | `local`, `openai-compatible`, or `openai` alias |
| `AI_API_KEY` | Provider only | Required for a configured external provider |
| `AI_MODEL` | Provider only | Provider model name |
| `AI_BASE_URL` | Provider only | OpenAI-compatible API base URL |
| `AI_TIMEOUT_MS` | No | Provider request timeout, default `15000` |
| `STUN_URLS` | No | Comma-separated STUN URLs |
| `TURN_URL` | Recommended | `turn:` or `turns:` relay URL |
| `TURN_USERNAME` | With TURN | TURN username |
| `TURN_CREDENTIAL` | With TURN | TURN credential |
| `CALL_RING_TIMEOUT_MS` | No | Ring timeout, default `30000` |
| `CALL_QUEUE_TTL_MS` | No | Maximum queue age, default `900000` |

Do not commit `.env`. Persist `DB_FILE` on durable storage and back it up.

## Verified AI knowledge

The application no longer ships assumed store hours, brands, prices, warranty, installation, payment, delivery, availability, or other business claims.

Customer factual flow:

```text
customer question → active verified knowledge lookup → exact grounded response
                                                   ↘ no match → HUMAN_REQUIRED
```

Knowledge entries are stored in `knowledge_entries` and contain:

```json
{
  "id": "optional-stable-id",
  "topic": "store_hours",
  "title": "Verified support hours",
  "content": "Owner-confirmed factual content.",
  "keywords": ["store", "hours", "open"],
  "source": "Owner/source used for verification",
  "active": true
}
```

They can be imported from the explicitly configured `BUSINESS_KNOWLEDGE_FILE` or managed through the Owner-authorized `/api/knowledge` API. Agents can read but cannot modify verified entries.

The optional external provider is isolated in `server/ai-provider.js`. It drafts **agent suggestions only** from verified context; suggestions are never auto-sent. Customer business facts are rendered from verified entries so provider output cannot introduce unsupported claims.

## AI/human concurrency

Every conversation has a persisted `revision`. An AI request captures the active revision. Customer activity, takeover, close, and call transitions advance it. Before persisting or emitting an AI answer, the server verifies that the conversation is still `AI_ACTIVE` at the same revision. A response completing after human takeover is discarded.

## Call state and persistent queue

Persisted call states are:

```text
WAITING → RINGING → ACTIVE → ENDED
   │         │         └────→ FAILED
   │         ├──────────────→ REJECTED / MISSED / CANCELLED / FAILED
   └────────────────────────→ CANCELLED / MISSED / FAILED
```

Every transition is validated server-side. A call stores the conversation status/mode that existed before the request. Reject, cancel, timeout, failure, disconnect, and normal end restore that exact prior state unless newer human activity is already authoritative.

At startup:

- stale `RINGING` and `ACTIVE` calls become `FAILED` with reason `server_restart`;
- valid `WAITING` calls remain ordered in the database;
- expired queue entries become `MISSED`;
- waiting calls resume when their verified customer session reconnects;
- duplicate `WAITING`/`RINGING`/`ACTIVE` calls for the same customer are rejected.

## WebRTC and TURN

The browser flow supports:

- authenticated offer/answer relay;
- authenticated ICE candidate relay between active-call peers only;
- buffering candidates received before `setRemoteDescription`;
- buffering early signaling while media/peer setup is pending;
- mute/unmute, duration, and clean end;
- media-track and `RTCPeerConnection` cleanup;
- bounded reconnect grace for `disconnected`;
- `failed`, `closed`, signaling, and microphone-permission failure handling.

Default STUN is useful for development, but it cannot guarantee connectivity through restrictive NAT/firewalls. Configure all TURN values in production:

```dotenv
TURN_URL=turns:turn.example.com:5349
TURN_USERNAME=<turn-user>
TURN_CREDENTIAL=<turn-secret>
```

TURN credentials are supplied at runtime only to authenticated call participants; they are not embedded in the JavaScript bundle. Prefer short-lived credentials from a properly secured TURN deployment. TURN reachability and real physical microphone/speaker quality must be verified in the target production networks.

## Development

```bash
npm ci
cp .env.example .env
# Fill JWT_SECRET and first-Owner values
npm run dev
```

- Customer: `http://localhost:5173/`
- Staff login: `http://localhost:5173/login`
- API/Socket.IO: proxied to `http://localhost:3001`

## Production

```bash
npm ci
npm run build
NODE_ENV=production npm start
```

Production requirements:

- HTTPS (required for microphone access and normal PWA installation outside localhost)
- strong `JWT_SECRET`
- durable `DB_FILE`
- reverse proxy/WebSocket support
- restrictive same-origin or explicit `CORS_ORIGIN`
- TURN for networks where direct peer connectivity fails
- log/backup/monitoring appropriate to the deployment

The server applies security headers, input limits, REST rate limits, no-store API headers, and authenticated Socket.IO signaling.

## PWA

The build generates:

- `manifest.webmanifest`
- 192px and 512px icons
- auto-updating service worker
- standalone display metadata

Install from Chrome/Edge through the browser's install action while served over HTTPS. Installing the PWA grants no staff role. Dashboard APIs and sockets still require valid Owner/Agent authentication.

The service worker precaches build assets only. It does **not** runtime-cache authentication, conversations, customers, messages, calls, or dashboard APIs. App startup/logout also deletes the legacy `api-cache` used by pre-M9 builds.

## Testing

```bash
npm run lint       # ESLint; exits non-zero on errors
npm test           # Node unit/integration/security/restart tests
npm run build      # Production PWA build
npm audit --audit-level=moderate

npx playwright install --with-deps chromium
npm run test:e2e   # Two isolated browser contexts with fake microphone media
```

The automated suite covers:

- login success/failure, invalid/expired JWTs, and role restrictions;
- cross-customer REST, bind, message, and realtime isolation;
- grounded AI fallback and Owner-verified facts;
- AI completion racing with human takeover;
- customer → AI → escalation → takeover → human reply → suggestion;
- call request, duplicate prevention, queue, accept, reject, cancel, timeout, failure, end;
- exact conversation-state restoration;
- multi-agent single claim and unrelated disconnect behavior;
- server crash/restart queue recovery and call history;
- offer, answer, ICE relay, candidate buffering, and TURN configuration;
- PWA private-cache removal;
- dual-browser customer/Owner flow through a connected WebRTC audio session.

The Playwright test uses Chromium fake microphone devices. It verifies WebRTC reaches `connected` and that each browser receives a remote audio track. It does not certify physical microphone/speaker quality or an external TURN server; those remain deployment verification tasks.

## Data model

- `users` — Owner/Agent identity, password hash, role, status
- `customers` — anonymous profile and hashed opaque session secret
- `conversations` — status, mode, assigned Agent, revision
- `messages` — CUSTOMER / AI / AGENT / SYSTEM history
- `calls` — state, queue position, timing, handler, previous conversation state
- `knowledge_entries` — Owner-verified business facts and provenance

## Security model summary

- Browser-provided customer, conversation, user, Agent, and peer identifiers are never authoritative.
- Customer ownership is resolved from an opaque session token hash.
- Staff tokens use configured HS256 secrets, issuer/audience/type checks, expiry, and current DB role/status verification.
- Owner-only operations are server-authorized.
- WebRTC signaling is restricted to the two peers of the active, claimed call.
- React renders message text without raw HTML.
- API responses are `no-store` and are excluded from service-worker runtime caching.
- Secrets and credentials stay in environment variables and are not logged.

## License

Proprietary — Electricalskart.
