import { PremiereBusyError, PREMIERE_STUCK_MS, bridgeErrorResult } from '../../bridge/errors.js';

describe('bridge error results', () => {
  it('maps a busy Premiere to a retryable result that does not stop the agent', () => {
    const result = bridgeErrorResult('detect_scene_edits', new PremiereBusyError(40000));
    expect(result).toMatchObject({
      success: false,
      status: 'premiere_busy',
      retry: true,
      userActionRequired: false,
      agentAction: 'verify_premiere_connection',
      busyForSec: 40,
    });
  });

  it('asks the user to check Premiere once a command has been running past the stuck limit', () => {
    const result = bridgeErrorResult('x', new PremiereBusyError(PREMIERE_STUCK_MS + 1000));
    expect(result).toMatchObject({ status: 'premiere_busy', retry: false, userActionRequired: true, agentAction: 'tell_user' });
  });

  it('keeps the panel-missing message as bridge_unavailable', () => {
    const result = bridgeErrorResult('x', new Error('The TeamTrau PremiereProControl panel is not running. Open Adobe Premiere Pro.'));
    expect(result).toMatchObject({ status: 'bridge_unavailable', userActionRequired: true });
  });

  it('returns null for an ordinary tool failure', () => {
    expect(bridgeErrorResult('x', new Error('Sequence not found'))).toBeNull();
  });
});
