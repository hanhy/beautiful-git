"use strict";

function parseConflictDocument(text) {
  const lines = toRawLines(text);
  const segments = [];
  let buffer = [];
  let conflictId = 0;

  const flushText = () => {
    if (buffer.length > 0) {
      segments.push({ type: "text", text: buffer.join("") });
      buffer = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const marker = lineText(lines[i]);
    if (!marker.startsWith("<<<<<<<")) {
      buffer.push(lines[i]);
      continue;
    }

    const startIndex = i;
    const leftLabel = marker.slice("<<<<<<<".length).trim() || "Current";
    const left = [];
    const base = [];
    const right = [];
    let baseLabel = "";
    let rightLabel = "";
    let bucket = left;
    let closed = false;

    i += 1;
    for (; i < lines.length; i += 1) {
      const current = lineText(lines[i]);
      if (current.startsWith("|||||||")) {
        baseLabel = current.slice("|||||||".length).trim() || "Base";
        bucket = base;
        continue;
      }
      if (current.startsWith("=======")) {
        bucket = right;
        continue;
      }
      if (current.startsWith(">>>>>>>")) {
        rightLabel = current.slice(">>>>>>>".length).trim() || "Incoming";
        closed = true;
        break;
      }
      bucket.push(lines[i]);
    }

    if (!closed) {
      for (let j = startIndex; j < lines.length; j += 1) {
        buffer.push(lines[j]);
      }
      break;
    }

    flushText();
    segments.push({
      type: "conflict",
      id: conflictId,
      startLine: startIndex + 1,
      leftLabel,
      baseLabel,
      rightLabel,
      left: left.join(""),
      base: base.join(""),
      right: right.join("")
    });
    conflictId += 1;
  }

  flushText();

  return {
    segments,
    conflicts: segments.filter((segment) => segment.type === "conflict"),
    conflictCount: conflictId
  };
}

function composeResolvedDocument(segments, resolutions) {
  const byId = new Map(Object.entries(resolutions || {}).map(([key, value]) => [Number(key), value]));
  return segments.map((segment) => {
    if (segment.type === "text") {
      return segment.text;
    }
    return byId.has(segment.id) ? byId.get(segment.id) : segment.left;
  }).join("");
}

function toRawLines(text) {
  const matches = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) || [];
  if (matches.length > 0 && matches[matches.length - 1] === "") {
    matches.pop();
  }
  return matches;
}

function lineText(rawLine) {
  return rawLine.replace(/(?:\r\n|\n|\r)$/u, "");
}

module.exports = {
  composeResolvedDocument,
  lineText,
  parseConflictDocument,
  toRawLines
};
