const accountQueues = new Map();

/** Serialize credential-consuming operations for one account within this process. */
export async function withAccountCredentialLock(accountId, task) {
  const key = String(accountId || '');
  if (!key) return task();
  const previous = accountQueues.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  accountQueues.set(key, tail);

  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (accountQueues.get(key) === tail) accountQueues.delete(key);
  }
}
