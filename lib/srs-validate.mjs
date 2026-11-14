import { createHash } from "node:crypto";
import { readTorBaselineSha256 } from "./baseline.mjs";
import { reintroducesOs } from "./scope-ids.mjs";

const REQUIRED_SECTIONS = [
  "Introduction",
  "Scope",
  "Functional Requirements",
  "Nonfunctional Requirements",
  "Acceptance Criteria",
  "Constraints and References",
];

const ID_HEADING = /^#{2,4} ((?:FR|NFR|AC)-\d{3})\b.*$/gm;

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function isTorPath(filePath) {
  return /(?:^|\/)docs\/tor\.md$/.test(String(filePath).replace(/\\/g, "/"));
}

function sectionBody(markdown, title) {
  const pattern = new RegExp(
    `^#{1,3} ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
    "im",
  );
  const match = pattern.exec(markdown);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = rest.search(/^#{1,3} /m);
  return next === -1 ? rest : rest.slice(0, next);
}

export function listRequirementIds(markdown) {
  return blocksById(markdown)
    .map((block) => block.id)
    .filter((id) => /^(?:FR|NFR)-/.test(id));
}

function blocksById(markdown) {
  const matches = [...markdown.matchAll(ID_HEADING)];
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    return { id: match[1], body: markdown.slice(start, end) };
  });
}

function field(body, name) {
  const match = body.match(
    new RegExp(`^\\s*(?:[-*]\\s+)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:\\s*(.+)$`, "im"),
  );
  return match ? match[1].trim() : null;
}

export function parseGapRegister(analysis, { prefix = "G" } = {}) {
  if (!analysis) return [];
  const line = new RegExp(
    `^- (${prefix}-\\d+) \\| (blocking|nonblocking) \\| (unresolved|resolved) \\| (.+)$`,
    "gm",
  );
  return [...analysis.matchAll(line)].map((match) => ({
    id: match[1],
    blocking: match[2] === "blocking",
    resolved: match[3] === "resolved",
    summary: match[4].trim(),
  }));
}

export function parseElicitationItems(log, { prefix = "EL" } = {}) {
  if (!log) return [];
  const parts = log.split(new RegExp(`^## (${prefix}-\\d{3})\\s*$`, "m"));
  const items = [];
  for (let index = 1; index < parts.length; index += 2) {
    const body = parts[index + 1] ?? "";
    items.push({
      id: parts[index],
      className: field(body, "class"),
      resolution: field(body, "resolution"),
    });
  }
  return items;
}

function parseGaps(analysis) {
  return parseGapRegister(analysis);
}

function parseElicitation(log) {
  return parseElicitationItems(log);
}

export function validateSrs({
  srs = "",
  torText = "",
  expectedTorSha256 = "",
  elicitationLog = "",
  analysis = "",
  changedPaths = [],
}) {
  const errors = [];
  const warnings = [];

  for (const title of REQUIRED_SECTIONS) {
    if (sectionBody(srs, title) === null) {
      errors.push(`missing required section: ${title}`);
    }
  }

  const blocks = blocksById(srs);
  const seen = new Map();
  for (const block of blocks) {
    if (seen.has(block.id)) errors.push(`duplicate requirement id: ${block.id}`);
    seen.set(block.id, block);
  }

  const requirementIds = new Set(
    blocks.filter((block) => /^(FR|NFR)-/.test(block.id)).map((block) => block.id),
  );
  const torIsIds = new Set([...String(torText).matchAll(/\b(IS-\d{3})\b/g)].map((match) => match[1]));

  for (const block of blocks) {
    if (/^(FR|NFR)-/.test(block.id)) {
      const source = field(block.body, "Source") ?? "";
      const isIds = source.match(/\bIS-\d{3}\b/g) ?? [];
      const osIds = source.match(/\bOS-\d{3}\b/g) ?? [];
      if (!source) errors.push(`${block.id} is missing a Source`);
      else if (isIds.length === 0) errors.push(`${block.id} Source must cite an IS-nnn item`);
      if (osIds.length > 0) errors.push(`${block.id} Source cites excluded ${osIds.join(", ")}`);
      for (const isId of isIds) {
        if (!torIsIds.has(isId)) errors.push(`${block.id} cites unknown ${isId}`);
      }
    }
    if (block.id.startsWith("AC-")) {
      const verifies = field(block.body, "Verifies");
      if (!verifies) {
        errors.push(`${block.id} is missing a Verifies line`);
      } else {
        const refs = verifies.match(/\b(?:FR|NFR)-\d{3}\b/g) ?? [];
        if (refs.length === 0) errors.push(`${block.id} does not reference a requirement id`);
        for (const ref of refs) {
          if (!requirementIds.has(ref)) {
            errors.push(`${block.id} references unknown requirement ${ref}`);
          }
        }
      }
    }
  }

  for (const id of reintroducesOs(torText, srs)) {
    errors.push(`SRS reintroduces excluded ${id}`);
  }

  const actualHash = sha256(torText);
  if (!expectedTorSha256 || actualHash !== expectedTorSha256) {
    errors.push("TOR hash does not match the frozen baseline in project.yaml");
  }

  const torChanges = changedPaths.filter(isTorPath);
  if (torChanges.length > 0) {
    errors.push(`frozen TOR path would change: ${torChanges.join(", ")}`);
  }

  const gaps = parseGaps(analysis);
  if (!analysis.trim()) warnings.push("analysis file was not provided");
  else if (gaps.length === 0 && !/## Gap register/i.test(analysis)) {
    warnings.push("analysis has no Gap register");
  }
  for (const gap of gaps) {
    if (gap.blocking && !gap.resolved) {
      errors.push(`blocking gap remains unresolved: ${gap.id} ${gap.summary}`);
    }
  }

  for (const item of parseElicitation(elicitationLog)) {
    if (item.className === "conflict") {
      const resolution = (item.resolution ?? "").toLowerCase();
      if (resolution !== "rejected" && resolution !== "escalated") {
        errors.push(
          `${item.id} conflicts with the TOR and has no resolution (rejected or escalated)`,
        );
      }
    }
  }

  const ok = errors.length === 0;
  const report = [
    "# SRS validation report",
    "",
    `Result: ${ok ? "pass" : "fail"}`,
    "",
    "## Errors",
    "",
    ...(errors.length ? errors.map((error) => `- ${error}`) : ["- none"]),
    "",
    "## Warnings",
    "",
    ...(warnings.length ? warnings.map((warning) => `- ${warning}`) : ["- none"]),
    "",
    `TOR sha256: ${actualHash}`,
    "",
  ].join("\n");

  return { ok, errors, warnings, report, torSha256: actualHash };
}

export function assessSrsGate({ project, torText = "" }) {
  const baseline = readTorBaselineSha256(project);
  if (!baseline.ok) return baseline;
  if (sha256(torText) !== baseline.sha256) return { ok: false, reason: "tor-hash-mismatch" };
  return { ok: true, sha256: baseline.sha256, mergeCommit: baseline.mergeCommit };
}
