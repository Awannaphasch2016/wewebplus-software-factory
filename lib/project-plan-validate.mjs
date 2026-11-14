import { readFileSync } from "node:fs";
import { parseElicitationItems } from "./srs-validate.mjs";
import { citesUnknownIs, parseScopeIds } from "./scope-ids.mjs";

export const PLAN_SECTIONS = [
  "1. About this plan",
  "2. Scope",
  "3. How we will work together",
  "4. Planned work",
  "5. Economic evaluation",
  "6. Risks",
  "7. Documents we will produce",
];

const MINIMUM_STATEMENTS = [
  "weekly Specification → Research → Prototype cycle",
  "at least one complete cycle per week",
  "evidence referenced from the Design Prototype",
  "requirements-gap route and a design-gap route",
  "the TOR is never changed",
];

const DENYLIST = [
  [/project\.yaml/i, "project.yaml"],
  [/pull request/i, "pull request"],
  [/PR #\d+/i, "PR #"],
  [/\bEve\b/, "Eve"],
  [/gate card/i, "gate card"],
  [/\b(?:EL|TEL|PEL)-\d+/, "EL-/TEL-/PEL-"],
  [/\b[0-9a-f]{40}\b/i, "merge commit SHA"],
  [/(?:^|\s)(?:setup|tor|project-plan|plan)\/[a-z0-9]/i, "branch prefix"],
  [/\b(?:specification|planning|project planner|tor) agent\b/i, "agent name"],
];

const DEFAULT_APPROVERS = ["U0CFRUV378D"];

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replaceAll("→", "->")
    .replace(/\s+/g, " ");
}

function sectionSpan(markdown, title) {
  const pattern = new RegExp(`^## ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const match = pattern.exec(markdown);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = rest.search(/^## /m);
  return { index: match.index, body: next === -1 ? rest : rest.slice(0, next) };
}

function field(body, name) {
  const match = String(body ?? "").match(
    new RegExp(`^\\s*(?:[-*]\\s+)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:\\s*(.*)$`, "im"),
  );
  return match ? match[1].trim() : null;
}

export function parsePlanElicitation(log) {
  return parseElicitationItems(log, { prefix: "PEL" }).map((item) => ({
    ...item,
    field: field(item.body ?? "", "field") ?? fieldFromSplit(log, item.id, "field"),
    value: fieldFromSplit(log, item.id, "value"),
    responder: fieldFromSplit(log, item.id, "responder"),
    resolution: (fieldFromSplit(log, item.id, "resolution") ?? item.resolution ?? "").toLowerCase(),
  }));
}

function fieldFromSplit(log, id, name) {
  const parts = String(log ?? "").split(new RegExp(`^## ${id}\\s*$`, "m"));
  return field(parts[1] ?? "", name);
}

function slackUser(responder) {
  const match = String(responder ?? "").match(/:([UW][A-Z0-9]+)$/);
  return match ? match[1] : null;
}

function tableRows(body) {
  return String(body ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && !/^\|\s*-+/.test(line) && !/^\|\s*Cycle\s*\|/i.test(line) && !/^\|\s*ID\s*\|/i.test(line) && !/^\|\s*Document\s*\|/i.test(line) && !/^\|\s*Week\s*\|/i.test(line) && !/^\|\s*Version\s*\|/i.test(line) && !/^\|\s*After\s*\|/i.test(line));
}

function cells(line) {
  return line.split("|").slice(1, -1).map((cell) => cell.trim());
}

function statementPresent(section, phrase) {
  const normalized = normalize(section);
  const expected = normalize(phrase);
  if (normalized.includes(expected)) return true;
  if (phrase.startsWith("weekly") && normalized.includes("specification") && normalized.includes("research") && normalized.includes("prototype")) {
    return normalized.indexOf("specification") < normalized.indexOf("research") && normalized.indexOf("research") < normalized.indexOf("prototype");
  }
  if (phrase.startsWith("at least one") && /at least one\b.*\bcycle\b.*\bweek/.test(normalized)) return true;
  if (phrase.startsWith("evidence") && normalized.includes("evidence") && normalized.includes("design prototype")) return true;
  if (phrase.startsWith("requirements-gap") || phrase.includes("requirements-gap")) {
    return normalized.includes("requirements gap") && normalized.includes("design gap");
  }
  if (phrase.startsWith("the TOR is never changed")) {
    return /tor is never changed|do not change the agreed tor|change to the tor means/.test(normalized);
  }
  return false;
}

export function bundledPlanGuideline() {
  return readFileSync(new URL("../knowledge/guidelines/project-plan.md", import.meta.url), "utf8");
}

export function validateProjectPlan({
  plan = "",
  tor = "",
  elicitationLog = "",
  approverIds = DEFAULT_APPROVERS,
} = {}) {
  const errors = [];
  const sections = PLAN_SECTIONS.map((title) => ({ title, span: sectionSpan(plan, title) }));
  let previous = -1;
  for (const section of sections) {
    if (!section.span) {
      errors.push(`missing section: ${section.title}`);
      continue;
    }
    if (section.span.index < previous) errors.push(`section out of order: ${section.title}`);
    previous = section.span.index;
  }
  const body = (title) => sections.find((section) => section.title === title)?.span?.body ?? "";
  const scope = parseScopeIds(tor);
  const knownIs = new Set(scope.inScope);

  const scopeBody = body("2. Scope");
  const inScopeLine = scopeBody.match(/in scope:[^\n]*/i)?.[0] ?? "";
  const outScopeLine = scopeBody.match(/out of scope:[^\n]*/i)?.[0] ?? "";
  if (sections.find((section) => section.title === "2. Scope")?.span && !/\bIS-\d{3}\b/.test(inScopeLine)) {
    errors.push("§2 without IS ids");
  }
  for (const id of inScopeLine.match(/\bOS-\d{3}\b/g) ?? []) {
    errors.push(`OS id as in-scope: ${id}`);
  }
  for (const id of citesUnknownIs(inScopeLine, knownIs)) errors.push(`§2 cites unknown ${id}`);

  const ways = body("3. How we will work together");
  if (sections.find((section) => section.title === "3. How we will work together")?.span) {
    for (const phrase of MINIMUM_STATEMENTS) {
      if (!statementPresent(ways, phrase)) errors.push(`missing minimum statement: ${phrase}`);
    }
  }

  const cycles = body("4. Planned work");
  const cycleRows = tableRows(cycles).filter((line) => /\bI-\d{3}\b/.test(line));
  if (sections.find((section) => section.title === "4. Planned work")?.span && cycleRows.length === 0) {
    errors.push("cycle without IS");
  }
  const covered = new Set();
  for (const row of cycleRows) {
    const ids = row.match(/\bIS-\d{3}\b/g) ?? [];
    if (ids.length === 0) errors.push(`cycle without IS: ${(row.match(/\bI-\d{3}\b/) ?? ["cycle"])[0]}`);
    for (const id of ids) covered.add(id);
    for (const id of row.match(/\bOS-\d{3}\b/g) ?? []) errors.push(`OS id as in-scope: ${id}`);
  }
  if (sections.find((section) => section.title === "4. Planned work")?.span) {
    for (const id of knownIs) {
      if (!covered.has(id)) errors.push(`uncovered IS: ${id}`);
    }
  }

  const economics = body("5. Economic evaluation");
  const effortRows = tableRows(economics).filter((line) => /\bI-\d{3}\b/.test(line));
  const pel = parsePlanElicitation(elicitationLog);
  const approvers = new Set(approverIds);
  let finalPresent = false;
  for (const row of effortRows) {
    const rowCells = cells(row);
    const cycle = (row.match(/\bI-\d{3}\b/) ?? [""])[0];
    const suggestion = rowCells[3] ?? "";
    const finalCell = rowCells[4] ?? "";
    if (suggestion && suggestion !== "—" && suggestion !== "-" && !/suggestion/i.test(suggestion)) {
      errors.push("suggested duration not labelled");
    }
    for (const id of row.match(/\bOS-\d{3}\b/g) ?? []) errors.push(`OS id as in-scope: ${id}`);
    if (!finalCell || finalCell === "—" || finalCell === "-" || /to be agreed/i.test(finalCell) || /^\{/.test(finalCell)) {
      continue;
    }
    finalPresent = true;
    const key = `s5.work.${cycle}.final`;
    const matches = pel.filter((item) => item.field === key && item.value === finalCell);
    const approved = matches.find((item) => item.resolution === "approved" && approvers.has(slackUser(item.responder)));
    if (!approved) {
      const inputOnly = matches.find((item) => item.resolution === "input" || (item.responder && !approvers.has(slackUser(item.responder))));
      if (inputOnly && !matches.some((item) => item.resolution === "approved")) {
        errors.push("PEL answer from a non-approver cannot satisfy a final figure");
      } else {
        errors.push("final figure without matching PEL answer");
      }
    }
  }
  if (/day rate[^\n]*to be agreed/i.test(economics)) {
    // allowed
  }
  if (finalPresent) {
    const name = field(economics, "Name");
    const date = field(economics, "Date");
    if (!name) errors.push("final figures without estimator name");
    if (!date) errors.push("final figures without estimator date");
  }

  const risks = body("6. Risks");
  if (sections.find((section) => section.title === "6. Risks")?.span) {
    const riskRows = tableRows(risks).filter((line) => /\bR-\d{3}\b/.test(line));
    const none = /none identified/i.test(risks);
    const confirmed = pel.some((item) => item.field === "s6.risks" && item.resolution === "approved");
    if (riskRows.length === 0 && !(none && confirmed)) errors.push("empty §6 without confirmed none");
  }

  const documents = body("7. Documents we will produce");
  if (sections.find((section) => section.title === "7. Documents we will produce")?.span) {
    if (!/WP-PS-SOW-01|Terms of Reference/i.test(documents)) errors.push("§7 missing TOR");
    if (!/\bSRS\b|Requirements specification/i.test(documents)) errors.push("§7 missing SRS");
    if (!/Design/i.test(documents)) errors.push("§7 missing Design");
  }

  const about = body("1. About this plan");
  if (sections.find((section) => section.title === "1. About this plan")?.span) {
    const plain = about.replace(/\*\*/g, "");
    if (!/status:\s*(draft|agreed)\b/i.test(plain)) errors.push("§1 status must be draft or agreed");
    if (!/agreed by/i.test(about)) errors.push("§1 version history is missing");
    for (const line of about.split("\n")) {
      if (!/^\|/.test(line) || /agreed by \(team\)/i.test(line) || /^\|\s*-+/.test(line)) continue;
      const agreedBy = cells(line)[2] ?? "";
      if (/\bU[A-Z0-9]{6,}\b/.test(agreedBy) || /\bbot\b/i.test(agreedBy)) {
        errors.push("§1 agreed-by cell contains a Slack id or bot");
      }
    }
  }

  const lines = String(plan).split("\n");
  lines.forEach((line, index) => {
    for (const [pattern, label] of DENYLIST) {
      if (pattern.test(line)) errors.push(`factory term on line ${index + 1}: ${label}`);
    }
  });

  return { ok: errors.length === 0, errors };
}
