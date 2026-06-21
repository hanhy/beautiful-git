"use strict";

const assert = require("assert");
const { parseBlamePorcelain, parsePorcelainStatus } = require("../src/git");

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

const blame = parseBlamePorcelain([
  "0123456789012345678901234567890123456789 1 1 1",
  "author Ada Lovelace",
  "author-mail <ada@example.com>",
  "author-time 1780000000",
  "summary Add repository routing",
  "\tpackage main",
  "abcdefabcdefabcdefabcdefabcdefabcdefabcd 2 2 1",
  "author Grace Hopper",
  "author-time 1781000000",
  "summary Fix handler registration",
  "\tfunc main() {}",
  ""
].join("\n"));

assert.strictEqual(blame.length, 2);
assert.strictEqual(blame[0].line, 1);
assert.strictEqual(blame[0].author, "Ada Lovelace");
assert.strictEqual(blame[0].authorTime, 1780000000);
assert.strictEqual(blame[0].summary, "Add repository routing");
assert.strictEqual(blame[1].author, "Grace Hopper");
assert.strictEqual(blame[1].authorTime, 1781000000);

console.log("git tests passed");
