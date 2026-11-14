export function toWorkspaceRelative(filePath: string):
  | { ok: true; relative: string }
  | { ok: false; reason: string };

export function assessWrite(
  filePath: string,
  options?: {
    allowedDocs?: readonly string[];
    allowSrc?: boolean;
    branch?: string;
    torGrant?: { agent: string; projectId: string; branchPrefix: string };
    planGrant?: { agent: string; projectId: string; branchPrefix: string };
  },
):
  | { allowed: true; relative: string }
  | { allowed: false; reason: string };
