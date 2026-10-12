// smoke-check.js — Backend boot verification. RUN BEFORE EVERY RAILWAY PUSH.
//
// What it does:
//   Phase 1 — requires every .js module under src/ (catches syntax errors,
//              missing files, broken require() chains). Names the broken file.
//   Phase 2 — boots the REAL app (src/index.js) with:
//               - DB mocked (initDb/query stubbed; no connection attempted)
//               - PORT=0 (ephemeral port; never a production port)
//               - dummy JWT_SECRET
//             The server is closed the instant it starts listening.
//
// Safety: never touches production data, never binds a production port,
// completes in seconds. Exit 0 = safe to push. Exit non-zero = DO NOT PUSH.
//
// Usage: node smoke-check.js

const fs = require('fs');
const path = require('path');
const http = require('http');

const SRC = path.join(__dirname, 'src');
const TIMEOUT_MS = 60000;

function fail(msg) {
  console.error('\n[smoke] FAIL: ' + msg);
  console.error('[smoke] DO NOT PUSH — fix the broken import first.\n');
  process.exit(1);
}
function ok(msg) {
  console.log('[smoke] OK: ' + msg);
}

// ----- Setup BEFORE any app import -----
// Dummy secrets: src/index.js exits(1) without JWT_SECRET, and Phase 1 imports it.
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'smoke-check-dummy-secret';
process.env.PORT = '0'; // ephemeral port — never production

// Mock the DB layer BEFORE anything imports it: no connection, no queries.
// (Phase 1 imports src/index.js, which requires ./db at load time.)
const _dbPath = require.resolve('./src/db.js');
require.cache[_dbPath] = {
  id: _dbPath,
  filename: _dbPath,
  loaded: true,
  exports: {
    initDb: async () => console.log('[smoke] initDb mocked (no DB touched)'),
    query: async () => { throw new Error('DB unavailable in smoke check'); },
  },
};

// ---------- Phase 1: import every module ----------
function listJs(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJs(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = listJs(SRC, [])
  .filter((f) => path.basename(f) !== 'index.js') // Phase 2 boots index.js (which pulls every route); excluding it here so a broken route names its own file
  .sort();
console.log(`[smoke] Phase 1: importing ${files.length} modules...`);
for (const f of files) {
  const rel = path.relative(__dirname, f);
  try {
    require(f);
  } catch (e) {
    fail(`broken import in ${rel}\n       ${(e.message || '').split('\n')[0]}`);
  }
}
ok(`all ${files.length} modules import cleanly`);

// ---------- Phase 2: boot the real app ----------
// Intercept listen: the moment the server starts, shut it down and pass.
const origListen = http.Server.prototype.listen;
let booted = false;
http.Server.prototype.listen = function (...args) {
  const cbIdx = args.findIndex((a) => typeof a === 'function');
  const userCb = cbIdx >= 0 ? args[cbIdx] : null;
  const wrapped = (...cbArgs) => {
    booted = true;
    console.log('[smoke] server started on ephemeral port — shutting down');
    this.close(() => {
      ok('app booted through the real startup sequence');
      console.log('\n[smoke] PASS — safe to push.\n');
      process.exit(0);
    });
    // Safety: force exit if close hangs
    setTimeout(() => process.exit(0), 5000).unref();
    if (userCb) userCb(...cbArgs);
  };
  if (cbIdx >= 0) args[cbIdx] = wrapped;
  else args.push(wrapped);
  return origListen.apply(this, args);
};

const timer = setTimeout(() => {
  if (!booted) fail('app did not start listening within 60s');
}, TIMEOUT_MS);
timer.unref();

console.log('[smoke] Phase 2: booting app (DB mocked, ephemeral port)...');
try {
  require('./src/index.js');
} catch (e) {
  fail(`startup threw\n       ${(e.message || '').split('\n')[0]}`);
}
