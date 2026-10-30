import { describe, expect, test } from "bun:test";
import { normalizeRepo } from "./repo.ts";

describe("normalizeRepo", () => {
  test("takes the directory under SourceRoot whatever the home dir", () => {
    expect(normalizeRepo("/Users/jkrumm/SourceRoot/argo/x/y")).toBe("argo");
    expect(normalizeRepo("/Users/johannes.krumm/SourceRoot/shutterflow")).toBe("shutterflow");
    expect(normalizeRepo("/home/ops/SourceRoot/vps/")).toBe("vps");
  });

  test("worktree paths fold into their repo", () => {
    expect(normalizeRepo("/Users/jkrumm/SourceRoot/argo/.claude/worktrees/basalt-1150")).toBe("argo");
    expect(normalizeRepo("/Users/jkrumm/SourceRoot/basalt-ui/.claude/maturation")).toBe("basalt-ui");
    expect(normalizeRepo("/Users/jkrumm/SourceRoot/warden-w6")).toBe("warden");
    expect(normalizeRepo("/Users/jkrumm/SourceRoot/basalt-ui-obsidian-w2")).toBe("basalt-ui-obsidian");
    expect(normalizeRepo("/Users/jkrumm/SourceRoot/linewatch-w11-trial")).toBe("linewatch");
    expect(normalizeRepo("/Users/johannes.krumm/SourceRoot/shutterflow-wt/p3-05")).toBe("shutterflow");
  });

  test("siblings that only look similar keep their own slug", () => {
    expect(normalizeRepo("/Users/jkrumm/SourceRoot/basalt-ui-obsidian")).toBe("basalt-ui-obsidian");
    expect(normalizeRepo("/Users/jkrumm/SourceRoot/linewatch-basalt-2")).toBe("linewatch-basalt-2");
    expect(normalizeRepo("/Users/jkrumm/SourceRoot/sy-serendipity-codex")).toBe("sy-serendipity-codex");
    expect(normalizeRepo("/Users/jkrumm/SourceRoot/ShutterflowOps")).toBe("ShutterflowOps");
  });

  test("IuRoot is a separate namespace", () => {
    expect(normalizeRepo("/Users/jkrumm/IuRoot/prometheus-epx/chat/ui")).toBe("iu/prometheus-epx");
    expect(normalizeRepo("/Users/jkrumm/IuRoot/epos.student-enrolment")).toBe("iu/epos.student-enrolment");
    expect(normalizeRepo("/Users/jkrumm/IuRoot/worktrees/se-loa")).toBeNull();
    expect(normalizeRepo("/Users/jkrumm/IuRoot/.wt/x")).toBeNull();
  });

  test("bare roots, scratch directories, non-paths and empties are null", () => {
    expect(normalizeRepo("/Users/jkrumm/SourceRoot")).toBeNull();
    expect(normalizeRepo("/Users/jkrumm/SourceRoot/")).toBeNull();
    expect(normalizeRepo("/Users/jkrumm/IuRoot")).toBeNull();
    expect(normalizeRepo("/Users/jkrumm/SourceRoot/.hermes-wt/rh-fix")).toBeNull();
    expect(normalizeRepo("/Users/jkrumm")).toBeNull();
    expect(normalizeRepo("/private/tmp/wt-1511")).toBeNull();
    expect(normalizeRepo("athena-teamchat")).toBeNull();
    expect(normalizeRepo("")).toBeNull();
    expect(normalizeRepo(null)).toBeNull();
  });
});
