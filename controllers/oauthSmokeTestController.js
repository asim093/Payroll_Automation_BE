const { runAllSmokeTests } = require('../services/oauthSmokeTestService');
const { renderOAuthResultPage, renderSmokeTestPage } = require('../utils/oauthPageRenderer');
const { formatError } = require('../utils/formatError');

// @desc    Runs a live, real (not mocked) read/write check against
//          Microsoft/Outlook, Dropbox, and ShareFile all at once, using
//          whatever refresh token is CURRENTLY stored for each provider.
//          Meant to be opened right after a hosted login (see
//          services/oauthSmokeTestService.js's top comment for why a
//          token existing isn't proof it actually works) - a single link
//          to open during a live call instead of three separate manual
//          checks.
// @route   GET /oauth/smoke-test?token=...
const runOAuthSmokeTest = async (req, res) => {
  const providedToken = req.query.token;
  const expectedToken = process.env.OAUTH_SETUP_SECRET;

  if (!expectedToken) {
    return renderOAuthResultPage(res, 500, {
      tone: 'error',
      heading: 'Not configured',
      message: 'OAUTH_SETUP_SECRET is not set on the server - this link cannot be used yet.',
    });
  }
  if (!providedToken || providedToken !== expectedToken) {
    return renderOAuthResultPage(res, 401, {
      tone: 'error',
      heading: 'Invalid or missing link',
      message: 'This link is missing its access token, or the token is wrong.',
    });
  }

  try {
    const results = await runAllSmokeTests();
    renderSmokeTestPage(res, results);
  } catch (error) {
    console.error('runOAuthSmokeTest ERROR:', formatError(error));
    renderOAuthResultPage(res, 500, {
      tone: 'error',
      heading: 'Smoke test could not run',
      message: 'Something went wrong running the checks. Please tell the team and try again.',
    });
  }
};

module.exports = { runOAuthSmokeTest };
