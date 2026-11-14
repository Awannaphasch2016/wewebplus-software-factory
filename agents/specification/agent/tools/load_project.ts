import { defineTool } from "eve/tools";
import { z } from "zod";
import { slackUserIdFromAuth } from "../../../../lib/authz.mjs";
import { loadApprovedPlan, loadApprovedTor } from "../../../../lib/project-files.mjs";
import { assessPhase3Gate } from "../../../../lib/srs-validate.mjs";
import { specificationConfig } from "../../../../generated/config.js";
import { githubClientFromContext } from "../lib/github-token.js";

export default defineTool({
  description:
    "Authorize the current Slack user, then load one project's files from the approved TOR baseline. Stops when the project uses the retired TOR format or docs/tor.md does not match tor.baseline.sha256.",
  inputSchema: z.object({
    projectId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  }),
  async execute({ projectId }, ctx) {
    const client = await githubClientFromContext(ctx);
    const loaded = await loadApprovedTor(client, {
      projectId,
      userId: slackUserIdFromAuth(ctx.session.auth.current),
      allowedUserIds: specificationConfig.allowedUserIds,
    });
    if (loaded.denied || loaded.stop) {
      return {
        denied: loaded.denied,
        fetch: false,
        stop: true,
        projectId,
        reason: loaded.reason,
      };
    }
    const plan = await loadApprovedPlan(client, {
      projectId,
      userId: slackUserIdFromAuth(ctx.session.auth.current),
      allowedUserIds: specificationConfig.allowedUserIds,
    });
    const phase = assessPhase3Gate({
      project: loaded.project,
      torText: loaded.documentText ?? "",
      planPaused: plan.paused === true,
    });
    if (!phase.ok) {
      return { denied: false, fetch: false, stop: true, projectId, reason: phase.reason };
    }
    const sandbox = await ctx.getSandbox();
    for (const [path, content] of Object.entries(loaded.files ?? {})) {
      await sandbox.writeTextFile({ path, content });
    }
    const baseline = loaded.project?.tor?.baseline ?? {};
    return {
      denied: false,
      fetch: true,
      stop: false,
      projectId,
      tor: {
        path: loaded.project?.tor?.path,
        status: loaded.project?.tor?.status,
        pullRequest: loaded.project?.tor?.pullRequest ?? null,
        branch: loaded.project?.tor?.branch ?? null,
        baseline: {
          mergeCommit: baseline.mergeCommit ?? null,
          approvedAt: baseline.approvedAt ?? null,
          approvedBy: baseline.approvedBy ?? null,
          sha256: baseline.sha256 ?? null,
        },
      },
    };
  },
});
