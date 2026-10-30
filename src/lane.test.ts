import { describe, expect, test } from "bun:test";
import { LANES, laneFor } from "./lane.ts";

describe("laneFor", () => {
  test("USAGE_LANE values on claude-code", () => {
    expect(laneFor("interactive", "claude-code")).toEqual({ lane: "interactive", detail: null });
    expect(laneFor("wave", "claude-code")).toEqual({ lane: "wave_mother", detail: null });
    expect(laneFor("fan", "claude-code")).toEqual({ lane: "fan_worker", detail: null });
    expect(laneFor("fleet", "claude-code")).toEqual({ lane: "worker", detail: { raw: "fleet" } });
    expect(laneFor("lead", "claude-code")).toEqual({ lane: "lead", detail: null });
    expect(laneFor("worker", "claude-code")).toEqual({ lane: "worker", detail: null });
    expect(laneFor("desktop", "claude-code").lane).toBe("interactive");
  });

  test("a missing lane is interactive where a human drives, other elsewhere", () => {
    expect(laneFor(null, "claude-code")).toEqual({ lane: "interactive", detail: null });
    expect(laneFor("", "opencode").lane).toBe("interactive");
    expect(laneFor(null, "codex").lane).toBe("interactive");
    expect(laneFor(null, "feuer")).toEqual({ lane: "other", detail: null });
    expect(laneFor(null, "athena-teamchat").lane).toBe("other");
  });

  test("agent-gateway workflows become agw_workflow with workflow and step", () => {
    expect(laneFor("agent-gateway:review", "claude-code")).toEqual({ lane: "agw_workflow", detail: { workflow: "review" } });
    expect(laneFor("agent-gateway:dispatch", "opencode").detail).toEqual({ workflow: "dispatch" });
    expect(laneFor("review:angle", "agent-gateway-opencode")).toEqual({
      lane: "agw_workflow",
      detail: { workflow: "review", step: "angle" },
    });
    expect(laneFor("bench:DeepSeek-V4-Pro:idle-watchdog:1:104eaab7", "agent-gateway-opencode").detail).toEqual({
      workflow: "bench",
      step: "DeepSeek-V4-Pro:idle-watchdog:1:104eaab7",
    });
    expect(laneFor(null, "litellm")).toEqual({ lane: "agw_workflow", detail: { workflow: "litellm" } });
  });

  test("retired research and audio gateways: the source is the workflow, sub_tool the step", () => {
    expect(laneFor("lead", "research-gateway")).toEqual({
      lane: "agw_workflow",
      detail: { workflow: "research-gateway", step: "lead" },
    });
    expect(laneFor("speech", "audio-gateway-vps").detail).toEqual({ workflow: "audio-gateway-vps", step: "speech" });
  });

  test("agw rows carry workflow, step and route in raw", () => {
    expect(laneFor("research", "agent-workflows", { workflow: "research", step: "search", route: "deepseek" })).toEqual({
      lane: "agw_workflow",
      detail: { workflow: "research", step: "search", route: "deepseek" },
    });
  });

  test("a subagent type in raw wins over the session lane", () => {
    expect(laneFor("wave", "claude-code", { subagentType: "Explore" })).toEqual({
      lane: "subagent",
      detail: { subagent_type: "Explore" },
    });
  });

  test("hermes keeps its surface, iris maps by source", () => {
    expect(laneFor("slack:title_generation", "hermes")).toEqual({ lane: "hermes", detail: { surface: "slack:title_generation" } });
    expect(laneFor(null, "hermes")).toEqual({ lane: "hermes", detail: null });
    expect(laneFor("push", "iris").lane).toBe("iris");
  });

  test("unknown values map to other and keep the raw string", () => {
    expect(laneFor("cron", "feuer")).toEqual({ lane: "other", detail: { raw: "cron" } });
    expect(laneFor("headless", "claude-code")).toEqual({ lane: "other", detail: { raw: "headless" } });
    expect(laneFor("chat-turn:chat", "athena-teamchat")).toEqual({ lane: "other", detail: { raw: "chat-turn:chat" } });
    expect(laneFor("coding-2026-09-11", "modelpick").detail).toEqual({ raw: "coding-2026-09-11" });
  });

  test("every result is in the CHECKed vocabulary", () => {
    const samples: [string | null, string][] = [
      ["wave", "claude-code"],
      ["x", "feuer"],
      [null, "hermes"],
      ["agent-gateway:ab", "claude-code"],
    ];
    for (const [t, s] of samples) expect(LANES).toContain(laneFor(t, s).lane);
  });
});
