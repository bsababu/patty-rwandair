import assert from "node:assert/strict";
import test from "node:test";
import {
  csvRecords,
  dateWindow,
  nonnegativeInteger,
  normalizeFlightNumber,
  parseCsv,
} from "./imports";

test("parses quoted CSV values and escaped quotes", () => {
  assert.deepEqual(parseCsv('a,b\n"Kigali, Rwanda","WB ""435"""'), [
    ["a", "b"],
    ["Kigali, Rwanda", 'WB "435"'],
  ]);
});

test("normalizes flight numbers consistently", () => {
  assert.equal(normalizeFlightNumber("wb435"), "WB 435");
  assert.equal(normalizeFlightNumber("WB 435"), "WB 435");
  assert.equal(normalizeFlightNumber("KQ435"), null);
});

test("validates required columns and numeric inputs", () => {
  assert.throws(() => csvRecords("a,b\n1,2", ["flight_number"]));
  assert.equal(nonnegativeInteger("12"), 12);
  assert.equal(nonnegativeInteger("-1"), null);
  assert.ok(dateWindow("2026-09-01"));
  assert.equal(dateWindow("01/09/2026"), null);
});
