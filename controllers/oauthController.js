const { buildAuthorizationUrl, completeLogin } = require('../services/microsoftOAuthSetupService');
const { formatError } = require('../utils/formatError');
const { renderOAuthResultPage, escapeHtml } = require('../utils/oauthPageRenderer');


const startMicrosoftLogin = async (req, res) => {
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
    const authUrl = await buildAuthorizationUrl();
    res.redirect(authUrl);
  } catch (error) {
    console.error('startMicrosoftLogin ERROR:', formatError(error));
    renderOAuthResultPage(res, 500, {
      tone: 'error',
      heading: 'Could not start login',
      message: 'Something went wrong preparing the Microsoft login page. Please tell the team and try again later.',
    });
  }
};


const microsoftLoginCallback = async (req, res) => {
  const { code, error, error_description: errorDescription } = req.query;

  if (error) {
    console.error(`microsoftLoginCallback: login failed - ${error}: ${errorDescription}`);
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
    const { loggedInAs } = await completeLogin(code);
    renderOAuthResultPage(res, 200, {
      tone: 'ok',
      heading: 'Login successful',
      message: `${loggedInAs ? `Signed in as <strong>${escapeHtml(loggedInAs)}</strong>. ` : ''}This mailbox is now connected. You can close this tab.`,
    });
  } catch (err) {
    console.error('microsoftLoginCallback ERROR:', formatError(err));
    renderOAuthResultPage(res, 500, {
      tone: 'error',
      heading: 'Login could not be completed',
      message: 'Something went wrong finishing the login. Please tell the team and try again.',
    });
  }
};

module.exports = { startMicrosoftLogin, microsoftLoginCallback };
