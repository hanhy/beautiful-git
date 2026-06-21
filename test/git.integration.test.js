"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { getChangedFiles, getConflictFiles } = require("../src/git");

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
    git(["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(root, "conflict.txt"), "feature\n");
    git(["commit", "-am", "feature"]);
    git(["checkout", "main"]);
    fs.writeFileSync(path.join(root, "conflict.txt"), "main\n");
    git(["commit", "-am", "main"]);

    try {
      git(["merge", "feature"]);
    } catch {
      // Expected: merge creates a conflict.
    }

    fs.writeFileSync(path.join(root, "notes.txt"), "new\n");
    const changes = await getChangedFiles(root, root);
    const conflicts = await getConflictFiles(root, root);

    assert(changes.some((file) => file.path === "conflict.txt" && file.isConflict));
    assert(changes.some((file) => file.path === "notes.txt" && file.label === "Unversioned"));
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
