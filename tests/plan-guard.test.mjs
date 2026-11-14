import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { GithubClient, assertCommitLeavesTorUntouched, openReviewedPullRequest } from "../lib/github.mjs";
import { issuePlanWriteGrant, planWriteAllowed } from "../lib/plan-guard.mjs";
import { planStagePullRequest } from "../lib/stage-gate.mjs";
import { assessWrite } from "../lib/write-policy.mjs";

const path = "projects/demo/docs/project-plan.md";
const grant = { agent: "project-planner", projectId: "demo", branchPrefix: "project-plan/demo/" };
const guards = [
  ["write-policy", (item) => assessWrite(path, { planGrant: item.grant, branch: item.branch }).allowed],
  ["stage-gate", (item) => planStagePullRequest({
    validationOk: true,
    projectId: "demo",
    files: [{ path }],
    allowedDocs: [],
    branch: item.branch,
    planGrant: item.grant,
  }).ok],
  ["reviewed", (item) => planWriteAllowed({ filePath: path, branch: item.branch, grant: item.grant }).allowed],
  ["commit", (item) => {
    try {
      assertCommitLeavesTorUntouched([{ path }], { planGrant: item.grant, branch: item.branch });
      return true;
    } catch {
      return false;
    }
  }],
];

test("allows with grant", () => {
  for (const [, check] of guards) {
    assert.equal(check({ grant, branch: "project-plan/demo/20261114T080000Z" }), true);
  }
});

test("refuses without", () => {
  for (const [, check] of guards) {
    assert.equal(check({ grant: null, branch: "project-plan/demo/20261114T080000Z" }), false);
  }
});

test("refuses other project", () => {
  for (const [, check] of guards) {
    assert.equal(check({ grant: { ...grant, projectId: "other" }, branch: "project-plan/demo/stamp" }), false);
  }
});

test("refuses non-project-plan branch", () => {
  for (const [, check] of guards) {
    assert.equal(check({ grant, branch: "plan/demo/stamp" }), false);
  }
});

test("only project-planner imports issuePlanWriteGrant", async () => {
  const root = resolve(new URL("..", import.meta.url).pathname, "agents");
  const files = await sourceFiles(root);
  const importers = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (text.includes("issuePlanWriteGrant")) importers.push(file);
  }
  assert.ok(importers.length > 0);
  assert.ok(importers.every((file) => file.includes(`${resolve(root, "project-planner")}/`)));
});

test("other agents cannot write project-plan.md", () => {
  assert.equal(assessWrite(path).allowed, false);
});

test("openReviewedPullRequest refuses a plan write before any fetch when the grant does not match", async () => {
  let fetched = false;
  const client = {
    owner: "o",
    repo: "r",
    async request() {
      fetched = true;
      throw new Error("fetched");
    },
  };
  await assert.rejects(
    () => openReviewedPullRequest(client, {
      projectId: "demo",
      baseBranch: "main",
      branch: "project-plan/demo/stamp",
      title: "Plan",
      body: "no",
      files: [{ path, content: "# Plan\n" }],
    }),
    /project plan/,
  );
  assert.equal(fetched, false);
});

test("grant refused when TOR is not approved or the hash does not match", async () => {
  const tor = "approved tor\n";
  const hash = createHash("sha256").update(tor).digest("hex");
  const yaml = (status, sha = hash) => `id: demo
title: Demo
status: active
tor:
  path: docs/tor.md
  status: ${status}
  pullRequest: null
  branch: null
  baseline:
    mergeCommit: ${"a".repeat(40)}
    approvedAt: null
    approvedBy: null
    sha256: ${sha}
`;
  const approved = await issuePlanWriteGrant(grantClient({ yaml: yaml("approved"), tor }), "demo");
  assert.equal(approved.ok, true);
  assert.equal(approved.grant.branchPrefix, "project-plan/demo/");
  const none = await issuePlanWriteGrant(grantClient({ yaml: yaml("none"), tor }), "demo");
  assert.equal(none.ok, false);
  const mismatch = await issuePlanWriteGrant(grantClient({ yaml: yaml("approved", "ab".repeat(32)), tor }), "demo");
  assert.equal(mismatch.reason, "tor-hash-mismatch");
});

function grantClient({ yaml, tor }) {
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    const { pathname } = new URL(url);
    if (method === "GET" && pathname === "/repos/o/r") return http({ default_branch: "main" });
    if (method === "GET" && pathname.includes("/contents/")) {
      const filePath = decodeURIComponent(pathname.split("/contents/")[1]);
      const text = filePath.endsWith("project.yaml") ? yaml : tor;
      if (text == null) return http({ message: "Not Found" }, 404);
      return http({ encoding: "base64", content: Buffer.from(text).toString("base64") });
    }
    return http({ message: `unhandled ${method} ${pathname}` }, 500);
  };
  return new GithubClient({ fetchImpl, token: "test-token", owner: "o", repo: "r" });
}

function http(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() {
      return JSON.stringify(body);
    },
  };
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const next = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(next)));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) files.push(next);
  }
  return files;
}
