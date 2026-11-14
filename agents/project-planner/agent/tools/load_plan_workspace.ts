import { defineTool } from "eve/tools";
import { z } from "zod";
import { slackUserIdFromAuth } from "../../../../lib/authz.mjs";
import { loadApprovedPlan, loadApprovedTor } from "../../../../lib/project-files.mjs";
import { renderHashMismatchAlert } from "../../../../lib/slack-gate.mjs";
import { factoryConfig } from "../../../../generated/config.js";
import { githubClientFromContext } from "../../../specification/agent/lib/github-token.js";

export default defineTool({
  description:
    "Load an approved TOR and, when present, the project plan. A TOR hash mismatch stops the load and returns an alert with no buttons. A paused plan can still be loaded for a revision.",
  inputSchema: z.object({
    projectId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    ref: z.string().min(1).optional(),
  }),
  async execute({ projectId, ref }, ctx) {
    const client = await githubClientFromContext(ctx);
    const actor = {
      projectId,
      headRef: ref,
      userId: slackUserIdFromAuth(ctx.session.auth.current),
      allowedUserIds: factoryConfig.allowedUserIds,
    };
    const tor = await loadApprovedTor(client, actor);
    if (tor.reason === "tor-hash-mismatch") {
      return { ok: false, stop: true, alert: renderHashMismatchAlert({ projectId, reason: tor.reason }) };
    }
    if (tor.denied || tor.stop) return { ok: false, stop: true, reason: tor.reason };
    const plan = await loadApprovedPlan(client, actor);
    const sandbox = await ctx.getSandbox();
    for (const [path, content] of Object.entries({ ...(tor.files ?? {}), ...(plan.files ?? {}) })) {
      await sandbox.writeTextFile({ path, content: String(content) });
    }
    return { ok: true, stop: false, paused: plan.paused === true, reason: plan.paused ? plan.reason : null };
  },
});
