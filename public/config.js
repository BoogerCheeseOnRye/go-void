/*
 * Runtime networking configuration.
 *
 * Local development with `npm start` uses the same-origin relay at /ws.
 * For a static deployment (such as GitHub Pages), set relayUrl to the
 * absolute wss:// URL of a GO/VOID matchmaking server and set
 * sameOriginRelay to false. The Pages workflow generates this file from
 * the GO_VOID_RELAY_URL repository variable.
 */
window.GO_VOID_CONFIG = Object.freeze({
  relayUrl: '',
  sameOriginRelay: true,
});
