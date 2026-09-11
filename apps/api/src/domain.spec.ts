import test from "node:test";
import assert from "node:assert/strict";
import { ReportStatus, Role } from "@prisma/client";
import {
  canAccess,
  canDecideReport,
  canSubmitReport,
  effectivePriceAt,
  onHandQuantity,
  schedulesOverlap,
} from "./domain";
test("only draft and returned reports can be submitted",()=>{assert.equal(canSubmitReport(null),true);assert.equal(canSubmitReport(ReportStatus.RETURNED),true);assert.equal(canSubmitReport(ReportStatus.SUBMITTED),false);assert.equal(canSubmitReport(ReportStatus.APPROVED),false)});
test("role policies are explicit",()=>{assert.equal(canAccess(Role.DIRECTOR,[Role.DIRECTOR]),true);assert.equal(canAccess(Role.ATTENDANT,[Role.PROCUREMENT,Role.DIRECTOR]),false)});
test("stock applies consumption but does not double-count informational returns",()=>assert.equal(onHandQuantity([100],[{quantity:-20,reason:"APPROVED_CONSUMPTION"},{quantity:5,reason:"RETURN"}]),80));
test("missing stock reduces on-hand quantity",()=>assert.equal(onHandQuantity([100],[{quantity:-4,reason:"MISSING"}]),96));
test("price selection uses the flight date rather than the newest price",()=>{
  const old={amountMinor:500,effectiveFrom:new Date("2026-01-01"),effectiveTo:new Date("2026-07-01")};
  const current={amountMinor:650,effectiveFrom:new Date("2026-07-01"),effectiveTo:null};
  assert.equal(effectivePriceAt([current,old],new Date("2026-06-15"))?.amountMinor,500);
});
test("Lead forwards and Procurement performs final approval",()=>{
  assert.equal(canDecideReport(Role.LEAD,ReportStatus.SUBMITTED,ReportStatus.FORWARDED),true);
  assert.equal(canDecideReport(Role.LEAD,ReportStatus.SUBMITTED,ReportStatus.APPROVED),false);
  assert.equal(canDecideReport(Role.PROCUREMENT,ReportStatus.FORWARDED,ReportStatus.APPROVED),true);
});
test("back-to-back flights do not overlap",()=>{
  const first={start:new Date("2026-09-01T08:00:00Z"),end:new Date("2026-09-01T10:00:00Z")};
  const next={start:new Date("2026-09-01T10:00:00Z"),end:new Date("2026-09-01T12:00:00Z")};
  const conflict={start:new Date("2026-09-01T09:30:00Z"),end:new Date("2026-09-01T11:00:00Z")};
  assert.equal(schedulesOverlap(first,next),false);
  assert.equal(schedulesOverlap(first,conflict),true);
});
