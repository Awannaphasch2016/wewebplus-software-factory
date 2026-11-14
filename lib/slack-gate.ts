import type { SlackInboundMessageContext, SlackInteractionAction, SlackInteractionContext, SlackMessage } from "eve/channels/slack";
import type { GithubClient } from "./github.mjs";
import { actionNeedsReason } from "./gate-actions.mjs";
import { renderGateReasonModal } from "./gate-reason.mjs";
import { actorFromUsersInfo, handleGateClick, handleReasonReply, parseGateButtonValue } from "./slack-gate.mjs";

export type SlackGateOptions = {
  agent: string;
  allowedUserIds: readonly string[];
  allowedChannelIds: readonly string[];
  createClient: () => Promise<GithubClient>;
};

type GatePost = { text: string; blocks?: readonly Record<string, unknown>[] };

function scrub(error: unknown) {
  const message = error instanceof Error ? error.message : "gate failed";
  return message.replace(/ghs_[A-Za-z0-9_]+/g, "[redacted]").replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted]").slice(0, 300);
}

async function post(ctx: SlackInteractionContext | SlackInboundMessageContext, payload: GatePost) {
  const body: Record<string, unknown> = {
    channel: ctx.slack.channelId,
    text: payload.text,
  };
  if (ctx.slack.threadTs) body.thread_ts = ctx.slack.threadTs;
  if (payload.blocks && payload.blocks.length > 0) body.blocks = payload.blocks;
  await ctx.slack.request("chat.postMessage", body);
}

/**
 * Shared gate handlers for every agent's Slack channel.
 * This is not a shared HTTP router. Each agent still has its own `/eve/<agent>/v1/slack`
 * URL, and the Slack app can point at only one of them. Whichever URL receives the
 * signed webhook runs this same handler.
 */
export function createSlackGate(options: SlackGateOptions) {
  return {
    async onInteraction(action: SlackInteractionAction, ctx: SlackInteractionContext) {
      if (!action.actionId.startsWith("gate:")) return;
      let reasonCapture: "modal" | undefined;
      const early = parseGateButtonValue(action.value ?? "");
      if (early.ok && actionNeedsReason(early.button.action) && action.triggerId) {
        try {
          await ctx.slack.request("views.open", {
            trigger_id: action.triggerId,
            view: renderGateReasonModal({
              title: early.button.action === "revise" ? "Request revision" : "Reject",
              button: early.button,
            }),
          });
          reasonCapture = "modal";
        } catch {
          reasonCapture = undefined;
        }
      }
      try {
        const info = await ctx.slack.request("users.info", { user: action.user.id });
        const actorResult = actorFromUsersInfo(action.user.id, info as { ok?: boolean; user?: { is_bot?: boolean; is_app_user?: boolean; bot_id?: string } });
        if (!actorResult.ok) {
          await post(ctx, { text: "Gate could not confirm the Slack user, so the click was ignored." });
          return;
        }
        const client = await options.createClient();
        const result = await handleGateClick({
          actionId: action.actionId,
          value: action.value,
          blockId: action.blockId,
          actor: { ...actorResult.actor, teamId: ctx.slack.teamId },
          channelId: ctx.slack.channelId,
          messageTs: action.messageTs,
          threadTs: ctx.slack.threadTs,
          trustedWebhook: "eve",
          env: process.env,
          client,
          allowedUserIds: options.allowedUserIds,
          allowedChannelIds: options.allowedChannelIds,
          reasonCapture,
          post: (payload: GatePost) => post(ctx, payload),
        });
        if (result.status === "approved" || result.status === "rejected" || result.status === "revise") {
          await post(ctx, { text: `Gate recorded ${result.status} for pull request #${result.decision?.pr}.` });
        }
      } catch (error) {
        console.error(`[slack-gate] agent=${options.agent} ${scrub(error)}`);
        try {
          await post(ctx, { text: "Gate could not record the decision." });
        } catch {
          console.error(`[slack-gate] agent=${options.agent} could not post the failure`);
        }
      }
    },
    async consumeReasonReply(ctx: SlackInboundMessageContext, message: SlackMessage) {
      try {
        await ctx.thread.refresh();
        const hasPending = ctx.thread.recentMessages.some(
          (entry) => (entry.isMe || Boolean(entry.botId)) && entry.text.includes("factory-gate-pending"),
        );
        if (!hasPending) return false;
        const client = await options.createClient();
        const result = await handleReasonReply({
          text: message.text,
          actor: {
            id: message.author?.userId,
            isBot: message.author?.isBot === true,
            teamId: message.teamId ?? ctx.slack.teamId,
          },
          channelId: message.channelId,
          messageTs: message.ts,
          threadTs: message.threadTs,
          threadMessages: ctx.thread.recentMessages.map((entry) => ({
            text: entry.text,
            ts: entry.ts,
            isBot: entry.isMe || Boolean(entry.botId),
          })),
          trustedWebhook: "eve",
          env: process.env,
          client,
          allowedUserIds: options.allowedUserIds,
          allowedChannelIds: options.allowedChannelIds,
          post: (payload: GatePost) => post(ctx, payload),
        });
        if (result.status === "ignored") return false;
        if (result.status === "approved" || result.status === "rejected" || result.status === "revise") {
          await post(ctx, { text: `Gate recorded ${result.status} for pull request #${result.decision?.pr}.` });
        }
        return true;
      } catch (error) {
        console.error(`[slack-gate] agent=${options.agent} reason ${scrub(error)}`);
        return false;
      }
    },
  };
}
