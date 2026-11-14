import { defineTool } from "eve/tools";
import { z } from "zod";
import { validateProjectPlan } from "../../../../lib/project-plan-validate.mjs";
import { assessWrite } from "../../../../lib/write-policy.mjs";
import { gateApproverIds } from "../../../../lib/gate-actions.mjs";

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
  description: "Check the project plan, PEL log, and feedback. Writes docs/project-plan-validation.md. Does not open a pull request.",
  inputSchema: z.object({
    projectId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  }),
  async execute({ projectId }, ctx) {
    const sandbox = await ctx.getSandbox();
    const root = `projects/${projectId}`;
    const result = validateProjectPlan({
      plan: await readOptional(sandbox, `${root}/docs/project-plan.md`),
      tor: await readOptional(sandbox, `${root}/docs/tor.md`),
      elicitationLog: await readOptional(sandbox, `${root}/docs/plan-elicitation-log.md`),
      approverIds: gateApproverIds(),
    });
    const reportPath = `${root}/docs/project-plan-validation.md`;
    const decision = assessWrite(reportPath, {
      planGrant: { agent: "project-planner", projectId, branchPrefix: `project-plan/${projectId}/` },
      branch: `project-plan/${projectId}/draft`,
    });
    if (!decision.allowed) throw new Error(decision.reason);
    const content = result.ok ? "pass\n" : result.errors.map((error) => `- ${error}`).join("\n");
    await sandbox.writeTextFile({ path: reportPath, content });
    return { ok: result.ok, errors: result.errors, reportPath };
  },
});
