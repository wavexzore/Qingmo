import type { MeetingResult } from "@qingmo/shared";

import type { IpcPort } from "../../lib/ipc/port";

/**
 * One in-flight `meeting_take_result` per request id. StrictMode mounts the
 * boot component twice; both runs must share the same read.
 */
const pending = new Map<string, Promise<MeetingResult | null>>();

export function takeMeetingResult(ipc: IpcPort, requestId: string): Promise<MeetingResult | null> {
  let promise = pending.get(requestId);
  if (!promise) {
    promise = ipc.meetingTakeResult(requestId);
    pending.set(requestId, promise);
  }
  return promise;
}

/** Test-only reset. */
export function resetMeetingResultForTests(): void {
  pending.clear();
}
