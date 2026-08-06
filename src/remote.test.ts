import { describe, expect, test } from "bun:test";
import { resolveIumacLabel } from "./remote.ts";

// resolveIumacLabel is the pure decision core of iumacMachineLabel(): the I/O
// (env read, disk cache read, ssh probe) all happens in the caller, so this
// pins the precedence order without touching ssh or rsync, per the brief's
// "do not attempt to unit-test rsync or ssh".

describe("resolveIumacLabel", () => {
  test("env override wins over everything", () => {
    expect(
      resolveIumacLabel({
        envLabel: "MacBook Pro (M2 Max)",
        diskLabel: "stale cached label",
        probedLabel: "probed label",
      }),
    ).toBe("MacBook Pro (M2 Max)");
  });

  test("trims a whitespace-padded env override", () => {
    expect(
      resolveIumacLabel({ envLabel: "  MacBook Pro (M2 Max)  ", diskLabel: null, probedLabel: null }),
    ).toBe("MacBook Pro (M2 Max)");
  });

  test("blank env override falls through to the disk cache", () => {
    expect(
      resolveIumacLabel({ envLabel: "   ", diskLabel: "MacBook Pro (M2 Max)", probedLabel: null }),
    ).toBe("MacBook Pro (M2 Max)");
  });

  test("disk cache wins over a fresh probe", () => {
    expect(
      resolveIumacLabel({ envLabel: undefined, diskLabel: "cached label", probedLabel: "probed label" }),
    ).toBe("cached label");
  });

  test("probe wins when neither env nor disk cache is set", () => {
    expect(
      resolveIumacLabel({ envLabel: undefined, diskLabel: null, probedLabel: "MacBook Pro (M2 Max)" }),
    ).toBe("MacBook Pro (M2 Max)");
  });

  test("falls back to the literal iumac when every source is empty", () => {
    expect(resolveIumacLabel({ envLabel: undefined, diskLabel: null, probedLabel: null })).toBe("iumac");
  });
});
