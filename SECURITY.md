# Security

## Reporting

Please open a private security advisory on the repository, or contact the maintainers directly. Do not file a public issue for an exploitable bug. Include the affected version, a reproduction, and the impact you believe it has. We aim to acknowledge reports within a few days.

## Supported versions

The current `1.x` line receives security fixes. There is no long-term support branch.

## Threat model

GO/VOID is a static client plus a small in-memory matchmaking relay. There are no accounts, cookies, databases, uploads, payments or third-party analytics. The assets are:

- **Players' browsers** — untrusted input arrives as moves, passes, signalling payloads and display names.
- **The relay** — must pair peers, forward bounded messages, and stay available under abuse.
- **Peer-to-peer links** — data channels are authenticated by WebRTC DTLS, but the remote peer is not otherwise trusted.

The relay is not a rules authority. A malicious peer can send any sequence of legal-looking moves; clients validate turn, sequence, board bounds and rules locally and ignore invalid messages. Cheating in a friendly P2P game is out of scope.

## Protections in place

### Transport and headers

- Strict Content Security Policy: `default-src 'self'`, `script-src 'self'`, `style-src 'self'`, `worker-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, restrictive `Permissions-Policy`, `Cross-Origin-Resource-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin`.
- No inline scripts or styles. Display names are inserted with `textContent`, never HTML.
- Static serving resolves paths inside `public/` and rejects traversal, NUL bytes, backslashes and dotfiles. Unknown extensions are served as `application/octet-stream`.
- The service worker caches only static shell assets; it never intercepts `/ws`, `/api/*` or `/healthz`.

### WebSocket and matchmaking

- Origin checks: missing origins are accepted for non-browser clients; browser origins must be same-host, localhost/loopback, a private LAN address, or explicitly listed in `ALLOWED_ORIGINS`. When `ALLOWED_ORIGINS` is set, only those origins are accepted.
- WebSocket upgrades are limited to `/ws`; all other paths return `404`.
- `ws` is configured with an 8 KiB max payload, no compression (`perMessageDeflate: false`), and connection/heartbeat limits.
- Per-IP connection cap (12) and global client cap (500); queues cap at 200 per board size.
- Token-bucket rate limiting per client (40-message burst, 4 messages/second refill).
- Binary frames, malformed JSON, unknown message types, oversized messages and invalid fields are rejected with an error event.
- Only known message types are forwarded. Relay payloads are re-validated server-side (type, sequence, index, color, dead-stone lists, byte size). Signalling SDP and ICE candidates are shape-checked and size-capped.
- Names are NFKC-normalized, stripped of control and markup characters, length-capped at 14 code points, and never used as HTML/selectors.
- Rooms are in memory; disconnects notify the peer and destroy the room. No IP addresses or messages are logged by default.

### Clients

- All game messages from the network are shape-checked before they reach the rules engine (`public/js/net.js`), and the engine re-checks legality, sequence and turn.
- The AI worker validates its input and runs with no network or DOM access.
- WebRTC uses an ordered data channel and falls back to the relay on ICE failure. Relay messages are still validated by the peer.
- `npm audit --omit=dev` is part of the release checklist and currently reports zero vulnerabilities. The only production dependency is `ws`.

## Residual risks

- **IP exposure in P2P.** WebRTC reveals candidate addresses to the opponent. Use `?relay=1` to force server relay, or deploy a TURN server with `ICE_SERVERS` to control candidates.
- **No anti-cheat or moderation.** A peer can resign, stall or send nonsense; clients handle invalid data, but a determined peer can still waste time.
- **In-memory rooms.** A restart drops all matches. This is intentional and limits stored data.
- **Denial of service.** Rate and size limits reduce abuse, but a very large distributed flood can still exhaust the single Node process. Put a reverse proxy with connection limits in front in production.
- **Third-party STUN.** The default ICE configuration uses public STUN servers. Configure your own for privacy or strict networks.

## Deployment checklist

- Serve over HTTPS/WSS; never ship game traffic over plain HTTP outside localhost/LAN testing.
- Set `ALLOWED_ORIGINS` to the exact public origin(s), including `https://`.
- Add a TURN server to `ICE_SERVERS` if players may be behind symmetric NAT.
- Configure a reverse proxy timeout appropriate for WebSockets and set conservative connection limits.
- Run as an unprivileged user and keep Node and `ws` patched.
- Run `npm audit --omit=dev` and `npm test` before deploying.
