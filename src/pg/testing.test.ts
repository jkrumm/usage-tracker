import { expect, test } from "bun:test";
import { assertScratchName } from "./testing.ts";

test("only usage_test_<12 hex> names may be created or dropped", () => {
  expect(assertScratchName("usage_test_0123456789ab")).toBe("usage_test_0123456789ab");
  for (const bad of ["shared", "postgres", "usage_test_", "usage_test_xyz", "usage_test_0123456789ab; DROP DATABASE shared", "agent_workflows", "usage_test_0123456789abc"]) {
    expect(() => assertScratchName(bad)).toThrow(/refusing/);
  }
});
