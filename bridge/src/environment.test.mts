import { test } from "node:test";
import assert from "node:assert/strict";

import { discoverEnvironment, refreshEnvironment } from "./environment.ts";

test("discoverEnvironment reports shape without exposing PATH values or credentials", () => {
  const info = discoverEnvironment({
    platform: "linux",
    env: { PATH: "/opt/bin:relative:/missing", API_KEY: "super-secret" },
    exists: (path) => path === "/opt/bin",
  });

  assert.equal(info.pathSource, "PATH");
  assert.equal(info.pathOrigin, "inherited");
  assert.equal(info.pathEntryCount, 3);
  assert.deepEqual(info.pathEntryKinds, { absolute: 2, relative: 1, missing: 2 });
  assert.equal(info.credentialKeysDetected, 1);
  assert.equal(info.credentialsExposed, false);
  assert.equal(JSON.stringify(info).includes("super-secret"), false);
  assert.equal(JSON.stringify(info).includes("/opt/bin"), false);
});

test("discoverEnvironment caches and refreshEnvironment rebuilds the snapshot", () => {
  const source = process.platform === "win32" && typeof process.env.Path === "string" ? "Path" : "PATH";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const original = process.env[source];
  const had = source in process.env;

  try {
    process.env[source] = ["/one", "/two"].join(delimiter);
    const first = refreshEnvironment();
    assert.equal(first.pathEntryCount, 2);
    assert.deepEqual(discoverEnvironment(), first);

    process.env[source] = ["/one", "/two", "/three"].join(delimiter);
    assert.equal(refreshEnvironment().pathEntryCount, 3);
  } finally {
    if (had) process.env[source] = original;
    else delete process.env[source];
    refreshEnvironment();
  }
});
