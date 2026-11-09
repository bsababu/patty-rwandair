import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  csvRecords,
  dateWindow,
  isoCalendarDate,
  nonnegativeInteger,
  normalizeFlightNumber,
  optionalImportHeaders,
  parseCsv,
  parseIsoTimestamp,
  importHeaders,
} from "./imports";

test("parses quoted CSV values and escaped quotes", () => {
  assert.deepEqual(parseCsv('a,b\n"Kigali, Rwanda","WB ""435"""'), [
    ["a", "b"],
    ["Kigali, Rwanda", 'WB "435"'],
  ]);
});

test("rejects duplicate headers and wrong row widths rather than silently overwriting inputs", () => {
  assert.throws(() => csvRecords("a,a\n1,2", ["a"]), /Duplicate CSV columns/);
  assert.throws(() => csvRecords("a,b\n1,2", ["a"]), /Unknown CSV columns/);
  assert.deepEqual(csvRecords("a,b\n1", ["a", "b"])[0].errors, ["Too few columns"]);
  assert.deepEqual(csvRecords("a,b\n1,2,3", ["a", "b"])[0].errors, ["Too many columns"]);
  assert.deepEqual(csvRecords("\uFEFFa,b\r\n1,2\r\n", ["a", "b"])[0].data, { a: "1", b: "2" });
});

test("requires explicit timestamp offsets and rejects invalid calendar times", () => {
  assert.equal(parseIsoTimestamp("2026-11-04T00:30:00+02:00")?.toISOString(), "2026-11-03T22:30:00.000Z");
  assert.equal(parseIsoTimestamp("2026-11-04T00:30Z")?.toISOString(), "2026-11-04T00:30:00.000Z");
  for (const invalid of ["2026-11-04T08:00:00", "2026-02-30T08:00:00Z", "2026-11-04T24:00:00Z", "2026-11-04T08:61:00Z", "2026-11-04T08:00:00+14:30", "2026-11-04T08:00:00+02:99"]) {
    assert.equal(parseIsoTimestamp(invalid), null, invalid);
  }
});

test("shipped flight and catering templates describe the same flight/date and valid sectors", () => {
  const flights = csvRecords(readFileSync(resolve(process.cwd(), "../../docs/flights-template.csv"), "utf8"), importHeaders.FLIGHTS);
  const catering = csvRecords(readFileSync(resolve(process.cwd(), "../../docs/catering-template.csv"), "utf8"), importHeaders.CATERING, optionalImportHeaders.CATERING);
  const sectors = new Set(flights.map(({ data }) => `${normalizeFlightNumber(data.flight_number)}|${data.flight_date}|${data.sector_sequence}`));
  for (const { data, errors } of catering) {
    assert.equal(sectors.has(`${normalizeFlightNumber(data.flight_number)}|${data.service_date || data.flight_date}|${data.sector_sequence || "1"}`), true);
    assert.deepEqual(errors, []);
  }
});

test("accepts the minimal catering template", () => {
  const rows = csvRecords(
    "flight_number,service_date,item,loaded\nWB700,2026-11-04,Chicken brochette meal,1\n",
    importHeaders.CATERING,
    optionalImportHeaders.CATERING,
  );
  assert.equal(rows[0].data.sector_sequence, undefined);
  assert.deepEqual(rows[0].errors, []);
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
  assert.equal(dateWindow("2026-02-30"), null);
  assert.equal(isoCalendarDate("2026-09-01T08:00:00+02:00"), "2026-09-01");
});
