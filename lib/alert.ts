/**
 * Best-effort error alerting: posts a pipeline failure to the "Automation Errors" Slack channel
 * (via the n8n error webhook). NEVER throws — alerting must not itself break the pipeline. No-op if
 * N8N_ERROR_WEBHOOK_URL isn't configured.
 */
export async function reportError(source: string, error: unknown, context?: string): Promise<void> {
  const url = process.env.N8N_ERROR_WEBHOOK_URL;
  if (!url) return;
  const message = error instanceof Error ? error.message : String(error);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, message: message.slice(0, 600), context: context ?? "" }),
    });
  } catch {
    // swallow — never let alerting break the caller
  }
}
