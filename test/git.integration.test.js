"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { getBlameAnnotations, getChangedFiles, getConflictFiles, getFileContentAtRevision, getFileDiff } = require("../src/git");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "beautiful-git-"));

function git(args) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

async function run() {
  try {
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(root, "conflict.txt"), "base\n");
    git(["add", "conflict.txt"]);
    git(["commit", "-m", "base"]);
    git(["branch", "-M", "main"]);
    const blame = await getBlameAnnotations(root, path.join(root, "conflict.txt"));
    assert.strictEqual(blame.length, 1);
    assert.strictEqual(blame[0].author, "Test User");
    assert(blame[0].authorTime > 0);
    assert.strictEqual(blame[0].summary, "base");
    assert.strictEqual(await getFileContentAtRevision(root, "conflict.txt", "HEAD"), "base\n");
    git(["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(root, "conflict.txt"), "feature\n");
    fs.writeFileSync(path.join(root, "resolved-but-unstaged.txt"), "feature\n");
    git(["add", "resolved-but-unstaged.txt"]);
    git(["commit", "-am", "feature"]);
    git(["checkout", "main"]);
    fs.writeFileSync(path.join(root, "conflict.txt"), "main\n");
    fs.writeFileSync(path.join(root, "resolved-but-unstaged.txt"), "main\n");
    git(["add", "resolved-but-unstaged.txt"]);
    git(["commit", "-am", "main"]);

    try {
      git(["merge", "feature"]);
    } catch {
      // Expected: merge creates a conflict.
    }

    fs.writeFileSync(path.join(root, "notes.txt"), "new\n");
    fs.writeFileSync(path.join(root, "resolved-but-unstaged.txt"), "manual resolution without markers\n");
    const changes = await getChangedFiles(root, root);
    const conflicts = await getConflictFiles(root, root);

    assert(changes.some((file) => file.path === "conflict.txt" && file.isConflict));
    assert(changes.some((file) => file.path === "resolved-but-unstaged.txt" && file.isConflict));
    assert(changes.some((file) => file.path === "notes.txt" && file.label === "Unversioned"));
    const notesDiff = await getFileDiff(root, "notes.txt", { status: "??" });
    assert.strictEqual(notesDiff.blocks[0].kind, "added");
    assert.strictEqual(notesDiff.stats.added, 1);
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(conflicts[0].path, "conflict.txt");
    assert.strictEqual(conflicts[0].conflictCount, 1);
    console.log("git integration tests passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
