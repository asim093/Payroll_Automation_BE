// Joins a Settings root-path (e.g. "WOTC") with a client's own manually-typed
// relative path (e.g. "Acme Corp/Payroll Files") into one clean path string,
// e.g. "WOTC/Acme Corp/Payroll Files". Replaces the old {Client Name}
// placeholder-substitution scheme (see git history / utils/pathTemplate.js)
// now that clients type their full remaining path themselves instead of
// filling in one fixed slot.
//
// Handles the usual leading/trailing-slash and blank-segment edge cases so
// callers don't have to: "WOTC/" + "/Acme Corp" -> "WOTC/Acme Corp", not
// "WOTC//Acme Corp" or "WOTC/Acme Corp/" etc.
const joinFolderPath = (rootPath, clientPath) => {
  const segments = [rootPath, clientPath]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .flatMap((part) => part.split('/'))
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.join('/');
};

module.exports = { joinFolderPath };
