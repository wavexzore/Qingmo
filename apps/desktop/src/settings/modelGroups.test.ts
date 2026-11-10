import { describe, expect, it } from "vitest";

import type { ModelView } from "@qingmo/shared";

import { aggregateState, buildRows, downloadableMembers, removableMembers } from "./modelGroups";

function model(id: string, state: ModelView["state"], group?: string): ModelView {
  return {
    id,
    display: id,
    kind: "segmentation",
    license: "MIT",
    licenseUrl: "https://example.test",
    languages: [],
    downloadBytes: 10,
    installBytes: 10,
    localBytes: 0,
    peakMemoryMb: 10,
    peakBasis: "estimated",
    ...(group ? { group } : {}),
    state,
  };
}

describe("model group aggregation", () => {
  it("uses the exclusion priority", () => {
    expect(aggregateState(["failed", "corrupt", "downloading"])).toBe("failed");
    expect(aggregateState(["missing", "downloading"])).toBe("corrupt");
    expect(aggregateState(["not_downloaded", "downloading"])).toBe("downloading");
    expect(aggregateState(["verifying", "not_verified"])).toBe("verifying");
    expect(aggregateState(["not_verified", "not_downloaded"])).toBe("not_verified");
    expect(aggregateState(["partial", "not_downloaded"])).toBe("partial");
    expect(aggregateState(["ready", "not_downloaded"])).toBe("partial");
    expect(aggregateState(["ready", "ready"])).toBe("ready");
    expect(aggregateState(["not_downloaded", "not_downloaded"])).toBe("not_downloaded");
  });

  it("merges the speaker pack into one row", () => {
    const rows = buildRows(
      [
        model("asr", "ready"),
        model("seg", "ready", "speaker-pack"),
        model("emb", "not_downloaded", "speaker-pack"),
      ],
      true,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.members.map((member) => member.id)).toEqual(["seg", "emb"]);
    expect(row.bytes).toBe(20);
    expect(row.state).toBe("partial");
    expect(buildRows([model("asr", "ready")], false)).toHaveLength(1);
  });

  it("only enqueues downloadable members and only removes present ones", () => {
    const row = buildRows(
      [
        model("seg", "ready", "speaker-pack"),
        model("emb", "corrupt", "speaker-pack"),
        model("third", "not_downloaded", "speaker-pack"),
        model("fourth", "verifying", "speaker-pack"),
      ],
      true,
    )[0]!;
    expect(downloadableMembers(row)).toEqual(["emb", "third"]);
    expect(removableMembers(row)).toEqual(["seg", "emb"]);
  });
});
