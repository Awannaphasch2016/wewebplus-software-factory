import { createHash } from "node:crypto";
import { closePullRequest, mergeRecordingPullRequest, openReviewedPullRequest, recordApprovedBaseline } from "./github.mjs";
import { validateProjectPlan } from "./project-plan-validate.mjs";
import { renderGateCard } from "./slack-gate.mjs";
import { withProjectPlanBlock } from "./plan-yaml.mjs";

export function planGateSummary({ plan, tor, elicitationLog }) {
  const validation = validateProjectPlan({ plan, tor, elicitationLog });
  const cycles = plan.match(/\bI-\d{3}\b/g) ?? [];
  const covered = new Set(plan.match(/\bIS-\d{3}\b/g) ?? []);
  const known = new Set(tor.match(/\bIS-\d{3}\b/g) ?? []);
  const totals = [...plan.matchAll(/\|\s*\*?\*?Total\*?\*?\s*\|[^\n]*\|\s*([^|]+)\|/gi)].map((match) => match[1].trim());
  return [
    `Validation: ${validation.ok ? "pass" : "fail"}`,
    `Cycles: ${new Set(cycles).size}`,
    `IS coverage: ${[...known].filter((id) => covered.has(id)).length}/${known.size}`,
    `Section 5 total person-days: ${totals[0] ?? "not set"}`,
  ].join("\n");
}

export function projectYamlForPlanPullRequest(yaml) {
  const block = withProjectPlanBlock(yaml);
  if (!block.added) return { include: false, yaml };
  return { include: true, yaml: block.yaml };
}

export async function openPlanDraft(client, input) {
  if (!String(input.branch ?? "").startsWith(`project-plan/${input.projectId}/`) || String(input.branch).startsWith("plan/")) {
    throw new Error("branch prefix is project-plan/ not plan/");
  }
  const validation = validateProjectPlan({
    plan: input.plan,
    tor: input.tor,
    elicitationLog: input.elicitationLog,
    approverIds: input.approverIds,
  });
  if (!validation.ok) {
    throw new Error(`Refusing to open a project plan pull request while validation fails: ${validation.errors.join("; ")}`);
  }
  if (input.supersededPullNumber) await closePullRequest(client, input.supersededPullNumber);
  const prefix = `projects/${input.projectId}/docs/`;
  const files = [
    { path: `${prefix}project-plan.md`, content: input.plan },
    { path: `${prefix}plan-elicitation-log.md`, content: input.elicitationLog },
    { path: `${prefix}plan-feedback.md`, content: input.feedback ?? "" },
    { path: `${prefix}project-plan-validation.md`, content: validation.errors.join("\n") || "pass\n" },
  ];
  let projectYaml = input.projectYaml ?? "";
  const block = projectYamlForPlanPullRequest(projectYaml);
  if (block.include) {
    files.push({ path: `projects/${input.projectId}/project.yaml`, content: block.yaml });
    projectYaml = block.yaml;
  }
  const opened = await openReviewedPullRequest(client, {
    projectId: input.projectId,
    baseBranch: input.baseBranch,
    branch: input.branch,
    title: input.title || `Project plan for ${input.projectId}`,
    messagePrefix: "Draft project plan",
    planGrant: input.grant,
    files,
    body: `Project plan for \`${input.projectId}\`. Based on the agreed TOR. This pull request does not merge itself.`,
  });
  const card = renderGateCard({
    projectId: input.projectId,
    stage: "project-plan",
    repo: `${client.owner}/${client.repo}`,
    pr: opened.number,
    headSha: opened.headSha,
    humanCommits: input.humanCommits ?? [],
    note: planGateSummary({ plan: input.plan, tor: input.tor, elicitationLog: input.elicitationLog }),
  });
  return { ...opened, card, projectYaml, addedProjectPlanBlock: block.include, merged: false, validation };
}

export async function recordProjectPlanBaseline(client, input) {
  const opened = await recordApprovedBaseline(client, { ...input, block: "projectPlan" });
  const merged = await mergeRecordingPullRequest(client, {
    pullNumber: opened.number,
    allowedUserIds: input.allowedUserIds,
    signingSecret: input.signingSecret,
  });
  return { ...opened, merged, postEditSha256: opened.sha256 };
}

export function planSha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}
