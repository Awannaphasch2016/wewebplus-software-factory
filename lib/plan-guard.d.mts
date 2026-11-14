export function planWriteAllowed(input: { filePath: string; branch?: string; grant?: { agent?: string; projectId?: string; branchPrefix?: string } | null }):
  { applies: boolean; allowed: boolean; reason?: string };
export function issuePlanWriteGrant(client: { owner: string; repo: string; request: Function }, projectId: string): Promise<
  | { ok: true; grant: { agent: string; projectId: string; branchPrefix: string } }
  | { ok: false; reason: string }
>;
