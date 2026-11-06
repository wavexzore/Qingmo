import type { AppErrorCode } from "@qingmo/shared";

/**
 * Maps workspace-specific failures onto the workspace namespace instead of
 * the generic document-error copy (which talks about document handles).
 */
export function workspaceErrorKey(code: AppErrorCode): string {
  switch (code) {
    case "INVALID_PATH":
      return "workspace:error.expired";
    case "OUTSIDE_SCOPE":
      return "workspace:error.outside";
    case "NOT_FOUND":
      return "workspace:error.missing";
    case "NOT_A_FILE":
      return "workspace:error.notFile";
    case "UNSUPPORTED_EXTENSION":
      return "workspace:error.unsupported";
    case "PERMISSION_DENIED":
      return "workspace:error.permission";
    default:
      return "workspace:error.io";
  }
}
