const { buildAuthorizationUrl, completeLogin } = require('../services/shareFileOAuthSetupService');
const { formatError } = require('../utils/formatError');
const { renderOAuthResultPage, escapeHtml } = require('../utils/oauthPageRenderer');

// @desc    Redirects the browser straight to ShareFile's own login page -
//          the entry point of the link sent to whoever owns the ShareFile
//          account (see services/shareFileOAuthSetupService.js's top
//          comment for why this replaces the old password-grant flow).
//          Gated by the same shared setup-secret as the Microsoft flow.
// @route   GET /oauth/sharefile/start?token=...
const startShareFileLogin = async (req, res) => {
  const providedToken = req.query.token;
  const expectedToken = process.env.OAUTH_SETUP_SECRET;

  if (!expectedToken) {
    return renderOAuthResultPage(res, 500, {
      tone: 'error',
      heading: 'Not configured',
      message: 'OAUTH_SETUP_SECRET is not set on the server - this login link cannot be used yet.',
    });
  }
  if (!providedToken || providedToken !== expectedToken) {
    return renderOAuthResultPage(res, 401, {
      tone: 'error',
      heading: 'Invalid or missing link',
      message: 'This login link is missing its access token, or the token is wrong. Ask for a fresh link.',
    });
  }

  try {
    const authUrl = buildAuthorizationUrl();
    res.redirect(authUrl);
  } catch (error) {
    console.error('startShareFileLogin ERROR:', formatError(error));
    renderOAuthResultPage(res, 500, {
      tone: 'error',
      heading: 'Could not start login',
      message: 'Something went wrong preparing the ShareFile login page. Please tell the team and try again later.',
    });
  }
};

// @desc    Where ShareFile redirects back to after login. Exchanges the
//          authorization code for a refresh token and saves it to MongoDB
//          (shared by the web service AND both cron jobs - no per-service
//          env-var copying needed).
// @route   GET /oauth/sharefile/callback
const shareFileLoginCallback = async (req, res) => {
  const { code, error, error_description: errorDescription } = req.query;

  if (error) {
    console.error(`shareFileLoginCallback: login failed - ${error}: ${errorDescription}`);
    return renderOAuthResultPage(res, 400, {
      tone: 'error',
      heading: 'Login was not completed',
      message: errorDescription
        ? escapeHtml(errorDescription)
        : 'The login was cancelled or denied. You can close this tab and try again.',
    });
  }

  if (!code) {
    return renderOAuthResultPage(res, 400, {
      tone: 'error',
      heading: 'Missing login information',
      message: 'No authorization code was received. You can close this tab and try the login link again.',
    });
  }

  try {
    await completeLogin(code);
    renderOAuthResultPage(res, 200, {
      tone: 'ok',
      heading: 'Login successful',
      message: 'Your ShareFile account is now connected. You can close this tab.',
    });
  } catch (err) {
    console.error('shareFileLoginCallback ERROR:', formatError(err));
    renderOAuthResultPage(res, 500, {
      tone: 'error',
      heading: 'Login could not be completed',
      message: 'Something went wrong finishing the login. Please tell the team and try again.',
    });
  }
};

module.exports = { startShareFileLogin, shareFileLoginCallback };
