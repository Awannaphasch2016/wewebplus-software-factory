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

export function withProjectPlanBlock(yaml) {
  const text = String(yaml ?? "");
  if (/^projectPlan:/m.test(text)) return { yaml: text, added: false };
  const base = text.endsWith("\n") ? text : `${text}\n`;
  return { yaml: `${base}${EMPTY_PROJECT_PLAN_BLOCK}`, added: true };
}
