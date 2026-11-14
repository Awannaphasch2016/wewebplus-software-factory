export function actorFromUsersInfo(
  userId: string,
  info: { ok?: boolean; user?: { is_bot?: boolean; is_app_user?: boolean; bot_id?: string } } | null,
): { ok: true; actor: { id: string; isBot: boolean } } | { ok: false; reason: string };
export function parseGateButtonValue(value: string):
  | { ok: true; button: { projectId: string; stage: string; pr: number; headSha: string; action: string; repo: string } }
  | { ok: false; reason: string };
export function renderGateCard(input: {
  projectId: string;
  stage: string;
  repo: string;
  pr: number;
  headSha: string;
  state?: string;
  humanCommits?: readonly {
    sha: string;
    summary?: string;
    files?: readonly { filename: string }[];
    additions?: number;
    deletions?: number;
  }[];
  stale?: boolean;
  note?: string;
}): { text: string; blocks: readonly Record<string, unknown>[] };
export function renderHashMismatchAlert(input: { projectId: string; reason?: string }): {
  text: string;
  blocks: readonly Record<string, unknown>[];
};
export function resolveGateClick(input: { value?: string; blockId?: string; reason?: string }):
  | { ok: true; button: { projectId: string; stage: string; pr: number; headSha: string; action: string; repo: string }; reason: string | undefined }
  | { ok: false; reason: string };
export function handleGateClick(input: Record<string, any>): Promise<Record<string, any>>;
export function pendingFromThread(threadMessages: readonly { text?: string; isBot?: boolean }[]): Record<string, any> | null;
export function handleReasonReply(input: Record<string, any>): Promise<Record<string, any>>;
export const DECISION_KIND: string;
