import { parseSimpleYaml } from "./project-yaml.mjs";
import { sha256Bytes } from "./baseline.mjs";

const PLAN_FILE = /(?:^|\/)docs\/(?:project-plan\.md|plan-elicitation-log\.md|plan-feedback\.md|project-plan-validation\.md)$/;

export function planWriteAllowed({ filePath, branch, grant }) {
  const normalized = String(filePath ?? "").replace(/\\/g, "/");
  if (!PLAN_FILE.test(normalized)) return { applies: false, allowed: true };
  const match = normalized.match(/(?:^|\/)projects\/([^/]+)\/docs\//);
  const projectId = match?.[1] ?? grant?.projectId;
  const sameProject = Boolean(grant) && grant.agent === "project-planner" && grant.projectId === projectId;
  if (!sameProject) {
    return { applies: true, allowed: false, reason: "the project plan must not be modified" };
  }
  const prefix = grant.branchPrefix;
  if (typeof branch !== "string" || !prefix || !branch.startsWith(prefix) || branch.includes("..")) {
    return {
      applies: true,
      allowed: false,
      reason: "plan writes are limited to this project's project-plan/ pull request",
    };
  }
  return { applies: true, allowed: true };
}

export async function issuePlanWriteGrant(client, projectId) {
  const { readRepoBytes, readRepoTextFile } = await import("./github.mjs");
  const repository = await client.request("GET", `/repos/${client.owner}/${client.repo}`);
  const base = repository?.default_branch;
  if (typeof base !== "string" || !base) throw new Error("repository has no default branch");
  const yaml = await readRepoTextFile(client, `projects/${projectId}/project.yaml`, base);
  if (yaml == null) return { ok: false, reason: "project.yaml is not on the default branch" };
  const project = parseSimpleYaml(yaml);
  if (project.status === "rejected") return { ok: false, reason: "the project is rejected" };
  if (project.status !== "active") return { ok: false, reason: "the project is not active" };
  if (project.tor?.status !== "approved") return { ok: false, reason: "TOR is not approved" };
  const mergeCommit = project.tor?.baseline?.mergeCommit;
  const expected = project.tor?.baseline?.sha256;
  const relative = project.tor?.path ?? "docs/tor.md";
  const torPath = `projects/${projectId}/${relative}`;
  const atMerge = await readRepoBytes(client, torPath, mergeCommit);
  const atHead = await readRepoBytes(client, torPath, base);
  if (!atMerge || !atHead || !expected) return { ok: false, reason: "tor-hash-mismatch" };
  if (sha256Bytes(atMerge) !== expected || sha256Bytes(atHead) !== expected) {
    return { ok: false, reason: "tor-hash-mismatch" };
  }
  return {
    ok: true,
    grant: { agent: "project-planner", projectId, branchPrefix: `project-plan/${projectId}/` },
  };
}
