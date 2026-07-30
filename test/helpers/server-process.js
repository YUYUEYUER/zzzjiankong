import { spawn } from 'node:child_process';
import { once } from 'node:events';

const START_TIMEOUT_MS = 30_000;
const LOG_LIMIT = 64 * 1024;

function appendLog(current, chunk) {
  return `${current}${chunk}`.slice(-LOG_LIMIT);
}

export async function startTestServer(environment) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs = appendLog(logs, chunk); });
  child.stderr.on('data', (chunk) => { logs = appendLog(logs, chunk); });

  let ready;
  try {
    ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`test server readiness timed out\n${logs}`)), START_TIMEOUT_MS);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('error', onError);
        child.off('exit', onExit);
      };
      const onMessage = (message) => {
        if (message?.type !== 'ready' || !Number.isInteger(message.port)) return;
        cleanup();
        resolve(message);
      };
      const onError = (error) => {
        cleanup();
        reject(new Error(`test server failed to start: ${error.message}\n${logs}`));
      };
      const onExit = (code) => {
        cleanup();
        reject(new Error(`test server exited with ${code}\n${logs}`));
      };
      child.on('message', onMessage);
      child.once('error', onError);
      child.once('exit', onExit);
    });
  } catch (error) {
    await stopTestServer(child);
    throw error;
  }

  return { child, baseUrl: `http://127.0.0.1:${ready.port}`, logs: () => logs };
}

export async function stopTestServer(child) {
  if (child.exitCode != null || child.signalCode) return;
  const exited = once(child, 'exit');
  child.kill();
  const forced = setTimeout(() => child.kill('SIGKILL'), 5000);
  forced.unref?.();
  await exited;
  clearTimeout(forced);
}
