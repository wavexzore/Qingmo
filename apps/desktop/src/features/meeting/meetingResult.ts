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
    const created = ipc.meetingTakeResult(requestId);
    // Never cache a rejected read: a retry must be able to call the IPC again.
    created.catch(() => {
      if (pending.get(requestId) === created) {
        pending.delete(requestId);
      }
    });
    promise = created;
    pending.set(requestId, promise);
  }
  return promise;
}

/** Test-only reset. */
export function resetMeetingResultForTests(): void {
  pending.clear();
}
