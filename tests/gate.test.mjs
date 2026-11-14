import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { verifySlackRequest } from "../node_modules/eve/dist/src/public/channels/slack/verify.js";
import { actionsForStage, gateApproverIds } from "../lib/gate-actions.mjs";
import {
  buildDecision,
  parseDecisionComment,
  renderDecisionComment,
} from "../lib/gate-decision.mjs";
import { signSlackRequest, verifySlackRequestSignature } from "../lib/slack-signature.mjs";
import { actorFromUsersInfo, handleGateClick, handleReasonReply, renderGateCard } from "../lib/slack-gate.mjs";
import { IDENTITY, gateGithub, pullFixture } from "./gate-harness.mjs";

const SECRET = "test-signing-secret";
const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const BASE = "c".repeat(40);
const HUMAN = "d".repeat(40);
const ANAK = "U0CFRUV378D";
const CHANNEL = "C0CG6SG8PNW";
const root = new URL("..", import.meta.url);

test("stage table offers only the actions for that stage", () => {
  const cases = [
    ["setup", "open", ["approve", "reject"]],
    ["tor", "open", ["approve", "reject", "revise"]],
    ["tor-baseline", "open", []],
    ["srs", "open", ["approve", "reject", "revise"]],
    ["srs-baseline", "open", []],
    ["architecture", "open", ["approve", "reject", "revise"]],
    ["architecture-baseline", "open", []],
    ["approved", "open", []],
    ["rejected", "open", []],
    ["hash-mismatch", "open", []],
    ["tor", "closed", []],
  ];
  for (const [stage, state, expected] of cases) {
    assert.deepEqual(actionsForStage(stage, state), expected, stage);
  }
  const tor = renderGateCard(cardInput("tor"));
  const buttons = tor.blocks.find((block) => block.type === "actions").elements;
  assert.deepEqual(buttons.map((button) => button.action_id), ["gate:approve", "gate:reject", "gate:revise"]);
  assert.equal(buttons.some((button) => String(button.action_id).startsWith("eve_input:")), false);
  assert.equal(buttons.every((button) => button.value.length < 2000), true);
  const setup = renderGateCard(cardInput("setup"));
  assert.equal(setup.blocks.find((block) => block.type === "actions").elements.length, 2);
  const baseline = renderGateCard(cardInput("tor-baseline"));
  assert.equal(baseline.blocks.some((block) => block.type === "actions"), false);
  assert.equal(gateApproverIds({}).join(","), ANAK);
  assert.deepEqual(gateApproverIds({ FACTORY_GATE_APPROVER_IDS: "U0CFRUV378D, UEXTRA" }), [ANAK, "UEXTRA"]);
  assert.throws(() => gateApproverIds({ FACTORY_GATE_APPROVER_IDS: " , " }), /fail-closed/);
  assert.throws(() => gateApproverIds({ FACTORY_GATE_APPROVER_IDS: "WBOTUSER01" }), /fail-closed/);
});

test("Slack signatures accept the fixture and reject a bad, missing, or stale signature", async () => {
  const raw = await readFile(new URL("fixtures/test/gate/block_actions.raw.txt", root), "utf8");
  const now = Date.parse("2026-11-14T08:00:00.000Z");
  const timestamp = String(Math.floor(now / 1000));
  const signature = signSlackRequest({ signingSecret: SECRET, timestamp, rawBody: raw });
  assert.deepEqual(verifySlackRequestSignature({ signingSecret: SECRET, timestamp, rawBody: raw, signature, now }), { ok: true });
  assert.equal(verifySlackRequestSignature({ signingSecret: SECRET, timestamp, rawBody: raw, signature: `${signature}00`, now }).ok, false);
  assert.equal(verifySlackRequestSignature({ signingSecret: SECRET, timestamp, rawBody: raw, signature: undefined, now }).reason, "missing signature headers");
  assert.equal(
    verifySlackRequestSignature({ signingSecret: SECRET, timestamp: String(Number(timestamp) - 301), rawBody: raw, signature, now }).reason,
    "timestamp outside allowed skew",
  );
  assert.equal(
    verifySlackRequestSignature({ signingSecret: SECRET, timestamp: String(Number(timestamp) + 301), rawBody: raw, signature, now }).reason,
    "timestamp outside allowed skew",
  );
  assert.equal(verifySlackRequestSignature({ signingSecret: SECRET, timestamp: `${timestamp}.5`, rawBody: raw, signature, now }).reason, "malformed timestamp");
  const request = new Request("https://example.test/eve/specification/v1/slack", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: raw,
  });
  assert.equal(await verifySlackRequest(request, { signingSecret: SECRET, now: () => now }), raw);
  const rejected = new Request("https://example.test/eve/specification/v1/slack", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": "v0=deadbeef",
    },
    body: raw,
  });
  await assert.rejects(() => verifySlackRequest(rejected, { signingSecret: SECRET, now: () => now }), /signature/i);
});

test("onInteraction ignores eve controls, bots, and non-allowlisted people or channels", async () => {
  const harness = openHarness();
  assert.equal((await handleGateClick(click(harness, { actionId: "eve_input:approve" }))).reason, "eve control");
  assert.equal((await handleGateClick(click(harness, { actor: { id: "UOTHER", isBot: false, teamId: "T0TEAM" } }))).reason, "user is not on the factory allowlist");
  assert.equal((await handleGateClick(click(harness, { actor: { id: ANAK, isBot: true, teamId: "T0TEAM" } }))).reason, "bot click");
  assert.equal((await handleGateClick(click(harness, { channelId: "COTHER" }))).reason, "channel is not on the allowlist");
  assert.equal((await handleGateClick(click(harness, { allowedUserIds: [] }))).reason, "fail-closed: factory allowlist is empty");
  assert.match(
    (await handleGateClick(click(harness, { env: { SLACK_SIGNING_SECRET: SECRET, FACTORY_GATE_APPROVER_IDS: "," } }))).reason,
    /fail-closed/,
  );
  assert.equal(actorFromUsersInfo(ANAK, { ok: true, user: { is_bot: true } }).actor.isBot, true);
  assert.equal(actorFromUsersInfo(ANAK, { ok: false }).ok, false);
  assert.equal(harness.calls.some((call) => call.method === "POST" || call.method === "PUT"), false);
});

test("a stale button re-asks and lists human commits made since the old head", async () => {
  const harness = openHarness({ headSha: NEXT });
  const posts = [];
  const result = await handleGateClick(click(harness, { post: (payload) => posts.push(payload) }));
  assert.equal(result.status, "reask");
  assert.deepEqual(result.humanCommits.map((commit) => commit.sha), [HUMAN]);
  const rendered = JSON.stringify(posts[0].blocks);
  assert.match(rendered, /docs\/tor.md/);
  assert.match(rendered, /\+3 -1/);
  assert.equal(harness.state.merges.length, 0);
  assert.equal(harness.state.comments[12] ?? [].length, 0);
});

test("approve records the human commits and merges the pinned head once", async () => {
  const harness = openHarness();
  const first = await handleGateClick(click(harness));
  assert.equal(first.status, "approved");
  assert.deepEqual(first.decision.humanCommits, [HUMAN]);
  const comment = harness.state.comments[12].at(-1).body;
  assert.match(comment, new RegExp(IDENTITY.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const parsed = parseDecisionComment(comment);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.decision.humanCommits, [HUMAN]);
  assert.equal(harness.state.merges.length, 1);
  assert.equal(harness.state.merges[0].body.sha, HEAD);
  assert.equal(harness.state.merges[0].body.merge_method, "merge");
  const second = await handleGateClick(click(harness));
  assert.notEqual(second.status, "approved");
  assert.equal(harness.state.merges.length, 1);
});

test("Gate 1 reject without a reason is refused", async () => {
  const harness = openHarness();
  const waiting = await handleGateClick(click(harness, { action: "reject" }));
  assert.equal(waiting.status, "needs-reason");
  assert.equal(harness.state.closes.length, 0);
  const comments = harness.state.comments[12] ?? [];
  assert.equal(comments.some((comment) => comment.body.includes("factory-decision")), false);
});

test("Gate 1 request revision without a reason is refused", async () => {
  const harness = openHarness();
  const waiting = await handleGateClick(click(harness, { action: "revise" }));
  assert.equal(waiting.status, "needs-reason");
  assert.equal(harness.state.closes.length, 0);
  assert.equal(harness.state.merges.length, 0);
});

test("whitespace-only reason is refused", async () => {
  const harness = openHarness();
  const refused = await handleGateClick(click(harness, { action: "reject", reason: " \n\t " }));
  assert.equal(refused.status, "refused");
  assert.equal(harness.state.closes.length, 0);
  const posts = [];
  const waiting = await handleGateClick(click(harness, { action: "revise", post: (payload) => posts.push(payload) }));
  const blank = await handleReasonReply(reply(harness, posts[0].text, "   "));
  assert.equal(blank.status, "needs-reason");
  assert.equal(harness.state.comments[12].some((comment) => comment.body.includes("factory-decision")), false);
});

test("Gate 1 reject with a reason records it on the decision", async () => {
  const harness = openHarness();
  const done = await handleGateClick(click(harness, { action: "reject", reason: "Scope is still draft." }));
  assert.equal(done.status, "rejected");
  assert.equal(done.decision.reason, "Scope is still draft.");
  assert.deepEqual(harness.state.closes, [12]);
});

test("Gate 1 request revision with a reason records it on the decision", async () => {
  const harness = openHarness();
  const done = await handleGateClick(click(harness, { action: "revise", reason: "Add the missing acceptance row." }));
  assert.equal(done.status, "revise");
  assert.equal(done.decision.reason, "Add the missing acceptance row.");
  assert.equal(harness.state.closes.length, 0);
  assert.equal(harness.state.merges.length, 0);
});

test("approve still completes without a reason", async () => {
  const harness = openHarness();
  const done = await handleGateClick(click(harness, { reason: undefined }));
  assert.equal(done.status, "approved");
  assert.equal(done.decision.reason, null);
  assert.equal(harness.state.merges.length, 1);
});

test("setup-stage reject also requires a reason", async () => {
  const harness = openHarness();
  const waiting = await handleGateClick(click(harness, { action: "reject", stage: "setup" }));
  assert.equal(waiting.status, "needs-reason");
  assert.equal(harness.state.closes.length, 0);
  const done = await handleGateClick(click(harness, { action: "reject", stage: "setup", reason: "Wrong customer." }));
  assert.equal(done.status, "rejected");
  assert.equal(done.decision.stage, "setup");
  assert.equal(done.decision.reason, "Wrong customer.");
});

test("a reason modal opens before any decision, and a failed modal falls back to the thread", async () => {
  const harness = openHarness();
  let opened = null;
  const modal = await handleGateClick(click(harness, {
    action: "reject",
    openReasonModal: async (view) => {
      opened = view;
    },
  }));
  assert.equal(modal.status, "refused");
  assert.equal(modal.capture, "modal");
  assert.equal(opened.callback_id, "factory-gate-reason");
  assert.equal(harness.state.closes.length, 0);
  assert.equal(harness.state.comments[12], undefined);
  const posts = [];
  const fallback = await handleGateClick(click(harness, {
    action: "reject",
    post: (payload) => posts.push(payload),
    openReasonModal: async () => {
      throw new Error("views.open failed");
    },
  }));
  assert.equal(fallback.status, "needs-reason");
  assert.match(posts[0].text, /Reply in this thread/);
});

test("the in-card reason field records the same decision", async () => {
  const harness = openHarness();
  const button = { projectId: "demo", stage: "tor", pr: 12, headSha: HEAD, action: "reject", repo: "o/r" };
  const done = await handleGateClick({
    ...click(harness, { action: "reject" }),
    value: "Scope is still draft.",
    blockId: JSON.stringify(button),
  });
  assert.equal(done.status, "rejected");
  assert.equal(done.decision.reason, "Scope is still draft.");
});

test("reject and revise require a reason, and the next allowlisted reply completes the decision", async () => {
  const harness = openHarness();
  const posts = [];
  const waiting = await handleGateClick(click(harness, { action: "reject", post: (payload) => posts.push(payload) }));
  assert.equal(waiting.status, "needs-reason");
  assert.equal(waiting.prompt, "Reply in this thread with the reason or comments");
  assert.match(posts[0].text, /Reply in this thread with the reason or comments/);
  assert.equal(harness.state.closes.length, 0);
  const empty = await handleReasonReply(reply(harness, posts[0].text, "  "));
  assert.equal(empty.status, "needs-reason");
  const done = await handleReasonReply(reply(harness, posts[0].text, "Section 3 is still draft."));
  assert.equal(done.status, "rejected");
  assert.equal(done.decision.reason, "Section 3 is still draft.");
  assert.deepEqual(harness.state.closes, [12]);
});

test("decision JSON round-trips and an unknown schema is rejected", () => {
  const decision = buildDecision({
    projectId: "demo",
    stage: "tor",
    repo: "o/r",
    pr: 12,
    headSha: HEAD,
    baseSha: BASE,
    action: "approve",
    decidedBy: `slack:T0TEAM:${ANAK}`,
    decidedAt: "2026-11-14T08:00:00.000Z",
    slack: { channel: CHANNEL, ts: "1700000000.000100", permalink: null, verification: "hmac", requestTimestamp: "1700000000" },
    reason: null,
    humanCommits: [HUMAN],
    idempotencyKey: "key",
    signingSecret: SECRET,
  });
  const parsed = parseDecisionComment(renderDecisionComment(decision, IDENTITY.label));
  assert.deepEqual(parsed.decision, decision);
  const unknown = { ...decision, schema: 2 };
  assert.equal(parseDecisionComment(renderDecisionComment(unknown, IDENTITY.label)).reason, "unknown schema");
});

test("model tools do not receive a merge tool, and this repo does not claim a shared Slack router", async () => {
  const forbidden = [
    "mergeApprovedPullRequest",
    "mergeRecordingPullRequest",
    "sealMergeAuthorization",
    "markVerifiedDecision",
    "handleGateClick",
    "merge-auth",
    "trustedWebhook",
    "/merge",
  ];
  const files = await walk(new URL("agents/", root));
  for (const file of files) {
    if (!/\.(ts|mjs)$/.test(file.pathname)) continue;
    const text = await readFile(file, "utf8");
    for (const token of forbidden) {
      assert.equal(text.includes(token), false, `${file.pathname} contains ${token}`);
    }
  }
  const readme = await readFile(new URL("README.md", root), "utf8");
  assert.match(readme, /does not add a shared Slack router/);
});

function cardInput(stage) {
  return {
    projectId: "demo",
    stage,
    repo: "o/r",
    pr: 12,
    headSha: HEAD,
    state: "open",
    humanCommits: [{ sha: HUMAN, summary: "edit the draft", files: [{ filename: "projects/demo/docs/tor.md" }], additions: 3, deletions: 1 }],
  };
}

function openHarness({ headSha = HEAD } = {}) {
  return gateGithub({
    pulls: { 12: pullFixture({ number: 12, headSha, baseSha: BASE }) },
    commits: {
      12: [
        { sha: HEAD, author: { login: "factory[bot]" }, commit: { message: "draft" }, files: [] },
        {
          sha: HUMAN,
          author: { login: "anak" },
          commit: { message: "edit the draft" },
          files: [{ filename: "projects/demo/docs/tor.md", additions: 3, deletions: 1 }],
        },
      ],
    },
  });
}

function click(harness, overrides = {}) {
  const now = Date.parse("2026-11-14T08:00:00.000Z");
  const action = overrides.action ?? "approve";
  const stage = overrides.stage ?? "tor";
  const value = JSON.stringify({ projectId: "demo", stage, pr: 12, headSha: HEAD, action, repo: "o/r" });
  const timestamp = String(Math.floor(now / 1000));
  return {
    actionId: overrides.actionId ?? `gate:${action}`,
    value,
    actor: overrides.actor ?? { id: ANAK, isBot: false, teamId: "T0TEAM" },
    channelId: overrides.channelId ?? CHANNEL,
    messageTs: "1700000000.000100",
    threadTs: "1700000000.000100",
    rawBody: value,
    requestTimestamp: timestamp,
    signature: signSlackRequest({ signingSecret: SECRET, timestamp, rawBody: value }),
    now,
    env: overrides.env ?? { SLACK_SIGNING_SECRET: SECRET },
    client: harness.client,
    allowedUserIds: overrides.allowedUserIds ?? [ANAK],
    allowedChannelIds: [CHANNEL],
    loadProjectUsers: async () => [ANAK],
    post: overrides.post,
    reason: overrides.reason,
    openReasonModal: overrides.openReasonModal,
    reasonCapture: overrides.reasonCapture,
  };
}

function reply(harness, pendingText, text) {
  const now = Date.parse("2026-11-14T08:05:00.000Z");
  const timestamp = String(Math.floor(now / 1000));
  const rawBody = `reason:${text}`;
  return {
    text,
    actor: { id: ANAK, isBot: false, teamId: "T0TEAM" },
    channelId: CHANNEL,
    messageTs: "1700000000.000200",
    threadTs: "1700000000.000100",
    threadMessages: [{ text: pendingText, isBot: true }],
    rawBody,
    requestTimestamp: timestamp,
    signature: signSlackRequest({ signingSecret: SECRET, timestamp, rawBody }),
    now,
    env: { SLACK_SIGNING_SECRET: SECRET },
    client: harness.client,
    allowedUserIds: [ANAK],
    allowedChannelIds: [CHANNEL],
    loadProjectUsers: async () => [ANAK],
  };
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}
