import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { actionsForStage } from "../lib/gate-actions.mjs";
import { buildDecision, renderDecisionComment } from "../lib/gate-decision.mjs";
import { mergeRecordingPullRequest } from "../lib/github.mjs";
import { applyAgreedPlanHeader, planHeaderDiffAllowed } from "../lib/plan-header.mjs";
import { planSha256, projectYamlForPlanPullRequest } from "../lib/plan-draft.mjs";
import { openPlanDraft } from "../lib/plan-draft.mjs";
import { parseSimpleYaml } from "../lib/project-yaml.mjs";
import { verifyGateDecision } from "../lib/gate-decision.mjs";
import { evaluateRecordingPullRequest, renderRecordingReference } from "../lib/recording-pr.mjs";
import { renderHashMismatchAlert, handleGateClick } from "../lib/slack-gate.mjs";
import { IDENTITY, gateGithub, pullFixture } from "./gate-harness.mjs";
import { signSlackRequest } from "../lib/slack-signature.mjs";

const SECRET = "test-signing-secret";
const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const BASE = "c".repeat(40);
const RECORD_HEAD = "d".repeat(40);
const ANAK = "U0CFRUV378D";
const ACTOR = `slack:T0TEAM:${ANAK}`;

const draft = `## 1. About this plan

**Status:** draft

| Version | Date | Agreed by (team) | What changed |
| --- | --- | --- | --- |
| 1 | 2026-11-14 | delivery team | First plan |
`;

test("planner refuses when TOR not approved", async () => {
  const { issuePlanWriteGrant } = await import("../lib/plan-guard.mjs");
  const client = {
    owner: "o",
    repo: "r",
    async request(method, path) {
      if (path === "/repos/o/r") return { default_branch: "main" };
      if (String(path).includes("project.yaml")) {
        return { encoding: "base64", content: Buffer.from("id: demo\nstatus: active\ntor:\n  status: none\n  path: docs/tor.md\n  baseline:\n    mergeCommit: null\n    sha256: null\n").toString("base64") };
      }
      return null;
    },
  };
  const issued = await issuePlanWriteGrant(client, "demo");
  assert.equal(issued.ok, false);
  assert.match(issued.reason, /TOR is not approved/);
});

test("planner refuses on TOR hash mismatch and renders alert", () => {
  const alert = renderHashMismatchAlert({ projectId: "demo", reason: "tor-hash-mismatch" });
  assert.equal(alert.blocks.some((block) => block.type === "actions"), false);
  assert.match(alert.text, /hash mismatch/);
});

test("plan PR refused while validation fails", async () => {
  await assert.rejects(
    () => openPlanDraft({ owner: "o", repo: "r", async request() { throw new Error("fetched"); } }, {
      projectId: "demo",
      branch: "project-plan/demo/20261114T080000Z",
      plan: "not a plan",
      tor: "IS-001\n",
      elicitationLog: "",
      baseBranch: "main",
      grant: { agent: "project-planner", projectId: "demo", branchPrefix: "project-plan/demo/" },
    }),
    /validation fails/,
  );
});

test("branch prefix is project-plan/ not plan/", async () => {
  await assert.rejects(
    () => openPlanDraft({ owner: "o", repo: "r", async request() { throw new Error("fetched"); } }, {
      projectId: "demo",
      branch: "plan/demo/20261114T080000Z",
      plan: draft,
      tor: "",
      elicitationLog: "",
    }),
    /project-plan\/ not plan\//,
  );
});

test("planner PR adds empty projectPlan block when missing", () => {
  const result = projectYamlForPlanPullRequest("id: demo\nstatus: active\n");
  assert.equal(result.include, true);
  assert.equal(parseSimpleYaml(result.yaml).projectPlan.status, "none");
  assert.equal(parseSimpleYaml(result.yaml).projectPlan.path, "docs/project-plan.md");
});

test("planner PR does not rewrite an existing projectPlan block", () => {
  const yaml = `id: demo\nstatus: active\nprojectPlan:\n  path: docs/project-plan.md\n  status: none\n  pullRequest: null\n  branch: null\n  baseline:\n    mergeCommit: null\n    approvedAt: null\n    approvedBy: null\n    sha256: null\n    sourceTorCommit: null\n`;
  const result = projectYamlForPlanPullRequest(yaml);
  assert.equal(result.include, false);
  assert.equal(result.yaml, yaml);
});

test("baseline hashes plan bytes after the allowed §1 recording edit", () => {
  const edited = applyAgreedPlanHeader(draft, { agreedOn: "2026-11-14T08:00:00.000Z" });
  assert.equal(planHeaderDiffAllowed(draft, edited), true);
  assert.equal(planSha256(edited), createHash("sha256").update(edited, "utf8").digest("hex"));
  assert.match(edited, /Status:\*\* agreed|Status:\*\* agreed|\bagreed\b/);
  assert.equal(planHeaderDiffAllowed(draft, `${edited}\nextra`), false);
});

test("approvedBy is the deciding Slack user, not the bot", () => {
  const decision = buildDecision({
    projectId: "demo",
    stage: "project-plan",
    repo: "o/r",
    pr: 12,
    headSha: HEAD,
    baseSha: BASE,
    action: "approve",
    decidedBy: ACTOR,
    decidedAt: "2026-11-14T08:00:00.000Z",
    slack: { channel: "C0CG6SG8PNW", ts: "1", permalink: null, verification: "hmac", requestTimestamp: "1" },
    reason: null,
    humanCommits: [],
    idempotencyKey: "plan-approve",
    signingSecret: SECRET,
  });
  assert.equal(decision.decidedBy, ACTOR);
  assert.equal(decision.decidedBy.includes("[bot]"), false);
});

test("header recording edit allowed exactly; any other plan byte refused", () => {
  const edited = applyAgreedPlanHeader(draft, { agreedOn: "2026-11-14T08:00:00.000Z" });
  const hash = planSha256(edited);
  const beforeYaml = { projectPlan: { status: "none", pullRequest: null, baseline: { mergeCommit: null, sha256: null, sourceTorCommit: null } } };
  const afterYaml = { projectPlan: { status: "approved", pullRequest: 12, baseline: { mergeCommit: MERGE, sha256: hash, approvedAt: "2026-11-14T08:00:00.000Z", approvedBy: ACTOR, sourceTorCommit: MERGE } } };
  const common = {
    reference: {
      document: "projectPlan",
      projectId: "demo",
      repo: "o/r",
      sourcePr: 12,
      sourceHeadSha: HEAD,
      sourceMergeSha: MERGE,
      recordingPr: 13,
      recordingHeadSha: RECORD_HEAD,
    },
    approval: approval().verified,
    sourcePull: { repo: "o/r", number: 12, headSha: HEAD, merged: true, mergeCommitSha: MERGE },
    beforeYaml,
    afterYaml,
    beforeText: "id: demo\nprojectPlan:\n  status: none\n",
    afterText: "id: demo\nprojectPlan:\n  status: approved\n",
    beforePlan: draft,
    afterPlan: edited,
  };
  const accepted = evaluateRecordingPullRequest({
    ...common,
    files: [
      { path: "projects/demo/project.yaml", status: "modified" },
      { path: "projects/demo/docs/project-plan.md", status: "modified" },
    ],
  });
  assert.equal(accepted.ok, true, accepted.reason);
  const tampered = evaluateRecordingPullRequest({
    ...common,
    files: [
      { path: "projects/demo/project.yaml", status: "modified" },
      { path: "projects/demo/docs/project-plan.md", status: "modified" },
    ],
    afterPlan: `${edited}\nextra line`,
  });
  assert.equal(tampered.reason, "any other plan byte refused");
});

test("recording PR with extra field / wrong PR / wrong SHA / extra file / missing approval is refused", () => {
  const edited = applyAgreedPlanHeader(draft, { agreedOn: "2026-11-14T08:00:00.000Z" });
  const base = {
    files: [
      { path: "projects/demo/project.yaml" },
      { path: "projects/demo/docs/project-plan.md" },
    ],
    beforePlan: draft,
    afterPlan: edited,
    beforeYaml: { projectPlan: { pullRequest: null, baseline: { mergeCommit: null, sha256: null } } },
    afterYaml: { projectPlan: { pullRequest: 12, baseline: { mergeCommit: MERGE, sha256: planSha256(edited) } } },
    beforeText: "id: demo\n",
    afterText: "id: demo\n",
    reference: {
      document: "projectPlan",
      projectId: "demo",
      repo: "o/r",
      sourcePr: 12,
      sourceHeadSha: HEAD,
      sourceMergeSha: MERGE,
    },
    approval: approval().verified,
    sourcePull: { repo: "o/r", number: 12, headSha: HEAD, merged: true, mergeCommitSha: MERGE },
  };
  assert.equal(evaluateRecordingPullRequest({ ...base, files: [...base.files, { path: "projects/demo/docs/extra.md" }] }).reason, "extra file");
  assert.equal(evaluateRecordingPullRequest({ ...base, reference: { ...base.reference, sourcePr: 99 }, afterYaml: { projectPlan: { pullRequest: 99, baseline: { mergeCommit: MERGE, sha256: planSha256(edited) } } } }).reason, "wrong PR ref");
  assert.equal(evaluateRecordingPullRequest({ ...base, reference: { ...base.reference, sourceHeadSha: "e".repeat(40) } }).reason, "wrong SHA");
  assert.equal(evaluateRecordingPullRequest({ ...base, approval: null }).reason, "missing approval");
});

test("projectPlan baseline recording PR auto-merges", async () => {
  const edited = applyAgreedPlanHeader(draft, { agreedOn: "2026-11-14T08:00:00.000Z" });
  const hash = planSha256(edited);
  const before = `id: demo\nstatus: active\nprojectPlan:\n  path: docs/project-plan.md\n  status: none\n  pullRequest: null\n  branch: null\n  baseline:\n    mergeCommit: null\n    approvedAt: null\n    approvedBy: null\n    sha256: null\n    sourceTorCommit: null\n`;
  const after = before
    .replace("status: none", "status: approved")
    .replace("pullRequest: null", "pullRequest: 12")
    .replace("mergeCommit: null", `mergeCommit: ${MERGE}`)
    .replace("approvedAt: null", 'approvedAt: "2026-11-14T08:00:00.000Z"')
    .replace("approvedBy: null", `approvedBy: ${ACTOR}`)
    .replace("sha256: null", `sha256: ${hash}`)
    .replace("sourceTorCommit: null", `sourceTorCommit: ${MERGE}`);
  const reference = {
    document: "projectPlan",
    projectId: "demo",
    repo: "o/r",
    sourcePr: 12,
    sourceHeadSha: HEAD,
    sourceMergeSha: MERGE,
  };
  const harness = gateGithub({
    pulls: {
      12: pullFixture({ number: 12, headSha: HEAD, baseSha: BASE, state: "closed", merged: true, mergeCommitSha: MERGE, headRef: "project-plan/demo/stamp" }),
      13: pullFixture({ number: 13, headSha: RECORD_HEAD, baseSha: BASE, body: renderRecordingReference(reference), headRef: "project-plan/demo/baseline/stamp" }),
    },
    comments: { 12: [{ id: 1, body: approval().comment.body, user: { login: approval().comment.authorLogin } }] },
    files: {
      13: [
        { filename: "projects/demo/project.yaml", status: "modified" },
        { filename: "projects/demo/docs/project-plan.md", status: "modified" },
      ],
    },
    contents: {
      [`${BASE}:projects/demo/project.yaml`]: before,
      [`${RECORD_HEAD}:projects/demo/project.yaml`]: after,
      [`${BASE}:projects/demo/docs/project-plan.md`]: draft,
      [`${RECORD_HEAD}:projects/demo/docs/project-plan.md`]: edited,
    },
  });
  await mergeRecordingPullRequest(harness.client, {
    pullNumber: 13,
    allowedUserIds: [ANAK],
    signingSecret: SECRET,
  });
  assert.equal(harness.state.merges.length, 1);
  assert.equal(harness.state.merges[0].body.sha, RECORD_HEAD);
});

test("gate offers approve, request revision and reject draft for project-plan, and none for its baseline", () => {
  assert.deepEqual(actionsForStage("project-plan", "open"), ["approve", "revise", "reject-draft"]);
  assert.deepEqual(actionsForStage("project-plan-baseline", "open"), []);
});

test("reject draft and request revision require a reason", async () => {
  const harness = gateGithub({
    pulls: { 12: pullFixture({ number: 12, headSha: HEAD, baseSha: BASE, headRef: "project-plan/demo/stamp" }) },
  });
  const waiting = await handleGateClick(click(harness, "reject-draft"));
  assert.equal(waiting.status, "needs-reason");
  assert.equal(harness.state.closes.length, 0);
  const revise = await handleGateClick(click(harness, "revise"));
  assert.equal(revise.status, "needs-reason");
});

test("reject draft closes the plan PR, leaves the project active, and leaves projectPlan.status none", async () => {
  const harness = gateGithub({
    pulls: { 12: pullFixture({ number: 12, headSha: HEAD, baseSha: BASE, headRef: "project-plan/demo/stamp" }) },
  });
  const done = await handleGateClick(click(harness, "reject-draft", "Start again."));
  assert.equal(done.status, "reject-draft");
  assert.equal(done.decision.reason, "Start again.");
  assert.deepEqual(harness.state.closes, [12]);
  const yaml = projectYamlForPlanPullRequest("id: demo\nstatus: active\n").yaml;
  const project = parseSimpleYaml(yaml);
  assert.equal(project.status, "active");
  assert.equal(project.projectPlan.status, "none");
});

test("push after approval blocks merge and re-asks", async () => {
  const harness = gateGithub({
    pulls: { 12: pullFixture({ number: 12, headSha: "b".repeat(40), baseSha: BASE, headRef: "project-plan/demo/stamp" }) },
    commits: { 12: [{ sha: "b".repeat(40), author: { login: "anak" }, commit: { message: "edit" }, files: [] }] },
  });
  const result = await handleGateClick(click(harness, "approve"));
  assert.equal(result.status, "reask");
  assert.equal(harness.state.merges.length, 0);
});

test("revision after approval opens new stamped PR and new baseline", () => {
  const branch = "project-plan/demo/20261114T090000Z";
  assert.equal(branch.startsWith("project-plan/demo/"), true);
  assert.equal(branch.includes("/baseline/"), false);
  assert.equal("project-plan/demo/baseline/20261114T090000Z".includes("/baseline/"), true);
});

function approval() {
  const decision = buildDecision({
    projectId: "demo",
    stage: "project-plan",
    repo: "o/r",
    pr: 12,
    headSha: HEAD,
    baseSha: BASE,
    action: "approve",
    decidedBy: ACTOR,
    decidedAt: "2026-11-14T08:00:00.000Z",
    slack: { channel: "C0CG6SG8PNW", ts: "1700000000.000100", permalink: null, verification: "hmac", requestTimestamp: "1700000000" },
    reason: null,
    humanCommits: [],
    idempotencyKey: "plan-approve",
    signingSecret: SECRET,
  });
  const comment = { body: renderDecisionComment(decision, IDENTITY.label), authorLogin: IDENTITY.botLogin };
  const verified = verifyGateDecision({
    comment,
    expectedAuthorLogin: IDENTITY.botLogin,
    repo: "o/r",
    pullNumber: 12,
    liveHeadSha: HEAD,
    allowedUserIds: [ANAK],
    projectId: "demo",
    signingSecret: SECRET,
    requireCi: false,
  });
  if (!verified.ok) throw new Error(verified.reason);
  return { comment, verified: verified.verified };
}

function click(harness, action, reason) {
  const now = Date.parse("2026-11-14T08:00:00.000Z");
  const value = JSON.stringify({ projectId: "demo", stage: "project-plan", pr: 12, headSha: HEAD, action, repo: "o/r" });
  const timestamp = String(Math.floor(now / 1000));
  return {
    actionId: `gate:${action}`,
    value,
    actor: { id: ANAK, isBot: false, teamId: "T0TEAM" },
    channelId: "C0CG6SG8PNW",
    messageTs: "1700000000.000100",
    threadTs: "1700000000.000100",
    rawBody: value,
    requestTimestamp: timestamp,
    signature: signSlackRequest({ signingSecret: SECRET, timestamp, rawBody: value }),
    now,
    env: { SLACK_SIGNING_SECRET: SECRET },
    client: harness.client,
    allowedUserIds: [ANAK],
    allowedChannelIds: ["C0CG6SG8PNW"],
    loadProjectUsers: async () => [ANAK],
    reason,
  };
}
