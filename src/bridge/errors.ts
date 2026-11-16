export function isBridgeUnavailableMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('mcp bridge is not running') ||
    normalized.includes('teamtrau premiereprocontrol panel is not running') ||
    normalized.includes('start bridge') ||
    normalized.includes('bridge response timeout')
  );
}

/** A command running this long is no longer "slow": something in Premiere is waiting on a person. */
export const PREMIERE_STUCK_MS = 10 * 60 * 1000;

/**
 * The panel is alive and connected but Premiere is still executing an earlier
 * ExtendScript call (scene edit detection, a long batch, another client's command).
 * The panel runs one native call at a time, so a new command waits behind it.
 * That is not a lost connection: it clears by itself when the call returns.
 */
export class PremiereBusyError extends Error {
  readonly busyMs: number;

  constructor(busyMs: number) {
    const sec = Math.round(busyMs / 1000);
    super(
      busyMs >= PREMIERE_STUCK_MS
        ? `Premiere is busy: it has been running one ExtendScript command for ${sec}s. Premiere is probably waiting on a dialog or progress window.`
        : `Premiere is busy: it is still running an earlier ExtendScript command (${sec}s so far). The panel connection is fine; this clears when that command finishes.`,
    );
    this.name = 'PremiereBusyError';
    this.busyMs = busyMs;
  }
}

export function premiereBusyResult(tool: string, busyMs: number): {
  success: false;
  error: string;
  tool: string;
  status: 'premiere_busy';
  busyForSec: number;
  retry: boolean;
  userActionRequired: boolean;
  agentAction: 'verify_premiere_connection' | 'tell_user';
  nextStep: string;
} {
  const error = new PremiereBusyError(busyMs).message;
  const busyForSec = Math.round(busyMs / 1000);
  if (busyMs >= PREMIERE_STUCK_MS) {
    return {
      success: false,
      error,
      tool,
      status: 'premiere_busy',
      busyForSec,
      retry: false,
      userActionRequired: true,
      agentAction: 'tell_user',
      nextStep:
        `Premiere has been running one command for ${Math.round(busyForSec / 60)} minutes. Look in Premiere for an open dialog or progress window (for example Scene Edit Detection, export or Auto Reframe) and let it finish or cancel it. The connection resumes by itself when it closes; there is no need to restart Premiere. Then run verify_premiere_connection once.`,
    };
  }
  return {
    success: false,
    error,
    tool,
    status: 'premiere_busy',
    busyForSec,
    retry: true,
    userActionRequired: false,
    agentAction: 'verify_premiere_connection',
    nextStep:
      'Premiere is still finishing an earlier command; the connection is not lost. Wait about 30 seconds, then call verify_premiere_connection. Retry this tool once it reports connected. Do not ask the user to restart Premiere.',
  };
}

export function bridgeUnavailableResult(tool: string, message: string): {
  success: false;
  error: string;
  tool: string;
  retry: false;
  status: 'bridge_unavailable';
  userActionRequired: true;
  agentAction: 'verify_premiere_connection';
  nextStep: string;
} {
  return {
    success: false,
    error: message,
    tool,
    retry: false,
    status: 'bridge_unavailable',
    userActionRequired: true,
    agentAction: 'verify_premiere_connection',
    nextStep:
      'Call verify_premiere_connection once. It launches Premiere when installed and waits for the TeamTrau PremiereProControl panel, which auto-starts. If that still fails, tell the user the nextStep from that result and stop. Do not retry other editing tools.',
  };
}

/** The structured result for a connection-level failure, or null when the error is the tool's own. */
export function bridgeErrorResult(
  tool: string,
  error: unknown,
): ReturnType<typeof premiereBusyResult> | ReturnType<typeof bridgeUnavailableResult> | null {
  if (error instanceof PremiereBusyError) return premiereBusyResult(tool, error.busyMs);
  const message = error instanceof Error ? error.message : String(error);
  if (isBridgeUnavailableMessage(message)) return bridgeUnavailableResult(tool, message);
  return null;
}
