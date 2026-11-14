import { authorizeProject, authorizeSlackActor } from "./authz.mjs";
import { assessDocumentApproval, assessProjectFormat, sha256Bytes } from "./baseline.mjs";
import { assertInsideProject, readRepoBytes } from "./github.mjs";
import { parseSimpleYaml } from "./project-yaml.mjs";

const SHA40 = /^[0-9a-f]{40}$/i;
const PULL_REF = /^pull\/([1-9]\d*)$/;

function stop(reason, extra = {}) {
  return { denied: false, fetch: false, stop: true, reason, files: {}, ...extra };
}

function denied(reason) {
  return { denied: true, fetch: false, stop: true, reason, files: {} };
}

export function classifyRef(ref) {
  if (typeof ref !== "string") return { ok: false, reason: "ref-not-found" };
  const trimmed = ref.trim();
  if (/^pull\/\d+$/.test(trimmed)) {
    const pull = PULL_REF.exec(trimmed);
    if (!pull) return { ok: false, reason: "ref-not-found" };
    return { ok: true, kind: "pull", pullNumber: Number(pull[1]) };
  }
  if (SHA40.test(trimmed)) return { ok: true, kind: "commit", sha: trimmed.toLowerCase() };
  if (
    !/^[A-Za-z0-9._/-]+$/.test(trimmed) ||
    trimmed.includes("..") ||
    trimmed.includes("//") ||
    trimmed.startsWith("/") ||
    trimmed.endsWith("/")
  ) {
    return { ok: false, reason: "ref-not-found" };
  }
  return { ok: true, kind: "branch", branch: trimmed };
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function resolveRef(client, ref) {
  const classified = classifyRef(ref);
  if (!classified.ok) return classified;
  if (classified.kind === "commit") return { ok: true, sha: classified.sha };
  if (classified.kind === "pull") {
    const pull = await client.request(
      "GET",
      `/repos/${client.owner}/${client.repo}/pulls/${classified.pullNumber}`,
      { allowNotFound: true },
    );
    const sha = pull?.head?.sha;
    if (!pull || typeof sha !== "string" || !SHA40.test(sha)) return { ok: false, reason: "ref-not-found" };
    return { ok: true, sha: sha.toLowerCase() };
  }
  const payload = await client.request(
    "GET",
    `/repos/${client.owner}/${client.repo}/git/ref/heads/${classified.branch}`,
    { allowNotFound: true },
  );
  const sha = payload?.object?.sha;
  if (!payload || typeof sha !== "string" || !SHA40.test(sha)) return { ok: false, reason: "ref-not-found" };
  return { ok: true, sha: sha.toLowerCase() };
}

async function readTextAt(client, filePath, sha) {
  const bytes = await readRepoBytes(client, filePath, sha);
  if (!bytes) return { missing: true };
  const text = decodeUtf8(bytes);
  if (text == null) return { stop: "not-utf8" };
  return { text, sha256: sha256Bytes(bytes) };
}

export async function loadProjectFiles(client, { projectId, ref, userId, allowedUserIds }) {
  const actor = authorizeSlackActor({ userId, allowedUserIds });
  if (!actor.allowed) return denied(actor.reason);

  const resolved = await resolveRef(client, ref);
  if (!resolved.ok) return stop(resolved.reason);

  let yamlPath;
  try {
    yamlPath = assertInsideProject(projectId, `projects/${projectId}/project.yaml`);
  } catch {
    return stop("path-refused");
  }
  const yamlRead = await readTextAt(client, yamlPath, resolved.sha);
  if (yamlRead.stop) return stop(yamlRead.stop);
  if (yamlRead.missing) return stop("project-not-found");

  let project;
  try {
    project = parseSimpleYaml(yamlRead.text);
  } catch {
    return stop("yaml-invalid");
  }
  const format = assessProjectFormat(project);
  if (!format.ok) return stop(format.reason, { project, projectYaml: yamlRead.text });

  const projectAuth = authorizeProject({
    userId,
    projectAllowedUserIds: project.authorization?.allowedSlackUserIds,
  });
  if (!projectAuth.allowed) return denied(projectAuth.reason);

  const tree = await client.request(
    "GET",
    `/repos/${client.owner}/${client.repo}/git/trees/${resolved.sha}?recursive=1`,
    { allowNotFound: true },
  );
  if (!tree) return stop("ref-not-found");
  if (tree.truncated === true) return stop("tree-truncated");
  if (!Array.isArray(tree.tree)) return stop("tree-unreadable");

  const prefix = `projects/${projectId}/`;
  const files = { [yamlPath]: yamlRead.text };
  for (const entry of tree.tree) {
    if (!entry || entry.type !== "blob" || typeof entry.path !== "string") continue;
    if (!entry.path.startsWith(prefix)) continue;
    let guarded;
    try {
      guarded = assertInsideProject(projectId, entry.path);
    } catch {
      return stop("path-refused");
    }
    if (guarded === yamlPath) continue;
    const read = await readTextAt(client, guarded, resolved.sha);
    if (read.stop) return stop(read.stop);
    if (read.missing) return stop("project-not-found");
    files[guarded] = read.text;
  }

  return {
    denied: false,
    fetch: true,
    stop: false,
    sha: resolved.sha,
    project,
    projectYaml: yamlRead.text,
    files,
  };
}

async function defaultBranch(client) {
  const repository = await client.request("GET", `/repos/${client.owner}/${client.repo}`);
  if (typeof repository?.default_branch !== "string" || !repository.default_branch) {
    throw new Error("repository has no default branch");
  }
  return repository.default_branch;
}

export async function loadApprovedDocument(client, input) {
  const actor = authorizeSlackActor({ userId: input.userId, allowedUserIds: input.allowedUserIds });
  if (!actor.allowed) return denied(actor.reason);
  const head = input.headRef ?? (await defaultBranch(client));
  const loaded = await loadProjectFiles(client, { ...input, ref: head });
  if (loaded.denied || loaded.stop) return loaded;

  const approval = assessDocumentApproval(loaded.project, input.block);
  if (!approval.ok) return stop(approval.reason, { project: loaded.project, projectYaml: loaded.projectYaml });

  let documentPath;
  try {
    documentPath = assertInsideProject(input.projectId, `projects/${input.projectId}/${approval.path}`);
  } catch {
    return stop("path-refused");
  }
  const atHead = await readTextAt(client, documentPath, loaded.sha);
  const atMerge = await readTextAt(client, documentPath, approval.mergeCommit);
  if (atHead.stop || atMerge.stop) return stop(atHead.stop || atMerge.stop);
  if (
    atHead.missing ||
    atMerge.missing ||
    atHead.sha256 !== approval.sha256 ||
    atMerge.sha256 !== approval.sha256
  ) {
    return stop(`${input.block}-hash-mismatch`, { project: loaded.project, projectYaml: loaded.projectYaml });
  }

  return {
    denied: false,
    fetch: true,
    stop: false,
    sha: loaded.sha,
    project: loaded.project,
    projectYaml: loaded.projectYaml,
    files: { ...loaded.files, [documentPath]: atHead.text },
    documentPath,
    documentText: atHead.text,
    sha256: approval.sha256,
    mergeCommit: approval.mergeCommit,
  };
}

export function loadApprovedTor(client, input) {
  return loadApprovedDocument(client, { ...input, block: "tor" });
}

export async function loadApprovedPlan(client, input) {
  const loaded = await loadApprovedDocument(client, { ...input, block: "projectPlan" });
  if (loaded.reason === "projectPlan-hash-mismatch") {
    return {
      denied: false,
      fetch: true,
      stop: false,
      paused: true,
      reason: loaded.reason,
      project: loaded.project,
      projectYaml: loaded.projectYaml,
    };
  }
  return { ...loaded, paused: false };
}

export function loadApprovedSrs(client, input) {
  return loadApprovedDocument(client, { ...input, block: "srs" });
}

export async function loadChangeControlSources(client, input) {
  const tor = await loadApprovedTor(client, input);
  if (tor.denied || tor.stop) return tor;
  const srs = await loadApprovedSrs(client, input);
  if (srs.denied || srs.stop) return srs;
  return {
    denied: false,
    fetch: true,
    stop: false,
    project: tor.project,
    projectYaml: tor.projectYaml,
    torPath: tor.documentPath,
    torText: tor.documentText,
    torSha256: tor.sha256,
    torMergeCommit: tor.mergeCommit,
    srsPath: srs.documentPath,
    srsText: srs.documentText,
    srsSha256: srs.sha256,
    srsMergeCommit: srs.mergeCommit,
  };
}
