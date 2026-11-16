import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const FILES = [];
const INCLUDE_DIRS = ['bridge/src', 'extension/src', 'shared/src', 'scripts', 'specs'];
const INCLUDE_FILES = ['package.json', 'bridge/package.json', 'extension/package.json', 'shared/package.json', 'package-lock.json'];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', '.pw-profile'].includes(entry.name)) continue;
      walk(p);
    } else if (entry.isFile()) {
      FILES.push(p);
    }
  }
}
for (const d of INCLUDE_DIRS) walk(d);
for (const f of INCLUDE_FILES) if (fs.existsSync(f)) FILES.push(f);

const REPLACEMENTS = [
  ['browseragent', 'broagentai'],
  ['BrowserAgent', 'BroAgentAI'],
  ['BROWSERAGENT', 'BROAGENTAI'],
];

const changed = [];
let count = 0;
for (const f of FILES) {
  if (f.endsWith('rename-browseragent.mjs')) continue;
  let text = fs.readFileSync(f, 'utf8');
  const before = text;
  for (const [from, to] of REPLACEMENTS) {
    text = text.split(from).join(to);
  }
  if (text !== before) {
    fs.writeFileSync(f, text);
    changed.push(f);
    count += 1;
  }
}
console.log('Changed files: ' + count);
for (const f of changed) console.log('  ' + f);
