import { parseSimpleYaml, setYamlPath } from "./project-yaml.mjs";

export const EMPTY_PROJECT_PLAN_BLOCK = `projectPlan:
  path: docs/project-plan.md
  status: none
  pullRequest: null
  branch: null
  baseline:
    mergeCommit: null
    approvedAt: null
    approvedBy: null
    sha256: null
    sourceTorCommit: null
`;

export function ensureSrsPlanFields(yaml) {
  let next = String(yaml ?? "");
  if (!/^ {4}sourcePlanCommit:/m.test(next)) {
    next = next.replace(/^ {4}sourceTorCommit:.*$/m, (line) => `${line}\n    sourcePlanCommit: null`);
  }
  if (!/^ {4}sourcePlanSha256:/m.test(next)) {
    next = next.replace(/^ {4}sourcePlanCommit:.*$/m, (line) => `${line}\n    sourcePlanSha256: null`);
  }
  return next;
}

export function ensureSrsReviewFields(yaml) {
  const next = ensureSrsPlanFields(yaml);
  if (/^ {2}review:/m.test(next)) return next;
  return next.replace(
    /^architecture:/m,
    `  review:\n    required: false\n    reason: null\n    flaggedAt: null\n    previousSourcePlanCommit: null\n    newPlanCommit: null\narchitecture:`,
  );
}

export function withProjectPlanBlock(yaml) {
  const text = String(yaml ?? "");
  if (/^projectPlan:/m.test(text)) return { yaml: text, added: false };
  const base = text.endsWith("\n") ? text : `${text}\n`;
  return { yaml: `${base}${EMPTY_PROJECT_PLAN_BLOCK}`, added: true };
}

export function flagSrsForNewPlan(yaml, { newPlanCommit, flaggedAt }) {
  const project = parseSimpleYaml(yaml);
  if (project.srs?.status !== "approved") return { flagged: false, yaml };
  const previous = project.srs.baseline?.sourcePlanCommit ?? null;
  if (previous === newPlanCommit) return { flagged: false, yaml };
  let next = ensureSrsReviewFields(yaml);
  next = setYamlPath(next, "srs.status", "needs-review");
  next = setYamlPath(next, "srs.review.required", true);
  next = setYamlPath(next, "srs.review.reason", "project-plan-version-changed");
  next = setYamlPath(next, "srs.review.flaggedAt", flaggedAt);
  next = setYamlPath(next, "srs.review.previousSourcePlanCommit", previous);
  next = setYamlPath(next, "srs.review.newPlanCommit", newPlanCommit);
  return { flagged: true, yaml: next };
}

export function clearSrsReviewFlag(yaml) {
  if (!/^ {2}review:/m.test(String(yaml ?? ""))) return yaml;
  let next = setYamlPath(yaml, "srs.status", "approved");
  next = setYamlPath(next, "srs.review.required", false);
  return setYamlPath(next, "srs.review.reason", null);
}
