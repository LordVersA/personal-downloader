import assert from "node:assert/strict";
import { test } from "node:test";
import { toolVersion } from "../src/tool-version.js";

test("tool versions show readable numbers without build metadata", () => {
  for (const [raw, expected] of [
    ["8.0.git-https://www.martin-riedl.de", "8.0"],
    ["0.6.0-beta+build.12", "0.6.0"],
    ["N-123456-gabcdef", "123456"],
    ["2026.11.01", "2026.11.01"],
    ["2.5.1", "2.5.1"],
    [null, "-"], [undefined, "-"], ["", "-"],
  ]) assert.equal(toolVersion(raw), expected);
});
