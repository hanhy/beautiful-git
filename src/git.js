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

module.exports = {
  commitFiles,
  findGitRoot,
  getBlameAnnotations,
  getChangedFiles,
  getConflictFiles,
  getCurrentBranch,
  parseBlamePorcelain,
  parsePorcelainStatus,
  push,
  runGit,
  statusLabel
};
