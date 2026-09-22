/**
 * Auto-fill the gateway token in the OpenClaw Control UI.
 *
 * The Control UI sends the gateway token inside the WebSocket `connect` frame
 * (signed together with the device identity), so the Worker can't inject it on
 * the wire. Instead the UI accepts `#token=...` in the page URL, saves it to
 * sessionStorage and strips it from the address bar. sessionStorage is
 * per-tab, which is why users are otherwise asked for the token in every new
 * tab.
 *
 * The Worker serves a same-origin script (the gateway's CSP only allows
 * `script-src 'self'`) that adds `#token=` when this tab has no stored token.
 * It runs before the UI's module scripts. The script is only reachable behind
 * Cloudflare Access.
 */

export const GATEWAY_TOKEN_SCRIPT_PATH = '/_moltworker/gateway-token.js';

/** Control UI sessionStorage key prefix for stored gateway tokens */
const TOKEN_STORAGE_PREFIX = 'openclaw.control.token.v1:';

/**
 * Build the script that hands the gateway token to the Control UI.
 *
 * Skips tabs that already have the token stored, because a `#token=` in the
 * URL also resets the UI to the main session.
 */
export function buildGatewayTokenScript(token: string): string {
  // JSON.stringify quotes the value; escape `<` so it can't close a script tag
  const tokenLiteral = JSON.stringify(token).replace(/</g, '\\u003c');
  const prefixLiteral = JSON.stringify(TOKEN_STORAGE_PREFIX);
  return `(function () {
  var token = ${tokenLiteral};
  try {
    var store = window.sessionStorage;
    for (var i = 0; i < store.length; i++) {
      var key = store.key(i);
      if (key && key.indexOf(${prefixLiteral}) === 0 && store.getItem(key) === token) return;
    }
  } catch (e) {}
  var params = new URLSearchParams(location.hash.slice(1));
  if (params.get('token') === token) return;
  params.set('token', token);
  history.replaceState(history.state, '', location.pathname + location.search + '#' + params.toString());
})();
`;
}

/**
 * Insert the token script as the first element of <head>, so it runs before
 * the Control UI's (deferred) module scripts.
 */
export function injectGatewayTokenScript(html: string): string {
  const tag = `<script src="${GATEWAY_TOKEN_SCRIPT_PATH}"></script>`;
  const headMatch = /<head[^>]*>/i.exec(html);
  if (!headMatch) return tag + html;
  const insertAt = headMatch.index + headMatch[0].length;
  return html.slice(0, insertAt) + tag + html.slice(insertAt);
}
