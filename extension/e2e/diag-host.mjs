// diag-host.mjs - spawn the REAL bridge host, send a system.ping frame, print response + stderr.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = path.join(root, 'bridge', 'dist', 'index.js');
const child = spawn(process.execPath, [entry], { cwd: root });
let out = Buffer.alloc(0); let err = '';
child.stdout.on('data', (c) => { out = Buffer.concat([out, c]); tryParse(); });
child.stderr.on('data', (c) => { err += c.toString(); });
function tryParse() {
  while (out.length >= 4) {
    const n = out.readUInt32LE(0);
    if (out.length < 4 + n) break;
    const body = out.subarray(4, 4 + n).toString();
    out = out.subarray(4 + n);
    console.log('FRAME', body);
  }
}
child.on('exit', (code) => { console.log('EXIT', code); console.log('STDERR\n' + err.slice(-2000)); });
const req = { v: 1, id: 1, method: 'system.ping', params: {} };
const body = Buffer.from(JSON.stringify(req));
const frame = Buffer.alloc(4 + body.length);
frame.writeUInt32LE(body.length, 0);
body.copy(frame, 4);
child.stdin.write(frame);
child.stdin.end();
setTimeout(() => child.kill(), 8000);
