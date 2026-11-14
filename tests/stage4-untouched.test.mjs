import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import test from "node:test";

const PLANNING_TREE = "0b96ec5ed03802f6e5f9b10b86e246a40cb82c3458986c5dd10f8df6696bce43";
const PLANNING_BLOCK = "e19480b7365279242de33d7407d1d486a2a16879781273248d61ac6851a09a64";

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else out.push(path);
  }
  return out.sort();
}

test("stage4 planning tools and planning: key unchanged since Phase 1 merge", async () => {
  const root = resolve(new URL("..", import.meta.url).pathname, "agents/planning");
  const hash = createHash("sha256");
  for (const file of await files(root)) {
    hash.update(relative(root, file));
    hash.update(await readFile(file));
  }
  assert.equal(hash.digest("hex"), PLANNING_TREE);
  const yaml = await readFile(new URL("../projects/task-tracker-lite/project.yaml", import.meta.url), "utf8");
  const block = yaml.slice(yaml.indexOf("planning:"), yaml.indexOf("implementation:"));
  assert.equal(createHash("sha256").update(block).digest("hex"), PLANNING_BLOCK);
  assert.match(block, /^planning:\n {2}path: docs\/feature-issues\.md\n {2}status: approved\n/);
});
