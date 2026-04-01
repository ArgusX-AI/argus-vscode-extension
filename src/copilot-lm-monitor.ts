import * as vscode from 'vscode';

export interface CopilotLmStatus {
  available: boolean;
  modelCount: number;
  modelIds: string[];
}

let monitorInterval: ReturnType<typeof setInterval> | null = null;
let lastStatus: CopilotLmStatus = { available: false, modelCount: 0, modelIds: [] };

/**
 * Check if Copilot language models are available via the VS Code LM API.
 * This detects Copilot Chat's language model registration.
 */
export async function checkCopilotLm(): Promise<CopilotLmStatus> {
  try {
    if (typeof vscode.lm?.selectChatModels !== 'function') {
      return { available: false, modelCount: 0, modelIds: [] };
    }
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    const ids = models.map(m => m.id);
    lastStatus = { available: ids.length > 0, modelCount: ids.length, modelIds: ids };
    return lastStatus;
  } catch {
    return { available: false, modelCount: 0, modelIds: [] };
  }
}

/**
 * Start periodic monitoring of Copilot LM availability.
 * Logs status changes to the provided logger.
 */
export function startLmMonitor(
  logger: (msg: string) => void,
  intervalMs: number = 30_000,
): void {
  if (monitorInterval) return;

  // Initial check after a delay (give Copilot time to register)
  setTimeout(async () => {
    const status = await checkCopilotLm();
    logger(`[lm-monitor] Copilot LM: available=${status.available}, models=${status.modelIds.join(', ') || 'none'}`);
  }, 5000);

  monitorInterval = setInterval(async () => {
    const prev = lastStatus.available;
    const status = await checkCopilotLm();
    if (status.available !== prev) {
      logger(`[lm-monitor] Copilot LM status changed: available=${status.available}, models=${status.modelIds.join(', ') || 'none'}`);
    }
  }, intervalMs);
}

/** Stop the LM monitor. */
export function stopLmMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

/** Get the last known Copilot LM status. */
export function getLmStatus(): CopilotLmStatus {
  return lastStatus;
}
