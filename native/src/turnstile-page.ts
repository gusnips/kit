/**
 * The page a WebView runs to host one Turnstile widget, and the messages it sends back.
 *
 * It is a string the app never edits: the site key, action, language and theme go in as JSON, and a
 * nonce ties every message to the round that made it. The script says `self` where a browser page
 * would say `window`, because `bun run purity` reads this file as phone code, and a phone has no
 * `window`. Inside the WebView `self` is the window.
 */
import { TURNSTILE_ORIGIN } from "@gusnips/react/turnstile-machine";

/** Changes when the page and `parseTurnstileMessage` stop agreeing on what a message means. */
export const MESSAGE_VERSION = 1;

/**
 * What the page can tell the app besides a token. Each name is the method of the same name on the
 * machine's round, except `rendered`, so the bridge forwards a message without a table.
 */
export const PAGE_SIGNALS = [
  "rendered",
  "expired",
  "failed",
  "unavailable",
  "unsupported",
  "interactive",
  "afterInteractive",
] as const;

export type PageSignal = (typeof PAGE_SIGNALS)[number];

export interface PageConfig {
  siteKey: string;
  action: string;
  language: string;
  theme: "auto" | "light" | "dark";
  nonce: string;
}

// The three origins Cloudflare documents for Turnstile, and nothing else. The inline script needs
// 'unsafe-inline' because the page is a string with no address to host a hashed file on.
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${TURNSTILE_ORIGIN}`,
  `frame-src ${TURNSTILE_ORIGIN}`,
  `connect-src ${TURNSTILE_ORIGIN}`,
  `img-src ${TURNSTILE_ORIGIN} data:`,
  "style-src 'unsafe-inline'",
].join("; ");

export function turnstilePage(config: PageConfig): string {
  // Each `<` is written as the six characters \u003c, so no value can close the script tag.
  const data = JSON.stringify(config).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">
<style>html,body{margin:0;padding:0;background:transparent}</style>
</head>
<body>
<div id="check"></div>
<script>
(function (config) {
  var post = function (type, token) {
    self.ReactNativeWebView.postMessage(
      JSON.stringify({ v: ${MESSAGE_VERSION}, nonce: config.nonce, type: type, token: token })
    );
  };
  var script = self.document.createElement("script");
  script.src = "${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.onerror = function () { post("unavailable"); };
  script.onload = function () {
    if (!self.turnstile) return post("unavailable");
    try {
      var id = self.turnstile.render("#check", {
        sitekey: config.siteKey,
        action: config.action,
        language: config.language,
        theme: config.theme,
        appearance: "interaction-only",
        size: "flexible",
        "response-field": false,
        "refresh-expired": "never",
        retry: "never",
        callback: function (token) { post("token", token); },
        "expired-callback": function () { post("expired"); },
        "error-callback": function () { post("failed"); return true; },
        "timeout-callback": function () { post("failed"); },
        "unsupported-callback": function () { post("unsupported"); },
        "before-interactive-callback": function () { post("interactive"); },
        "after-interactive-callback": function () { post("afterInteractive"); }
      });
      post(id ? "rendered" : "failed");
    } catch (error) {
      post("failed");
    }
  };
  self.document.head.appendChild(script);
})(${data});
</script>
</body>
</html>`;
}
