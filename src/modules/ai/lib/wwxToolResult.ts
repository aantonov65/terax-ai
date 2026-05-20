import type { UIMessage } from "ai";

const WWX_WORKFLOWS = new Set([
  "create_ads",
  "start_research_run",
  "list_research_runs",
  "get_batch_status",
  "list_final_ads",
  "get_final_ad",
  "get_asset_inputs",
  "get_batch_metrics",
  "analyze_ads",
  "compare_batches",
  "answer_batch_question",
  "export_handoff_package",
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
