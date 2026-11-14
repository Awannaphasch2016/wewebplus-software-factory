export const PLAN_SECTIONS: readonly string[];
export function parsePlanElicitation(log: string): Array<{
  id: string;
  field: string | null;
  value: string | null;
  responder: string | null;
  resolution: string;
}>;
export function validateProjectPlan(input?: {
  plan?: string;
  tor?: string;
  elicitationLog?: string;
  approverIds?: readonly string[];
}): { ok: boolean; errors: string[] };
