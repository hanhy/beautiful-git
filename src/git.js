"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 12 }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = new Error((stderr || stdout || error.message).trim());
        wrapped.code = error.code;
        wrapped.args = args;
        reject(wrapped);
        return;
      }
      resolve(stdout);
    });
  });
}

async function findGitRoot(startPath) {
  const cwd = normalizeStartPath(startPath);
  const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  return root.trim();
}

async function getCurrentBranch(root) {
  try {
    const branch = await runGit(root, ["branch", "--show-current"]);
    return branch.trim() || "HEAD";
  } catch {
    return "HEAD";
  }
}

async function getChangedFiles(root, scopePath) {
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
  appendPathspec(args, root, scopePath);
  const output = await runGit(root, args);
  return parsePorcelainStatus(output).map((entry) => ({
    ...entry,
    absolutePath: path.join(root, entry.path)
  }));
}

async function getFileDiff(root, filePath, options = {}) {
  const relativePath = normalizeRelativePath(root, filePath);
  const status = options.status || "";

  if (status === "??") {
    const absolutePath = path.join(root, relativePath);
    const text = await fs.promises.readFile(absolutePath, "utf8");
    return buildUntrackedDiff(relativePath, text);
  }

  const output = await runGit(root, ["diff", "--no-color", "--no-ext-diff", "--unified=1000000", "HEAD", "--", relativePath]);
  const diff = parseUnifiedDiff(output);
  diff.file = relativePath;
  diff.oldPath = options.oldPath || diff.oldPath || "";
  diff.status = status;

  if (isConflictStatus(status)) {
    for (const row of diff.rows) {
      if (row.kind !== "context") {
        row.kind = "conflict";
      }
    }
    for (const block of diff.blocks) {
      block.kind = "conflict";
    }
  }

  return diff;
}

async function getConflictFiles(root, scopePath, readFile) {
  const args = ["diff", "--name-only", "--diff-filter=U", "-z"];
  appendPathspec(args, root, scopePath);
  const output = await runGit(root, args);
  const reader = readFile || ((filePath) => fs.promises.readFile(filePath, "utf8"));
  const files = output.split("\0").filter(Boolean);
  const result = [];
  for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath);
    let conflictCount = 0;
    try {
      const text = await reader(absolutePath);
      conflictCount = (text.match(/^<<<<<<<(?: .*)?$/gmu) || []).length;
    } catch {
      conflictCount = 0;
    }
    if (conflictCount > 0) {
      result.push({
        path: relativePath,
        absolutePath,
        conflictCount
      });
    }
  }
  return result;
}

async function getBlameAnnotations(root, filePath) {
  const relativePath = path.relative(root, filePath);
  const output = await runGit(root, ["blame", "--line-porcelain", "--", relativePath]);
  return parseBlamePorcelain(output);
}

async function commitFiles(root, files, message) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Select at least one file to commit.");
  }
  if (!message || !message.trim()) {
    throw new Error("Commit message is required.");
  }
  await runGit(root, ["add", "--", ...files]);
  return runGit(root, ["commit", "-m", message.trim(), "--", ...files]);
}

async function push(root) {
  return runGit(root, ["push"]);
}

function parseBlamePorcelain(output) {
  const annotations = [];
  const lines = output.split(/\r?\n/u);
  let current = null;

  for (const line of lines) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/u.exec(line);
    if (header) {
      current = {
        hash: header[1],
        line: Number(header[2]),
        author: "",
        authorTime: 0,
        summary: ""
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("author ")) {
      current.author = line.slice("author ".length);
      continue;
    }

    if (line.startsWith("author-time ")) {
      current.authorTime = Number(line.slice("author-time ".length)) || 0;
      continue;
    }

    if (line.startsWith("summary ")) {
      current.summary = line.slice("summary ".length);
      continue;
    }

    if (line.startsWith("\t")) {
      annotations[current.line - 1] = current;
      current = null;
    }
  }

  return annotations.filter(Boolean);
}

function parsePorcelainStatus(output) {
  const entries = [];
  const chunks = output.split("\0");
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (!chunk) {
      continue;
    }
    const status = chunk.slice(0, 2);
    let filePath = chunk.slice(3);
    let oldPath = "";
    if (status.includes("R") || status.includes("C")) {
      oldPath = chunks[i + 1] || "";
      i += 1;
    }
    entries.push({
      path: filePath,
      oldPath,
      status,
      label: statusLabel(status),
      isConflict: isConflictStatus(status)
    });
  }
  return entries;
}

function parseUnifiedDiff(output) {
  const diff = {
    file: "",
    oldPath: "",
    status: "",
    oldTitle: "HEAD",
    newTitle: "Current version",
    rows: [],
    blocks: [],
    stats: {
      added: 0,
      deleted: 0,
      modified: 0
    },
    isBinary: /Binary files /u.test(output)
  };

  const lines = output.split(/\r?\n/u);
  let index = 0;
  let oldLine = 0;
  let newLine = 0;
  let blockId = 0;

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      diff.oldTitle = cleanDiffTitle(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      diff.newTitle = cleanDiffTitle(line.slice(4));
    }
  }

  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(lines[index]);
    if (!header) {
      index += 1;
      continue;
    }

    oldLine = Number(header[1]);
    newLine = Number(header[3]);
    index += 1;

    while (index < lines.length && !lines[index].startsWith("@@ ")) {
      const line = lines[index];
      if (line.startsWith("\\ No newline")) {
        index += 1;
        continue;
      }

      if (line.startsWith(" ")) {
        diff.rows.push({
          oldNumber: oldLine,
          newNumber: newLine,
          oldText: line.slice(1),
          newText: line.slice(1),
          kind: "context",
          blockId: null
        });
        oldLine += 1;
        newLine += 1;
        index += 1;
        continue;
      }

      if (line.startsWith("-") || line.startsWith("+")) {
        const deleted = [];
        const added = [];
        while (index < lines.length && (lines[index].startsWith("-") || lines[index].startsWith("+"))) {
          const changeLine = lines[index];
          if (changeLine.startsWith("-")) {
            deleted.push({
              number: oldLine,
              text: changeLine.slice(1)
            });
            oldLine += 1;
          } else {
            added.push({
              number: newLine,
              text: changeLine.slice(1)
            });
            newLine += 1;
          }
          index += 1;
        }

        appendChangeRows(diff, {
          id: `change-${blockId}`,
          deleted,
          added
        });
        blockId += 1;
        continue;
      }

      index += 1;
    }
  }

  return diff;
}

function appendChangeRows(diff, change) {
  const kind = getChangeKind(change.deleted.length, change.added.length);
  const startRow = diff.rows.length;
  const max = Math.max(change.deleted.length, change.added.length);

  for (let i = 0; i < max; i += 1) {
    const oldEntry = change.deleted[i];
    const newEntry = change.added[i];
    diff.rows.push({
      oldNumber: oldEntry?.number || "",
      newNumber: newEntry?.number || "",
      oldText: oldEntry?.text || "",
      newText: newEntry?.text || "",
      kind,
      blockId: change.id
    });
  }

  diff.blocks.push({
    id: change.id,
    kind,
    startRow,
    rowCount: max,
    deleted: change.deleted.length,
    added: change.added.length
  });

  if (kind === "added") {
    diff.stats.added += change.added.length;
  } else if (kind === "deleted") {
    diff.stats.deleted += change.deleted.length;
  } else {
    diff.stats.modified += max;
  }
}

function getChangeKind(deletedCount, addedCount) {
  if (deletedCount > 0 && addedCount > 0) {
    return "changed";
  }
  if (addedCount > 0) {
    return "added";
  }
  return "deleted";
}

function buildUntrackedDiff(relativePath, text) {
  const lines = splitFileLines(text);
  const rows = lines.map((line, index) => ({
    oldNumber: "",
    newNumber: index + 1,
    oldText: "",
    newText: line,
    kind: "added",
    blockId: "change-0"
  }));

  return {
    file: relativePath,
    oldPath: "",
    status: "??",
    oldTitle: "No base revision",
    newTitle: "Current version",
    rows,
    blocks: rows.length > 0 ? [{
      id: "change-0",
      kind: "added",
      startRow: 0,
      rowCount: rows.length,
      deleted: 0,
      added: rows.length
    }] : [],
    stats: {
      added: rows.length,
      deleted: 0,
      modified: 0
    },
    isBinary: false
  };
}

function splitFileLines(text) {
  if (!text) {
    return [];
  }
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function cleanDiffTitle(value) {
  return value.replace(/^[ab]\//u, "") || value;
}

function statusLabel(status) {
  if (isConflictStatus(status)) {
    return "Conflict";
  }
  if (status === "??") {
    return "Unversioned";
  }
  if (status.includes("R")) {
    return "Renamed";
  }
  if (status.includes("C")) {
    return "Copied";
  }
  if (status.includes("A")) {
    return "Added";
  }
  if (status.includes("D")) {
    return "Deleted";
  }
  if (status.includes("M")) {
    return "Modified";
  }
  return "Changed";
}

function isConflictStatus(status) {
  return status.includes("U") || ["AA", "DD"].includes(status);
}

function normalizeStartPath(startPath) {
  if (!startPath) {
    return process.cwd();
  }
  try {
    const stat = fs.statSync(startPath);
    return stat.isDirectory() ? startPath : path.dirname(startPath);
  } catch {
    return path.dirname(startPath);
  }
}

function appendPathspec(args, root, scopePath) {
  if (!scopePath) {
    return;
  }
  const relative = path.relative(root, normalizeStartPath(scopePath));
  if (relative && !relative.startsWith("..") && relative !== ".") {
    args.push("--", relative);
  }
}

function normalizeRelativePath(root, filePath) {
  const relative = path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath;
  if (!relative || relative.startsWith("..")) {
    throw new Error("File is outside the Git repository.");
  }
  return relative;
}

module.exports = {
  commitFiles,
  findGitRoot,
  getBlameAnnotations,
  getChangedFiles,
  getConflictFiles,
  getFileDiff,
  getCurrentBranch,
  parseBlamePorcelain,
  parsePorcelainStatus,
  parseUnifiedDiff,
  push,
  runGit,
  statusLabel
};
