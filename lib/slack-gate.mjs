import { parseSimpleYaml } from "./project-yaml.mjs";
import {
  ACTION_LABELS,
  actionNeedsReason,
  actionsForStage,
  gateApproverIds,
  gateDenyIds,
  stageIsKnown,
} from "./gate-actions.mjs";
import { renderGateReasonModal, requireGateReason } from "./gate-reason.mjs";
import {
  DECISION_KIND,
  PENDING_KIND,
  REASON_PROMPT,
  buildDecision,
  buildPending,
  gateIdempotencyKey,
  parseDecisionComment,
  parseFencedRecord,
  renderDecisionComment,
  renderPendingComment,
} from "./gate-decision.mjs";
import { verifySlackRequestSignature } from "./slack-signature.mjs";
import {
  assertInsideProject,
  closePullRequest,
  commentOnPullRequest,
  getPullRequestStatus,
  humanCommitsSince,
  listIssueComments,
  listPullRequestCommits,
  mergeApprovedPullRequest,
  readRepoTextFile,
} from "./github.mjs";

const SHA = /^[0-9a-f]{40}$/i;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;
const REPO = /^[^/\s]+\/[^/\s]+$/;

export function actorFromUsersInfo(userId, info) {
  if (!info || info.ok !== true || !info.user) {
    return { ok: false, reason: "slack user lookup failed" };
  }
  const isBot = info.user.is_bot === true || info.user.is_app_user === true || Boolean(info.user.bot_id);
  return { ok: true, actor: { id: userId, isBot } };
}

export function parseGateButtonValue(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, reason: "button value is not JSON" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "button value is not an object" };
  if (typeof parsed.projectId !== "string" || !PROJECT_ID.test(parsed.projectId)) {
    return { ok: false, reason: "button project is invalid" };
  }
  if (!stageIsKnown(parsed.stage)) return { ok: false, reason: "button stage is invalid" };
  if (!Number.isInteger(parsed.pr) || parsed.pr < 1) return { ok: false, reason: "button pull request is invalid" };
  if (typeof parsed.headSha !== "string" || !SHA.test(parsed.headSha)) {
    return { ok: false, reason: "button head SHA is invalid" };
  }
  if (!["approve", "reject", "revise", "reject-draft"].includes(parsed.action)) {
    return { ok: false, reason: "button action is invalid" };
  }
  if (typeof parsed.repo !== "string" || !REPO.test(parsed.repo)) {
    return { ok: false, reason: "button repo is invalid" };
  }
  return { ok: true, button: parsed };
}

export function renderGateCard({
  projectId,
  stage,
  repo,
  pr,
  headSha,
  state = "open",
  humanCommits = [],
  stale = false,
  note = "",
}) {
  const actions = actionsForStage(stage, state);
  const shown = humanCommits.slice(0, 20);
  const commitLines = shown.length
    ? shown
        .map((commit) => {
          const files = (commit.files ?? []).map((file) => file.filename).join(", ") || "no files";
          return `• \`${commit.sha.slice(0, 12)}\` ${commit.summary} (${files}, +${commit.additions ?? 0} -${commit.deletions ?? 0})`;
        })
        .join("\n")
    : "No human commits on this pull request.";
  const extra = humanCommits.length > shown.length ? `\n…and ${humanCommits.length - shown.length} more.` : "";
  const intro = stale
    ? `The previous button was for a different commit. Review the commits people added, then use the new buttons.`
    : `Only the actions for this stage are offered. The model cannot merge.`;
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `Gate ${stage}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${repo}* pull request #${pr}\nProject \`${projectId}\`\nHead \`${headSha}\`\n${intro}${note ? `\n${note}` : ""}`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Commits by people*\n${commitLines}${extra}` },
    },
  ];
  if (actions.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          state === "open"
            ? "No approval buttons are offered for this stage."
            : "This pull request is no longer open, so there is nothing to approve.",
      },
    });
  } else {
    blocks.push({
      type: "actions",
      block_id: `gate:${stage}:${pr}:${headSha.slice(0, 12)}`,
      elements: actions.map((action) => {
        const element = {
          type: "button",
          action_id: `gate:${action}`,
          text: { type: "plain_text", text: ACTION_LABELS[action] },
          value: JSON.stringify({ projectId, stage, pr, headSha, action, repo }),
        };
        if (action === "approve") element.style = "primary";
        if (action === "reject" || action === "reject-draft") element.style = "danger";
        return element;
      }),
    });
    for (const action of actions) {
      if (!actionNeedsReason(action)) continue;
      const encoded = JSON.stringify({ projectId, stage, pr, headSha, action, repo });
      if (encoded.length > 255) continue;
      blocks.push({
        type: "input",
        dispatch_action: true,
        block_id: encoded,
        label: { type: "plain_text", text: `${ACTION_LABELS[action]} reason` },
        element: {
          type: "plain_text_input",
          action_id: `gate:${action}`,
          placeholder: { type: "plain_text", text: "Required" },
        },
      });
    }
  }
  const text = `Gate ${stage} for ${repo}#${pr} at ${headSha.slice(0, 12)}`;
  return { text, blocks };
}

export function renderSrsReviewNotice({ projectId }) {
  return {
    text: `SRS needs review for ${projectId}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "SRS needs review" } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Project \`${projectId}\` has a new agreed project plan. The SRS stays in this project and needs review before Phase 3 continues. There are no approval buttons.`,
        },
      },
    ],
  };
}

export function renderHashMismatchAlert({ projectId, reason = "tor-hash-mismatch" }) {
  return {
    text: `TOR hash mismatch for ${projectId}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "TOR hash mismatch" } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Project \`${projectId}\` is stopped (\`${reason}\`). Revert the TOR on the default branch or start a new project. There are no approval buttons.`,
        },
      },
    ],
  };
}

function authorizeClick({ actor, channelId, factoryUserIds, projectUserIds, env }) {
  if (!actor || actor.isBot) return { allowed: false, reason: "bot click" };
  const userId = actor.id;
  if (gateDenyIds(env).includes(userId)) return { allowed: false, reason: "user is not a gate approver" };
  if (!Array.isArray(factoryUserIds) || factoryUserIds.length === 0) {
    return { allowed: false, reason: "fail-closed: factory allowlist is empty" };
  }
  if (!factoryUserIds.includes(userId)) {
    return { allowed: false, reason: "user is not on the factory allowlist" };
  }
  let approvers;
  try {
    approvers = gateApproverIds(env);
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : "fail-closed: gate approver list is empty",
    };
  }
  if (!approvers.includes(userId)) return { allowed: false, reason: "user is not a gate approver" };
  if (!Array.isArray(projectUserIds) || projectUserIds.length === 0 || !projectUserIds.includes(userId)) {
    return { allowed: false, reason: "user is not authorized for this project" };
  }
  if (!channelId || !Array.isArray(actor.allowedChannelIds) || !actor.allowedChannelIds.includes(channelId)) {
    return { allowed: false, reason: "channel is not on the allowlist" };
  }
  return { allowed: true };
}

function resolveVerification({ rawBody, signature, requestTimestamp, trustedWebhook, env, now }) {
  if (rawBody != null && signature && requestTimestamp != null) {
    const checked = verifySlackRequestSignature({
      signingSecret: env.SLACK_SIGNING_SECRET,
      timestamp: requestTimestamp,
      rawBody,
      signature,
      now,
    });
    if (!checked.ok) return checked;
    return { ok: true, method: "hmac" };
  }
  if (trustedWebhook === "eve" && env.SLACK_SIGNING_SECRET) return { ok: true, method: "hmac" };
  if (trustedWebhook === "eve" && env.SLACK_CONNECTOR) return { ok: true, method: "eve-connect" };
  return { ok: false, reason: "slack signature was not verified" };
}

async function defaultProjectUsers(client, projectId, ref) {
  const path = assertInsideProject(projectId, `projects/${projectId}/project.yaml`);
  const text = await readRepoTextFile(client, path, ref);
  if (!text) return [];
  const parsed = parseSimpleYaml(text);
  const ids = parsed.authorization?.allowedSlackUserIds;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
}

function permalinkFor(channel, ts) {
  if (!channel || !ts) return null;
  return `https://slack.com/archives/${channel}/p${String(ts).replace(".", "")}`;
}

function decisionForKey(comments, botLogin, key) {
  return comments.find((comment) => {
    if (comment.authorLogin !== botLogin) return false;
    const parsed = parseDecisionComment(comment.body);
    return parsed.ok && parsed.decision.idempotencyKey === key;
  });
}

export function resolveGateClick(input) {
  const fromValue = parseGateButtonValue(String(input.value ?? ""));
  if (fromValue.ok) return { ok: true, button: fromValue.button, reason: input.reason };
  const fromBlock = parseGateButtonValue(String(input.blockId ?? ""));
  if (!fromBlock.ok) return fromValue.ok ? fromValue : fromBlock;
  return { ok: true, button: fromBlock.button, reason: input.value };
}

export async function handleGateClick(input) {
  const env = input.env ?? process.env;
  const actionId = input.actionId ?? "";
  if (actionId.startsWith("eve_input:")) return { status: "ignored", reason: "eve control" };
  if (!actionId.startsWith("gate:")) return { status: "ignored", reason: "not a gate action" };

  const verification = resolveVerification({ ...input, env });
  if (!verification.ok) return { status: "ignored", reason: verification.reason };
  if (verification.method === "eve-connect" && !String(input.client?.identity?.botLogin ?? "").endsWith("[bot]")) {
    return { status: "ignored", reason: "eve-connect decisions require the GitHub App bot" };
  }

  const resolved = resolveGateClick(input);
  if (!resolved.ok) return { status: "ignored", reason: resolved.reason };
  const button = resolved.button;
  const suppliedReason = resolved.reason;
  if (actionId !== `gate:${button.action}`) return { status: "ignored", reason: "action id does not match the button" };
  const repo = `${input.client.owner}/${input.client.repo}`;
  if (button.repo !== repo) return { status: "ignored", reason: "button repo does not match the gate repository" };
  if (!input.client.identity?.botLogin) return { status: "ignored", reason: "GitHub identity is unresolved" };

  const actor = { ...input.actor, allowedChannelIds: input.allowedChannelIds };
  const projectUsers = input.loadProjectUsers
    ? await input.loadProjectUsers({ projectId: button.projectId, ref: button.headSha })
    : await defaultProjectUsers(input.client, button.projectId, button.headSha);
  const allowed = authorizeClick({
    actor,
    channelId: input.channelId,
    factoryUserIds: input.allowedUserIds,
    projectUserIds: projectUsers,
    env,
  });
  if (!allowed.allowed) return { status: "ignored", reason: allowed.reason };
  if (!input.actor?.teamId) return { status: "ignored", reason: "slack team is missing" };

  const pull = await getPullRequestStatus(input.client, button.pr);
  const commits = await listPullRequestCommits(input.client, button.pr);
  const botLogin = input.client.identity?.botLogin ?? null;
  if (pull.state !== "open" || pull.headSha !== button.headSha) {
    const headMoved = pull.headSha !== button.headSha;
    const human = humanCommitsSince(commits, {
      botLogin,
      afterSha: headMoved ? button.headSha : null,
    });
    const card = renderGateCard({
      ...button,
      headSha: pull.headSha ?? button.headSha,
      state: pull.state === "open" ? "open" : "closed",
      humanCommits: human,
      stale: headMoved,
    });
    if (input.post) await input.post(card);
    return { status: "reask", humanCommits: human, card };
  }

  const offered = actionsForStage(button.stage, "open");
  if (!offered.includes(button.action)) return { status: "ignored", reason: "action is not offered for this stage" };

  const comments = await listIssueComments(input.client, button.pr);
  const key = gateIdempotencyKey({
    repo,
    pr: button.pr,
    teamId: input.actor.teamId,
    channel: input.channelId,
    messageTs: input.messageTs,
    userId: input.actor.id,
    action: button.action,
    headSha: button.headSha,
  });
  const existing = decisionForKey(comments, botLogin, key);
  if (existing) {
    if (button.action === "approve" && pull.state === "open" && !pull.merged) {
      await mergeApprovedPullRequest(input.client, gateMergeInput(input, button));
    }
    if (button.action === "reject" && pull.state === "open") await closePullRequest(input.client, button.pr);
    return { status: "replay" };
  }
  const prior = comments
    .map((comment) => (comment.authorLogin === botLogin ? parseDecisionComment(comment.body) : null))
    .find((parsedComment) => parsedComment?.ok && parsedComment.decision.headSha === button.headSha && parsedComment.decision.pr === button.pr);
  if (prior) return { status: "ignored", reason: "a decision is already recorded for this commit" };

  if (actionNeedsReason(button.action)) {
    const assessed = requireGateReason(button.action, suppliedReason);
    if (!assessed.ok) {
      if (suppliedReason !== undefined) {
        return { status: "refused", reason: assessed.reason };
      }
      if (input.reasonCapture === "modal") {
        return { status: "refused", reason: assessed.reason, capture: "modal" };
      }
      if (input.openReasonModal) {
        try {
          await input.openReasonModal(renderGateReasonModal({
            title: button.action === "revise" ? "Request revision" : "Reject",
            button,
          }));
          return { status: "refused", reason: assessed.reason, capture: "modal" };
        } catch {
          // The modal could not be opened. The thread reply below is the fallback.
        }
      }
      const pendingKey = comments.some((comment) => {
        if (comment.authorLogin !== botLogin) return false;
        const pending = parseFencedRecord(comment.body, PENDING_KIND);
        return pending?.idempotencyKey === key;
      });
      if (!pendingKey) {
        const pending = buildPending({
          projectId: button.projectId,
          stage: button.stage,
          repo,
          pr: button.pr,
          headSha: button.headSha,
          action: button.action,
          requestedBy: `slack:${input.actor.teamId}:${input.actor.id}`,
          idempotencyKey: key,
          slack: { channel: input.channelId, threadTs: input.threadTs ?? null, messageTs: input.messageTs },
        });
        await commentOnPullRequest(
          input.client,
          button.pr,
          renderPendingComment(pending, input.client.identity?.label),
        );
      }
      const prompt = renderPendingComment(
        buildPending({
          projectId: button.projectId,
          stage: button.stage,
          repo,
          pr: button.pr,
          headSha: button.headSha,
          action: button.action,
          requestedBy: `slack:${input.actor.teamId}:${input.actor.id}`,
          idempotencyKey: key,
          slack: { channel: input.channelId, threadTs: input.threadTs ?? null, messageTs: input.messageTs },
        }),
        null,
      );
      if (input.post && !pendingKey) await input.post({ text: prompt, blocks: [] });
      return { status: "needs-reason", prompt: REASON_PROMPT, reason: assessed.reason };
    }
    return recordDecision({ ...input, reason: assessed.reason }, button, key, commits, verification.method);
  }

  return recordDecision({ ...input, reason: null }, button, key, commits, verification.method);
}

function gateMergeInput(input, button) {
  return {
    pullNumber: button.pr,
    projectId: button.projectId,
    allowedUserIds: gateApproverIds(input.env ?? process.env),
    signingSecret: (input.env ?? process.env).SLACK_SIGNING_SECRET,
    env: input.env ?? process.env,
  };
}

async function recordDecision(input, button, key, commits, verification) {
  const env = input.env ?? process.env;
  const human = humanCommitsSince(commits, { botLogin: input.client.identity?.botLogin ?? null });
  const decision = buildDecision({
    projectId: button.projectId,
    stage: button.stage,
    repo: button.repo,
    pr: button.pr,
    headSha: button.headSha,
    baseSha: (await getPullRequestStatus(input.client, button.pr)).baseSha,
    action: button.action,
    decidedBy: `slack:${input.actor.teamId}:${input.actor.id}`,
    decidedAt: new Date(input.now ?? Date.now()).toISOString(),
    slack: {
      channel: input.channelId,
      ts: input.messageTs,
      permalink: permalinkFor(input.channelId, input.messageTs),
      verification,
      requestTimestamp: String(input.requestTimestamp ?? Math.floor((input.now ?? Date.now()) / 1000)),
    },
    reason: String(input.reason ?? "").trim() || null,
    humanCommits: human.map((commit) => commit.sha),
    idempotencyKey: key,
    signingSecret: verification === "hmac" ? env.SLACK_SIGNING_SECRET : undefined,
  });
  await commentOnPullRequest(input.client, button.pr, renderDecisionComment(decision, input.client.identity?.label));
  if (button.action === "approve") {
    await mergeApprovedPullRequest(input.client, gateMergeInput(input, button));
    return { status: "approved", decision, humanCommits: human };
  }
  if (button.action === "reject" || button.action === "reject-draft") {
    await closePullRequest(input.client, button.pr);
    return {
      status: button.action === "reject-draft" ? "reject-draft" : "rejected",
      decision,
      humanCommits: human,
    };
  }
  return { status: "revise", decision, humanCommits: human };
}

export function pendingFromThread(threadMessages) {
  const found = [];
  for (const message of threadMessages ?? []) {
    if (!message?.isBot) continue;
    const pending = parseFencedRecord(message.text ?? "", PENDING_KIND);
    if (pending?.kind === PENDING_KIND) found.push(pending);
  }
  return found.at(-1) ?? null;
}

export async function handleReasonReply(input) {
  const env = input.env ?? process.env;
  const verification = resolveVerification({ ...input, env });
  if (!verification.ok) return { status: "ignored", reason: verification.reason };
  if (!input.actor || input.actor.isBot) return { status: "ignored", reason: "bot click" };
  const pending = pendingFromThread(input.threadMessages);
  if (!pending) return { status: "ignored", reason: "no pending gate reason" };
  const assessed = requireGateReason(pending.action, input.text);
  if (!assessed.ok) return { status: "needs-reason", prompt: REASON_PROMPT, reason: assessed.reason };
  const reason = assessed.reason;
  if (pending.requestedBy !== `slack:${input.actor.teamId}:${input.actor.id}`) {
    return { status: "ignored", reason: "reason is from a different person" };
  }
  if (pending.slack?.channel !== input.channelId) return { status: "ignored", reason: "channel is not on the allowlist" };
  const projectUsers = input.loadProjectUsers
    ? await input.loadProjectUsers({ projectId: pending.projectId, ref: pending.headSha })
    : await defaultProjectUsers(input.client, pending.projectId, pending.headSha);
  const allowed = authorizeClick({
    actor: { ...input.actor, allowedChannelIds: input.allowedChannelIds },
    channelId: input.channelId,
    factoryUserIds: input.allowedUserIds,
    projectUserIds: projectUsers,
    env,
  });
  if (!allowed.allowed) return { status: "ignored", reason: allowed.reason };
  const comments = await listIssueComments(input.client, pending.pr);
  const stored = comments.find((comment) => {
    if (comment.authorLogin !== input.client.identity?.botLogin) return false;
    const parsed = parseFencedRecord(comment.body, PENDING_KIND);
    return parsed?.idempotencyKey === pending.idempotencyKey;
  });
  if (!stored) return { status: "ignored", reason: "pending record is not on the pull request" };
  const button = {
    projectId: pending.projectId,
    stage: pending.stage,
    repo: pending.repo,
    pr: pending.pr,
    headSha: pending.headSha,
    action: pending.action,
  };
  const parsed = parseGateButtonValue(JSON.stringify(button));
  if (!parsed.ok) return { status: "ignored", reason: parsed.reason };
  const pull = await getPullRequestStatus(input.client, button.pr);
  if (pull.state !== "open" || pull.headSha !== button.headSha) {
    const headMoved = pull.headSha !== button.headSha;
    const commits = await listPullRequestCommits(input.client, button.pr);
    const human = humanCommitsSince(commits, {
      botLogin: input.client.identity?.botLogin,
      afterSha: headMoved ? button.headSha : null,
    });
    const card = renderGateCard({
      ...button,
      headSha: pull.headSha ?? button.headSha,
      state: pull.state === "open" ? "open" : "closed",
      humanCommits: human,
      stale: headMoved,
    });
    if (input.post) await input.post(card);
    return { status: "reask", card, humanCommits: human };
  }
  const existing = decisionForKey(comments, input.client.identity?.botLogin, pending.idempotencyKey);
  if (existing) return { status: "replay" };
  const commits = await listPullRequestCommits(input.client, button.pr);
  return recordDecision(
    { ...input, reason, requestTimestamp: input.requestTimestamp ?? pending.slack?.messageTs ?? "0" },
    button,
    pending.idempotencyKey,
    commits,
    verification.method,
  );
}

export { DECISION_KIND };
