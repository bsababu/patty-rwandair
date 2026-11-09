import assert from "node:assert/strict";
import test from "node:test";
import { mergeConsumptionLines } from "../app/lib/run-drafts";

test("shared consumption merges independent fields without replacing team edits", () => {
  const base = [{ id: "a", consumed: 0, remarks: "" }, { id: "b", consumed: 0, remarks: "" }];
  const mine = [{ id: "a", consumed: 4, remarks: "" }, base[1]];
  const server = [{ id: "a", consumed: 0, remarks: "Team note" }, { id: "b", consumed: 6, remarks: "" }];
  const result = mergeConsumptionLines(base, mine, server);
  assert.deepEqual(result.lines, [{ id: "a", consumed: 4, remarks: "Team note" }, server[1]]);
  assert.deepEqual(result.conflicts, []);
  assert.equal(server[0].consumed, 0);
});

test("conflicting edits require a choice and preserve both candidate values", () => {
  const base = [{ id: "a", consumed: 0, remarks: "" }];
  const result = mergeConsumptionLines(base, [{ id: "a", consumed: 4, remarks: "Mine" }], [{ id: "a", consumed: 7, remarks: "Team" }]);
  assert.deepEqual(result.conflicts, [{ id: "a", field: "consumed", local: 4, server: 7 }, { id: "a", field: "remarks", local: "Mine", server: "Team" }]);
  assert.equal(result.lines[0].consumed, 7);
  assert.equal(result.lines[0].remarks, "Team");
});

test("identical changes and absent optional remarks do not cause false conflicts", () => {
  const result = mergeConsumptionLines([{ id: "a", consumed: 0 }], [{ id: "a", consumed: 4, remarks: "" }], [{ id: "a", consumed: 4, remarks: null }]);
  assert.deepEqual(result.conflicts, []);
});
