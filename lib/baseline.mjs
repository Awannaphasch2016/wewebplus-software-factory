import { createHash } from "node:crypto";
import { setYamlPath } from "./project-yaml.mjs";

export const BASELINE_BLOCKS = ["tor", "srs", "architecture", "projectPlan"];

const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;
const STAMP = /^[0-9]{8}T[0-9]{6}Z$/;
const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const TOR_STATUSES = new Set(["none", "approved", "rejected"]);
const BASELINE_KEYS = ["mergeCommit", "approvedAt", "approvedBy", "sha256"];
const EXTRA_KEYS = new Set(["sha256", "sourceTorCommit", "sourceSrsCommit", "sourcePlanCommit", "sourcePlanSha256"]);

const BLOCK_LABEL = {
  tor: "TOR",
  srs: "SRS",
  architecture: "architecture",
  projectPlan: "project plan",
};

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assessProjectFormat(project) {
  const tor = project?.tor;
  if (!tor || typeof tor !== "object" || Array.isArray(tor)) {
    return { ok: false, reason: "old-format" };
  }
  if (
    typeof tor.sha256 === "string" ||
    tor.status === "frozen" ||
    Object.prototype.hasOwnProperty.call(tor, "baselineId") ||
    Object.prototype.hasOwnProperty.call(tor, "gitCommit")
  ) {
    return { ok: false, reason: "old-format" };
  }
  if (!TOR_STATUSES.has(tor.status) || typeof tor.path !== "string" || !tor.path) {
    return { ok: false, reason: "old-format" };
  }
  if (!tor.baseline || typeof tor.baseline !== "object" || Array.isArray(tor.baseline)) {
    return { ok: false, reason: "old-format" };
  }
  for (const key of BASELINE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(tor.baseline, key)) {
      return { ok: false, reason: "old-format" };
    }
  }
  return { ok: true };
}

export function assessDocumentApproval(project, block) {
  const format = assessProjectFormat(project);
  if (!format.ok) return format;
  if (!BASELINE_BLOCKS.includes(block)) return { ok: false, reason: "old-format" };
  const doc = project[block];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, reason: `${block}-not-approved` };
  }
  if (doc.status === "rejected") return { ok: false, reason: `${block}-rejected` };
  if (doc.status !== "approved") return { ok: false, reason: `${block}-not-approved` };
  const baseline = doc.baseline;
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    return { ok: false, reason: `${block}-not-approved` };
  }
  if (typeof baseline.mergeCommit !== "string" || !SHA40.test(baseline.mergeCommit)) {
    return { ok: false, reason: `${block}-not-approved` };
  }
  if (typeof baseline.sha256 !== "string" || !SHA256.test(baseline.sha256)) {
    return { ok: false, reason: `${block}-not-approved` };
  }
  if (typeof doc.path !== "string" || !doc.path || doc.path.includes("..") || doc.path.startsWith("/")) {
    return { ok: false, reason: "path-refused" };
  }
  return {
    ok: true,
    mergeCommit: baseline.mergeCommit.toLowerCase(),
    sha256: baseline.sha256.toLowerCase(),
    path: doc.path,
  };
}

export function readTorBaselineSha256(project) {
  return assessDocumentApproval(project, "tor");
}

function writePath(yaml, dotted) {
  return (value) => {
    try {
      return setYamlPath(yaml, dotted, value);
    } catch {
      throw new Error(`project.yaml is not the new format: ${dotted} is missing`);
    }
  };
}

export function recordBaseline(yaml, block, { pullNumber, mergeCommit, approvedBy, approvedAt, extra = {} }) {
  if (!BASELINE_BLOCKS.includes(block)) {
    throw new Error(`unknown baseline document: ${block}`);
  }
  if (!Number.isInteger(pullNumber) || pullNumber < 1) {
    throw new Error("recording pull request is missing the approved pull request number");
  }
  if (typeof mergeCommit !== "string" || !SHA40.test(mergeCommit)) {
    throw new Error("recording pull request is missing the approved merge commit");
  }
  if (typeof approvedBy !== "string" || !approvedBy) {
    throw new Error("recording pull request is missing the decision actor");
  }
  if (typeof approvedAt !== "string" || !approvedAt) {
    throw new Error("recording pull request is missing the decision time");
  }
  let next = yaml;
  const fields = {
    status: "approved",
    pullRequest: pullNumber,
    "baseline.mergeCommit": mergeCommit.toLowerCase(),
    "baseline.approvedAt": approvedAt,
    "baseline.approvedBy": approvedBy,
  };
  for (const [key, value] of Object.entries(extra)) {
    if (!EXTRA_KEYS.has(key)) throw new Error(`unknown baseline field: ${key}`);
    fields[`baseline.${key}`] = value;
  }
  for (const [path, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    next = writePath(next, `${block}.${path}`)(value);
  }
  return next;
}

export function markProjectRejected(yaml) {
  return setYamlPath(yaml, "status", "rejected");
}

export function blockLabel(block) {
  const label = BLOCK_LABEL[block];
  if (!label) throw new Error(`unknown baseline document: ${block}`);
  return label;
}

export function recordingBranchName(block, projectId, stamp) {
  if (!BASELINE_BLOCKS.includes(block)) throw new Error(`unknown baseline document: ${block}`);
  if (!PROJECT_ID.test(projectId)) throw new Error(`invalid project id: ${projectId}`);
  if (!STAMP.test(stamp)) throw new Error(`invalid baseline stamp: ${stamp}`);
  if (block === "tor") return `tor/${projectId}/baseline/${stamp}`;
  if (block === "srs") return `spec/${projectId}/srs-baseline/${stamp}`;
  if (block === "projectPlan") return `project-plan/${projectId}/baseline/${stamp}`;
  return `arch/${projectId}/baseline/${stamp}`;
}

export function sourceBranchMatches(block, projectId, headRef) {
  if (!BASELINE_BLOCKS.includes(block) || !PROJECT_ID.test(projectId)) return false;
  if (typeof headRef !== "string" || !headRef || headRef.includes("..") || headRef.includes("//")) {
    return false;
  }
  if (block === "srs") return headRef.startsWith(`spec/${projectId}/srs/`);
  if (block === "projectPlan") {
    return headRef.startsWith(`project-plan/${projectId}/`) && !headRef.includes("/baseline/");
  }
  const prefix = block === "tor" ? `tor/${projectId}/` : `arch/${projectId}/`;
  return headRef.startsWith(prefix) && !headRef.startsWith(`${prefix}baseline/`);
}
