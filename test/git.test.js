"use strict";

const assert = require("assert");
const { parsePorcelainStatus } = require("../src/git");

const entries = parsePorcelainStatus(" M src/app.js\0A  src/new.js\0?? notes.txt\0R  src/new-name.js\0src/old-name.js\0UU conflict.txt\0");

assert.deepStrictEqual(entries.map((entry) => entry.path), [
  "src/app.js",
  "src/new.js",
  "notes.txt",
  "src/new-name.js",
  "conflict.txt"
]);
assert.strictEqual(entries[0].label, "Modified");
assert.strictEqual(entries[1].label, "Added");
assert.strictEqual(entries[2].label, "Unversioned");
assert.strictEqual(entries[3].oldPath, "src/old-name.js");
assert.strictEqual(entries[4].isConflict, true);

console.log("git tests passed");
