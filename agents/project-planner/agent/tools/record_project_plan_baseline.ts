import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { gateApproverIds } from "../../../../lib/gate-actions.mjs";
import { recordProjectPlanBaseline } from "../../../../lib/plan-draft.mjs";
import { githubClientFromContext } from "../../../specification/agent/lib/github-token.js";

export default defineTool({
  description:
    "After the plan pull request is merged, record the post-edit plan hash and open the baseline pull request. approvedBy comes from the gate decision. Never asks the model for the hash.",
  inputSchema: z.object({
    projectId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    pullNumber: z.number().int().positive(),
  }),
  approval: always(),
  async execute({ projectId, pullNumber }, ctx) {
    const client = await githubClientFromContext(ctx);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    return recordProjectPlanBaseline(client, {
      projectId,
      pullNumber,
      stamp,
      allowedUserIds: gateApproverIds(),
      signingSecret: process.env.SLACK_SIGNING_SECRET,
    });
  },
});
