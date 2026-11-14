import { defineTool } from "eve/tools";
import { z } from "zod";
import { parseSimpleYaml } from "../../../../lib/project-yaml.mjs";
import { assessPhase3Gate, sha256, validateSrs } from "../../../../lib/srs-validate.mjs";
import { assessWrite } from "../../../../lib/write-policy.mjs";

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
    "Deterministically validate the hydrated SRS: required sections, unique ids, sources, acceptance links, TOR hash, TOR path changes, blocking gaps, and unresolved TOR conflicts. Writes validation-report.md.",
  inputSchema: z.object({
    projectId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    changedPaths: z.array(z.string()).optional(),
  }),
  async execute({ projectId, changedPaths }, ctx) {
    const sandbox = await ctx.getSandbox();
    const root = `projects/${projectId}`;
    const projectYaml = await sandbox.readTextFile({ path: `${root}/project.yaml` });
    if (!projectYaml) throw new Error(`Missing ${root}/project.yaml`);
    const project = parseSimpleYaml(projectYaml);
    const torPath = `${root}/${project.tor?.path ?? "docs/tor.md"}`;
    const torText = (await sandbox.readTextFile({ path: torPath })) ?? "";
    const planPath = `${root}/${project.projectPlan?.path ?? "docs/project-plan.md"}`;
    const planText = await readOptional(sandbox, planPath);
    const planSha = project.projectPlan?.baseline?.sha256;
    const planPaused = typeof planSha === "string" && planSha.length > 0 && sha256(planText) !== planSha;
    const baseline = assessPhase3Gate({ project, torText, planPaused });
    if (!baseline.ok || !baseline.sha256) {
      return {
        ok: false,
        errors: [`SRS is blocked until the approved project plan and TOR hash match: ${baseline.reason ?? "projectPlan-not-approved"}`],
        warnings: [],
        reportPath: null,
      };
    }
    const result = validateSrs({
      srs: await readOptional(sandbox, `${root}/docs/srs.md`),
      torText,
      expectedTorSha256: baseline.sha256,
      elicitationLog: await readOptional(sandbox, `${root}/docs/elicitation-log.md`),
      analysis: await readOptional(sandbox, `${root}/docs/_analysis.md`),
      changedPaths: changedPaths ?? [],
    });
    const reportPath = `${root}/docs/validation-report.md`;
    const decision = assessWrite(reportPath);
    if (!decision.allowed) throw new Error(decision.reason);
    await sandbox.writeTextFile({ path: reportPath, content: result.report });
    return {
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      reportPath,
    };
  },
});
