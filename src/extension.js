"use strict";

const path = require("path");
const vscode = require("vscode");
const { composeResolvedDocument, parseConflictDocument } = require("./conflictParser");

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("ideaMergeResolver.open", () => openFromActiveEditor(context)),
    vscode.commands.registerCommand("ideaMergeResolver.openResource", (resource) => openFromResource(context, resource))
  );
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
      --blue-soft: rgba(64, 116, 173, 0.32);
      --green-soft: rgba(63, 141, 86, 0.32);
      --red-soft: rgba(139, 74, 65, 0.35);
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
      background: #30333a;
      border: 1px solid #50545c;
      border-radius: 5px;
      min-height: 28px;
      padding: 3px 10px;
      font: inherit;
    }

    button {
      cursor: pointer;
    }

    button:hover { border-color: #727782; background: #383c44; }
    button.primary { background: #3f73d8; border-color: #4b82ed; color: white; }
    button.icon { min-width: 30px; padding: 2px 8px; font-weight: 700; }
    button.ghost { background: transparent; border-color: transparent; }
    button.danger { color: var(--danger); }

    .window {
      display: grid;
      grid-template-rows: 42px 36px minmax(0, 1fr) 48px;
      height: 100vh;
    }

    .titlebar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 14px;
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
      gap: 8px;
      padding: 4px 12px;
      background: var(--chrome);
      border-bottom: 1px solid #25272b;
      overflow-x: auto;
    }

    .toolbar .spacer { flex: 1; }
    .toolbar .status { color: #d6d8dc; font-weight: 650; white-space: nowrap; }
    .toolbar .label { color: #cfd2d8; white-space: nowrap; }

    .merge-grid {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) minmax(320px, 1.22fr) minmax(260px, 1fr);
      min-height: 0;
      overflow: hidden;
    }

    .pane {
      min-width: 0;
      overflow: auto;
      border-right: 1px solid var(--border);
      background: #1e2024;
    }

    .pane:last-child { border-right: 0; }

    .pane-header {
      position: sticky;
      top: 0;
      z-index: 3;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      height: 34px;
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
    }

    .section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 30px;
      padding: 4px 10px 4px 54px;
      color: #aeb4bd;
      background: rgba(255, 255, 255, 0.025);
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .section-title .actions {
      display: flex;
      gap: 4px;
      flex: 0 0 auto;
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
    .left-change .line { background: var(--blue-soft); }
    .right-change .line { background: var(--red-soft); }
    .result-change .line { background: var(--green-soft); }
    .empty {
      padding: 18px 12px 18px 62px;
      color: var(--muted);
      font-style: italic;
    }

    textarea.result-editor {
      width: calc(100% - 18px);
      min-height: 120px;
      margin: 9px;
      resize: vertical;
      border: 1px solid #515762;
      border-radius: 4px;
      outline: none;
      background: #202328;
      color: #d9dde5;
      padding: 10px 12px;
      font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      letter-spacing: 0;
    }

    textarea.result-editor:focus {
      border-color: #5f93ea;
      box-shadow: 0 0 0 1px rgba(95, 147, 234, 0.28);
    }

    .footer {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
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
      <section class="pane" id="resultPane"></section>
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
    let currentConflict = 0;
    let highlightWords = true;
    let displayMode = "normal";

    for (const segment of mergeState.segments) {
      if (segment.type === "conflict") {
        resolutions[segment.id] = segment.left;
      }
    }

    const panes = {
      left: document.getElementById("leftPane"),
      result: document.getElementById("resultPane"),
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
        setResolution(id, conflictById(id).left);
      } else if (action === "right") {
        setResolution(id, conflictById(id).right);
      } else if (action === "both") {
        const conflict = conflictById(id);
        setResolution(id, ensureTrailingLineBreak(conflict.left) + conflict.right);
      } else if (action === "all-left") {
        for (const conflict of conflicts()) {
          resolutions[conflict.id] = conflict.left;
        }
        render();
        markDirty("All conflicts set to left");
      } else if (action === "all-right") {
        for (const conflict of conflicts()) {
          resolutions[conflict.id] = conflict.right;
        }
        render();
        markDirty("All conflicts set to right");
      } else if (action === "apply") {
        syncTextareas();
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

    document.addEventListener("input", (event) => {
      if (!event.target.matches("textarea[data-id]")) {
        return;
      }
      resolutions[Number(event.target.dataset.id)] = event.target.value;
      markDirty("Edited result");
    });

    function render() {
      panes.left.innerHTML = paneHeader("Changes from " + firstLabel("leftLabel"), true) + renderSide("left");
      panes.result.innerHTML = paneHeader("Result", false) + renderResult();
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
        return section(
          '<div class="section-title">' +
            '<span>#' + (segment.id + 1) + " " + escapeHtml(label || side) + "</span>" +
            '<span class="actions">' +
              '<button class="icon" data-action="reveal" data-line="' + segment.startLine + '" title="Reveal in file">↗</button>' +
              '<button class="icon" data-action="' + action + '" data-id="' + segment.id + '" title="Accept this side">»</button>' +
            "</span>" +
          "</div>" +
          codeBlock(text, segment.startLine + 1, cls),
          "conflict",
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
        return section(
          '<div class="section-title">' +
            '<span>#' + (segment.id + 1) + " resolved text</span>" +
            '<span class="actions">' +
              '<button data-action="left" data-id="' + segment.id + '">Left</button>' +
              '<button data-action="right" data-id="' + segment.id + '">Right</button>' +
              '<button data-action="both" data-id="' + segment.id + '">Both</button>' +
            "</span>" +
          "</div>" +
          '<textarea class="result-editor" data-id="' + segment.id + '" spellcheck="false">' + escapeHtml(value) + "</textarea>" +
          codeBlock(value, segment.startLine + 1, "result-change"),
          "conflict",
          "conflict-" + segment.id + "-result"
        );
      }).join("");
    }

    function paneHeader(title, showDetails) {
      return '<div class="pane-header"><span>' + escapeHtml(title) + "</span>" +
        (showDetails ? '<a href="#" data-action="reveal" data-line="1">Show Details</a>' : '<span></span>') +
        "</div>";
    }

    function section(content, extraClass = "", id = "") {
      return '<div class="section ' + extraClass + '"' + (id ? ' id="' + id + '"' : "") + ">" + content + "</div>";
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

    function setResolution(id, value) {
      resolutions[id] = value;
      render();
      markDirty("Updated conflict #" + (id + 1));
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
      const paneList = [panes.left, panes.result, panes.right];
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

    function syncTextareas() {
      for (const textarea of document.querySelectorAll("textarea[data-id]")) {
        resolutions[Number(textarea.dataset.id)] = textarea.value;
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
