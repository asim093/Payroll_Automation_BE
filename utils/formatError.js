// When Node's fetch() itself throws (network-level failure — DNS, connection
// reset, timeout, etc), the top-level error.message is just the generic
// "fetch failed" — the actual reason (ECONNRESET, ENOTFOUND, timeout, ...)
// is hidden in error.cause. This surfaces both so logs are actually useful
// instead of just saying "fetch failed" with no further detail.
const formatError = (error) => {
  if (error?.cause) {
    const causeMessage = error.cause.message || error.cause.code || String(error.cause);
    return `${error.message} (cause: ${causeMessage})`;
  }
  return error?.message || String(error);
};

module.exports = { formatError };
