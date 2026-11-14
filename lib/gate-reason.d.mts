export const GATE_REASON_MODAL_CALLBACK: string;
export function requireGateReason(action: string, raw: unknown):
  | { required: false; ok: true; reason: null }
  | { required: true; ok: false; reason: string }
  | { required: true; ok: true; reason: string };
export function renderGateReasonModal(input: {
  title?: string;
  button: { projectId: string; stage: string; pr: number; headSha: string; action: string; repo: string };
}): Record<string, unknown>;
