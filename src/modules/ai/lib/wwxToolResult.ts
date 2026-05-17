import type { UIMessage } from "ai";

const WWX_WORKFLOWS = new Set([
  "submit_lfs_job",
  "get_lfs_plan",
  "approve_concept_matrix",
  "advance_lfs_job",
  "resume_lfs_job",
  "get_lfs_job",
  "list_lfs_artifacts",
  "read_lfs_artifact",
  "edit_lfs_artifact",
  "rerun_lfs_checks",
  "retry_lfs_failures",
  "export_lfs",
  "cancel_lfs_job",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isSuccessfulWwxOutput(output: unknown): boolean {
  if (!isRecord(output)) return false;
  return output.ok === true && WWX_WORKFLOWS.has(String(output.workflow ?? ""));
}

export function hasSuccessfulWwxToolResult(messages: UIMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "user") return false;
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isRecord(part) || !("output" in part)) continue;
      if (isSuccessfulWwxOutput(part.output)) return true;
    }
  }
  return false;
}

export function isRecoverableWwxFollowupError(error: Error | undefined): boolean {
  if (!error?.message) return false;
  return /load failed|failed to fetch|network error/i.test(error.message);
}
