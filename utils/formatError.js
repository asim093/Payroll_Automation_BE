const formatError = (error) => {
  if (error?.cause) {
    const causeMessage = error.cause.message || error.cause.code || String(error.cause);
    return `${error.message} (cause: ${causeMessage})`;
  }
  return error?.message || String(error);
};

module.exports = { formatError };
