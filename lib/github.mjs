import { planWriteAllowed } from "./plan-guard.mjs";
import { applyAgreedPlanHeader, planHeaderDiffAllowed } from "./plan-header.mjs";
import { torWriteAllowed } from "./tor-guard.mjs";
import {
  assessProjectFormat,
  blockLabel,
  recordBaseline,
  recordingBranchName,
  sha256Bytes,
  sourceBranchMatches,
} from "./baseline.mjs";
import { ciIsGreen, verifyGateDecision } from "./gate-decision.mjs";
import { formatGithubIdentityLine } from "./github-identity.mjs";
import { readMergeAuthorization } from "./merge-auth.mjs";
import { ensureSrsPlanFields } from "./plan-yaml.mjs";
import { parseSimpleYaml } from "./project-yaml.mjs";
import {
  RECORDING_DOCUMENTS,
  evaluateRecordingPullRequest,
  parseRecordingReference,
  renderRecordingReference,
} from "./recording-pr.mjs";

export const MERGE_REFUSED =
  "merge refused: no verified gate decision for this pull request and commit";

function isMergeRequest(method, apiPath) {
  const path = String(apiPath).split("?")[0];
  if (/\/merge$/.test(path)) return true;
  return String(method).toUpperCase() === "MERGE";
}

function pullNumberFromMergePath(apiPath) {
  const path = String(apiPath).split("?")[0];
  const match = path.match(/\/pulls\/(\d+)\/merge$/);
  return match ? Number(match[1]) : null;
}

export function assertMergeAuthorized(method, apiPath, body, mergeAuthorization) {
  if (!isMergeRequest(method, apiPath)) return;
  const authorization = readMergeAuthorization(mergeAuthorization);
  if (!authorization) throw new Error(MERGE_REFUSED);
  const path = String(apiPath).split("?")[0];
  const expected = `/repos/${authorization.repo}/pulls/${authorization.pr}/merge`;
  if (path !== expected && !path.endsWith(expected)) {
    throw new Error("merge refused: authorization is for a different repository");
  }
  const pullNumber = pullNumberFromMergePath(apiPath);
  if (pullNumber === null || pullNumber !== authorization.pr) {
    throw new Error("merge refused: authorization is for a different pull request");
  }
  if (!body || body.sha !== authorization.headSha) {
    throw new Error("merge refused: merge sha is not the approved head");
  }
  if (body.merge_method !== "merge") {
    throw new Error("merge refused: merge_method must be merge");
  }
}

const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;

const SRS_COMMIT_FILES = new Set([
  "docs/srs.md",
  "docs/elicitation-log.md",
  "docs/validation-report.md",
]);

export function assertInsideProject(projectId, filePath) {
  if (!PROJECT_ID.test(projectId)) {
    throw new Error(`invalid project id: ${projectId}`);
  }
  const normalized = String(filePath).replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.includes("..") || normalized.includes("//")) {
    throw new Error(`refusing path outside projects/${projectId}/: ${filePath}`);
  }
  const prefix = `projects/${projectId}/`;
  if (!normalized.startsWith(prefix)) {
    throw new Error(`refusing path outside projects/${projectId}/: ${filePath}`);
  }
  return normalized;
}

export function assertSrsCommitPath(projectId, filePath) {
  const normalized = assertInsideProject(projectId, filePath);
  const rest = normalized.slice(`projects/${projectId}/`.length);
  if (rest === "docs/tor.md") {
    throw new Error("refusing to commit the frozen TOR");
  }
  if (!SRS_COMMIT_FILES.has(rest)) {
    throw new Error(`refusing to commit ${normalized}`);
  }
  return normalized;
}

const SETUP_COMMIT_FILES = new Set(["project.yaml", "intake/tor-source.md"]);

export function assertSetupCommitPath(projectId, filePath) {
  const normalized = assertInsideProject(projectId, filePath);
  const rest = normalized.slice(`projects/${projectId}/`.length);
  if (!SETUP_COMMIT_FILES.has(rest)) {
    throw new Error("a setup pull request may only commit project.yaml and intake/tor-source.md");
  }
  return normalized;
}

export function assertBaselineCommitPath(projectId, filePath) {
  const normalized = assertInsideProject(projectId, filePath);
  const rest = normalized.slice(`projects/${projectId}/`.length);
  if (rest !== "project.yaml") {
    throw new Error("a baseline follow-up may only commit project.yaml");
  }
  return normalized;
}

export function planSrsPullRequest({ validationOk, files, projectId }) {
  if (!validationOk) {
    return {
      ok: false,
      error: "Refusing to open a pull request while validate_srs is not ok.",
    };
  }
  const accepted = [];
  for (const file of files) {
    if (/(?:^|\/)docs\/tor\.md$/.test(file.path)) {
      return { ok: false, error: "Refusing to commit a modified frozen TOR." };
    }
    accepted.push(assertSrsCommitPath(projectId, file.path));
  }
  if (!accepted.includes(`projects/${projectId}/docs/srs.md`)) {
    return { ok: false, error: "The pull request must include docs/srs.md." };
  }
  return { ok: true, paths: accepted };
}

export function buildSrsPullRequestBody({
  projectId,
  mergeCommit,
  sha256,
  summaryOfDecisions,
  errors = [],
  warnings = [],
}) {
  return [
    "## What was generated",
    "",
    `Software requirements specification for \`${projectId}\`.`,
    "",
    "## TOR baseline",
    "",
    `- Merge commit: \`${mergeCommit ?? "not yet recorded"}\``,
    `- SHA-256: \`${sha256}\``,
    "",
    "## Human decisions",
    "",
    summaryOfDecisions.trim() || "None recorded.",
    "",
    "## Validation",
    "",
    ...(errors.length === 0
      ? ["validate_srs passed."]
      : ["validate_srs failed.", ...errors.map((error) => `- ${error}`)]),
    "",
    "## Remaining non-blocking issues",
    "",
    ...(warnings.length ? warnings.map((warning) => `- ${warning}`) : ["- none"]),
    "",
    "This pull request does not merge itself. A person reviews and merges it.",
    "",
  ].join("\n");
}

export function githubRepoFromEnv(env = process.env) {
  const full = typeof env.GITHUB_REPOSITORY === "string" ? env.GITHUB_REPOSITORY.trim() : "";
  if (!full) {
    throw new Error("GITHUB_REPOSITORY is required (owner/repo). Refusing to guess a repository.");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(full)) {
    throw new Error("GITHUB_REPOSITORY must be owner/repo");
  }
  const [owner, repo] = full.split("/");
  return { owner, repo };
}

export class GithubClient {
  constructor({ fetchImpl = fetch, token, owner, repo, identity = null }) {
    if (!token) throw new Error("GitHub token is missing.");
    this.fetchImpl = fetchImpl;
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.identity = identity;
    this.calls = [];
  }

  async request(method, apiPath, { body, allowNotFound = false, mergeAuthorization } = {}) {
    const path = apiPath.startsWith("http")
      ? new URL(apiPath).pathname
      : apiPath.startsWith("/")
        ? apiPath
        : `/${apiPath}`;
    assertMergeAuthorized(method, apiPath, body, mergeAuthorization);
    assertMergeAuthorized(method, path, body, mergeAuthorization);
    const url = apiPath.startsWith("http") ? apiPath : `https://api.github.com${path}`;
    this.calls.push({ method: method.toUpperCase(), path, body });
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "user-agent": "wewebplus-software-factory",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        if (response.status === 404 && allowNotFound) return null;
        throw new Error(`GitHub ${method} ${path} failed (${response.status}): ${text.slice(0, 200)}`);
      }
    }
    if (response.status === 404 && allowNotFound) return null;
    if (!response.ok) {
      const message = payload.message || response.statusText;
      throw new Error(`GitHub ${method} ${path} failed (${response.status}): ${message}`);
    }
    return payload;
  }
}

function repoApi(client, suffix) {
  return `/repos/${client.owner}/${client.repo}${suffix}`;
}

function assertBranchIsNotBase(baseBranch, branch) {
  if (!branch || branch === baseBranch || branch.startsWith("refs/")) {
    throw new Error("Refusing to update the base branch.");
  }
}

export function assertCommitLeavesTorUntouched(files, { torGrant, planGrant, branch } = {}) {
  for (const file of files) {
    const decision = torWriteAllowed({ filePath: file.path, branch, grant: torGrant });
    if (decision.applies && !decision.allowed) throw new Error(decision.reason);
    const planDecision = planWriteAllowed({ filePath: file.path, branch, grant: planGrant });
    if (planDecision.applies && !planDecision.allowed) throw new Error(planDecision.reason);
  }
}

function refAlreadyExists(error) {
  return (
    error instanceof Error &&
    /failed \(422\)/.test(error.message) &&
    /Reference already exists/i.test(error.message)
  );
}

async function lookupBranchSha(client, branch) {
  const payload = await client.request("GET", repoApi(client, `/git/ref/heads/${branch}`), {
    allowNotFound: true,
  });
  if (payload === null) return null;
  const sha = payload.object && payload.object.sha;
  if (!sha) throw new Error(`GitHub ref heads/${branch} did not include a sha.`);
  return sha;
}

async function lookupFileSha(client, filePath, branch) {
  const payload = await client.request(
    "GET",
    repoApi(client, `/contents/${filePath}?ref=${encodeURIComponent(branch)}`),
    { allowNotFound: true },
  );
  if (payload === null) return null;
  if (
    Array.isArray(payload) ||
    payload.type === "dir" ||
    typeof payload.sha !== "string" ||
    !payload.sha
  ) {
    throw new Error(`Refusing to write ${filePath}: GitHub did not return a file sha.`);
  }
  return payload.sha;
}

async function pointBranchAt(client, branch, sha, { force }) {
  await client.request("PATCH", repoApi(client, `/git/refs/heads/${branch}`), {
    body: { sha, force },
  });
}

async function ensureBranchAtBase(client, baseBranch, branch, baseSha) {
  assertBranchIsNotBase(baseBranch, branch);
  const existing = await lookupBranchSha(client, branch);
  if (existing === null) {
    try {
      await client.request("POST", repoApi(client, "/git/refs"), {
        body: { ref: `refs/heads/${branch}`, sha: baseSha },
      });
      return;
    } catch (error) {
      if (!refAlreadyExists(error)) throw error;
    }
  }
  if (existing !== baseSha) {
    await pointBranchAt(client, branch, baseSha, { force: true });
  }
}

// One commit for every file. The branch is created at the base HEAD, or reset
// there when it already exists. Each path is read on that branch: a 404 creates
// the file, and an existing blob sha is an update in the new tree.
async function commitFilesOnBranch(client, { baseBranch, branch, message, files, torGrant, planGrant }) {
  assertCommitLeavesTorUntouched(files, { torGrant, planGrant, branch });
  assertBranchIsNotBase(baseBranch, branch);
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Refusing to commit an empty file list.");
  }
  const baseRef = await client.request("GET", repoApi(client, `/git/ref/heads/${baseBranch}`));
  const baseSha = baseRef.object && baseRef.object.sha;
  if (!baseSha) throw new Error(`Base branch ${baseBranch} has no commit.`);
  await ensureBranchAtBase(client, baseBranch, branch, baseSha);
  const baseCommit = await client.request("GET", repoApi(client, `/git/commits/${baseSha}`));
  const baseTree = baseCommit.tree && baseCommit.tree.sha;
  if (!baseTree) throw new Error(`Base commit ${baseSha} has no tree.`);

  const tree = [];
  for (const file of files) {
    if (typeof file.content !== "string") {
      throw new Error(`Refusing to commit ${file.path} without text content.`);
    }
    // 404 returns null and the path is created. A blob sha means the path
    // already exists, so the tree entry below replaces that file.
    const existing = await lookupFileSha(client, file.path, branch);
    if (/(?:^|\/)intake\/tor-source\.md$/.test(String(file.path).replace(/\\/g, "/")) && existing) {
      throw new Error("intake/tor-source.md is immutable after setup");
    }
    const blob = await client.request("POST", repoApi(client, "/git/blobs"), {
      body: { content: file.content, encoding: "utf-8" },
    });
    if (!blob.sha) throw new Error(`GitHub did not return a blob sha for ${file.path}.`);
    tree.push({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: blob.sha,
    });
  }

  const createdTree = await client.request("POST", repoApi(client, "/git/trees"), {
    body: { base_tree: baseTree, tree },
  });
  if (!createdTree.sha) throw new Error("GitHub did not return the new tree sha.");
  const commit = await client.request("POST", repoApi(client, "/git/commits"), {
    body: { message, tree: createdTree.sha, parents: [baseSha] },
  });
  if (!commit.sha) throw new Error("GitHub did not return the new commit sha.");
  await pointBranchAt(client, branch, commit.sha, { force: false });
  return commit.sha;
}

function withIdentity(client, body) {
  const line = formatGithubIdentityLine(client.identity);
  const text = body == null ? "" : String(body);
  if (!line || text.includes(line)) return text;
  return `${text.replace(/\n?$/, "\n")}\n${line}\n`;
}

async function openPull(client, { title, branch, baseBranch, body, headSha }) {
  const pull = await client.request("POST", repoApi(client, "/pulls"), {
    body: {
      title,
      head: branch,
      base: baseBranch,
      draft: false,
      body: withIdentity(client, body),
    },
  });
  return {
    url: pull.html_url,
    number: pull.number,
    branch,
    headSha: pull.head?.sha ?? headSha,
  };
}

export async function createSrsPullRequest(client, input) {
  const plan = planSrsPullRequest(input);
  if (!plan.ok) throw new Error(plan.error);
  const branch = `spec/${input.projectId}/srs/${input.stamp}`;
  const files = input.files.map((file) => ({
    path: assertSrsCommitPath(input.projectId, file.path),
    content: file.content,
  }));
  const headSha = await commitFilesOnBranch(client, {
    baseBranch: input.baseBranch,
    branch,
    message: `Specify ${input.projectId}`,
    files,
  });
  return openPull(client, {
    title: input.title || `SRS for ${input.projectId}`,
    branch,
    baseBranch: input.baseBranch,
    body: input.body,
    headSha,
  });
}

export async function openReviewedPullRequest(client, input) {
  const files = [];
  for (const file of input.files) {
    const normalized = assertInsideProject(input.projectId, file.path);
    if (isFixturePath(normalized)) throw new Error("Refusing to commit a fixture or the frozen TOR.");
    const torDecision = torWriteAllowed({ filePath: normalized, branch: input.branch, grant: input.torGrant });
    if (torDecision.applies && !torDecision.allowed) throw new Error(torDecision.reason);
    const planDecision = planWriteAllowed({ filePath: normalized, branch: input.branch, grant: input.planGrant });
    if (planDecision.applies && !planDecision.allowed) throw new Error(planDecision.reason);
    files.push({ path: normalized, content: file.content });
  }
  const headSha = await commitFilesOnBranch(client, {
    baseBranch: input.baseBranch,
    branch: input.branch,
    message: `${input.messagePrefix ?? "Update"} ${input.projectId}`,
    files,
    torGrant: input.torGrant,
    planGrant: input.planGrant,
  });
  return openPull(client, {
    title: input.title,
    branch: input.branch,
    baseBranch: input.baseBranch,
    body: input.body,
    headSha,
  });
}

function isFixturePath(filePath) {
  return String(filePath).replace(/\\/g, "/").includes("fixtures/");
}

export async function getPullRequestStatus(client, pullNumber) {
  const pull = await client.request(
    "GET",
    `/repos/${client.owner}/${client.repo}/pulls/${pullNumber}`,
  );
  const reviews = await client.request(
    "GET",
    `/repos/${client.owner}/${client.repo}/pulls/${pullNumber}/reviews`,
  );
  const reviewComments = await client.request(
    "GET",
    `/repos/${client.owner}/${client.repo}/pulls/${pullNumber}/comments`,
  );
  const issueComments = await client.request(
    "GET",
    `/repos/${client.owner}/${client.repo}/issues/${pullNumber}/comments`,
  );
  const requestedChanges = reviews
    .filter((review) => review.state === "CHANGES_REQUESTED")
    .map((review) => review.body)
    .filter(Boolean);
  return {
    number: pull.number,
    state: pull.state,
    merged: pull.merged === true,
    mergeCommitSha: pull.merge_commit_sha ?? null,
    url: pull.html_url,
    headSha: pull.head?.sha ?? null,
    headRef: pull.head?.ref ?? null,
    baseSha: pull.base?.sha ?? null,
    mergedBy: pull.merged_by?.login ?? null,
    body: pull.body ?? "",
    requestedChanges,
    comments: [...reviewComments, ...issueComments]
      .map((comment) => comment.body)
      .filter(Boolean),
  };
}

export async function listIssueComments(client, pullNumber) {
  const comments = await client.request("GET", repoApi(client, `/issues/${pullNumber}/comments`));
  if (!Array.isArray(comments)) throw new Error("GitHub issue comments were not a list.");
  return comments.map((comment) => ({
    id: comment.id ?? null,
    body: comment.body ?? "",
    authorLogin: comment.user?.login ?? null,
  }));
}

export async function commentOnPullRequest(client, pullNumber, body) {
  return client.request("POST", repoApi(client, `/issues/${pullNumber}/comments`), {
    body: { body: withIdentity(client, body) },
  });
}

export async function closePullRequest(client, pullNumber) {
  return client.request("PATCH", repoApi(client, `/pulls/${pullNumber}`), {
    body: { state: "closed" },
  });
}

export async function listPullRequestCommits(client, pullNumber) {
  const commits = await client.request("GET", repoApi(client, `/pulls/${pullNumber}/commits`));
  if (!Array.isArray(commits)) throw new Error("GitHub pull request commits were not a list.");
  const described = [];
  for (const commit of commits) {
    const detail = await client.request("GET", repoApi(client, `/commits/${commit.sha}`));
    const files = Array.isArray(detail.files) ? detail.files : [];
    described.push({
      sha: commit.sha,
      authorLogin: commit.author?.login ?? null,
      message: commit.commit?.message ?? "",
      files: files.map((file) => ({
        filename: file.filename,
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
      })),
    });
  }
  return described;
}

export function humanCommitsSince(commits, { botLogin, afterSha } = {}) {
  let start = 0;
  if (afterSha) {
    const index = commits.findIndex((commit) => commit.sha === afterSha);
    start = index === -1 ? 0 : index + 1;
  }
  return commits.slice(start).flatMap((commit) => {
    const login = commit.authorLogin ?? "";
    if ((botLogin && login === botLogin) || login.endsWith("[bot]")) return [];
    const files = commit.files ?? [];
    return [
      {
        sha: commit.sha,
        summary: String(commit.message ?? "").split("\n")[0],
        files,
        additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
        deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      },
    ];
  });
}

export async function getCombinedStatus(client, sha) {
  const status = await client.request("GET", repoApi(client, `/commits/${sha}/status`));
  const checks = await client.request("GET", repoApi(client, `/commits/${sha}/check-runs`));
  return {
    state: status.state ?? "pending",
    checkRuns: Array.isArray(checks.check_runs)
      ? checks.check_runs.map((run) => ({
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
        }))
      : [],
  };
}

export async function readRepoBytes(client, filePath, ref) {
  const payload = await client.request(
    "GET",
    `${repoApi(client, `/contents/${filePath}`)}?ref=${encodeURIComponent(ref)}`,
    { allowNotFound: true },
  );
  if (payload === null) return null;
  if (payload.encoding !== "base64" || typeof payload.content !== "string") {
    throw new Error(`Refusing to read ${filePath}: GitHub did not return a blob.`);
  }
  return Buffer.from(payload.content.replace(/\s/g, ""), "base64");
}

export async function readRepoTextFile(client, filePath, ref) {
  const bytes = await readRepoBytes(client, filePath, ref);
  if (bytes === null) return null;
  return bytes.toString("utf8");
}

function requiredCheckName(env = process.env) {
  const raw = env.FACTORY_REQUIRED_CHECK;
  const name = raw == null || String(raw).trim() === "" ? "check" : String(raw).trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
    throw new Error("merge refused: FACTORY_REQUIRED_CHECK is not a pinned check name");
  }
  return name;
}

async function refetchHeadForMerge(client, pullNumber, expectedSha) {
  const latest = await getPullRequestStatus(client, pullNumber);
  if (latest.state !== "open" || latest.merged || latest.headSha !== expectedSha) {
    throw new Error("merge refused: head SHA moved before merge");
  }
  return latest.headSha;
}

function assertClientIdentity(client) {
  if (!client.identity?.botLogin || !client.identity.kind || !client.identity.label) {
    throw new Error("merge refused: GitHub identity is unresolved");
  }
}

function parseYamlOrNull(text) {
  if (typeof text !== "string") return null;
  try {
    return parseSimpleYaml(text);
  } catch {
    return null;
  }
}

async function findVerifiedApproval(client, {
  pullNumber,
  liveHeadSha,
  projectId,
  allowedUserIds,
  signingSecret,
  requireCi,
  ciGreen,
}) {
  const comments = await listIssueComments(client, pullNumber);
  const repo = `${client.owner}/${client.repo}`;
  let verified = null;
  let reason = "no verified gate decision for this pull request and commit";
  for (const comment of comments) {
    const result = verifyGateDecision({
      comment,
      expectedAuthorLogin: client.identity.botLogin,
      repo,
      pullNumber,
      liveHeadSha,
      allowedUserIds,
      projectId,
      signingSecret,
      requireMac: client.identity.kind === "personal-token",
      ciGreen,
      requireCi,
    });
    if (result.ok) {
      verified = result;
      continue;
    }
    if (typeof comment.body === "string" && comment.body.includes("factory-gate-decision")) {
      reason = result.reason;
    }
  }
  return { verified, reason };
}

export async function mergeApprovedPullRequest(client, {
  pullNumber,
  projectId,
  allowedUserIds,
  signingSecret,
  env = process.env,
}) {
  assertClientIdentity(client);
  const status = await getPullRequestStatus(client, pullNumber);
  if (status.state !== "open" || status.merged || !status.headSha) {
    throw new Error("merge refused: pull request is not an open commit");
  }
  const combined = await getCombinedStatus(client, status.headSha);
  const green = ciIsGreen({
    combinedState: combined.state,
    checkRuns: combined.checkRuns,
    requiredCheckName: requiredCheckName(env),
  });
  const found = await findVerifiedApproval(client, {
    pullNumber,
    liveHeadSha: status.headSha,
    projectId,
    allowedUserIds,
    signingSecret,
    requireCi: true,
    ciGreen: green,
  });
  if (!found.verified) throw new Error(`merge refused: ${found.reason}`);
  const headSha = await refetchHeadForMerge(client, pullNumber, status.headSha);
  return client.request("PUT", repoApi(client, `/pulls/${pullNumber}/merge`), {
    body: {
      sha: headSha,
      merge_method: "merge",
      commit_message: `Merged by the factory gate.\n${formatGithubIdentityLine(client.identity)}`,
    },
    mergeAuthorization: found.verified.authorization,
  });
}

export async function mergeRecordingPullRequest(client, {
  pullNumber,
  allowedUserIds,
  signingSecret,
  env = process.env,
}) {
  assertClientIdentity(client);
  const status = await getPullRequestStatus(client, pullNumber);
  if (status.state !== "open" || status.merged || !status.headSha || !status.baseSha) {
    throw new Error("recording merge refused: pull request is not an open commit");
  }
  const combined = await getCombinedStatus(client, status.headSha);
  if (
    !ciIsGreen({
      combinedState: combined.state,
      checkRuns: combined.checkRuns,
      requiredCheckName: requiredCheckName(env),
    })
  ) {
    throw new Error("recording merge refused: required CI is not green");
  }
  const files = await client.request("GET", repoApi(client, `/pulls/${pullNumber}/files`));
  if (!Array.isArray(files)) throw new Error("recording merge refused: file list was not returned");
  const parsedReference = parseRecordingReference(status.body);
  const reference = parsedReference
    ? { ...parsedReference, recordingPr: pullNumber, recordingHeadSha: status.headSha }
    : null;
  let beforeYaml = null;
  let afterYaml = null;
  let beforeText = null;
  let afterText = null;
  let beforePlan = null;
  let afterPlan = null;
  if (reference) {
    const yamlFile = files.find((file) => String(file.filename ?? file.path ?? "").endsWith("project.yaml"));
    const planFile = files.find((file) => String(file.filename ?? file.path ?? "").endsWith("docs/project-plan.md"));
    if (yamlFile) {
      const path = yamlFile.filename ?? yamlFile.path;
      beforeText = await readRepoTextFile(client, path, status.baseSha);
      afterText = await readRepoTextFile(client, path, status.headSha);
      beforeYaml = parseYamlOrNull(beforeText);
      afterYaml = parseYamlOrNull(afterText);
    }
    if (planFile) {
      const path = planFile.filename ?? planFile.path;
      beforePlan = await readRepoTextFile(client, path, status.baseSha);
      afterPlan = await readRepoTextFile(client, path, status.headSha);
    }
  }
  let sourcePull = null;
  let approval = null;
  if (reference) {
    const sourceStatus = await getPullRequestStatus(client, reference.sourcePr);
    sourcePull = {
      repo: `${client.owner}/${client.repo}`,
      number: sourceStatus.number,
      headSha: sourceStatus.headSha,
      merged: sourceStatus.merged,
      mergeCommitSha: sourceStatus.mergeCommitSha,
    };
    const found = await findVerifiedApproval(client, {
      pullNumber: reference.sourcePr,
      liveHeadSha: reference.sourceHeadSha,
      projectId: reference.projectId,
      allowedUserIds,
      signingSecret,
      requireCi: false,
      ciGreen: true,
    });
    approval = found.verified?.verified ?? null;
  }
  const evaluated = evaluateRecordingPullRequest({
    files: files.map((file) => ({ path: file.filename ?? file.path })),
    reference,
    approval,
    sourcePull,
    beforeYaml,
    afterYaml,
    beforeText,
    afterText,
    beforePlan,
    afterPlan,
  });
  if (!evaluated.ok || !evaluated.authorization) {
    throw new Error(`recording merge refused: ${evaluated.reason}`);
  }
  const headSha = await refetchHeadForMerge(client, pullNumber, status.headSha);
  return client.request("PUT", repoApi(client, `/pulls/${pullNumber}/merge`), {
    body: {
      sha: headSha,
      merge_method: "merge",
      commit_message: `Recorded an approved decision.\n${formatGithubIdentityLine(client.identity)}`,
    },
    mergeAuthorization: evaluated.authorization,
  });
}

const SHA40 = /^[0-9a-f]{40}$/i;

export async function openBaselinePullRequest(client, input) {
  const block = input.block ?? "srs";
  const label = blockLabel(block);
  if (!input.merged || !input.mergeCommitSha) {
    throw new Error(`Refusing to record a ${label} baseline before the pull request is merged.`);
  }
  if (!sourceBranchMatches(block, input.projectId, input.headRef)) {
    throw new Error("refusing a merge commit from a foreign branch");
  }
  if (!Number.isInteger(input.sourcePr) || input.sourcePr < 1) {
    throw new Error("recording pull request is missing the approved pull request number");
  }
  if (typeof input.sourceHeadSha !== "string" || !SHA40.test(input.sourceHeadSha)) {
    throw new Error("recording pull request is missing the approved commit");
  }
  if (!SHA40.test(input.mergeCommitSha)) {
    throw new Error("recording pull request is missing the approved merge commit");
  }
  const path = assertBaselineCommitPath(input.projectId, input.projectYamlPath);
  const branch = recordingBranchName(block, input.projectId, input.stamp);
  const committed = [{ path, content: input.projectYaml }, ...(input.extraFiles ?? [])];
  const reference = {
    document: block,
    projectId: input.projectId,
    repo: `${client.owner}/${client.repo}`,
    sourcePr: input.sourcePr,
    sourceHeadSha: input.sourceHeadSha.toLowerCase(),
    sourceMergeSha: input.mergeCommitSha.toLowerCase(),
  };
  const headSha = await commitFilesOnBranch(client, {
    baseBranch: input.baseBranch,
    branch,
    message: `Record approved ${label} baseline ${reference.sourceMergeSha}`,
    files: committed,
    planGrant: input.planGrant,
  });
  const opened = await openPull(client, {
    title: `Record ${label} baseline for ${input.projectId}`,
    branch,
    baseBranch: input.baseBranch,
    headSha,
    body: renderRecordingReference(reference),
  });
  return { ...opened, reference, projectYaml: input.projectYaml };
}

export async function recordApprovedBaseline(client, input) {
  const block = input.block;
  if (!RECORDING_DOCUMENTS.includes(block)) throw new Error(`unknown baseline document: ${block}`);
  assertClientIdentity(client);
  const status = await getPullRequestStatus(client, input.pullNumber);
  if (!status.merged || !status.mergeCommitSha || !status.headSha) {
    throw new Error(`Refusing to record a ${blockLabel(block)} baseline before the pull request is merged.`);
  }
  if (!sourceBranchMatches(block, input.projectId, status.headRef)) {
    throw new Error("refusing a merge commit from a foreign branch");
  }
  const found = await findVerifiedApproval(client, {
    pullNumber: input.pullNumber,
    liveHeadSha: status.headSha,
    projectId: input.projectId,
    allowedUserIds: input.allowedUserIds,
    signingSecret: input.signingSecret,
    requireCi: false,
    ciGreen: true,
  });
  if (!found.verified?.decision || found.verified.decision.action !== "approve") {
    throw new Error(`refusing to record a baseline without a verified approval: ${found.reason}`);
  }
  const decision = found.verified.decision;
  if (decision.pr !== input.pullNumber || decision.headSha !== status.headSha || decision.projectId !== input.projectId) {
    throw new Error("refusing to record a baseline for a different pull request or commit");
  }
  const repository = input.baseBranch
    ? { default_branch: input.baseBranch }
    : await client.request("GET", repoApi(client, ""));
  const base = repository.default_branch;
  if (typeof base !== "string" || !base) throw new Error("repository has no default branch");
  const yamlPath = assertBaselineCommitPath(input.projectId, `projects/${input.projectId}/project.yaml`);
  let current = await readRepoTextFile(client, yamlPath, base);
  if (current == null) throw new Error("project.yaml was not found on the default branch");
  const project = parseSimpleYaml(current);
  const format = assessProjectFormat(project);
  if (!format.ok) throw new Error(`refusing to record a baseline: ${format.reason}`);
  const relative = project[block]?.path;
  if (typeof relative !== "string" || relative.includes("..") || relative.startsWith("/")) {
    throw new Error(`project.yaml is missing ${block}.path`);
  }
  const docPath = assertInsideProject(input.projectId, `projects/${input.projectId}/${relative}`);
  const bytes = await readRepoBytes(client, docPath, status.mergeCommitSha);
  if (!bytes) throw new Error(`missing ${relative} at the approved merge commit`);
  let stored = bytes;
  let extraFiles = [];
  if (block === "projectPlan") {
    const original = bytes.toString("utf8");
    const edited = applyAgreedPlanHeader(original, { agreedOn: decision.decidedAt });
    if (!planHeaderDiffAllowed(original, edited)) throw new Error("any other plan byte refused");
    stored = Buffer.from(edited);
    extraFiles = [{ path: docPath, content: edited }];
  }
  const extra = { sha256: sha256Bytes(stored) };
  if (block === "srs" || block === "projectPlan") extra.sourceTorCommit = project.tor?.baseline?.mergeCommit ?? null;
  if (block === "architecture") extra.sourceSrsCommit = project.srs?.baseline?.mergeCommit ?? null;
  if (block === "srs") {
    current = ensureSrsPlanFields(current);
    extra.sourcePlanCommit = project.projectPlan?.baseline?.mergeCommit ?? null;
    extra.sourcePlanSha256 = project.projectPlan?.baseline?.sha256 ?? null;
  }
  const projectYaml = recordBaseline(current, block, {
    pullNumber: input.pullNumber,
    mergeCommit: status.mergeCommitSha,
    approvedBy: decision.decidedBy,
    approvedAt: decision.decidedAt,
    extra,
  });
  const opened = await openBaselinePullRequest(client, {
    projectId: input.projectId,
    block,
    baseBranch: base,
    stamp: input.stamp,
    merged: true,
    mergeCommitSha: status.mergeCommitSha,
    headRef: status.headRef,
    sourcePr: input.pullNumber,
    sourceHeadSha: status.headSha,
    projectYamlPath: yamlPath,
    projectYaml,
    extraFiles,
    planGrant: block === "projectPlan"
      ? { agent: "project-planner", projectId: input.projectId, branchPrefix: `project-plan/${input.projectId}/` }
      : undefined,
  });
  return {
    ...opened,
    approvedBy: decision.decidedBy,
    approvedAt: decision.decidedAt,
    sha256: extra.sha256,
  };
}

const SETUP_STAMP = /^[0-9]{8}T[0-9]{6}Z$/;

export async function openSetupPullRequest(client, input) {
  if (!SETUP_STAMP.test(input.stamp)) throw new Error(`invalid setup stamp: ${input.stamp}`);
  if (!Array.isArray(input.files) || input.files.length !== 2) {
    throw new Error("a setup pull request must contain exactly two paths");
  }
  const files = input.files.map((file) => ({
    path: assertSetupCommitPath(input.projectId, file.path),
    content: file.content,
  }));
  const prefix = `projects/${input.projectId}/`;
  const paths = new Set(files.map((file) => file.path));
  if (!paths.has(`${prefix}project.yaml`) || !paths.has(`${prefix}intake/tor-source.md`)) {
    throw new Error("a setup pull request must contain exactly two paths");
  }
  const branch = `setup/${input.projectId}/${input.stamp}`;
  const headSha = await commitFilesOnBranch(client, {
    baseBranch: input.baseBranch,
    branch,
    message: `Set up ${input.projectId}`,
    files,
  });
  return openPull(client, {
    title: input.title || `Set up ${input.projectId}`,
    branch,
    baseBranch: input.baseBranch,
    headSha,
    body: input.body,
  });
}

export async function openProjectYamlPullRequest(client, input) {
  const path = assertBaselineCommitPath(input.projectId, input.projectYamlPath ?? `projects/${input.projectId}/project.yaml`);
  const headSha = await commitFilesOnBranch(client, {
    baseBranch: input.baseBranch,
    branch: input.branch,
    message: input.message,
    files: [{ path, content: input.projectYaml }],
  });
  const opened = await openPull(client, {
    title: input.title,
    branch: input.branch,
    baseBranch: input.baseBranch,
    headSha,
    body: input.body,
  });
  return { ...opened, projectYaml: input.projectYaml };
}
