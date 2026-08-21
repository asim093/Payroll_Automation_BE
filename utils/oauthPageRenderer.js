// Shared HTML "result page" renderer for the web-hosted OAuth login flows
// (see controllers/oauthController.js for Microsoft, and
// controllers/shareFileOAuthController.js for ShareFile) - both land the
// browser on a plain result page after login (success or failure) instead
// of a raw JSON API response, since the person landing here is very likely
// someone outside the team (the client, logging into their own mailbox or
// ShareFile account), not a developer.
//
// These /callback routes are unauthenticated (the provider hits them with
// query params after a real login, but anyone could also hit them directly
// with crafted query params, e.g. an error description) - escape anything
// dynamic before it's interpolated into `message`. `heading` is always a
// literal string from the caller, escaped here regardless as cheap
// insurance.
const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));

const renderOAuthResultPage = (res, status, { heading, message, tone = 'ok' }) => {
  const color = tone === 'ok' ? '#0f7a45' : '#ab2323';
  res.status(status).type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Payroll Automation - Login</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: #f3f5fa; color: #16192b;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
  .card { background: #fff; border: 1px solid #e1e5ee; border-radius: 10px; padding: 32px; max-width: 420px;
          box-shadow: 0 6px 20px rgba(19,27,58,0.08); text-align: center; }
  h1 { font-size: 18px; color: ${color}; margin: 0 0 12px; }
  p { font-size: 14px; color: #676f89; line-height: 1.5; margin: 0; }
</style></head>
<body><div class="card"><h1>${escapeHtml(heading)}</h1><p>${message}</p></div></body></html>`);
};

module.exports = { renderOAuthResultPage, escapeHtml };
