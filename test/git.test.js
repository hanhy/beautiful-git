"use strict";

const assert = require("assert");
const { getPushArgs, parseBlamePorcelain, parsePorcelainStatus, parseUnifiedDiff } = require("../src/git");

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

const parsedDiff = parseUnifiedDiff([
  "diff --git a/src/app.js b/src/app.js",
  "--- a/src/app.js",
  "+++ b/src/app.js",
  "@@ -1,7 +1,8 @@",
  " const a = 1;",
  "-const name = 'old';",
  "+const name = 'new';",
  " const keep = true;",
  "+const added = true;",
  " const middle = 2;",
  "-const removed = false;",
  " const z = 3;",
  ""
].join("\n"));

assert.strictEqual(parsedDiff.oldTitle, "src/app.js");
assert.strictEqual(parsedDiff.newTitle, "src/app.js");
assert.deepStrictEqual(parsedDiff.blocks.map((block) => block.kind), ["changed", "added", "deleted"]);
assert.strictEqual(parsedDiff.stats.modified, 1);
assert.strictEqual(parsedDiff.stats.added, 1);
assert.strictEqual(parsedDiff.stats.deleted, 1);
assert(parsedDiff.rows.some((row) => row.kind === "changed" && row.oldText.includes("old") && row.newText.includes("new")));
assert(parsedDiff.rows.some((row) => row.kind === "added" && row.newText.includes("added")));
assert(parsedDiff.rows.some((row) => row.kind === "deleted" && row.oldText.includes("removed")));

assert.deepStrictEqual(getPushArgs("main", true), ["push"]);
assert.deepStrictEqual(getPushArgs("hhy/test-plugin_20260622", false), [
  "push",
  "--set-upstream",
  "origin",
  "hhy/test-plugin_20260622"
]);
assert.deepStrictEqual(getPushArgs("HEAD", false), ["push"]);

console.log("git tests passed");
