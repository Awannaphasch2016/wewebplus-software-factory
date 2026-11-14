import { defineAgent } from "eve";

const model = process.env.PROJECT_PLANNER_MODEL ?? process.env.SPECIFICATION_AGENT_MODEL ?? "anthropic/claude-opus-5.5";

export default defineAgent({
  model,
  approval: ({ toolName }) => {
    if (toolName === "create_project_plan_pull_request" || toolName === "record_project_plan_baseline") {
      return "user-approval";
    }
    return undefined;
  },
});
