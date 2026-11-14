export function planGateSummary(input: { plan: string; tor: string; elicitationLog: string }): string;
export function projectYamlForPlanPullRequest(yaml: string): { include: boolean; yaml: string };
export function openPlanDraft(client: unknown, input: Record<string, unknown>): Promise<Record<string, unknown>>;
export function recordProjectPlanBaseline(client: unknown, input: Record<string, unknown>): Promise<Record<string, unknown>>;
export function planSha256(text: string): string;
