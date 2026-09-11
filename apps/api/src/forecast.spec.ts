import test from "node:test";
import assert from "node:assert/strict";
import { suggestLoad } from "./forecast";

test("forecast falls back to a transparent network default", () => {
  assert.deepEqual(suggestLoad(100, "KGL-NBO", [], 0.05), {
    baseline: 100,
    safetyBuffer: 5,
    suggested: 105,
    confidence: "LOW",
    sampleSize: 0,
    source: "network default",
  });
});

test("forecast uses route history once the minimum sample is met", () => {
  const history = Array.from({ length: 5 }, (_, index) => ({
    consumed: 80,
    passengers: 100,
    route: "KGL-NBO",
    ageDays: index + 1,
  }));
  const result = suggestLoad(150, "KGL-NBO", history, 0.05);
  assert.equal(result.baseline, 120);
  assert.equal(result.suggested, 126);
  assert.equal(result.source, "route recent average");
  assert.equal(result.confidence, "MEDIUM");
});
