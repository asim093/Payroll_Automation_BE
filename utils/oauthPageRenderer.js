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

// PHASE-UI-17 — live smoke-test summary page (see oauthSmokeTestService.js).
// One row per provider, big clear PASS/FAIL, meant to be glanced at during
// a live call - not a JSON blob someone has to parse mid-meeting.
const renderSmokeTestPage = (res, results) => {
  const rows = Object.values(results)
    .map((result) => {
      const color = result.pass ? '#0f7a45' : '#ab2323';
      const badge = result.pass ? 'PASS' : 'FAIL';
      const lines = [];
      if (result.detail) lines.push(`<p class="detail">${escapeHtml(result.detail)}</p>`);
      if (result.error) lines.push(`<p class="error">${escapeHtml(result.error)}</p>`);
      if (result.hint) lines.push(`<p class="hint">💡 ${escapeHtml(result.hint)}</p>`);
      if (result.writeTest) {
        const wt = result.writeTest;
        const wtColor = wt.pass ? '#0f7a45' : '#ab2323';
        const wtBadge = wt.pass ? 'PASS' : 'FAIL';
        lines.push(
          `<p class="subtest">Write-test (upload+delete): <strong style="color:${wtColor}">${wtBadge}</strong>${
            wt.error ? ` — ${escapeHtml(wt.error)}` : ''
          }${wt.warning ? ` — ${escapeHtml(wt.warning)}` : ''}</p>`
        );
      }
      return `<div class="row">
        <div class="row-head"><span class="badge" style="background:${color}">${badge}</span><h2>${escapeHtml(result.label)}</h2></div>
        ${lines.join('')}
      </div>`;
    })
    .join('');

  const allPass = Object.values(results).every((r) => r.pass);
  const overallColor = allPass ? '#0f7a45' : '#ab2323';
  const overallText = allPass ? 'All 3 services verified working' : 'Some services need attention';

  res.status(200).type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Payroll Automation - OAuth Smoke Test</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: #f3f5fa; color: #16192b;
         display: flex; align-items: flex-start; justify-content: center; min-height: 100vh; margin: 0; padding: 32px 16px; }
  .card { background: #fff; border: 1px solid #e1e5ee; border-radius: 10px; padding: 28px; max-width: 560px; width: 100%;
          box-shadow: 0 6px 20px rgba(19,27,58,0.08); }
  h1 { font-size: 18px; color: ${overallColor}; margin: 0 0 20px; }
  .row { border-top: 1px solid #eef0f6; padding: 16px 0; }
  .row:first-of-type { border-top: none; padding-top: 0; }
  .row-head { display: flex; align-items: center; gap: 10px; }
  .badge { color: #fff; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; padding: 3px 10px; border-radius: 999px; }
  h2 { font-size: 15px; margin: 0; color: #16192b; }
  p { font-size: 13px; color: #676f89; line-height: 1.5; margin: 6px 0 0; }
  p.error { color: #ab2323; }
  p.hint { color: #8a5a00; }
  p.subtest { color: #454c63; }
  .note { margin-top: 20px; font-size: 12px; color: #9aa1b5; }
</style></head>
<body><div class="card">
  <h1>${escapeHtml(overallText)}</h1>
  ${rows}
  <p class="note">Reload this page (same URL) to re-run all 3 tests.</p>
</div></body></html>`);
};

module.exports = { renderOAuthResultPage, renderSmokeTestPage, escapeHtml };
