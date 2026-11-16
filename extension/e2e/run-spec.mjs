// run-spec.mjs - launch sidepanel.spec.mjs detached, log to files, write run.done marker.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const spec = path.join(root, 'e2e', 'sidepanel.spec.mjs');
const outFd = fs.openSync(path.join(root, 'e2e', 'run.out.log'), 'w');
const errFd = fs.openSync(path.join(root, 'e2e', 'run.err.log'), 'w');

const child = spawn(process.execPath, [spec], {
  env: { ...process.env, PLAYWRIGHT_CHROMIUM_CHANNEL: 'chromium' },
  cwd: root,
  detached: true,
  stdio: ['ignore', outFd, errFd],
});
child.unref();
child.on('exit', (code) => {
  fs.writeFileSync(path.join(root, 'e2e', 'run.done'), 'exit=' + code + '\n');
  try { fs.closeSync(outFd); } catch {}
  try { fs.closeSync(errFd); } catch {}
});
console.log('RUNNER_PID=' + child.pid);
