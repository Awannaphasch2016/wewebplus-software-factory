import { createHash } from "node:crypto";
import { readVerifiedDecision, sealMergeAuthorization } from "./merge-auth.mjs";
import { planHeaderDiffAllowed } from "./plan-header.mjs";
import { parseFencedRecord } from "./gate-decision.mjs";

export const RECORDING_KIND = "factory-recording";
export const RECORDING_DOCUMENTS = ["tor", "srs", "architecture", "projectPlan"];

const SHA = /^[0-9a-f]{40}$/i;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;
const PROJECT_YAML = /^projects\/([a-z0-9][a-z0-9-]*)\/project\.yaml$/;

const RECORDING_FIELDS = [
  "status",
  "pullRequest",
  "baseline.mergeCommit",
  "baseline.approvedAt",
  "baseline.approvedBy",
  "baseline.sha256",
  "baseline.sourceTorCommit",
  "baseline.sourceSrsCommit",
];

export function renderRecordingReference(reference) {
  return [
    "Records an already approved decision. This pull request is not a new human approval.",
    "",
    "```json",
    JSON.stringify({ ...reference, schema: 1, kind: RECORDING_KIND }, null, 2),
    "```",
    "",
  ].join("\n");
}

export function parseRecordingReference(body) {
  const parsed = parseFencedRecord(body, RECORDING_KIND);
  if (!parsed) return null;
  if (parsed.schema !== 1) return null;
  if (!RECORDING_DOCUMENTS.includes(parsed.document)) return null;
  if (typeof parsed.projectId !== "string" || !PROJECT_ID.test(parsed.projectId)) return null;
  if (!Number.isInteger(parsed.sourcePr) || parsed.sourcePr < 1) return null;
  if (typeof parsed.sourceHeadSha !== "string" || !SHA.test(parsed.sourceHeadSha)) return null;
  if (typeof parsed.sourceMergeSha !== "string" || !SHA.test(parsed.sourceMergeSha)) return null;
  if (typeof parsed.repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(parsed.repo)) return null;
  return {
    document: parsed.document,
    projectId: parsed.projectId,
    sourcePr: parsed.sourcePr,
    sourceHeadSha: parsed.sourceHeadSha,
    sourceMergeSha: parsed.sourceMergeSha,
    repo: parsed.repo,
    reviewOnly: parsed.reviewOnly === true,
  };
}

function isPlain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function changedYamlPaths(before, after, prefix = "") {
  const paths = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const left = before?.[key];
    const right = after?.[key];
    if (isPlain(left) && isPlain(right)) {
      paths.push(...changedYamlPaths(left, right, path));
      continue;
    }
    if (!sameValue(left, right)) paths.push(path);
  }
  return paths;
}

function refuse(reason) {
  return { ok: false, reason };
}

export function recordingYamlIssue(text) {
  if (typeof text !== "string" || !text.trim()) return "yaml trick";
  if (text.includes("\t") || text.includes("\0")) return "yaml trick";
  const stack = [{ indent: -1, keys: new Set(), kind: "object" }];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (/^(---|\.\.\.)\s*$/.test(raw.trim())) return "yaml trick";
    const indent = raw.match(/^ */)[0].length;
    if (indent !== raw.length - raw.trimStart().length) return "yaml trick";
    const line = raw.trim();
    if (/[&*!]/.test(line) || line.includes("<<") || /[{}\[\]]/.test(line)) return "yaml trick";
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (line.startsWith("- ")) {
      if (parent.kind !== "array") return "yaml trick";
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) return "yaml trick";
    const key = line.slice(0, colon).trim().replace(/^["']|["']$/g, "");
    if (!/^[A-Za-z0-9_-]+$/.test(key)) return "yaml trick";
    if (parent.kind !== "object" || parent.keys.has(key)) return "yaml trick";
    parent.keys.add(key);
    const rest = line.slice(colon + 1).trim();
    if (rest === "") {
      let next = index + 1;
      while (next < lines.length && (!lines[next].trim() || lines[next].trim().startsWith("#"))) next += 1;
      const nextLine = lines[next] ?? "";
      const nextIndent = nextLine.match(/^ */)[0].length;
      const isArray = nextIndent > indent && nextLine.trim().startsWith("- ");
      stack.push({ indent, keys: new Set(), kind: isArray ? "array" : "object" });
    }
  }
  return null;
}

function valueAt(root, dotted) {
  return dotted.split(".").reduce((current, key) => (current == null ? undefined : current[key]), root);
}

export function evaluateRecordingPullRequest({
  files,
  reference,
  approval,
  sourcePull,
  beforeYaml,
  afterYaml,
  beforeText,
  afterText,
  beforePlan,
  afterPlan,
}) {
  if (recordingYamlIssue(beforeText) || recordingYamlIssue(afterText)) return refuse("yaml trick");
  if (reference?.document === "projectPlan") {
    if (!Array.isArray(files) || files.length !== 2) return refuse("extra file");
    const paths = files.map((file) => String(file.path ?? file.filename ?? ""));
    if (!paths.some((path) => path.endsWith("project.yaml"))) return refuse("extra file");
    if (!paths.some((path) => path.endsWith("docs/project-plan.md"))) return refuse("extra file");
    if (!planHeaderDiffAllowed(beforePlan, afterPlan)) return refuse("any other plan byte refused");
    const hash = createHash("sha256").update(String(afterPlan ?? ""), "utf8").digest("hex");
    if (afterYaml?.projectPlan?.baseline?.sha256 !== hash) return refuse("wrong SHA");
  } else if (!Array.isArray(files) || files.length !== 1) return refuse("extra file");
  const file = files.find((item) => PROJECT_YAML.test(String(item.path ?? item.filename ?? ""))) ?? files[0];
  if (file.status && file.status !== "modified" && file.status !== "added") return refuse("extra file");
  const match = PROJECT_YAML.exec(String(file.path ?? file.filename ?? ""));
  if (!match) return refuse("extra file");
  if (!reference) return refuse("wrong PR ref");
  if (match[1] !== reference.projectId) return refuse("extra file");
  if (!beforeYaml || !afterYaml) return refuse("wrong field");

  const paths = changedYamlPaths(beforeYaml, afterYaml);
  if (paths.length === 0) return refuse("wrong field");
  const allowed = new Set(RECORDING_FIELDS.map((field) => `${reference.document}.${field}`));
  if (paths.some((path) => !allowed.has(path))) return refuse("wrong field");

  const block = afterYaml[reference.document];
  if (!isPlain(block)) return refuse("wrong field");
  if (block.pullRequest !== reference.sourcePr) return refuse("wrong PR ref");
  if (block.baseline?.mergeCommit !== reference.sourceMergeSha) return refuse("wrong SHA");

  const decision = readVerifiedDecision(approval);
  if (!decision) return refuse("missing approval");
  if (decision.action !== "approve") return refuse("missing approval");
  if (decision.repo !== reference.repo) return refuse("wrong PR ref");
  if (decision.pr !== reference.sourcePr) return refuse("wrong PR ref");
  if (decision.projectId !== reference.projectId) return refuse("wrong PR ref");
  if (!sourcePull || sourcePull.repo !== reference.repo || sourcePull.number !== reference.sourcePr) {
    return refuse("wrong PR ref");
  }
  if (decision.headSha !== reference.sourceHeadSha || sourcePull.headSha !== reference.sourceHeadSha) {
    return refuse("wrong SHA");
  }
  if (sourcePull.merged !== true || sourcePull.mergeCommitSha !== reference.sourceMergeSha) {
    return refuse("wrong SHA");
  }
  if (valueAt(afterYaml, `${reference.document}.baseline.mergeCommit`) !== reference.sourceMergeSha) {
    return refuse("wrong SHA");
  }
  const accepted = {
    ok: true,
    reason: "recording diff matches the approved decision",
    paths,
  };
  if (Number.isInteger(reference.recordingPr) && SHA.test(reference.recordingHeadSha ?? "")) {
    accepted.authorization = sealMergeAuthorization({
      kind: "recording",
      repo: reference.repo,
      pr: reference.recordingPr,
      headSha: reference.recordingHeadSha,
    });
  }
  return accepted;
}
