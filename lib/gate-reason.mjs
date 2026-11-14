import { actionNeedsReason } from "./gate-actions.mjs";

export const GATE_REASON_MODAL_CALLBACK = "factory-gate-reason";

export function requireGateReason(action, raw) {
  if (!actionNeedsReason(action)) return { required: false, ok: true, reason: null };
  const text = typeof raw === "string" ? raw : "";
  if (text.trim().length === 0) {
    return { required: true, ok: false, reason: "a non-empty reason is required" };
  }
  return { required: true, ok: true, reason: text.trim() };
}

export function renderGateReasonModal({ title, button }) {
  return {
    type: "modal",
    callback_id: GATE_REASON_MODAL_CALLBACK,
    private_metadata: JSON.stringify(button),
    title: { type: "plain_text", text: String(title ?? "Reason").slice(0, 24) },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "gate-reason",
        label: { type: "plain_text", text: "Reason" },
        element: {
          type: "plain_text_input",
          action_id: "reason",
          multiline: true,
          min_length: 1,
        },
      },
    ],
  };
}
