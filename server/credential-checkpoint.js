const credentialCheckpoints = new WeakMap();

/** Keep rotated credentials out of enumerable Error properties and process logs. */
export function attachCredentialCheckpoint(error, secret) {
  if (error instanceof Error && secret && typeof secret === 'object') {
    credentialCheckpoints.set(error, secret);
  }
  return error;
}

export function takeCredentialCheckpoint(error) {
  if (!(error instanceof Error)) return undefined;
  const secret = credentialCheckpoints.get(error);
  credentialCheckpoints.delete(error);
  return secret;
}

export function getCredentialCheckpoint(error) {
  return error instanceof Error ? credentialCheckpoints.get(error) : undefined;
}
