import { defineTool } from "eve/tools";
import { writeFile } from "eve/tools/write_file";
import { assessWrite } from "../../../../lib/write-policy.mjs";

export default defineTool({
  ...writeFile,
  description: "Write a project draft. Refuses the raw TOR upload, the frozen TOR, project.yaml, and knowledge.",
  async execute(input, ctx) {
    const decision = assessWrite(input.filePath);
    if (!decision.allowed) throw new Error(decision.reason);
    return (await writeFile.execute(input, ctx)) as { existed: boolean; path: string };
  },
});
