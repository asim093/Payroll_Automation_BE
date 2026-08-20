const { buildAuthorizationUrl, completeLogin } = require('../services/microsoftOAuthSetupService');
const { formatError } = require('../utils/formatError');

// /callback is unauthenticated (Microsoft hits it with query params after a
// real login, but anyone could also hit it directly with crafted query
// params - e.g. `error_description`) - escape anything that ever lands in
// `message` before it's interpolated into HTML, since some of it (the OAuth
// error description, the signed-in account name) originates outside this
// server's control.
const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));

// Minimal styling so this reads as a real page, not a bare error dump -
// the person landing here is very likely someone OUTSIDE the team (the
// client, logging in on their own mailbox), not a developer. `message` may
// contain a few pre-approved <strong> tags (see callers) - everything else
// passed into it must already be escaped by the caller.
const renderPage = (res, status, { heading, message, tone = 'ok' }) => {
  const color = tone === 'ok' ? '#0f7a45' : '#ab2323';
  res.status(status).type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Payroll Automation - Mailbox Login</title>
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

// @desc    Redirects the browser straight to Microsoft's login page - the
//          entry point of the link sent to whoever needs to log in (see
//          services/microsoftOAuthSetupService.js's top comment for why
//          this exists instead of the local getRefreshToken.js script).
//          Gated by a shared setup-secret so this isn't a fully public
//          "anyone can (re-)authorize our mailbox integration" link.
// @route   GET /oauth/microsoft/start?token=...
const startMicrosoftLogin = async (req, res) => {
  const providedToken = req.query.token;
  const expectedToken = process.env.OAUTH_SETUP_SECRET;

  if (!expectedToken) {
    return renderPage(res, 500, {
      tone: 'error',
      heading: 'Not configured',
      message: 'OAUTH_SETUP_SECRET is not set on the server - this login link cannot be used yet.',
    });
  }
  if (!providedToken || providedToken !== expectedToken) {
    return renderPage(res, 401, {
      tone: 'error',
      heading: 'Invalid or missing link',
      message: 'This login link is missing its access token, or the token is wrong. Ask for a fresh link.',
    });
  }

  try {
    const authUrl = await buildAuthorizationUrl();
    res.redirect(authUrl);
  } catch (error) {
    console.error('startMicrosoftLogin ERROR:', formatError(error));
    renderPage(res, 500, {
      tone: 'error',
      heading: 'Could not start login',
      message: 'Something went wrong preparing the Microsoft login page. Please tell the team and try again later.',
    });
  }
};

// @desc    Where Microsoft redirects back to after login. Exchanges the
//          authorization code for a refresh token and saves it to MongoDB
//          (shared by the web service AND both cron jobs - no per-service
//          env-var copying needed).
// @route   GET /oauth/microsoft/callback
const microsoftLoginCallback = async (req, res) => {
  const { code, error, error_description: errorDescription } = req.query;

  if (error) {
    console.error(`microsoftLoginCallback: login failed - ${error}: ${errorDescription}`);
    return renderPage(res, 400, {
      tone: 'error',
      heading: 'Login was not completed',
      message: errorDescription
        ? escapeHtml(errorDescription)
        : 'The login was cancelled or denied. You can close this tab and try again.',
    });
  }

  if (!code) {
    return renderPage(res, 400, {
      tone: 'error',
      heading: 'Missing login information',
      message: 'No authorization code was received. You can close this tab and try the login link again.',
    });
  }

  try {
    const { loggedInAs } = await completeLogin(code);
    renderPage(res, 200, {
      tone: 'ok',
      heading: 'Login successful',
      message: `${loggedInAs ? `Signed in as <strong>${escapeHtml(loggedInAs)}</strong>. ` : ''}This mailbox is now connected. You can close this tab.`,
    });
  } catch (err) {
    console.error('microsoftLoginCallback ERROR:', formatError(err));
    renderPage(res, 500, {
      tone: 'error',
      heading: 'Login could not be completed',
      message: 'Something went wrong finishing the login. Please tell the team and try again.',
    });
  }
};

module.exports = { startMicrosoftLogin, microsoftLoginCallback };
