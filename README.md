# Electricalskart Help Desk

**One single full-stack PWA** providing AI chat, human live chat, AI→human handoff, and browser-to-browser WebRTC voice calls — no phone numbers, no telecom providers.

The same Express/React app serves:

| Route               | Who can access                              |
|---------------------|---------------------------------------------|
| `/`                 | Public customer chat + call                 |
| `/login`            | Owner/Agent login                           |
| `/dashboard`        | Authenticated Owner/Agent call center       |

## Features

- Customer chat without registration (name + requirement only)
- AI assistant first-level support (OpenAI-compatible; falls back to a deterministic local KB if no API key is configured so the app always works out-of-the-box)
- Automatic AI→human handoff when AI is uncertain, with live notification to the dashboard
- Live human takeover, real-time agent replies, AI "Suggest Reply"
- **Browser voice calls** using WebRTC (no Twilio, no SIP, no phone numbers)
- Incoming call notifications with Accept / Reject, in-browser ring, mute/unmute, call duration, end call
- Call queue when multiple customers call at once, with queue position shown to customer
- Live conversation monitoring (AI chat / human required / human chat / in call / waiting for call)
- Chat & call history, customer directory, search
- Secure JWT authentication, server-side role checks, rate limiting
- Installable PWA (Chrome / Edge / mobile browsers) with manifest, service worker, and notifications

## Tech Stack

- **Backend:** Node.js + Express + Socket.IO (real-time msgs + WebRTC signaling) + sql.js (embedded SQLite DB)
- **Frontend:** React 18 + Vite + React Router + Tailwind CSS
- **Auth:** JWT + bcryptjs
- **Realtime:** Socket.IO
- **Voice:** WebRTC peer-to-peer audio (STUN servers only; TURN optional for restricted NATs)
- **PWA:** vite-plugin-pwa (autoUpdate service worker)

## Quick start

```bash
npm install
cp .env.example .env     # optional — a dev .env already exists
npm run dev
```

Then open:

- Customer UI: http://localhost:5173/
- Agent login: http://localhost:5173/login

Default **owner** credentials (bootstrapped on first run from `.env`):

- Email: `owner@electricalskart.local`
- Password: `Owner@123`

**Change the password immediately** (or update `.env` before first run).

## Production

```bash
npm run build
NODE_ENV=production npm start
```

The server listens on `PORT` (default `3001`) and serves the built React app plus API/Socket.IO on the same port.

## AI configuration

The AI service layer is provider-agnostic via environment variables:

- `AI_PROVIDER` — currently supports `openai` (any OpenAI-compatible endpoint) or unset → local fallback
- `AI_API_KEY` — your OpenAI-compatible API key
- `AI_MODEL` — e.g. `gpt-4o-mini`
- `AI_BASE_URL` — OpenAI-compatible base URL (defaults to OpenAI)
- `AI_SYSTEM_PROMPT` — the system prompt

When the model detects it cannot answer confidently (or the user asks for pricing, complaints, order status, bookings, etc.), it returns the escalation token `[[HUMAN_REQUIRED]]` and the conversation moves to the **Human Required** queue automatically. The local fallback uses keyword detection for the same escalation path.

## Roles

- **Owner** — full access; can create Agent accounts
- **Agent** — live chat, calls, monitoring (no user management)
- **Customer** — public chat/call; never sees the dashboard

Authorization is enforced server-side on every REST endpoint and Socket.IO event. The PWA installation does **not** grant any access; a valid JWT is required.

## WebRTC notes

- Uses Google public STUN servers by default. For users behind strict NATs, configure a TURN server (set via env in a future tweak — add to `RTCPeerConnection` config in `client/components/CallWidget.jsx` and the `ActiveCallPanel`).
- Signaling goes through Socket.IO and is authenticated (relay allowed only between the two peers of the active call).
- Customer always initiates; agents cannot dial out.

## Project layout

```
server/
  index.js     Express + Socket.IO server, REST, realtime, signaling, queue logic
  db.js        SQLite (sql.js) schema, helpers, persistence to file
  auth.js      JWT + bcrypt + middleware
  ai.js        Pluggable AI service + knowledge-based fallback
client/
  main.jsx     React entry
  App.jsx      Routes and role-based protection
  pages/       LoginPage, CustomerApp, Dashboard
  components/  ChatWindow, CallWidget (customer), dashboard/* (agent UI)
  lib/         auth, api, socket helpers
public/        PWA icons, favicon
```

## Data model (SQLite)

- `users` (owner/agent accounts)
- `customers` (anonymous customers, keyed by browser session id)
- `conversations` (status: `AI_ACTIVE`, `HUMAN_REQUIRED`, `HUMAN_ACTIVE`, `WAITING_CALL`, `IN_CALL`, `CLOSED`)
- `messages` (`sender_type`: CUSTOMER / AI / AGENT / SYSTEM)
- `calls` (status: `pending`, `ringing`, `in_queue`, `active`, `ended`, `rejected`, `missed`, `cancelled`)

## Security notes

- All secrets/keys are in `.env` and never shipped to the browser.
- Rate limiting on `/api/*` and stricter on `/api/auth/login`.
- Customer input sanitized/length-limited server-side; output rendered by React (XSS-safe).
- JWT verified on every authenticated socket connection and WebRTC signal is only relayed between verified peers.

## License

Proprietary — Electricalskart.
