import { ReportStatus, Role } from "@prisma/client";

export const canSubmitReport = (status: ReportStatus | null) =>
  status === null ||
  status === ReportStatus.DRAFT ||
  status === ReportStatus.RETURNED;

export const canAccess = (role: Role, allowed: Role[]) =>
  allowed.includes(role);

export const onHandQuantity = (
  lots: number[],
  movements: Array<{ quantity: number; reason: string }>,
) =>
  lots.reduce((sum, quantity) => sum + quantity, 0) +
  movements
    .filter((movement) => movement.reason !== "RETURN")
    .reduce((sum, movement) => sum + movement.quantity, 0);

export function effectivePriceAt<T extends {
  effectiveFrom: Date;
  effectiveTo: Date | null;
}>(prices: T[], at: Date): T | undefined {
  return prices
    .filter(
      (price) =>
        price.effectiveFrom <= at &&
        (!price.effectiveTo || price.effectiveTo > at),
    )
    .sort(
      (left, right) => right.effectiveFrom.getTime() - left.effectiveFrom.getTime(),
    )[0];
}
export type ScheduleWindow = { start: Date; end: Date };
export const schedulesOverlap = (left: ScheduleWindow, right: ScheduleWindow) =>
  left.start < right.end && right.start < left.end;
export const canDecideReport = (
  role: Role,
  current: ReportStatus,
  next: ReportStatus,
) =>
  role === Role.LEAD
    ? current === ReportStatus.SUBMITTED &&
      (next === ReportStatus.FORWARDED || next === ReportStatus.RETURNED)
    : role === Role.PROCUREMENT
      ? current === ReportStatus.FORWARDED &&
        (next === ReportStatus.APPROVED ||
          next === ReportStatus.RETURNED ||
          next === ReportStatus.REJECTED)
      : false;
