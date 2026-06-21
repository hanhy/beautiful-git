"use strict";

const assert = require("assert");
const { composeResolvedDocument, parseConflictDocument } = require("../src/conflictParser");

const sample = [
  "alpha",
  "<<<<<<< HEAD",
  "left one",
  "left two",
  "||||||| base",
  "base one",
  "=======",
  "right one",
  ">>>>>>> feature",
  "omega",
  ""
].join("\n");

const parsed = parseConflictDocument(sample);
assert.strictEqual(parsed.conflictCount, 1);
assert.strictEqual(parsed.conflicts[0].leftLabel, "HEAD");
assert.strictEqual(parsed.conflicts[0].baseLabel, "base");
assert.strictEqual(parsed.conflicts[0].rightLabel, "feature");
assert.strictEqual(parsed.conflicts[0].left, "left one\nleft two\n");
assert.strictEqual(parsed.conflicts[0].right, "right one\n");

const resolved = composeResolvedDocument(parsed.segments, { 0: parsed.conflicts[0].right });
assert.strictEqual(resolved, "alpha\nright one\nomega\n");

const crlf = "a\r\n<<<<<<< ours\r\nx\r\n=======\r\ny\r\n>>>>>>> theirs\r\nb\r\n";
const parsedCrlf = parseConflictDocument(crlf);
assert.strictEqual(parsedCrlf.conflictCount, 1);
assert.strictEqual(composeResolvedDocument(parsedCrlf.segments, { 0: parsedCrlf.conflicts[0].left }), "a\r\nx\r\nb\r\n");

console.log("parser tests passed");
