import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { gateApproverIds } from "../../../../lib/gate-actions.mjs";
import { issuePlanWriteGrant } from "../../../../lib/plan-guard.mjs";
import { openPlanDraft } from "../../../../lib/plan-draft.mjs";
import { githubClientFromContext } from "../../../specification/agent/lib/github-token.js";

async function readOptional(
  sandbox: { readTextFile: (input: { path: string }) => PromiseLike<string | null> },
  path: string,
) {
  try {
    return (await sandbox.readTextFile({ path })) ?? "";
  } catch {
    return "";
  }
}

export default defineTool({
  description:
    "Open a project-plan/<id>/<stamp> pull request after validation passes. Adds an empty projectPlan block when project.yaml does not have one. Never merges.",
  inputSchema: z.object({
    projectId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().optional(),
    supersededPullNumber: z.number().int().positive().optional(),
  }),
  approval: always(),
  async execute({ projectId, title, supersededPullNumber }, ctx) {
    const sandbox = await ctx.getSandbox();
    const root = `projects/${projectId}`;
    const client = await githubClientFromContext(ctx);
    const issued = await issuePlanWriteGrant(client, projectId);
    if (!issued.ok) throw new Error(issued.reason);
    const repository = await client.request("GET", `/repos/${client.owner}/${client.repo}`);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    return openPlanDraft(client, {
      projectId,
      title,
      stamp,
      branch: `project-plan/${projectId}/${stamp}`,
      grant: issued.grant,
      baseBranch: repository.default_branch,
      supersededPullNumber,
      approverIds: gateApproverIds(),
      plan: await readOptional(sandbox, `${root}/docs/project-plan.md`),
      tor: await readOptional(sandbox, `${root}/docs/tor.md`),
      elicitationLog: await readOptional(sandbox, `${root}/docs/plan-elicitation-log.md`),
      feedback: await readOptional(sandbox, `${root}/docs/plan-feedback.md`),
      projectYaml: await readOptional(sandbox, `${root}/project.yaml`),
    });
  },
});
