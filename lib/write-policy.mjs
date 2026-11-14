import { planWriteAllowed } from "./plan-guard.mjs";
import { torWriteAllowed } from "./tor-guard.mjs";

const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;
const WRITABLE_DOCS = new Set([
  "srs.md",
  "elicitation-log.md",
  "_analysis.md",
  "validation-report.md",
]);

export function toWorkspaceRelative(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return { ok: false, reason: "path is empty" };
  }
  let path = filePath.trim().replace(/\\/g, "/");
  if (path.startsWith("file://") || path.startsWith("$HOME") || path.startsWith("~")) {
    return { ok: false, reason: "writes outside /workspace are refused" };
  }
  if (path.startsWith("/workspace/")) path = path.slice("/workspace/".length);
  else if (path.startsWith("/")) {
    return { ok: false, reason: "absolute paths outside /workspace are refused" };
  }
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return { ok: false, reason: "path escapes the workspace" };
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return { ok: true, relative: parts.join("/") };
}

export function assessWrite(filePath, options = {}) {
  const allowedDocs = new Set(options.allowedDocs ?? WRITABLE_DOCS);
  const normalized = toWorkspaceRelative(filePath);
  if (!normalized.ok) return { allowed: false, reason: normalized.reason };
  const relative = normalized.relative;
  if (relative.startsWith("fixtures/") || relative === "fixtures") {
    return { allowed: false, reason: "fixtures are not writable project baselines" };
  }
  if (relative.startsWith("knowledge/") || relative === "knowledge") {
    return { allowed: false, reason: "reusable knowledge is immutable at runtime" };
  }
  const match = relative.match(/^projects\/([^/]+)\/(.+)$/);
  if (!match || !PROJECT_ID.test(match[1])) {
    return {
      allowed: false,
      reason: "writes are limited to projects/<id>/docs draft files",
    };
  }
  const rest = match[2];
  const planDecision = planWriteAllowed({
    filePath: relative,
    branch: options.branch,
    grant: options.planGrant,
  });
  if (planDecision.applies) {
    if (!planDecision.allowed) return { allowed: false, reason: planDecision.reason };
    return { allowed: true, relative };
  }
  if (rest === "docs/tor.md" || rest.endsWith("/docs/tor.md")) {
    const decision = torWriteAllowed({
      filePath: relative,
      branch: options.branch,
      grant: options.torGrant,
    });
    if (!decision.allowed) return { allowed: false, reason: decision.reason };
    return { allowed: true, relative };
  }
  if (rest === "intake/tor-source.md") {
    return { allowed: false, reason: "intake/tor-source.md is immutable after setup" };
  }
  if (rest === "project.yaml" || (rest.startsWith("src/") && !options.allowSrc)) {
    return {
      allowed: false,
      reason: "project.yaml and src/ are not sandbox write targets",
    };
  }
  if (options.allowSrc && (rest.startsWith("src/") || rest.startsWith("tests/"))) {
    return { allowed: true, relative };
  }
  const doc = rest.match(/^docs\/([^/]+)$/);
  if (!doc || !allowedDocs.has(doc[1])) {
    return {
      allowed: false,
      reason: `refusing to write ${relative}`,
    };
  }
  return { allowed: true, relative };
}
