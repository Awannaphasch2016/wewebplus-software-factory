import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";
import { gateApproverIds } from "../../../../lib/gate-actions.mjs";
import { factoryConfig } from "../../../../generated/config.js";
import { createSlackGate } from "../../../../lib/slack-gate.js";
import { createGateGithubClient } from "../../../specification/agent/lib/github-token.js";

const THREAD_GUIDANCE =
  "You are continuing a project-plan thread. Reply only when the message continues that work. Otherwise call no_reply.";

function allowUser(userId: string | undefined) {
  const allow = factoryConfig.allowedUserIds;
  return allow.length > 0 && Boolean(userId && allow.includes(userId));
}

function allowChannel(channelId: string | undefined) {
  const allow = factoryConfig.allowedChannelIds;
  return allow.length > 0 && Boolean(channelId && allow.includes(channelId));
}

function allowApprover(userId: string | undefined) {
  return Boolean(userId && gateApproverIds().includes(userId));
}

const gate = createSlackGate({
  agent: "project-planner",
  allowedUserIds: factoryConfig.allowedUserIds,
  allowedChannelIds: factoryConfig.allowedChannelIds,
  createClient: () => createGateGithubClient(),
});

export default slackChannel({
  credentials: process.env.SLACK_CONNECTOR
    ? connectSlackCredentials(process.env.SLACK_CONNECTOR)
    : undefined,
  onInteraction: (action, ctx) => gate.onInteraction(action, ctx),
  async onDirectMessage() {
    return null;
  },
  async onMessage(ctx, message) {
    if (!message.author || message.author.isBot) return null;
    if (message.raw.channel_type === "im") return null;
    if (!allowUser(message.author.userId) || !allowChannel(message.channelId)) return null;
    if (await gate.consumeReasonReply(ctx, message)) return null;
    if (factoryConfig.status !== "approved") return null;
    const auth = defaultSlackAuth(message, ctx);
    if (!auth) return null;
    if (ctx.isBotMentioned()) return { auth };
    const inThread = message.threadTs !== message.ts;
    if (ctx.edit || (inThread && (await ctx.isSubscribed()))) {
      return { auth, status: "deferred" as const, guidance: THREAD_GUIDANCE };
    }
    return null;
  },
  onMessageEdited() {
    return null;
  },
  onAnswers(ctx, submission) {
    if (!allowApprover(submission.user.id) || !allowChannel(ctx.slack.channelId)) return null;
    return { auth: ctx.defaultAuth };
  },
});
