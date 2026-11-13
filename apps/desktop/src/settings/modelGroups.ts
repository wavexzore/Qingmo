import type { ModelState, ModelView } from "@qingmo/shared";

export const SPEAKER_GROUP = "speaker-pack";

export type GroupState =
  | "ready"
  | "not_verified"
  | "partial"
  | "not_downloaded"
  | "downloading"
  | "verifying"
  | "corrupt"
  | "failed";

/** Whole megabytes; one shared format for every model surface. */
export function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export interface ModelRow {
  key: string;
  group: boolean;
  display: string;
  members: ModelView[];
  bytes: number;
  peakMemoryMb: number;
  state: GroupState;
  error: ModelView["error"];
}

const DOWNLOADABLE: ModelState[] = ["not_downloaded", "partial", "failed", "corrupt", "missing"];
const REMOVABLE: ModelState[] = [
  "ready",
  "corrupt",
  "missing",
  "failed",
  "partial",
  "not_verified",
];

/** Exclusion-order aggregation from the design, evaluated across members. */
export function aggregateState(states: ModelState[]): GroupState {
  if (states.includes("failed")) {
    return "failed";
  }
  if (states.includes("corrupt") || states.includes("missing")) {
    return "corrupt";
  }
  if (states.includes("downloading")) {
    return "downloading";
  }
  if (states.includes("verifying")) {
    return "verifying";
  }
  if (states.includes("not_verified")) {
    return "not_verified";
  }
  if (states.includes("partial")) {
    return "partial";
  }
  if (states.every((state) => state === "ready")) {
    return "ready";
  }
  if (states.includes("ready")) {
    return "partial";
  }
  return "not_downloaded";
}

/** Groups the speaker pack into one row; other packs stay single rows. */
export function buildRows(models: ModelView[], group: boolean): ModelRow[] {
  const rows: ModelRow[] = [];
  const groupMembers = models.filter((model) => Boolean(model.group) === group);
  if (group) {
    const byGroup = new Map<string, ModelView[]>();
    for (const model of groupMembers) {
      const key = model.group ?? "";
      byGroup.set(key, [...(byGroup.get(key) ?? []), model]);
    }
    for (const [key, members] of byGroup) {
      rows.push({
        key,
        group: true,
        display: members.map((member) => member.display).join(" · "),
        members,
        bytes: members.reduce((total, member) => total + member.downloadBytes, 0),
        peakMemoryMb: Math.max(...members.map((member) => member.peakMemoryMb)),
        state: aggregateState(members.map((member) => member.state)),
        error: members.find((member) => member.error)?.error,
      });
    }
  } else {
    for (const model of groupMembers) {
      rows.push({
        key: model.id,
        group: false,
        display: model.display,
        members: [model],
        bytes: model.downloadBytes,
        peakMemoryMb: model.peakMemoryMb,
        state: model.state as GroupState,
        error: model.error,
      });
    }
  }
  return rows;
}

/** Members an explicit "download" on this row should enqueue. */
export function downloadableMembers(row: ModelRow): string[] {
  return row.members
    .filter((member) => DOWNLOADABLE.includes(member.state))
    .map((member) => member.id);
}

/** Members an explicit "remove" should delete; ignored ones are never errors. */
export function removableMembers(row: ModelRow): string[] {
  return row.members
    .filter((member) => REMOVABLE.includes(member.state))
    .map((member) => member.id);
}

export function rowLabelKey(state: GroupState): string {
  return `ai.models.state.${state}`;
}
