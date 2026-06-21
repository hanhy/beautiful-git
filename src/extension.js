"use strict";

const path = require("path");
const vscode = require("vscode");
const { composeResolvedDocument, parseConflictDocument } = require("./conflictParser");
const {
  commitFiles,
  findGitRoot,
  getBlameAnnotations,
  getChangedFiles,
  getConflictFiles,
  getCurrentBranch,
  push
} = require("./git");

function activate(context) {
  const commitViewProvider = new CommitViewProvider(context);
  const blameAnnotationController = new BlameAnnotationController(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CommitViewProvider.viewType, commitViewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("ideaMergeResolver.open", () => openFromActiveEditor(context)),
    vscode.commands.registerCommand("ideaMergeResolver.openResource", (resource) => openFromResource(context, resource)),
    vscode.commands.registerCommand("beautifulGit.commitFiles", (resource) => openCommitFiles(commitViewProvider, resource)),
    vscode.commands.registerCommand("beautifulGit.resolveConflicts", (resource) => openResolveConflicts(context, resource)),
    vscode.commands.registerCommand("beautifulGit.annotateBlame", () => blameAnnotationController.enable()),
    vscode.commands.registerCommand("beautifulGit.closeAnnotation", () => blameAnnotationController.disable()),
    vscode.window.onDidChangeActiveTextEditor(() => blameAnnotationController.reapplyVisibleAnnotations()),
    vscode.window.onDidChangeVisibleTextEditors(() => blameAnnotationController.reapplyVisibleAnnotations()),
    vscode.workspace.onDidSaveTextDocument((document) => blameAnnotationController.refreshDocument(document))
  );
  blameAnnotationController.updateContext();
}

function deactivate() {}

async function openFromActiveEditor(context) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Open a file with Git conflict markers first.");
    return;
  }
  await openMergeResolver(context, editor.document.uri);
}

async function openFromResource(context, resource) {
  const uri = resource || vscode.window.activeTextEditor?.document.uri;
  if (!uri) {
    vscode.window.showWarningMessage("Select a file with Git conflict markers first.");
    return;
  }
  await openMergeResolver(context, uri);
}

async function openCommitFiles(provider, resource) {
  try {
    const target = await getGitTarget(resource);
    await provider.setTarget(target);
    await vscode.commands.executeCommand(`${CommitViewProvider.viewType}.focus`);
  } catch (error) {
    vscode.window.showErrorMessage(`Unable to open Commit Files: ${error.message}`);
  }
}

async function openResolveConflicts(context, resource) {
  try {
    const target = await getGitTarget(resource);
    await showConflictsDialog(context, target);
  } catch (error) {
    vscode.window.showErrorMessage(`Unable to open Resolve Conflicts: ${error.message}`);
  }
}

async function getGitTarget(resource) {
  const uri = resource || vscode.window.activeTextEditor?.document.uri || vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!uri || uri.scheme !== "file") {
    throw new Error("Select a file or folder inside a Git repository first.");
  }
  const root = await findGitRoot(uri.fsPath);
  const branch = await getCurrentBranch(root);
  return {
    root,
    branch,
    scopePath: uri.fsPath,
    scopeName: path.basename(uri.fsPath) || root
  };
}

class CommitViewProvider {
  static viewType = "beautifulGit.commitView";

  constructor(context) {
    this.context = context;
    this.view = undefined;
    this.target = undefined;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = getCommitViewHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    this.refresh();
  }

  async setTarget(target) {
    this.target = target;
    await this.refresh();
  }

  async handleMessage(message) {
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "refresh") {
      await this.refresh();
      return;
    }

    if (message.type === "openFile") {
      const file = message.file ? vscode.Uri.file(path.join(this.target.root, message.file)) : undefined;
      if (file) {
        await vscode.window.showTextDocument(file, { preview: true });
      }
      return;
    }

    if (message.type === "commit") {
      await this.commit(message.files || [], message.message || "", Boolean(message.pushAfter));
    }
  }

  async commit(files, message, pushAfter) {
    if (!this.target) {
      vscode.window.showWarningMessage("Select a Git directory first.");
      return;
    }
    try {
      await commitFiles(this.target.root, files, message);
      if (pushAfter) {
        await push(this.target.root);
      }
      vscode.window.showInformationMessage(pushAfter ? "Committed and pushed selected files." : "Committed selected files.");
      await this.refresh();
    } catch (error) {
      vscode.window.showErrorMessage(error.message);
    } finally {
      this.post({ type: "busy", busy: false });
    }
  }

  async refresh() {
    if (!this.view) {
      return;
    }

    if (!this.target) {
      this.post({
        type: "state",
        target: null,
        files: [],
        error: "Right-click a directory and choose Git > Commit Files..."
      });
      return;
    }

    try {
      const files = await getChangedFiles(this.target.root, this.target.scopePath);
      this.post({
        type: "state",
        target: this.target,
        files,
        error: ""
      });
    } catch (error) {
      this.post({
        type: "state",
        target: this.target,
        files: [],
        error: error.message
      });
    }
  }

  post(message) {
    this.view?.webview.postMessage(message);
  }
}

class BlameAnnotationController {
  constructor(context) {
    this.context = context;
    this.enabled = false;
    this.annotationCache = new Map();
    this.pending = new Set();
    this.decorationType = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      before: {
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
        margin: "0 18px 0 0",
        textDecoration: "none"
      }
    });
    context.subscriptions.push(this.decorationType);
  }

  async enable() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      vscode.window.showWarningMessage("Open a tracked file before enabling Git blame annotations.");
      return;
    }
    this.enabled = true;
    await this.updateContext();
    await this.reapplyVisibleAnnotations();
  }

  async disable() {
    this.enabled = false;
    this.annotationCache.clear();
    this.pending.clear();
    for (const visibleEditor of vscode.window.visibleTextEditors) {
      visibleEditor.setDecorations(this.decorationType, []);
    }
    await this.updateContext();
  }

  async reapplyVisibleAnnotations() {
    await this.updateContext();
    if (!this.enabled) {
      for (const editor of vscode.window.visibleTextEditors) {
        editor.setDecorations(this.decorationType, []);
      }
      return;
    }

    await Promise.all(vscode.window.visibleTextEditors.map((editor) => this.annotateEditor(editor)));
  }

  async refreshDocument(document) {
    if (!this.enabled || document.uri.scheme !== "file") {
      return;
    }
    this.annotationCache.delete(document.uri.toString());
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === document.uri.toString()) {
        await this.annotateEditor(editor);
      }
    }
  }

  async annotateEditor(editor) {
    if (!editor || editor.document.uri.scheme !== "file") {
      return;
    }

    const key = editor.document.uri.toString();
    if (this.annotationCache.has(key)) {
      this.applyAnnotations(editor, this.annotationCache.get(key));
      return;
    }
    if (this.pending.has(key)) {
      return;
    }

    this.pending.add(key);
    try {
      const root = await findGitRoot(editor.document.uri.fsPath);
      const annotations = await getBlameAnnotations(root, editor.document.uri.fsPath);
      if (annotations.length > 0) {
        this.annotationCache.set(key, annotations);
        this.applyAnnotations(editor, annotations);
      } else {
        editor.setDecorations(this.decorationType, []);
      }
    } catch {
      editor.setDecorations(this.decorationType, []);
    } finally {
      this.pending.delete(key);
    }
  }

  applyAnnotations(editor, annotations) {
    const palette = buildBlamePalette(annotations);
    const decorations = annotations
      .filter((annotation) => annotation.line >= 1 && annotation.line <= editor.document.lineCount)
      .map((annotation) => ({
        range: new vscode.Range(annotation.line - 1, 0, annotation.line - 1, 0),
        renderOptions: {
          before: {
            contentText: formatBlameAnnotation(annotation),
            backgroundColor: palette.get(annotation.authorTime) || "rgba(47, 59, 88, 0.55)",
            color: "rgba(205, 211, 224, 0.82)",
            margin: "0 14px 0 0",
            width: "17em",
            textDecoration: "none; display: inline-block; padding: 0 7px; opacity: 1;"
          }
        }
      }));
    editor.setDecorations(this.decorationType, decorations);
  }

  async updateContext() {
    await vscode.commands.executeCommand("setContext", "beautifulGit.annotationVisible", this.enabled);
  }
}

function formatBlameAnnotation(annotation) {
  const date = formatBlameDate(annotation.authorTime);
  const author = truncate(annotation.author || "Unknown", 14);
  return `${date}  ${author}`;
}

function formatBlameDate(authorTime) {
  if (!authorTime) {
    return "unknown";
  }
  const date = new Date(authorTime * 1000);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function buildBlamePalette(annotations) {
  const times = [...new Set(annotations.map((annotation) => annotation.authorTime).filter(Boolean))].sort((a, b) => a - b);
  const palette = new Map();
  if (times.length === 0) {
    return palette;
  }
  const min = times[0];
  const max = times[times.length - 1];
  for (const time of times) {
    const ratio = max === min ? 0.45 : (time - min) / (max - min);
    palette.set(time, blameBlue(ratio));
  }
  return palette;
}

function blameBlue(ratio) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const alpha = 0.34 + clamped * 0.34;
  const red = Math.round(42 + clamped * 25);
  const green = Math.round(54 + clamped * 38);
  const blue = Math.round(88 + clamped * 78);
  return `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(2)})`;
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, Math.max(0, length - 1))}…` : value;
}

async function showConflictsDialog(context, target) {
  const panel = vscode.window.createWebviewPanel(
    "beautifulGitResolveConflicts",
    "Resolve Conflicts",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  async function loadState() {
    const files = await getConflictFiles(target.root, target.scopePath);
    return {
      target,
      files,
      count: files.length
    };
  }

  async function render() {
    panel.webview.html = getConflictsDialogHtml(panel.webview, await loadState());
  }

  await render();

  panel.webview.onDidReceiveMessage(async (message) => {
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "close") {
      panel.dispose();
      return;
    }

    if (message.type === "refresh") {
      await render();
      return;
    }

    const relativePath = message.file;
    if (!relativePath) {
      return;
    }
    const uri = vscode.Uri.file(path.join(target.root, relativePath));

    if (message.type === "openFile") {
      await vscode.window.showTextDocument(uri, { preview: true });
      return;
    }

    if (message.type === "merge") {
      await openMergeResolver(context, uri);
      return;
    }

    if (message.type === "acceptLeft" || message.type === "acceptRight") {
      await acceptWholeFileSide(uri, message.type === "acceptLeft" ? "left" : "right");
      await render();
    }
  });
}

async function acceptWholeFileSide(uri, side) {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString("utf8");
  const parsed = parseConflictDocument(text);
  if (parsed.conflictCount === 0) {
    vscode.window.showInformationMessage("No conflict markers were found in this file.");
    return;
  }
  const resolutions = {};
  for (const conflict of parsed.conflicts) {
    resolutions[conflict.id] = conflict[side];
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(composeResolvedDocument(parsed.segments, resolutions), "utf8"));
  vscode.window.showInformationMessage(`Accepted ${side === "left" ? "left" : "right"} changes for ${path.basename(uri.fsPath)}.`);
}

async function openMergeResolver(context, uri) {
  let documentText;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    documentText = Buffer.from(bytes).toString("utf8");
  } catch (error) {
    vscode.window.showErrorMessage(`Unable to read file: ${error.message}`);
    return;
  }

  const parsed = parseConflictDocument(documentText);
  if (parsed.conflictCount === 0) {
    vscode.window.showInformationMessage("No Git conflict markers were found in this file.");
    return;
  }

  const fileName = path.basename(uri.fsPath);
  const panel = vscode.window.createWebviewPanel(
    "ideaMergeResolver",
    `Merge Revisions: ${fileName}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri, {
    fileName,
    filePath: uri.fsPath,
    segments: parsed.segments,
    conflictCount: parsed.conflictCount
  });

  panel.webview.onDidReceiveMessage(async (message) => {
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "cancel") {
      panel.dispose();
      return;
    }

    if (message.type === "reveal") {
      await revealDocumentLocation(uri, Number(message.line || 1));
      return;
    }

    if (message.type === "apply") {
      const resolved = composeResolvedDocument(parsed.segments, message.resolutions || {});
      if (hasConflictMarkers(resolved)) {
        const choice = await vscode.window.showWarningMessage(
          "The result still contains conflict markers. Apply anyway?",
          { modal: true },
          "Apply"
        );
        if (choice !== "Apply") {
          return;
        }
      }

      try {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(resolved, "utf8"));
        panel.dispose();
        const openChoice = await vscode.window.showInformationMessage(
          `Resolved ${parsed.conflictCount} conflict${parsed.conflictCount === 1 ? "" : "s"} in ${fileName}.`,
          "Open File"
        );
        if (openChoice === "Open File") {
          await vscode.window.showTextDocument(uri, { preview: false });
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Unable to write resolved file: ${error.message}`);
      }
    }
  });
}

async function revealDocumentLocation(uri, line) {
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
  const zeroBasedLine = Math.max(0, Math.min(document.lineCount - 1, line - 1));
  const position = new vscode.Position(zeroBasedLine, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

function hasConflictMarkers(text) {
  return /^(<<<<<<<|=======|>>>>>>>)(?: .*)?$/mu.test(text);
}

function getCommitViewHtml(webview) {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Commit Files</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      --bg: #1f2125;
      --panel: #25272c;
      --line: #383b42;
      --text: #cfd2d8;
      --muted: #888e99;
      --accent: #4b86e8;
      --green: #6aab73;
      --red: #c76d61;
      --yellow: #d6b46c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, textarea, input {
      font: inherit;
    }
    button {
      min-height: 24px;
      border: 1px solid #4a4e57;
      border-radius: 3px;
      background: #30333a;
      color: var(--text);
      cursor: pointer;
      padding: 1px 8px;
      line-height: 18px;
    }
    button:hover { background: #383c45; border-color: #6a707c; }
    button.primary { background: #3f73d8; border-color: #4f83e9; color: white; }
    .commit-tool {
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      height: 100vh;
      min-width: 0;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 36px;
      padding: 8px 10px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      font-weight: 650;
    }
    .scope {
      padding: 7px 10px;
      color: var(--muted);
      border-bottom: 1px solid rgba(255,255,255,0.06);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 8px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .toolbar button {
      min-height: 24px;
      padding: 1px 7px;
    }
    .files {
      overflow: auto;
      min-height: 0;
    }
    .empty {
      padding: 18px 10px;
      color: var(--muted);
    }
    .file-row {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr) auto;
      gap: 6px;
      align-items: center;
      min-height: 30px;
      padding: 3px 8px;
      border-bottom: 1px solid rgba(255,255,255,0.035);
    }
    .file-row:hover { background: rgba(255,255,255,0.04); }
    .name {
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;
    }
    .old {
      display: block;
      color: var(--muted);
      font-size: 11px;
    }
    .badge {
      justify-self: end;
      border: 1px solid #4b5059;
      border-radius: 3px;
      padding: 1px 5px;
      color: #c8ccd3;
      font-size: 11px;
    }
    .badge.conflict { color: var(--red); border-color: rgba(199,109,97,0.5); }
    .badge.added { color: var(--green); border-color: rgba(106,171,115,0.5); }
    .badge.deleted { color: var(--red); border-color: rgba(199,109,97,0.5); }
    .badge.unversioned { color: var(--yellow); border-color: rgba(214,180,108,0.5); }
    .footer {
      border-top: 1px solid var(--line);
      background: var(--panel);
      padding: 8px;
    }
    textarea {
      width: 100%;
      min-height: 82px;
      resize: vertical;
      border: 1px solid #4c515a;
      border-radius: 3px;
      outline: none;
      background: #1e2024;
      color: var(--text);
      padding: 8px;
      letter-spacing: 0;
    }
    textarea:focus { border-color: var(--accent); }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 8px;
    }
    .hint {
      margin-top: 6px;
      min-height: 18px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <div class="commit-tool">
    <div class="header"><span>Commit</span><button id="refresh">↻</button></div>
    <div class="scope" id="scope">Select a Git directory</div>
    <div>
      <div class="toolbar">
        <button id="all">All</button>
        <button id="none">None</button>
        <span id="count"></span>
      </div>
      <div class="files" id="files"></div>
    </div>
    <div class="footer">
      <textarea id="message" placeholder="Commit Message"></textarea>
      <div class="actions">
        <button id="commit">Commit</button>
        <button id="commitPush" class="primary">Commit & Push</button>
      </div>
      <div class="hint" id="hint"></div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = { target: null, files: [], error: "" };
    let selected = new Set();
    const filesEl = document.getElementById("files");
    const scopeEl = document.getElementById("scope");
    const countEl = document.getElementById("count");
    const hintEl = document.getElementById("hint");
    const messageEl = document.getElementById("message");

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "state") {
        state = message;
        selected = new Set(state.files.map((file) => file.path));
        render();
      }
      if (message.type === "busy") {
        setBusy(Boolean(message.busy));
      }
    });

    document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    document.getElementById("all").addEventListener("click", () => {
      selected = new Set(state.files.map((file) => file.path));
      render();
    });
    document.getElementById("none").addEventListener("click", () => {
      selected = new Set();
      render();
    });
    document.getElementById("commit").addEventListener("click", () => commit(false));
    document.getElementById("commitPush").addEventListener("click", () => commit(true));

    filesEl.addEventListener("change", (event) => {
      const checkbox = event.target.closest("input[data-file]");
      if (!checkbox) {
        return;
      }
      if (checkbox.checked) {
        selected.add(checkbox.dataset.file);
      } else {
        selected.delete(checkbox.dataset.file);
      }
      updateCount();
    });

    filesEl.addEventListener("click", (event) => {
      const name = event.target.closest("[data-open]");
      if (name) {
        vscode.postMessage({ type: "openFile", file: name.dataset.open });
      }
    });

    function commit(pushAfter) {
      const files = Array.from(selected);
      if (files.length === 0) {
        hintEl.textContent = "Select at least one file.";
        return;
      }
      if (!messageEl.value.trim()) {
        hintEl.textContent = "Commit message is required.";
        messageEl.focus();
        return;
      }
      setBusy(true);
      vscode.postMessage({ type: "commit", files, message: messageEl.value, pushAfter });
    }

    function render() {
      const targetLabel = state.target ? state.target.scopeName + " · " + state.target.branch : "No Git target";
      scopeEl.textContent = state.error || targetLabel;
      if (state.error) {
        filesEl.innerHTML = '<div class="empty">' + escapeHtml(state.error) + "</div>";
        updateCount();
        return;
      }
      if (!state.files.length) {
        filesEl.innerHTML = '<div class="empty">No local changes in this scope.</div>';
        updateCount();
        return;
      }
      filesEl.innerHTML = state.files.map((file) => {
        const checked = selected.has(file.path) ? " checked" : "";
        const badgeClass = file.label.toLowerCase().replace(/\\s+/g, "-");
        const oldPath = file.oldPath ? '<span class="old">from ' + escapeHtml(file.oldPath) + "</span>" : "";
        return '<label class="file-row">' +
          '<input type="checkbox" data-file="' + escapeAttr(file.path) + '"' + checked + ">" +
          '<span class="name" data-open="' + escapeAttr(file.path) + '">' + escapeHtml(file.path) + oldPath + "</span>" +
          '<span class="badge ' + badgeClass + '">' + escapeHtml(file.label) + "</span>" +
        "</label>";
      }).join("");
      updateCount();
      hintEl.textContent = "";
    }

    function updateCount() {
      countEl.textContent = selected.size + " / " + state.files.length + " selected";
    }

    function setBusy(busy) {
      for (const button of document.querySelectorAll("button")) {
        button.disabled = busy;
      }
      hintEl.textContent = busy ? "Running Git..." : "";
    }

    function escapeHtml(value) {
      return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/'/g, "&#39;");
    }

    vscode.postMessage({ type: "refresh" });
  </script>
</body>
</html>`;
}

function getConflictsDialogHtml(webview, state) {
  const nonce = getNonce();
  const serializedState = JSON.stringify(state).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Resolve Conflicts</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      --bg: #1f2125;
      --dialog: #2b2d31;
      --line: #3d4149;
      --text: #d1d4da;
      --muted: #8b909b;
      --blue: #4b86e8;
      --red: #c76d61;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: #1f2125;
      color: var(--text);
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button {
      min-height: 24px;
      border: 1px solid #515762;
      border-radius: 3px;
      background: #30333a;
      color: var(--text);
      font: inherit;
      cursor: pointer;
      padding: 1px 8px;
      line-height: 18px;
    }
    button:hover { background: #383c45; border-color: #717783; }
    button.primary { background: #3f73d8; border-color: #5287ee; color: white; }
    .shell {
      display: grid;
      place-items: center;
      min-height: 100vh;
      padding: 24px;
    }
    .dialog {
      width: min(860px, calc(100vw - 48px));
      min-height: 430px;
      background: var(--dialog);
      border: 1px solid #4a4e57;
      box-shadow: 0 18px 70px rgba(0,0,0,0.45);
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
    }
    .title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      font-weight: 650;
      font-size: 14px;
    }
    .sub {
      padding: 8px 14px;
      color: var(--muted);
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .list {
      overflow: auto;
      padding: 8px 0;
      background: #24262b;
    }
    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      min-height: 44px;
      padding: 6px 14px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .row:hover { background: rgba(255,255,255,0.04); }
    .file {
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: 0;
    }
    .meta {
      color: var(--muted);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin-top: 2px;
    }
    .actions {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .empty {
      padding: 36px 14px;
      color: var(--muted);
      text-align: center;
    }
    .footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 10px 14px;
      border-top: 1px solid var(--line);
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="dialog">
      <div class="title">
        <span>Resolve Conflicts</span>
        <span id="count"></span>
      </div>
      <div class="sub" id="scope"></div>
      <div class="list" id="list"></div>
      <div class="footer">
        <button data-action="refresh">Refresh</button>
        <button data-action="close" class="primary">Close</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = ${serializedState};
    const list = document.getElementById("list");
    document.getElementById("scope").textContent = state.target.scopeName + " · " + state.target.branch;
    document.getElementById("count").textContent = state.count + " conflict file" + (state.count === 1 ? "" : "s");
    render();

    document.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) {
        return;
      }
      vscode.postMessage({ type: button.dataset.action, file: button.dataset.file || "" });
    });

    function render() {
      if (!state.files.length) {
        list.innerHTML = '<div class="empty">No conflicted files in this directory.</div>';
        return;
      }
      list.innerHTML = state.files.map((file) => {
        return '<div class="row">' +
          '<div><div class="file" title="' + escapeAttr(file.path) + '">' + escapeHtml(file.path) + '</div>' +
          '<div class="meta">' + file.conflictCount + ' conflict block' + (file.conflictCount === 1 ? "" : "s") + '</div></div>' +
          '<div class="actions">' +
            '<button data-action="openFile" data-file="' + escapeAttr(file.path) + '">Open</button>' +
            '<button data-action="acceptLeft" data-file="' + escapeAttr(file.path) + '">Accept Yours</button>' +
            '<button data-action="acceptRight" data-file="' + escapeAttr(file.path) + '">Accept Theirs</button>' +
            '<button class="primary" data-action="merge" data-file="' + escapeAttr(file.path) + '">Merge...</button>' +
          '</div>' +
        '</div>';
      }).join("");
    }

    function escapeHtml(value) {
      return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/'/g, "&#39;");
    }
  </script>
</body>
</html>`;
}

function getWebviewHtml(webview, extensionUri, state) {
  const nonce = getNonce();
  const serializedState = JSON.stringify(state).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IDEA Merge Resolver</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      --bg: #1f2125;
      --chrome: #2b2d31;
      --chrome-2: #24262a;
      --border: #3c3f44;
      --text: #c9ccd1;
      --muted: #858a93;
      --blue: #4775ac;
      --blue-ribbon: rgba(65, 100, 139, 0.78);
      --green-ribbon: rgba(54, 94, 65, 0.78);
      --gray-ribbon: rgba(76, 79, 84, 0.75);
      --red-ribbon: rgba(103, 63, 57, 0.78);
      --yellow: #d7ba7d;
      --accent: #4b86e8;
      --danger: #d1867a;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    button, select {
      color: var(--text);
      background: #303238;
      border: 1px solid #4b4f57;
      border-radius: 3px;
      min-height: 24px;
      padding: 1px 8px;
      font: inherit;
      line-height: 18px;
    }

    button {
      cursor: pointer;
    }

    button:hover { border-color: #686d76; background: #373a41; }
    button.primary { background: #3f6fcb; border-color: #4c7de0; color: white; }
    button.icon { min-width: 24px; padding: 1px 5px; font-weight: 600; }
    button.ghost { background: transparent; border-color: transparent; }
    button.danger { color: var(--danger); }

    .window {
      display: grid;
      grid-template-rows: 34px 32px minmax(0, 1fr) 40px;
      height: 100vh;
    }

    .titlebar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 12px;
      background: var(--chrome);
      border-bottom: 1px solid #25272b;
      white-space: nowrap;
      overflow: hidden;
    }

    .titlebar strong {
      overflow: hidden;
      text-overflow: ellipsis;
      color: #b7bbc3;
      font-size: 14px;
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      background: var(--chrome);
      border-bottom: 1px solid #25272b;
      overflow-x: auto;
    }

    .toolbar .spacer { flex: 1; }
    .toolbar .status { color: #d6d8dc; font-weight: 650; white-space: nowrap; }
    .toolbar .label { color: #cfd2d8; white-space: nowrap; }

    .merge-grid {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) 46px minmax(320px, 1.18fr) 46px minmax(260px, 1fr);
      min-height: 0;
      overflow: hidden;
    }

    .pane {
      min-width: 0;
      overflow-y: auto;
      overflow-x: hidden;
      border-right: 1px solid var(--border);
      background: #1e2024;
    }

    .pane:last-child { border-right: 0; }

    .merge-gap-pane {
      min-width: 0;
      overflow: hidden;
      background: #191b1f;
      border-right: 1px solid #343840;
      border-left: 1px solid #24272d;
    }

    .pane-header {
      position: sticky;
      top: 0;
      z-index: 3;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      height: 30px;
      padding: 0 12px;
      background: #25272c;
      border-bottom: 1px solid var(--border);
      color: #d4d7dd;
      font-weight: 650;
    }

    .pane-header a {
      color: #75a7ff;
      text-decoration: none;
      font-weight: 500;
    }

    .section {
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .section.conflict {
      position: relative;
      border-top: 1px solid rgba(255, 255, 255, 0.09);
      isolation: isolate;
      --band-fill: var(--blue-ribbon);
      --band-line: rgba(121, 160, 201, 0.38);
    }

    .section.conflict.kind-changed {
      --band-fill: var(--blue-ribbon);
      --band-line: rgba(121, 160, 201, 0.38);
      --line-fill: rgba(67, 108, 151, 0.54);
    }

    .section.conflict.kind-added {
      --band-fill: var(--green-ribbon);
      --band-line: rgba(106, 171, 115, 0.38);
      --line-fill: rgba(58, 105, 70, 0.54);
    }

    .section.conflict.kind-deleted {
      --band-fill: var(--gray-ribbon);
      --band-line: rgba(165, 171, 178, 0.32);
      --line-fill: rgba(79, 83, 89, 0.5);
    }

    .section.conflict.kind-conflict {
      --band-fill: var(--red-ribbon);
      --band-line: rgba(193, 124, 116, 0.4);
      --line-fill: rgba(111, 67, 60, 0.58);
    }

    .change-band {
      position: absolute;
      z-index: 1;
      top: 26px;
      height: 2px;
      background: var(--band-fill);
      opacity: 0.95;
      pointer-events: none;
    }

    .left-ribbon .change-band {
      left: 48px;
      right: 0;
    }

    .right-ribbon .change-band {
      left: 0;
      right: 48px;
    }

    .result-ribbon .change-band {
      left: 0;
      right: 0;
      top: 0;
    }

    .merge-gap-section {
      position: relative;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      --band-fill: rgba(73, 82, 93, 0.5);
      --band-line: rgba(140, 148, 160, 0.28);
    }

    .merge-gap-section.kind-changed {
      --band-fill: var(--blue-ribbon);
      --band-line: rgba(121, 160, 201, 0.38);
    }

    .merge-gap-section.kind-added {
      --band-fill: var(--green-ribbon);
      --band-line: rgba(106, 171, 115, 0.38);
    }

    .merge-gap-section.kind-deleted {
      --band-fill: var(--gray-ribbon);
      --band-line: rgba(165, 171, 178, 0.32);
    }

    .merge-gap-section.kind-conflict {
      --band-fill: var(--red-ribbon);
      --band-line: rgba(193, 124, 116, 0.4);
    }

    .merge-gap-section .change-band {
      position: absolute;
      z-index: 1;
      top: 26px;
      height: 2px;
      left: 0;
      right: 0;
      background: var(--band-fill);
      opacity: 0.95;
      pointer-events: none;
    }

    .left-gap .merge-gap-section .change-band {
      clip-path: none;
    }

    .right-gap .merge-gap-section .change-band {
      clip-path: none;
    }

    .merge-gap-section.discarded .change-band {
      background: transparent;
      border-top: 2px dashed var(--band-line);
      clip-path: none;
      left: 5px;
      right: 5px;
      top: 29px;
      height: 0;
    }

    .merge-gap-section.accepted .change-band {
      background: transparent;
      border-top: 2px dashed var(--band-line);
      height: 0;
    }

    .gap-title {
      position: relative;
      z-index: 2;
      height: 26px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }

    .gap-lines {
      position: relative;
      z-index: 2;
    }

    .gap-line {
      min-height: 22px;
    }

    .section.conflict.discarded .change-band {
      background: transparent;
      border-top: 2px dashed var(--band-line);
      opacity: 1;
      clip-path: none;
      left: 34px;
      right: 34px;
      top: 29px;
      height: 0;
    }

    .section.conflict.accepted .change-band {
      background: transparent;
      border-top: 2px dashed var(--band-line);
      opacity: 1;
      height: 0;
    }

    .section.conflict.discarded .line {
      opacity: 0.58;
    }

    .result-ribbon.discarded .change-band {
      left: 5px;
      right: 5px;
      top: 3px;
    }

    .ribbon-rail {
      position: absolute;
      z-index: 2;
      top: 28px;
      display: flex;
      align-items: center;
      gap: 4px;
      height: 24px;
      color: #cfd3da;
      font: 13px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .left-ribbon .ribbon-rail {
      right: 5px;
    }

    .right-ribbon .ribbon-rail {
      left: 5px;
    }

    .result-ribbon .ribbon-rail {
      left: 10px;
      top: 2px;
      color: #aeb5bf;
    }

    .ribbon-rail button {
      min-width: 20px;
      min-height: 20px;
      padding: 0 3px;
      border: 0;
      background: transparent;
      color: #cdd2da;
      font: 16px/18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      pointer-events: auto;
    }

    .ribbon-rail button:hover {
      background: rgba(255, 255, 255, 0.08);
      border: 0;
    }

    .ribbon-line-number {
      min-width: 28px;
      color: #b9c0c9;
      text-align: left;
    }

    .section-title {
      position: relative;
      z-index: 3;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 26px;
      padding: 3px 8px 3px 52px;
      color: #aeb4bd;
      background: rgba(255, 255, 255, 0.025);
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .section-title .actions {
      display: flex;
      gap: 3px;
      flex: 0 0 auto;
    }

    .section-title .actions button {
      min-height: 21px;
      padding: 0 6px;
    }

    .code {
      font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      letter-spacing: 0;
    }

    .line {
      display: grid;
      grid-template-columns: 48px minmax(0, 1fr);
      min-height: 22px;
      white-space: pre;
      position: relative;
      z-index: 2;
    }

    .gutter {
      user-select: none;
      color: #5f6671;
      text-align: right;
      padding: 0 10px 0 4px;
      border-right: 1px solid rgba(255, 255, 255, 0.05);
      background: rgba(0, 0, 0, 0.07);
    }

    .source {
      overflow: visible;
      padding: 0 12px;
      color: #cdd0d6;
    }

    .source .tag { color: var(--yellow); }
    .source .string { color: #8ccf7e; }
    .source .marker { color: #a7b9d8; }

    .unchanged .source { color: #969ba4; }
    .left-change .line,
    .right-change .line,
    .result-change .line { background: var(--line-fill, transparent); }
    .empty {
      padding: 18px 12px 18px 62px;
      color: var(--muted);
      font-style: italic;
    }

    .footer {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      background: var(--chrome);
      border-top: 1px solid #383b41;
    }

    .footer .spacer { flex: 1; }
    .dirty {
      color: #aeb4bd;
      min-width: 120px;
    }

    .kbd {
      border: 1px solid #535861;
      border-bottom-color: #393d44;
      border-radius: 4px;
      padding: 1px 5px;
      color: #bfc4cc;
      background: #2e3137;
      font-size: 12px;
    }

    @media (max-width: 900px) {
      .merge-grid { grid-template-columns: 1fr; }
      .pane { border-right: 0; border-bottom: 1px solid var(--border); }
      .merge-gap-pane { display: none; }
      .window { grid-template-rows: 42px 42px minmax(0, 1fr) 54px; }
    }
  </style>
</head>
<body>
  <div class="window">
    <header class="titlebar">
      <strong id="title"></strong>
    </header>
    <nav class="toolbar">
      <button class="icon ghost" data-action="prev" title="Previous conflict">↑</button>
      <button class="icon ghost" data-action="next" title="Next conflict">↓</button>
      <span class="label">Apply all:</span>
      <button data-action="all-left">» Left</button>
      <button data-action="all-right">Right «</button>
      <select id="displayMode" title="Display mode">
        <option value="normal">Do not ignore</option>
        <option value="trim">Ignore leading/trailing whitespace</option>
      </select>
      <button data-action="toggle-words" id="wordToggle">Highlight words</button>
      <span class="spacer"></span>
      <span class="status" id="stats"></span>
    </nav>
    <main class="merge-grid">
      <section class="pane" id="leftPane"></section>
      <section class="merge-gap-pane left-gap" id="leftGapPane"></section>
      <section class="pane" id="resultPane"></section>
      <section class="merge-gap-pane right-gap" id="rightGapPane"></section>
      <section class="pane" id="rightPane"></section>
    </main>
    <footer class="footer">
      <button data-action="all-left">Accept Left</button>
      <button data-action="all-right">Accept Right</button>
      <span class="dirty" id="dirtyState">No changes applied</span>
      <span class="spacer"></span>
      <button data-action="cancel">Cancel</button>
      <button class="primary" data-action="apply">Apply</button>
    </footer>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const mergeState = ${serializedState};
    const resolutions = Object.create(null);
    const discarded = Object.create(null);
    const accepted = Object.create(null);
    let currentConflict = 0;
    let highlightWords = true;
    let displayMode = "normal";

    for (const segment of mergeState.segments) {
      if (segment.type === "conflict") {
        resolutions[segment.id] = segment.left;
        discarded[segment.id] = false;
        accepted[segment.id] = false;
      }
    }

    const panes = {
      left: document.getElementById("leftPane"),
      leftGap: document.getElementById("leftGapPane"),
      result: document.getElementById("resultPane"),
      rightGap: document.getElementById("rightGapPane"),
      right: document.getElementById("rightPane")
    };

    document.getElementById("title").textContent = "Merge Revisions for " + mergeState.filePath;
    render();

    document.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) {
        return;
      }

      const action = button.dataset.action;
      const id = Number(button.dataset.id);
      if (action === "left") {
        setResolution(id, conflictById(id).left, false, true);
      } else if (action === "right") {
        setResolution(id, conflictById(id).right, false, true);
      } else if (action === "empty") {
        setResolution(id, "", true, true);
      } else if (action === "both") {
        const conflict = conflictById(id);
        setResolution(id, ensureTrailingLineBreak(conflict.left) + conflict.right, false, true);
      } else if (action === "all-left") {
        for (const conflict of conflicts()) {
          resolutions[conflict.id] = conflict.left;
          discarded[conflict.id] = false;
          accepted[conflict.id] = true;
        }
        render();
        markDirty("All conflicts set to left");
      } else if (action === "all-right") {
        for (const conflict of conflicts()) {
          resolutions[conflict.id] = conflict.right;
          discarded[conflict.id] = false;
          accepted[conflict.id] = true;
        }
        render();
        markDirty("All conflicts set to right");
      } else if (action === "apply") {
        vscode.postMessage({ type: "apply", resolutions });
      } else if (action === "cancel") {
        vscode.postMessage({ type: "cancel" });
      } else if (action === "reveal") {
        vscode.postMessage({ type: "reveal", line: button.dataset.line });
      } else if (action === "prev") {
        jumpToConflict(Math.max(0, currentConflict - 1));
      } else if (action === "next") {
        jumpToConflict(Math.min(conflicts().length - 1, currentConflict + 1));
      } else if (action === "toggle-words") {
        highlightWords = !highlightWords;
        button.textContent = highlightWords ? "Highlight words" : "Plain text";
        render();
      }
    });

    document.getElementById("displayMode").addEventListener("change", (event) => {
      displayMode = event.target.value;
      render();
    });

    function render() {
      panes.left.innerHTML = paneHeader("Changes from " + firstLabel("leftLabel"), true) + renderSide("left");
      panes.leftGap.innerHTML = gapHeader() + renderGap("left");
      panes.result.innerHTML = paneHeader("Result", false) + renderResult();
      panes.rightGap.innerHTML = gapHeader() + renderGap("right");
      panes.right.innerHTML = paneHeader("Changes from " + firstLabel("rightLabel"), true) + renderSide("right");
      document.getElementById("stats").textContent = mergeState.conflictCount + " conflict" + (mergeState.conflictCount === 1 ? "" : "s");
      restoreScrollCoupling();
    }

    function renderSide(side) {
      return mergeState.segments.map((segment) => {
        if (segment.type === "text") {
          return section(codeBlock(segment.text, "", "unchanged"));
        }
        const text = side === "left" ? segment.left : segment.right;
        const label = side === "left" ? segment.leftLabel : segment.rightLabel;
        const action = side === "left" ? "left" : "right";
        const cls = side === "left" ? "left-change" : "right-change";
        const ribbonClass = side === "left" ? "left-ribbon" : "right-ribbon";
        const arrow = side === "left" ? "»" : "«";
        const kind = conflictKind(segment);
        const discardedClass = discarded[segment.id] ? " discarded" : "";
        const acceptedClass = accepted[segment.id] ? " accepted" : "";
        return section(
          ribbonMarkup(segment, side, action, arrow) +
          '<div class="section-title">' +
            '<span>#' + (segment.id + 1) + " " + escapeHtml(label || side) + "</span>" +
            '<span class="actions">' +
              '<button class="icon" data-action="reveal" data-line="' + segment.startLine + '" title="Reveal in file">↗</button>' +
              '<button class="icon" data-action="' + action + '" data-id="' + segment.id + '" title="Accept this side">' + arrow + '</button>' +
            "</span>" +
          "</div>" +
          codeBlock(text, segment.startLine + 1, cls),
          "conflict " + ribbonClass + " kind-" + kind + discardedClass + acceptedClass,
          "conflict-" + segment.id + "-" + side
        );
      }).join("");
    }

    function renderResult() {
      return mergeState.segments.map((segment) => {
        if (segment.type === "text") {
          return section(codeBlock(segment.text, "", "unchanged"));
        }
        const value = resolutions[segment.id] ?? segment.left;
        const kind = conflictKind(segment);
        const discardedClass = discarded[segment.id] ? " discarded" : "";
        const acceptedClass = accepted[segment.id] ? " accepted" : "";
        return section(
          '<div class="change-band"></div><div class="ribbon-rail"><span class="ribbon-line-number">' + segment.startLine + '</span></div>' +
          codeBlock(value, segment.startLine + 1, "result-change"),
          "conflict result-ribbon kind-" + kind + discardedClass + acceptedClass,
          "conflict-" + segment.id + "-result"
        );
      }).join("");
    }

    function renderGap(side) {
      return mergeState.segments.map((segment) => {
        if (segment.type === "text") {
          return gapSection(gapSpacer(segment.text));
        }
        const sideText = side === "left" ? segment.left : segment.right;
        const kind = conflictKind(segment);
        const discardedClass = discarded[segment.id] ? " discarded" : "";
        const acceptedClass = accepted[segment.id] ? " accepted" : "";
        return gapSection(
          '<div class="change-band"></div><div class="gap-title"></div>' + gapSpacer(sideText),
          "kind-" + kind + discardedClass + acceptedClass
        );
      }).join("");
    }

    function ribbonMarkup(segment, side, action, arrow) {
      const controls = side === "right"
        ? '<button data-action="' + action + '" data-id="' + segment.id + '" title="Accept this block">' + arrow + '</button>' +
          '<button data-action="empty" data-id="' + segment.id + '" title="Discard this block">×</button>'
        : '<button data-action="empty" data-id="' + segment.id + '" title="Discard this block">×</button>' +
          '<button data-action="' + action + '" data-id="' + segment.id + '" title="Accept this block">' + arrow + '</button>';
      return '<div class="change-band"></div>' +
        '<div class="ribbon-rail">' +
          controls +
          '<span class="ribbon-line-number">' + segment.startLine + '</span>' +
        '</div>';
    }

    function conflictKind(segment) {
      const left = segment.left.trim();
      const right = segment.right.trim();
      if (!left && right) {
        return "added";
      }
      if (left && !right) {
        return "deleted";
      }
      if (left && right && left !== right) {
        return countDisplayLines(segment.left) === countDisplayLines(segment.right) ? "changed" : "conflict";
      }
      return "changed";
    }

    function countDisplayLines(text) {
      const normalized = normalizeForDisplay(text).replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n");
      const lines = normalized.split("\\n");
      return lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    }

    function paneHeader(title, showDetails) {
      return '<div class="pane-header"><span>' + escapeHtml(title) + "</span>" +
        (showDetails ? '<a href="#" data-action="reveal" data-line="1">Show Details</a>' : '<span></span>') +
        "</div>";
    }

    function gapHeader() {
      return '<div class="pane-header"></div>';
    }

    function section(content, extraClass = "", id = "") {
      return '<div class="section ' + extraClass + '"' + (id ? ' id="' + id + '"' : "") + ">" + content + "</div>";
    }

    function gapSection(content, extraClass = "") {
      return '<div class="merge-gap-section ' + extraClass + '">' + content + "</div>";
    }

    function codeBlock(text, startLine, className) {
      const normalized = normalizeForDisplay(text);
      let lines = normalized.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n").split("\\n");
      if (lines.length > 1 && lines[lines.length - 1] === "") {
        lines = lines.slice(0, -1);
      }
      if (lines.length === 1 && lines[0] === "") {
        return '<div class="empty">empty block</div>';
      }
      const numberBase = Number(startLine);
      return '<div class="code ' + className + '">' + lines.map((line, index) => {
        const lineNumber = Number.isFinite(numberBase) ? numberBase + index : "";
        return '<div class="line"><span class="gutter">' + lineNumber + '</span><span class="source">' + decorateCode(line) + "</span></div>";
      }).join("") + "</div>";
    }

    function gapSpacer(text) {
      let lines = normalizeForDisplay(text).replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n").split("\\n");
      if (lines.length > 1 && lines[lines.length - 1] === "") {
        lines = lines.slice(0, -1);
      }
      if (lines.length === 1 && lines[0] === "") {
        return '<div class="gap-lines"><div class="gap-line"></div></div>';
      }
      return '<div class="gap-lines">' + lines.map(() => '<div class="gap-line"></div>').join("") + "</div>";
    }

    function normalizeForDisplay(text) {
      if (displayMode === "trim") {
        return text.split(/(\\r\\n|\\n|\\r)/).map((part) => /^(\\r\\n|\\n|\\r)$/.test(part) ? part : part.trim()).join("");
      }
      return text;
    }

    function decorateCode(line) {
      let escaped = escapeHtml(line);
      escaped = escaped.replace(/(&lt;\\/?[\\w:-]+)/g, '<span class="tag">$1</span>');
      escaped = escaped.replace(/(&quot;[^&]*&quot;)/g, '<span class="string">$1</span>');
      if (highlightWords) {
        escaped = escaped.replace(/\\b(TODO|FIXME|conflict|merge)\\b/gi, '<span class="marker">$1</span>');
      }
      return escaped || " ";
    }

    function setResolution(id, value, isDiscarded, isAccepted) {
      resolutions[id] = value;
      discarded[id] = Boolean(isDiscarded);
      accepted[id] = Boolean(isAccepted);
      render();
      markDirty(isDiscarded ? "Discarded change #" + (id + 1) : "Updated conflict #" + (id + 1));
      jumpToConflict(id);
    }

    function jumpToConflict(index) {
      currentConflict = index;
      for (const suffix of ["left", "result", "right"]) {
        const target = document.getElementById("conflict-" + index + "-" + suffix);
        if (target) {
          target.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }
    }

    function restoreScrollCoupling() {
      const paneList = [panes.left, panes.leftGap, panes.result, panes.rightGap, panes.right];
      let syncing = false;
      for (const pane of paneList) {
        pane.onscroll = () => {
          if (syncing) {
            return;
          }
          syncing = true;
          const ratio = pane.scrollTop / Math.max(1, pane.scrollHeight - pane.clientHeight);
          for (const other of paneList) {
            if (other !== pane) {
              other.scrollTop = ratio * Math.max(1, other.scrollHeight - other.clientHeight);
            }
          }
          syncing = false;
        };
      }
    }

    function markDirty(text) {
      document.getElementById("dirtyState").textContent = text;
    }

    function conflicts() {
      return mergeState.segments.filter((segment) => segment.type === "conflict");
    }

    function conflictById(id) {
      return conflicts().find((conflict) => conflict.id === id);
    }

    function firstLabel(key) {
      const conflict = conflicts()[0];
      return conflict ? conflict[key] : "";
    }

    function ensureTrailingLineBreak(text) {
      return /\\r\\n$|\\n$|\\r$/.test(text) ? text : text + "\\n";
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
  </script>
</body>
</html>`;
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

module.exports = {
  activate,
  deactivate
};
