import "reflect-metadata";
import {
  BadRequestException,
  ArgumentsHost,
  Body,
  Catch,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpException,
  HttpStatus,
  ExceptionFilter,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  StreamableFile,
  UnauthorizedException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import {
  Cabin,
  FlightStatus,
  ImportStatus,
  ImportType,
  Prisma,
  PrismaClient,
  ReportStatus,
  Role,
} from "@prisma/client";
import { hash, verify } from "argon2";
import cookieParser from "cookie-parser";
import { createHash, randomBytes, randomUUID } from "crypto";
import type { Request, Response } from "express";
import {
  canDecideReport,
  canSubmitReport,
  effectivePriceAt,
  onHandQuantity,
  schedulesOverlap,
} from "./domain";
import {
  csvRecords,
  dateWindow,
  isoCalendarDate,
  parseIsoTimestamp,
  importHeaders,
  nonnegativeInteger,
  normalizeFlightNumber,
  optionalImportHeaders,
  type CsvRow,
} from "./imports";
import { renderReportPdf, serializeReportCsv, type ReportSnapshot } from "./reports";

const prisma = new PrismaClient();
const SESSION_SECONDS = 8 * 60 * 60;
const databaseConfigurationError = () => {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) return "DATABASE_URL is not configured";
  if (!/^postgres(?:ql)?:\/\//.test(value))
    return "DATABASE_URL must be a PostgreSQL URL beginning with postgresql:// or postgres://";
  return null;
};
type CurrentUser = { id: string; email: string; name: string; role: Role };
type AuthedRequest = Request & {
  currentUser?: CurrentUser;
  sessionId?: string;
  csrf?: string;
};
const secureCookie = () => process.env.COOKIE_SECURE === "true";
const sameSiteCookie = (): "lax" | "none" | "strict" => {
  const configured = process.env.COOKIE_SAMESITE;
  if (configured === "none" && !secureCookie())
    throw new Error("COOKIE_SAMESITE=none requires COOKIE_SECURE=true");
  return configured === "none" || configured === "strict" ? configured : "lax";
};

async function authenticate(req: AuthedRequest, roles?: Role[]) {
  const sessionId = req.cookies?.wb_session;
  if (!sessionId) throw new UnauthorizedException("Authentication required");
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: { select: { id: true, email: true, name: true, role: true, active: true, sessionVersion: true } } },
  });
  if (!session || session.expiresAt <= new Date()) {
    if (session) await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
    throw new UnauthorizedException("Session expired");
  }
  const current = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      sessionVersion: true,
    },
  });
  if (
    !current?.active ||
    current.role !== session.user.role ||
    current.sessionVersion !== session.user.sessionVersion
  ) {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
    throw new UnauthorizedException("Session revoked");
  }
  const user = publicUser(current);
  if (roles && !roles.includes(user.role))
    throw new ForbiddenException("Insufficient permissions");
  req.currentUser = user;
  req.sessionId = sessionId;
  req.csrf = session.csrfToken;
  await prisma.session.update({
    where: { id: sessionId },
    data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000) },
  });
  return user;
}
async function authorizeMutation(req: AuthedRequest, roles?: Role[]) {
  const user = await authenticate(req, roles);
  if (!req.headers["x-csrf-token"] || req.headers["x-csrf-token"] !== req.csrf)
    throw new ForbiddenException("Invalid CSRF token");
  return user;
}
async function audit(
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  metadata?: object,
) {
  await prisma.auditEvent.create({
    data: {
      actorId,
      action,
      entityType,
      entityId,
      metadata: metadata || undefined,
    },
  });
}
const publicUser = (u: CurrentUser) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
});
type NotificationInput = { title: string; body: string; kind: string; actionPath: string };
async function notifyUsers(tx: Pick<Prisma.TransactionClient, "notification">, userIds: Array<string | null | undefined>, input: NotificationInput) {
  const recipients = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (!recipients.length) return;
  await tx.notification.createMany({
    data: recipients.map((userId) => ({ userId, ...input })),
  });
}

const MAX_IMPORT_BYTES = 1_000_000;
const canonicalJson = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalJson)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalJson(entry)]))
    : value;
const requestHash = (payload: unknown) => createHash("sha256").update(JSON.stringify(canonicalJson(payload ?? null))).digest("hex");
const scopedKey = (actorId: string, action: string, resourceId: string, operationId: string) => {
  if (typeof operationId !== "string" || !operationId.trim() || operationId.length > 160)
    throw new BadRequestException("A valid operation ID is required");
  return createHash("sha256").update(`${actorId}|${action}|${resourceId}|${operationId}`).digest("hex");
};
async function lockFlight(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "Flight" WHERE "id" = ${id} FOR UPDATE`;
}
async function lockRun(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "CateringList" WHERE "id" = ${id} FOR UPDATE`;
}
const assertReplay = (duplicate: { requestHash: string | null; response: unknown } | null, hash: string) => {
  if (!duplicate) return null;
  if (duplicate.requestHash && duplicate.requestHash !== hash)
    throw new ConflictException("Retry payload does not match the original request");
  return duplicate.response;
};

export async function validateImport(type: ImportType, sourceText: string, database: Prisma.TransactionClient = prisma) {
  if (type === ImportType.CREW)
    throw new BadRequestException("Crew CSV imports are not supported; assign crew from the Lead workspace");
  if (Buffer.byteLength(sourceText, "utf8") > MAX_IMPORT_BYTES)
    throw new BadRequestException("CSV exceeds the 1 MB pilot limit");

  let rows: CsvRow[];
  try {
    rows = csvRecords(
      sourceText,
      importHeaders[type],
      type === ImportType.CATERING ? optionalImportHeaders.CATERING : [],
    ).map((row) => ({
      ...row,
      data: type === ImportType.CATERING && !Object.hasOwn(row.data, "sector_sequence")
        ? { sector_sequence: "1", ...row.data }
        : row.data,
    }));
  } catch (error) {
    throw new BadRequestException(
      error instanceof Error ? error.message : "Invalid CSV",
    );
  }
  if (rows.length > 1_000)
    throw new BadRequestException("CSV exceeds the 1,000 row pilot limit");

  const seen = new Set<string>();
  const flightCache = new Map<string, Awaited<ReturnType<typeof findFlight>>>();
  const itemCache = new Map<
    string,
    Awaited<ReturnType<typeof prisma.catalogItem.findFirst>>
  >();
  const cateringLockCache = new Map<string, boolean>();
  async function cachedFlight(number: string, date: string) {
    const key = `${number}|${date}`;
    if (!flightCache.has(key)) flightCache.set(key, await findFlight(number, date, database));
    return flightCache.get(key) || null;
  }

  for (const row of rows) {
    const data = row.data;
    const flightNumber = normalizeFlightNumber(data.flight_number || "");
    const serviceDate = (data.service_date || "").trim();
    const legacyFlightDate = (data.flight_date || "").trim();
    if (serviceDate && legacyFlightDate && serviceDate !== legacyFlightDate)
      row.errors.push("service_date and flight_date must match");
    const canonicalDate = serviceDate || legacyFlightDate;
    if (canonicalDate) {
      data.service_date = canonicalDate;
      data.flight_date = canonicalDate;
    }
    const window = dateWindow(canonicalDate);
    if (!flightNumber) row.errors.push("Invalid RwandAir flight number");
    else data.flight_number = flightNumber;
    if (!window) row.errors.push("service_date must use YYYY-MM-DD");

    if (type === ImportType.FLIGHTS) {
      const sequence = nonnegativeInteger(data.sector_sequence);
      const economyPax = nonnegativeInteger(data.economy_pax);
      const businessPax = nonnegativeInteger(data.business_pax);
      const departure = parseIsoTimestamp(data.departure_iso);
      const arrival = parseIsoTimestamp(data.arrival_iso);
      if (!data.aircraft.trim()) row.errors.push("Aircraft is required");
      if (!sequence || sequence < 1) row.errors.push("Invalid sector sequence");
      if (!/^[A-Z]{3}$/.test(data.origin.toUpperCase()))
        row.errors.push("Invalid origin airport code");
      if (!/^[A-Z]{3}$/.test(data.destination.toUpperCase()))
        row.errors.push("Invalid destination airport code");
      if (!departure || !arrival)
        row.errors.push("Invalid departure or arrival timestamp");
      else if (arrival <= departure)
        row.errors.push("Arrival must be after departure");
      if (sequence === 1 && isoCalendarDate(data.departure_iso) !== data.flight_date)
        row.errors.push(`departure_iso calendar date ${isoCalendarDate(data.departure_iso) || "(invalid)"} must match flight_date ${data.flight_date}`);
      if (economyPax === null || businessPax === null)
        row.errors.push("Passenger counts must be nonnegative integers");
      const duplicateKey = `${flightNumber}|${data.flight_date}|${sequence}`;
      if (seen.has(duplicateKey)) row.errors.push("Duplicate sector in file");
      seen.add(duplicateKey);
      data.origin = data.origin.toUpperCase();
      data.destination = data.destination.toUpperCase();
      if (flightNumber && window) {
        const existing = await cachedFlight(flightNumber, data.flight_date);
        if (existing) row.errors.push("Flight already exists for this date");
      }
    }

    if (type === ImportType.CATERING) {
      const sequence = nonnegativeInteger(data.sector_sequence?.trim() || "1");
      const cabin = (data.cabin || "").trim().toUpperCase();
      if (!sequence || sequence < 1) row.errors.push("Invalid sector sequence");
      if (cabin && ![Cabin.ECONOMY, Cabin.BUSINESS].includes(cabin as Cabin))
        row.errors.push("Cabin must be ECONOMY or BUSINESS");
      data.cabin = cabin;
      data.sector_sequence = data.sector_sequence?.trim() || "1";
      data.override_reason = data.override_reason?.trim() || "";
      const itemLabel = (data.item || data.item_sku || "").trim();
      data.item = itemLabel;
      if (!itemLabel) row.errors.push("item is required");
      const loaded = nonnegativeInteger(data.loaded.trim());
      if (loaded === null) row.errors.push("loaded must be a nonnegative integer");
      const defaultQuantity = loaded ?? 0;
      const quantity = (field: string, fallback: number) => {
        const raw = data[field]?.trim() || "";
        if (!raw) {
          data[field] = String(fallback);
          return fallback;
        }
        const parsed = nonnegativeInteger(raw);
        if (parsed === null) row.errors.push(`${field} must be a nonnegative integer`);
        data[field] = parsed === null ? raw : String(parsed);
        return parsed ?? fallback;
      };
      const planned = quantity("planned", defaultQuantity);
      const approved = quantity("approved", planned);
      const suggested = quantity("suggested", planned);
      if (approved !== null && loaded !== null && loaded > approved)
        row.errors.push("Loaded quantity cannot exceed approved quantity");
      if (
        approved !== null &&
        suggested !== null &&
        approved !== suggested &&
        !data.override_reason.trim()
      )
        row.errors.push(
          "Override reason is required when approved differs from suggested",
        );
      const itemKey = itemLabel.toUpperCase();
      if (!itemCache.has(itemKey))
        itemCache.set(
          itemKey,
          await database.catalogItem.findFirst({
            where: {
              OR: [
                { sku: itemKey },
                { nameEn: { equals: itemLabel, mode: "insensitive" } },
                { nameFr: { equals: itemLabel, mode: "insensitive" } },
              ],
            },
          }),
        );
      const item = itemCache.get(itemKey);
      if (!item) row.errors.push(`Unknown catering item: ${itemLabel || "(blank)"}`);
      else if (!item.active) row.errors.push(`Inactive catering item: ${itemLabel}`);
      else {
        data.item = item.nameEn;
        data.item_sku = item.sku;
        data.__item_id = item.id;
      }
      if (flightNumber && window) {
        const listKey = `${flightNumber}|${data.flight_date}`;
        if (!cateringLockCache.has(listKey)) {
          const list = await database.cateringList.findUnique({
            where: {
              flightNumber_serviceDate: {
                flightNumber,
                serviceDate: window.start,
              },
            },
            include: { report: { select: { status: true } } },
          });
          cateringLockCache.set(
            listKey,
            Boolean(list?.status === "CANCELLED" || list?.reportingStartedAt || (list?.report && !canSubmitReport(list.report.status))),
          );
        }
        if (cateringLockCache.get(listKey))
          row.errors.push("Catering list is locked because reporting has started");
      }
    }

  }

  if (type === ImportType.CATERING) {
    const groups = new Map<string, CsvRow[]>();
    for (const row of rows) {
      const key = `${row.data.flight_number}|${row.data.flight_date}`;
      groups.set(key, [...(groups.get(key) || []), row]);
    }
    const cateringSeen = new Set<string>();
    for (const group of groups.values()) {
      const explicitCabins = new Set(group.map((row) => row.data.cabin).filter(Boolean));
      const missingCabin = group.filter((row) => !row.data.cabin);
      if (missingCabin.length && explicitCabins.has(Cabin.BUSINESS))
        missingCabin.forEach((row) => row.errors.push("Cabin is required when Economy and Business rows are mixed"));
      else missingCabin.forEach((row) => { row.data.cabin = Cabin.ECONOMY; });
      for (const row of group) {
        const duplicateKey = `${row.data.flight_number}|${row.data.flight_date}|${row.data.sector_sequence}|${row.data.cabin}|${row.data.item_sku}`;
        if (cateringSeen.has(duplicateKey)) row.errors.push("Duplicate catering line in file");
        cateringSeen.add(duplicateKey);
      }
    }
  }

  if (type === ImportType.FLIGHTS) {
    const groups = new Map<string, CsvRow[]>();
    for (const row of rows) {
      const key = `${row.data.flight_number}|${row.data.flight_date}`;
      groups.set(key, [...(groups.get(key) || []), row]);
    }
    for (const group of groups.values()) {
      const aircraft = new Set(group.map((row) => row.data.aircraft));
      if (aircraft.size > 1)
        group.forEach((row) => row.errors.push("Aircraft must match across sectors"));
      const ordered = [...group].sort(
        (left, right) => Number(left.data.sector_sequence) - Number(right.data.sector_sequence),
      );
      ordered.forEach((row, index) => {
        if (Number(row.data.sector_sequence) !== index + 1)
          row.errors.push("Sector sequences must start at 1 without gaps");
        if (index && ordered[index - 1].data.destination !== row.data.origin)
          row.errors.push("Sector origin does not continue from the previous destination");
        if (index) {
          const previousArrival = parseIsoTimestamp(ordered[index - 1].data.arrival_iso);
          const departure = parseIsoTimestamp(row.data.departure_iso);
          if (previousArrival && departure && departure < previousArrival)
            row.errors.push("Sector departure must be at or after the previous sector's arrival");
        }
      });
    }
  }
  return rows;
}

async function findFlight(flightNumber: string, date: string, database: Prisma.TransactionClient = prisma) {
  const window = dateWindow(date);
  if (!window) return null;
  const flights = await database.flight.findMany({
    where: {
      flightNumber,
      serviceDate: window.start,
    },
    include: {
      sectors: true,
      report: { select: { status: true } },
    },
    take: 2,
  });
  return flights.length === 1 ? flights[0] : null;
}

function scheduleBounds(
  sectors: Array<{ scheduledDeparture: Date; scheduledArrival: Date }>,
) {
  if (!sectors.length) return null;
  return {
    start: new Date(
      Math.min(...sectors.map((sector) => sector.scheduledDeparture.valueOf())),
    ),
    end: new Date(
      Math.max(...sectors.map((sector) => sector.scheduledArrival.valueOf())),
    ),
  };
}

async function requireLeadFlight(userId: string, flightId: string) {
  const flight = await prisma.flight.findFirst({
    where: { id: flightId, leadId: userId },
    include: {
      sectors: { orderBy: { sequence: "asc" } },
      report: { select: { status: true } },
    },
  });
  if (!flight)
    throw new ForbiddenException("This flight is not assigned to the Lead");
  return flight;
}

/** Attach a validated catering list to a flight and materialize its manifests. */
async function attachCateringToFlight(
  actor: CurrentUser,
  flightId: string,
  listId: string,
  operationId: string,
  leadOnly: boolean,
) {
  const idemKey = scopedKey(actor.id, "CATERING_ATTACH", flightId, operationId);
  const idemHash = requestHash({ listId });
  const duplicate = await prisma.idempotencyKey.findUnique({ where: { key: idemKey } });
  const replay = assertReplay(duplicate, idemHash);
  if (replay) return replay;

  const flight = leadOnly
    ? await requireLeadFlight(actor.id, flightId)
    : await prisma.flight.findUnique({
        where: { id: flightId },
        include: {
          sectors: { orderBy: { sequence: "asc" } },
          report: { select: { status: true } },
        },
      });
  if (!flight) throw new NotFoundException("Flight not found");
  if (flight.report && flight.report.status !== ReportStatus.DRAFT)
    throw new ConflictException("Catering is locked after report submission");

  const list = await prisma.cateringList.findUnique({
    where: { id: listId },
    include: { lines: true },
  });
  if (!list || list.status !== "READY")
    throw new NotFoundException("Catering list not found");
  const date = flight.serviceDate.toISOString().slice(0, 10);
  if (
    list.flightNumber !== flight.flightNumber ||
    list.serviceDate.toISOString().slice(0, 10) !== date
  )
    throw new BadRequestException("Catering list and flight number/date must match");
  const current = await prisma.flight.findUnique({ where: { id: flightId }, select: { cateringListId: true } });
  if (current?.cateringListId === list.id)
    return { flightId, cateringList: { id: list.id, name: list.name } };
  for (const line of list.lines)
    if (!flight.sectors.some((sector) => sector.sequence === line.sectorSequence))
      throw new BadRequestException("Catering list contains an unknown sector");

  await prisma.$transaction(async (tx) => {
    await lockFlight(tx, flightId);
    const txFlight = await tx.flight.findUnique({
      where: { id: flightId },
      select: {
        leadId: true,
        status: true,
        reportingStartedAt: true,
        report: { select: { status: true } },
      },
    });
    if (!txFlight) throw new NotFoundException("Flight not found");
    if (leadOnly && txFlight.leadId !== actor.id)
      throw new ForbiddenException("This flight is not assigned to the Lead");
    if (txFlight.status === FlightStatus.CANCELLED)
      throw new ConflictException("Cancelled flights are read-only");
    if (txFlight.reportingStartedAt || (txFlight.report && txFlight.report.status !== ReportStatus.DRAFT))
      throw new ConflictException("Catering is locked after reporting starts");
    const txList = await tx.cateringList.findUnique({ where: { id: listId }, include: { lines: true } });
    if (!txList || txList.status !== "READY")
      throw new ConflictException("Catering list is no longer ready to assign");
    if (txList.flightNumber !== flight.flightNumber || txList.serviceDate.toISOString().slice(0, 10) !== date)
      throw new ConflictException("Catering list and flight number/date no longer match");
    for (const line of txList.lines)
      if (!flight.sectors.some((sector) => sector.sequence === line.sectorSequence))
        throw new ConflictException("Catering list contains an unknown sector");
    const manifests = await tx.manifest.findMany({ where: { flightId } });
    await tx.manifestLine.deleteMany({ where: { manifestId: { in: manifests.map((item) => item.id) } } });
    await tx.manifest.deleteMany({ where: { flightId } });
    const groups = new Map<string, typeof txList.lines>();
    for (const line of txList.lines) {
      const key = `${line.sectorSequence}|${line.cabin}`;
      groups.set(key, [...(groups.get(key) || []), line]);
    }
    for (const lines of groups.values()) {
      const first = lines[0];
      const sector = flight.sectors.find((item) => item.sequence === first.sectorSequence);
      if (!sector) continue;
      await tx.manifest.create({
        data: {
          flightId,
          sectorId: sector.id,
          cabin: first.cabin,
          status: "DRAFT",
          lines: {
            create: lines.map((line) => ({
              itemId: line.itemId,
              suggested: line.suggested,
              planned: line.planned,
              approved: line.approved,
              loaded: line.loaded,
              overrideReason: line.overrideReason,
            })),
          },
        },
      });
    }
    await tx.flight.update({ where: { id: flightId }, data: { cateringListId: txList.id, version: { increment: 1 } } });
    const response = { flightId, cateringList: { id: txList.id, name: txList.name } };
    await tx.idempotencyKey.create({
      data: {
        key: idemKey,
        requestHash: idemHash,
        response,
        expiresAt: new Date(Date.now() + 30 * 86400000),
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        action: "CATERING_LIST_ATTACHED",
        entityType: "Flight",
        entityId: flightId,
        metadata: { cateringListId: txList.id },
      },
    });
  });
  return { flightId, cateringList: { id: list.id, name: list.name } };
}

function publicImportRows(rows: CsvRow[]) {
  return rows.map((row) => ({
    ...row,
    data: Object.fromEntries(
      Object.entries(row.data).filter(([key]) => !key.startsWith("__")),
    ),
  }));
}

function csvCell(value: unknown) {
  const raw = value === null || value === undefined ? "" : String(value);
  const text = /^[\s\u0000-\u001f]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function loadRunReportData(runId: string, revision?: number): Promise<ReportSnapshot> {
  const run = await prisma.cateringList.findUnique({
    where: { id: runId },
    include: {
      purser: { select: { id: true, name: true, email: true } },
      pursers: { include: { user: { select: { id: true, name: true, email: true } } }, orderBy: [{ assignedAt: "asc" }, { id: "asc" }] },
      lines: { include: { item: true }, orderBy: [{ sectorSequence: "asc" }, { cabin: "asc" }] },
      report: { include: { revisions: true, approvals: { orderBy: { createdAt: "asc" } } } },
    },
  });
  if (!run) throw new NotFoundException("Catering run not found");
  const target = revision || run.report?.version || 0;
  const events = (run.report?.approvals || []).filter((entry) => entry.revision <= target).map((entry) => ({
    decision: entry.decision, actorName: entry.actorName, reason: entry.reason || "", createdAt: entry.createdAt.toISOString(),
  }));
  if (revision || (run.report && !canSubmitReport(run.report.status))) {
    const saved = run.report?.revisions.find((entry) => entry.revision === target);
    if (!saved) throw new NotFoundException("Report revision not found");
    const snapshot = saved.snapshot as unknown as ReportSnapshot;
    return { ...snapshot, id: run.report!.id, flight: { ...snapshot.flight, id: run.id }, status: revision ? snapshot.status : run.report!.status,
      approvedAt: revision ? snapshot.approvedAt : run.report?.approvedAt?.toISOString() || null,
      reviewHistory: [...snapshot.reviewHistory, ...events].filter((event, index, all) =>
        all.findIndex((other) => other.decision === event.decision && other.createdAt === event.createdAt && other.actorName === event.actorName) === index) };
  }
  return {
    id: run.report?.id || null, status: run.report?.status || ReportStatus.DRAFT, version: target, runVersion: run.version,
    notes: run.report?.notes || "", submittedAt: run.report?.submittedAt?.toISOString() || null,
    approvedAt: run.report?.approvedAt?.toISOString() || null,
    purser: run.purser || { id: null, name: "Unassigned", email: "" },
    pursers: run.pursers.map((assignment) => assignment.user),
    flight: { id: run.id, flightNumber: run.flightNumber, serviceDate: run.serviceDate.toISOString().slice(0, 10), aircraft: "", status: run.status, sectors: [] },
    lines: run.lines.map((line) => ({
      manifestLineId: line.id, sector: line.sectorSequence, origin: "", destination: "", cabin: line.cabin,
      sku: line.item.sku, item: line.item.nameEn, unit: line.item.unit, loaded: line.loaded,
      consumed: line.consumed, returned: line.returned, spoiled: line.spoiled, discarded: line.discarded,
      unexplained: line.loaded - line.consumed - line.returned - line.spoiled - line.discarded, remarks: line.remarks || "",
    })),
    reviewHistory: events,
  };
}

async function loadReportData(flightId: string, revision?: number): Promise<ReportSnapshot> {
  const flight = await prisma.flight.findUnique({
    where: { id: flightId },
    include: {
      sectors: { orderBy: { sequence: "asc" } },
      assignments: { where: { duty: "PURSER" }, include: { user: { select: { id: true, name: true, email: true } } } },
      manifests: {
        include: {
          sector: true,
          lines: { include: { item: true } },
        },
      },
      report: {
        include: {
          purser: { select: { id: true, name: true, email: true } },
          lines: true,
          revisions: { orderBy: { revision: "asc" } },
          approvals: { include: { actor: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
        },
      },
    },
  });
  if (!flight) throw new NotFoundException("Flight not found");
  const targetRevision = revision || flight.report?.version || 0;
  if (revision !== undefined || (flight.report && !canSubmitReport(flight.report.status))) {
    const snapshot = flight.report?.revisions.find((entry) => entry.revision === targetRevision);
    if (!snapshot) throw new NotFoundException("Report revision not found");
    const saved = snapshot.snapshot as unknown as ReportSnapshot;
    const events = (flight.report?.approvals || []).filter((event) => event.revision === targetRevision).map((event) => ({
      decision: event.decision, actorName: event.actorName, reason: event.reason || "", createdAt: event.createdAt.toISOString(),
    }));
    const history = [...saved.reviewHistory, ...events].filter((event, index, entries) => entries.findIndex((entry) => entry.decision === event.decision && entry.createdAt === event.createdAt && entry.actorName === event.actorName) === index);
    return revision !== undefined ? { ...saved, reviewHistory: history } : {
      ...saved,
      status: flight.report!.status,
      approvedAt: flight.report?.approvedAt?.toISOString() || null,
      reviewHistory: history,
    };
  }
  const lines = flight.manifests.flatMap((manifest) =>
    manifest.lines.map((line) => {
      const { consumed, returned, spoiled, discarded } = line;
      const unexplained = line.loaded - consumed - returned - spoiled - discarded;
      return {
        manifestLineId: line.id,
        sector: manifest.sector.sequence,
        origin: manifest.sector.origin,
        destination: manifest.sector.destination,
        cabin: manifest.cabin,
        sku: line.item.sku,
        item: line.item.nameEn,
        unit: line.item.unit,
        loaded: line.loaded,
        consumed,
        returned,
        spoiled,
        discarded,
        unexplained,
        remarks: line.remarks ?? "",
      };
    }),
  );
  return {
    id: flight.report?.id || null,
    status: flight.report?.status || ReportStatus.DRAFT,
    version: targetRevision,
    notes: flight.report?.notes || "",
    submittedAt: flight.report?.submittedAt?.toISOString() || null,
    approvedAt: flight.report?.approvedAt?.toISOString() || null,
    purser: flight.assignments[0]?.user || { id: null, name: "Unassigned", email: "" },
    flight: {
      id: flight.id,
      flightNumber: flight.flightNumber,
      serviceDate: flight.serviceDate.toISOString().slice(0, 10),
      aircraft: flight.aircraft,
      status: flight.status,
      sectors: flight.sectors.map((sector) => ({
        sequence: sector.sequence,
        origin: sector.origin,
        destination: sector.destination,
        scheduledDeparture: sector.scheduledDeparture.toISOString(),
        scheduledArrival: sector.scheduledArrival.toISOString(),
        economyPax: sector.economyPax,
        businessPax: sector.businessPax,
      })),
    },
    lines,
    reviewHistory: (flight.report?.approvals || []).map((event) => ({
      decision: event.decision,
      actorName: event.actorName,
      reason: event.reason || "",
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

@Catch()
class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const databaseError = databaseConfigurationError();
    const databaseConfigError = Boolean(databaseError) || (exception instanceof Error && exception.message.includes("DATABASE_URL"));
    const schemaDrift = (exception instanceof Prisma.PrismaClientKnownRequestError && ["P2021", "P2022"].includes(exception.code))
      || (exception instanceof Error && /column .* does not exist|relation .* does not exist/i.test(exception.message));
    const databaseConflict = exception instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2025", "P2034"].includes(exception.code);
    const bodyTooLarge = typeof exception === "object" && exception !== null && "status" in exception && exception.status === 413;
    const status = databaseConfigError || schemaDrift
      ? HttpStatus.SERVICE_UNAVAILABLE
      : databaseConflict ? HttpStatus.CONFLICT
      : bodyTooLarge ? HttpStatus.PAYLOAD_TOO_LARGE
      : exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : null;
    const details = typeof raw === "object" && raw ? raw as Record<string, unknown> : {};
    let message = "Request failed";
    if (databaseError) message = databaseError;
    else if (schemaDrift) message = "Database schema is out of date. Run prisma migrate deploy against this database, then restart the API.";
    else if (databaseConflict) message = "This record changed or already exists. Refresh and try again.";
    else if (bodyTooLarge) message = "Request body exceeds the upload limit.";
    else if (databaseConfigError) message = "Database configuration is invalid";
    else if (typeof raw === "string") message = raw;
    else if (typeof details.message === "string") message = details.message;
    else if (status === 500) message = "Internal server error";
    const requestId = String(request.headers["x-request-id"] || randomUUID());
    if (status >= 500) {
      console.error("API request failed", {
        requestId,
        method: request.method,
        path: request.originalUrl || request.url,
        error: exception instanceof Error ? exception.message : String(exception),
      });
    }
    response.status(status).json({code: details.code || "HTTP_" + status,message,fieldErrors: details.fieldErrors,conflict: details.conflict,requestId});
  }
}

@Controller()
export class AppController {
  @Get("health") health() {
    return {
      status: "ok",
      service: "wingsbalance-api",
      time: new Date().toISOString(),
    };
  }
  @Get("ready") async ready() {
    const databaseError = databaseConfigurationError();
    if (databaseError) throw new ServiceUnavailableException(databaseError);
    try {
      await prisma.$queryRaw`SELECT 1`;
      await prisma.$queryRaw`SELECT "leadId", "purserId", "reportingStartedAt" FROM "CateringList" LIMIT 0`;
      await prisma.$queryRaw`SELECT "cateringListId", "userId" FROM "CateringListPurser" LIMIT 0`;
      await prisma.$queryRaw`SELECT "id" FROM "CateringRunReport" LIMIT 0`;
      return { status: "ready", database: "connected" };
    } catch {
      throw new ServiceUnavailableException("Database schema is not ready. Run prisma migrate deploy against this database.");
    }
  }

  @Post("v1/auth/login") async login(
    @Body() body: { email?: string; password?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const email = body.email?.trim().toLowerCase();
    if (!email || !body.password)
      throw new UnauthorizedException("Invalid email or password");
    const databaseError = databaseConfigurationError();
    if (databaseError) throw new ServiceUnavailableException(databaseError);
    const user = await prisma.user.findUnique({ where: { email } });
    if (
      !user ||
      !user.active ||
      (user.lockedUntil && user.lockedUntil > new Date()) ||
      !(await verify(user.passwordHash, body.password).catch(() => false))
    ) {
      if (user) {
        const failures = user.failedLoginAttempts + 1;
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: failures,
            lockedUntil:
              failures >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null,
          },
        });
        await audit(user.id, "AUTH_FAILED", "User", user.id);
      }
      throw new UnauthorizedException("Invalid email or password");
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
    await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const sessionId = randomBytes(32).toString("hex"),
      csrf = randomBytes(24).toString("hex");
    const safe = publicUser(user);
    await prisma.session.create({
      data: {
        id: sessionId,
        userId: user.id,
        csrfToken: csrf,
        expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000),
      },
    });
    res.cookie("wb_session", sessionId, {
      httpOnly: true,
      sameSite: sameSiteCookie(),
      secure: secureCookie(),
      maxAge: SESSION_SECONDS * 1000,
      path: "/",
    });
    res.cookie("wb_csrf", csrf, {
      httpOnly: false,
      sameSite: sameSiteCookie(),
      secure: secureCookie(),
      maxAge: SESSION_SECONDS * 1000,
      path: "/",
    });
    await audit(user.id, "AUTH_LOGIN", "User", user.id);
    return { user: safe, csrf };
  }
  @Get("v1/auth/me") async me(@Req() req: AuthedRequest) {
    return { user: publicUser(await authenticate(req)), csrf: req.csrf };
  }
  @Post("v1/auth/logout") async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await authorizeMutation(req);
    await prisma.session.delete({ where: { id: req.sessionId! } }).catch(() => {});
    res.clearCookie("wb_session", { path: "/" });
    res.clearCookie("wb_csrf", { path: "/" });
    await audit(user.id, "AUTH_LOGOUT", "User", user.id);
    return { ok: true };
  }
  @Post("v1/auth/change-password") async changePassword(
    @Body() body: { currentPassword?: string; newPassword?: string },
    @Req() req: AuthedRequest,
  ) {
    const user = await authorizeMutation(req);
    const record = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    if (
      !body.currentPassword ||
      !(await verify(record.passwordHash, body.currentPassword))
    )
      throw new UnauthorizedException("Current password is incorrect");
    if (!body.newPassword || body.newPassword.length < 10)
      throw new BadRequestException(
        "New password must contain at least 10 characters",
      );
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hash(body.newPassword),
        passwordChangedAt: new Date(),
        sessionVersion: { increment: 1 },
      },
    });
    await prisma.session.deleteMany({ where: { id: req.sessionId! } });
    await audit(user.id, "PASSWORD_CHANGED", "User", user.id);
    return { ok: true, reauthenticate: true };
  }
  @Post("v1/admin/users/:id/reset-password") async resetPassword(
    @Param("id") id: string,
    @Body() body: { temporaryPassword?: string },
    @Req() req: AuthedRequest,
  ) {
    const actor = await authorizeMutation(req, [Role.ADMIN]);
    if (!body.temporaryPassword || body.temporaryPassword.length < 10)
      throw new BadRequestException(
        "Temporary password must contain at least 10 characters",
      );
    await prisma.user.update({
      where: { id },
      data: {
        passwordHash: await hash(body.temporaryPassword),
        passwordChangedAt: new Date(),
        sessionVersion: { increment: 1 },
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    await audit(actor.id, "PASSWORD_ADMIN_RESET", "User", id);
    return { ok: true };
  }
  @Post("v1/admin/users") async createUser(
    @Body() body: { email?: string; name?: string; role?: Role; temporaryPassword?: string },
    @Req() req: AuthedRequest,
  ) {
    const actor = await authorizeMutation(req, [Role.ADMIN]);
    const email = body.email?.trim().toLowerCase();
    const name = body.name?.trim();
    const role = body.role;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new BadRequestException("A valid email is required");
    if (!name || name.length < 2)
      throw new BadRequestException("Name must contain at least 2 characters");
    if (!role || !Object.values(Role).includes(role))
      throw new BadRequestException("A valid user role is required");
    if (!body.temporaryPassword || body.temporaryPassword.length < 10)
      throw new BadRequestException("Temporary password must contain at least 10 characters");
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException("A user with this email already exists");
    const user = await prisma.user.create({
      data: {
        email,
        name,
        role,
        passwordHash: await hash(body.temporaryPassword),
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        passwordChangedAt: true,
      },
    });
    await audit(actor.id, "USER_CREATED", "User", user.id, { email, role });
    return user;
  }

  @Get("v1/navigation") async navigation(@Req() req: AuthedRequest) {
    const user = await authenticate(req);
    const items: Record<Role, string[]> = {
      ATTENDANT: ["my-runs", "history"],
      LEAD: ["operations", "attendants"],
      PROCUREMENT: ["dashboard", "uploads", "reconciliation", "stock", "waste"],
      DIRECTOR: ["executive", "costs", "insights"],
      ADMIN: ["users", "audit"],
    };
    return { items: items[user.role] };
  }
  @Get("v1/runs") async runs(@Req() req: AuthedRequest) {
    const actor = await authenticate(req, [Role.PROCUREMENT, Role.LEAD, Role.ATTENDANT]);
    const rows = await prisma.cateringList.findMany({
      where: actor.role === Role.LEAD ? { leadId: actor.id } : actor.role === Role.ATTENDANT ? { pursers: { some: { userId: actor.id } } } : {},
      include: {
        lead: { select: { id: true, name: true, email: true } },
        purser: { select: { id: true, name: true, email: true } },
        pursers: { include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { assignedAt: "asc" } },
        lines: { include: { item: { select: { id: true, sku: true, nameEn: true, nameFr: true, category: true, unit: true } } }, orderBy: { id: "asc" } },
        report: { select: { id: true, status: true, version: true, notes: true, submittedAt: true, approvedAt: true,
          approvals: { where: { decision: ReportStatus.RETURNED }, orderBy: { createdAt: "desc" }, take: 1, select: { reason: true } },
        } },
      },
      orderBy: [{ serviceDate: "desc" }, { flightNumber: "asc" }],
    });
    return rows.map((run) => ({
      ...run,
      serviceDate: run.serviceDate.toISOString().slice(0, 10),
      report: run.report ? { ...run.report, returnReason: run.report.status === ReportStatus.RETURNED ? run.report.approvals[0]?.reason || null : null } : null,
      pursers: run.pursers.map((assignment) => assignment.user),
      metrics: {
        lineCount: run.lines.length,
        assignedPursers: run.pursers.length,
        loaded: run.lines.reduce((total, line) => total + line.loaded, 0),
        consumed: run.lines.reduce((total, line) => total + line.consumed, 0),
        returned: run.lines.reduce((total, line) => total + line.returned, 0),
        spoiled: run.lines.reduce((total, line) => total + line.spoiled, 0),
        discarded: run.lines.reduce((total, line) => total + line.discarded, 0),
        unexplained: run.lines.reduce((total, line) => total + Math.max(0, line.loaded - line.consumed - line.returned - line.spoiled - line.discarded), 0),
      },
    }));
  }
  @Patch("v1/runs/:id/lead") async assignRunLead(@Param("id") id: string, @Body() body: { leadId: string; version: number }, @Req() req: AuthedRequest) {
    const actor = await authorizeMutation(req, [Role.PROCUREMENT]);
    if (!body.leadId) throw new BadRequestException("Select a Cabin Services lead");
    return prisma.$transaction(async (tx) => {
      await lockRun(tx, id);
      const run = await tx.cateringList.findUnique({ where: { id }, include: { report: true } });
      if (!run) throw new NotFoundException("Catering run not found");
      if (run.status === "CANCELLED") throw new ConflictException("Cancelled catering runs are read-only");
      if (!Number.isInteger(body.version) || run.version !== body.version) throw new ConflictException("Run changed; reload before assigning the lead");
      if (run.reportingStartedAt || (run.report && !canSubmitReport(run.report.status))) throw new ConflictException("Assignment is locked after reporting starts");
      const lead = await tx.user.findFirst({ where: { id: body.leadId, role: Role.LEAD, active: true }, select: { id: true, name: true } });
      if (!lead) throw new BadRequestException("Active Cabin Services lead not found");
      const isNewAssignment = run.leadId !== lead.id;
      await tx.cateringList.update({ where: { id }, data: { leadId: lead.id, version: { increment: 1 } } });
      if (isNewAssignment) await notifyUsers(tx, [lead.id], {
        title: `${run.flightNumber}: catering run assigned`,
        body: `Catering assigned you the ${run.serviceDate.toISOString().slice(0, 10)} run. Choose the Flight Pursers when ready.`,
        kind: "RUN_ASSIGNED",
        actionPath: "operations",
      });
      await tx.auditEvent.create({ data: { actorId: actor.id, action: "RUN_LEAD_ASSIGNED", entityType: "CateringList", entityId: id, metadata: { leadId: lead.id } } });
      return { id, lead };
    });
  }
  @Patch("v1/runs/:id/pursers") async assignRunPursers(@Param("id") id: string, @Body() body: { purserIds: string[]; version: number }, @Req() req: AuthedRequest) {
    const actor = await authorizeMutation(req, [Role.LEAD]);
    if (!Array.isArray(body.purserIds)) throw new BadRequestException("purserIds must be an array");
    const purserIds = [...new Set(body.purserIds.filter((value): value is string => typeof value === "string" && value.length > 0))];
    return prisma.$transaction(async (tx) => {
      await lockRun(tx, id);
      const run = await tx.cateringList.findUnique({ where: { id }, include: { report: true, pursers: true } });
      if (!run || run.leadId !== actor.id) throw new ForbiddenException("Run is not assigned to you");
      if (run.status === "CANCELLED") throw new ConflictException("Cancelled catering runs are read-only");
      if (!Number.isInteger(body.version) || run.version !== body.version) throw new ConflictException("Run changed; reload before assigning the Purser");
      if (run.reportingStartedAt || run.report?.submittedAt) throw new ConflictException("Purser assignment is locked after reporting starts");
      const pursers = await tx.user.findMany({ where: { id: { in: purserIds }, role: Role.ATTENDANT, active: true }, select: { id: true, name: true, email: true } });
      if (pursers.length !== purserIds.length) throw new BadRequestException("One or more selected Flight Pursers are inactive or invalid");
      const currentPurserIds = new Set(run.pursers.map((assignment) => assignment.userId));
      const newlyAssigned = purserIds.filter((purserId) => !currentPurserIds.has(purserId));
      await tx.cateringListPurser.deleteMany({ where: { cateringListId: id } });
      await tx.cateringListPurser.createMany({ data: purserIds.map((userId) => ({ cateringListId: id, userId })) });
      await tx.cateringList.update({ where: { id }, data: { purserId: purserIds[0] || null, version: { increment: 1 } } });
      await notifyUsers(tx, newlyAssigned, {
        title: `${run.flightNumber}: catering run assigned`,
        body: `Cabin Services assigned you the ${run.serviceDate.toISOString().slice(0, 10)} catering run. Record consumed quantities when service is complete.`,
        kind: "PURSER_ASSIGNED",
        actionPath: "my-runs",
      });
      await tx.auditEvent.create({ data: { actorId: actor.id, action: "RUN_PURSERS_ASSIGNED", entityType: "CateringList", entityId: id, metadata: { purserIds } } });
      return { id, pursers };
    });
  }
  @Post("v1/runs/:id/pursers") async addRunPurser(@Param("id") id: string, @Body() body: { purserId: string; version: number }, @Req() req: AuthedRequest) {
    if (!body.purserId) throw new BadRequestException("Select a Flight Purser");
    const actor = await authorizeMutation(req, [Role.LEAD]);
    return prisma.$transaction(async (tx) => {
      await lockRun(tx, id);
      const run = await tx.cateringList.findUnique({ where: { id }, include: { report: true, pursers: true } });
      if (!run || run.leadId !== actor.id) throw new ForbiddenException("Run is not assigned to you");
      if (run.status === "CANCELLED") throw new ConflictException("Cancelled catering runs are read-only");
      if (!Number.isInteger(body.version) || run.version !== body.version) throw new ConflictException("Run changed; reload before assigning the Purser");
      if (run.reportingStartedAt || run.report?.submittedAt) throw new ConflictException("Purser assignment is locked after reporting starts");
      const purser = await tx.user.findFirst({ where: { id: body.purserId, role: Role.ATTENDANT, active: true }, select: { id: true, name: true, email: true } });
      if (!purser) throw new BadRequestException("Active Flight Purser not found");
      if (!run.pursers.some((assignment) => assignment.userId === purser.id)) {
        await tx.cateringListPurser.create({ data: { cateringListId: id, userId: purser.id } });
        await tx.cateringList.update({ where: { id }, data: { purserId: run.purserId || purser.id, version: { increment: 1 } } });
        await notifyUsers(tx, [purser.id], {
          title: `${run.flightNumber}: catering run assigned`,
          body: `Cabin Services assigned you the ${run.serviceDate.toISOString().slice(0, 10)} catering run. Record consumed quantities when service is complete.`,
          kind: "PURSER_ASSIGNED",
          actionPath: "my-runs",
        });
      }
      await tx.auditEvent.create({ data: { actorId: actor.id, action: "RUN_PURSER_ADDED", entityType: "CateringList", entityId: id, metadata: { purserId: purser.id } } });
      return { id, purser };
    });
  }
  @Delete("v1/runs/:id/pursers/:purserId") async removeRunPurser(@Param("id") id: string, @Param("purserId") purserId: string, @Body() body: { version: number }, @Req() req: AuthedRequest) {
    const actor = await authorizeMutation(req, [Role.LEAD]);
    return prisma.$transaction(async (tx) => {
      await lockRun(tx, id);
      const run = await tx.cateringList.findUnique({ where: { id }, include: { report: true, pursers: { orderBy: { assignedAt: "asc" } } } });
      if (!run || run.leadId !== actor.id) throw new ForbiddenException("Run is not assigned to you");
      if (run.status === "CANCELLED") throw new ConflictException("Cancelled catering runs are read-only");
      if (!Number.isInteger(body.version) || run.version !== body.version) throw new ConflictException("Run changed; reload before updating Pursers");
      if (run.reportingStartedAt || run.report?.submittedAt) throw new ConflictException("Purser assignment is locked after reporting starts");
      if (!run.pursers.some((assignment) => assignment.userId === purserId)) throw new NotFoundException("Purser is not assigned to this run");
      await tx.cateringListPurser.deleteMany({ where: { cateringListId: id, userId: purserId } });
      const next = run.pursers.find((assignment) => assignment.userId !== purserId);
      await tx.cateringList.update({ where: { id }, data: { purserId: next?.userId || null, version: { increment: 1 } } });
      await tx.auditEvent.create({ data: { actorId: actor.id, action: "RUN_PURSER_REMOVED", entityType: "CateringList", entityId: id, metadata: { purserId } } });
      return { id, purserId };
    });
  }
  @Patch("v1/runs/:id/purser") async assignRunPurser(@Param("id") id: string, @Body() body: { purserId: string; version: number }, @Req() req: AuthedRequest) {
    return this.assignRunPursers(id, { purserIds: [body.purserId], version: body.version }, req);
  }
  @Patch("v1/runs/:id/draft") async saveRunDraft(@Param("id") id: string, @Body() body: { version: number; lines: Array<{ id: string; consumed: number; remarks?: string; returned?: never; spoiled?: never; discarded?: never }> }, @Req() req: AuthedRequest) {
    const actor = await authorizeMutation(req, [Role.ATTENDANT]);
    if (!Array.isArray(body.lines)) throw new BadRequestException("Catering lines are required");
    return prisma.$transaction(async (tx) => {
      await lockRun(tx, id);
      const run = await tx.cateringList.findUnique({ where: { id }, include: { lines: true, report: true, pursers: true } });
      if (!run || !run.pursers.some((assignment) => assignment.userId === actor.id)) throw new ForbiddenException("Only an assigned Flight Purser may edit this run");
      if (run.status === "CANCELLED") throw new ConflictException("Cancelled catering runs are read-only");
      if (run.report && ([ReportStatus.FORWARDED, ReportStatus.APPROVED, ReportStatus.REJECTED] as ReportStatus[]).includes(run.report.status))
        throw new ConflictException("Report is read-only");
      if (run.version !== body.version) throw new ConflictException("Run changed on the server; reload before saving");
      const ids = new Set(body.lines.map((line) => line.id));
      if (ids.size !== body.lines.length || ids.size !== run.lines.length || run.lines.some((line) => !ids.has(line.id))) throw new BadRequestException("Submit every catering line exactly once");
      for (const line of body.lines) {
        const source = run.lines.find((entry) => entry.id === line.id)!;
        if (!Number.isSafeInteger(line.consumed) || line.consumed < 0 || line.consumed > source.loaded)
          throw new BadRequestException("Consumed quantity must be a whole number between zero and loaded quantity");
        await tx.cateringListLine.update({ where: { id: line.id }, data: { consumed: line.consumed, returned: source.loaded - line.consumed, spoiled: 0, discarded: 0, remarks: line.remarks?.trim() || null } });
      }
      const saved = await tx.cateringList.update({ where: { id }, data: { version: { increment: 1 }, reportingStartedAt: run.reportingStartedAt || new Date() } });
      return { version: saved.version };
    });
  }
  @Post("v1/runs/:id/reports") async submitRunReport() {
    throw new ForbiddenException("Flight Pursers save consumption only; Cabin Services generates the final report");
  }
  @Post("v1/runs/:id/report") async generateRunReport(@Param("id") id: string, @Body() body: { operationId: string; runVersion: number }, @Req() req: AuthedRequest) {
    const actor = await authorizeMutation(req, [Role.LEAD]);
    if (!body.operationId || !Number.isInteger(body.runVersion)) throw new BadRequestException("Preview the report before sending it");
    const key = scopedKey(actor.id, "RUN_REPORT_GENERATE", id, body.operationId);
    const hash = requestHash({ runVersion: body.runVersion });
    const result = await prisma.$transaction(async (tx) => {
      await lockRun(tx, id);
      const previous = assertReplay(await tx.idempotencyKey.findUnique({ where: { key } }), hash);
      if (previous) return previous as { id: string; version: number };
      const run = await tx.cateringList.findUnique({ where: { id }, include: {
        report: true,
        lines: { include: { item: true }, orderBy: [{ sectorSequence: "asc" }, { cabin: "asc" }] },
        pursers: { include: { user: { select: { id: true, name: true, email: true } } }, orderBy: [{ assignedAt: "asc" }, { id: "asc" }] },
      } });
      if (!run) throw new NotFoundException("Catering run not found");
      if (run.leadId !== actor.id) throw new ForbiddenException("Run is not assigned to you");
      if (run.status === "CANCELLED") throw new ConflictException("Cancelled catering runs are read-only");
      if (run.version !== body.runVersion) throw new ConflictException("Consumption changed since your preview. Preview the report again before sending.");
      if (!run.reportingStartedAt) throw new ConflictException("A Flight Purser must save consumption before the report can be sent");
      if (!run.lines.length) throw new ConflictException("No catering items are available");
      if (run.lines.some((line) => ![line.loaded, line.consumed, line.returned, line.spoiled, line.discarded].every((quantity) => Number.isSafeInteger(quantity) && quantity >= 0) || line.consumed + line.returned + line.spoiled + line.discarded !== line.loaded))
        throw new ConflictException("Save balanced consumption quantities for every item before sending the report");
      const reporter = run.pursers[0]?.user || (run.purserId ? await tx.user.findUnique({ where: { id: run.purserId }, select: { id: true, name: true, email: true } }) : null);
      if (!reporter) throw new ConflictException("Assign at least one Flight Purser before generating the report");
      if (run.report && ([ReportStatus.FORWARDED, ReportStatus.APPROVED] as ReportStatus[]).includes(run.report.status))
        return { id: run.report.id, version: run.report.version };
      const now = new Date();
      const version = (run.report?.version || 0) + 1;
      const report = run.report
        ? await tx.cateringRunReport.update({ where: { id: run.report.id }, data: { purserId: reporter.id, purserName: reporter.name, status: ReportStatus.FORWARDED, submittedAt: run.report.submittedAt || now, approvedAt: null, version, notes: run.report.notes || "Generated by Cabin Services" } })
        : await tx.cateringRunReport.create({ data: { cateringListId: id, purserId: reporter.id, purserName: reporter.name, status: ReportStatus.FORWARDED, submittedAt: now, version, notes: "Generated by Cabin Services" } });
      await tx.cateringRunReportLine.createMany({ data: run.lines.map((line) => ({
        reportId: report.id, cateringListLineId: line.id, itemId: line.itemId, itemSku: line.item.sku, itemName: line.item.nameEn, unit: line.item.unit,
        sectorSequence: line.sectorSequence, cabin: line.cabin, loaded: line.loaded, consumed: line.consumed, returned: line.returned,
        spoiled: line.spoiled, discarded: line.discarded, unexplained: Math.max(0, line.loaded - line.consumed - line.returned - line.spoiled - line.discarded), remarks: line.remarks, revision: version,
      })) });
      const snapshot: ReportSnapshot = {
        id: report.id, status: ReportStatus.FORWARDED, version, notes: report.notes || "", submittedAt: (report.submittedAt || now).toISOString(), approvedAt: null,
        purser: reporter, pursers: run.pursers.map((assignment) => assignment.user), runVersion: run.version,
        flight: { id, flightNumber: run.flightNumber, serviceDate: run.serviceDate.toISOString().slice(0, 10), aircraft: "", status: run.status, sectors: [] },
        lines: run.lines.map((line) => ({ manifestLineId: line.id, sector: line.sectorSequence, origin: "", destination: "", cabin: line.cabin,
          sku: line.item.sku, item: line.item.nameEn, unit: line.item.unit, loaded: line.loaded, consumed: line.consumed, returned: line.returned,
          spoiled: line.spoiled, discarded: line.discarded, unexplained: Math.max(0, line.loaded - line.consumed - line.returned - line.spoiled - line.discarded), remarks: line.remarks || "" })),
        reviewHistory: [{ decision: "FORWARDED", actorName: actor.name, reason: "Generated by Cabin Services", createdAt: now.toISOString() }],
      };
      await tx.cateringRunReportRevision.create({ data: { reportId: report.id, revision: version, snapshot: snapshot as unknown as Prisma.InputJsonValue } });
      await tx.cateringList.update({ where: { id }, data: { reportingStartedAt: run.reportingStartedAt || now, version: { increment: 1 } } });
      const cateringUsers = await tx.user.findMany({ where: { role: Role.PROCUREMENT, active: true }, select: { id: true } });
      await notifyUsers(tx, cateringUsers.map((user) => user.id), {
        title: `${run.flightNumber}: report ready to review`,
        body: `Cabin Services sent the ${run.serviceDate.toISOString().slice(0, 10)} consumption report for Catering review.`,
        kind: "REPORT_READY",
        actionPath: "reconciliation",
      });
      await notifyUsers(tx, run.pursers.map((assignment) => assignment.userId), {
        title: `${run.flightNumber}: report sent to Catering`,
        body: "Cabin Services has sent the shared consumption report to Catering.",
        kind: "REPORT_SENT",
        actionPath: "history",
      });
      const response = { id: report.id, version };
      await tx.idempotencyKey.create({ data: { key, requestHash: hash, response, expiresAt: new Date(Date.now() + 7 * 86400000) } });
      await tx.auditEvent.create({ data: { actorId: actor.id, action: "RUN_REPORT_GENERATED", entityType: "CateringList", entityId: id, metadata: { revision: version, pursers: run.pursers.map((assignment) => assignment.userId) } } });
      return response;
    });
    return loadRunReportData(id, result.version);
  }
  @Get("v1/runs/:id/report/preview") async previewRunReport(@Param("id") id: string, @Req() req: AuthedRequest) {
    const actor = await authenticate(req, [Role.LEAD]);
    const run = await prisma.cateringList.findUnique({ where: { id }, select: { leadId: true } });
    if (!run) throw new NotFoundException("Catering run not found");
    if (run.leadId !== actor.id) throw new ForbiddenException("Run is not assigned to you");
    return loadRunReportData(id);
  }
  @Get("v1/runs/:id/report") async runReportDetails(@Param("id") id: string, @Req() req: AuthedRequest, @Query("revision") revision?: string | number) {
    const actor = await authenticate(req, [Role.ATTENDANT, Role.LEAD, Role.PROCUREMENT, Role.ADMIN]);
    const run = await prisma.cateringList.findUnique({ where: { id }, select: { leadId: true, purserId: true, pursers: { select: { userId: true } } } });
    if (!run) throw new NotFoundException("Catering run not found");
    if ((actor.role === Role.ATTENDANT && !run.pursers.some((assignment) => assignment.userId === actor.id)) || (actor.role === Role.LEAD && run.leadId !== actor.id)) throw new ForbiddenException("Run is not assigned to you");
    const parsed = revision === undefined ? undefined : Number(revision);
    if (parsed !== undefined && (!Number.isInteger(parsed) || parsed < 1)) throw new BadRequestException("Invalid revision");
    return loadRunReportData(id, parsed);
  }
  @Get("v1/runs/:id/report.csv") async runReportCsv(@Param("id") id: string, @Req() req: AuthedRequest, @Res({ passthrough: true }) response: Response) {
    const report = await this.runReportDetails(id, req) as ReportSnapshot;
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename="${report.flight.flightNumber.replace(/[^A-Za-z0-9_-]+/g, "-")}-${report.flight.serviceDate}-leftovers.csv"`);
    return serializeReportCsv(report);
  }
  @Get("v1/runs/:id/report.pdf") async runReportPdf(@Param("id") id: string, @Req() req: AuthedRequest, @Res({ passthrough: true }) response: Response) {
    const report = await this.runReportDetails(id, req) as ReportSnapshot;
    response.setHeader("Content-Disposition", `attachment; filename="${report.flight.flightNumber.replace(/[^A-Za-z0-9_-]+/g, "-")}-${report.flight.serviceDate}-leftovers.pdf"`);
    return new StreamableFile(await renderReportPdf(report), { type: "application/pdf" });
  }
  @Patch("v1/run-reports/:id/decision") async decideRunReport(@Param("id") id: string, @Body() body: { decision: "FORWARDED" | "APPROVED" | "RETURNED" | "REJECTED"; reason?: string; version: number; operationId: string }, @Req() req: AuthedRequest) {
    const actor = await authorizeMutation(req, [Role.LEAD, Role.PROCUREMENT]);
    if (!["FORWARDED", "APPROVED"].includes(body.decision) && !body.reason?.trim()) throw new BadRequestException("Reason is required");
    const key = scopedKey(actor.id, "RUN_REPORT_DECISION", id, body.operationId);
    const hash = requestHash({ decision: body.decision, version: body.version, reason: body.reason || "" });
    const initial = await prisma.cateringRunReport.findUnique({ where: { id }, select: { cateringListId: true } });
    if (!initial) throw new NotFoundException("Report not found");
    return prisma.$transaction(async (tx) => {
      await lockRun(tx, initial.cateringListId);
      const previous = assertReplay(await tx.idempotencyKey.findUnique({ where: { key } }), hash);
      if (previous) return previous;
      const report = await tx.cateringRunReport.findUnique({ where: { id }, include: {
        cateringList: { include: { pursers: { select: { userId: true } } } },
        lines: { where: { revision: body.version }, include: { item: { include: { prices: true } } } },
      } });
      if (!report || report.version !== body.version) throw new ConflictException("Report changed; reload before reviewing");
      if (report.cateringList.status === "CANCELLED") throw new ConflictException("Cancelled catering runs are read-only");
      if (actor.role === Role.LEAD && report.cateringList.leadId !== actor.id) throw new ForbiddenException("Run is not assigned to you");
      if (!canDecideReport(actor.role, report.status, body.decision as ReportStatus)) throw new ForbiddenException("Decision is not permitted for this role or report status");
      if (body.decision === "APPROVED") {
        if (!report.lines.length) throw new ConflictException("Report has no catering lines");
        for (const line of report.lines) {
          const price = effectivePriceAt(line.item.prices, report.cateringList.serviceDate);
          if (!price) throw new ConflictException(`No effective price exists for ${line.itemName} on the service date`);
          for (const [reason, quantity] of [["APPROVED_CONSUMPTION", line.consumed], ["RETURN", line.returned], ["SPOILAGE", line.spoiled], ["DISCARD", line.discarded], ["MISSING", line.unexplained]] as const) {
            if (quantity > 0) await tx.stockMovement.create({ data: { itemId: line.itemId, runId: report.cateringListId, quantity: reason === "RETURN" ? quantity : -quantity, reason, operationId: `${key}:${line.id}:${reason}`, unitCostMinor: price.amountMinor, currency: price.currency } });
          }
        }
      }
      const status = body.decision as ReportStatus;
      await tx.cateringRunReport.update({ where: { id }, data: { status, approvedAt: status === ReportStatus.APPROVED ? new Date() : null } });
      await tx.cateringRunApproval.create({ data: { reportId: id, actorId: actor.id, actorName: actor.name, decision: status, revision: report.version, reason: body.reason } });
      if (status === ReportStatus.APPROVED) {
        const stakeholders = await tx.user.findMany({ where: { role: { in: [Role.ADMIN, Role.DIRECTOR] }, active: true }, select: { id: true, role: true } });
        await notifyUsers(tx, stakeholders.filter((user) => user.role === Role.DIRECTOR).map((user) => user.id), {
          title: `${report.cateringList.flightNumber}: consumption approved`,
          body: "Catering approved the report. The latest consumption is now reflected in operations analytics.",
          kind: "ANALYTICS_UPDATED",
          actionPath: "executive",
        });
        await notifyUsers(tx, stakeholders.filter((user) => user.role === Role.ADMIN).map((user) => user.id), {
          title: `${report.cateringList.flightNumber}: consumption approved`,
          body: "Catering approved the report. The latest consumption is now reflected in operations analytics.",
          kind: "ANALYTICS_UPDATED",
          actionPath: "users",
        });
        await notifyUsers(tx, [report.cateringList.leadId], {
          title: `${report.cateringList.flightNumber}: report approved`,
          body: "Catering approved the consumption report and completed reconciliation.",
          kind: "REPORT_APPROVED",
          actionPath: "operations",
        });
        await notifyUsers(tx, report.cateringList.pursers.map((assignment) => assignment.userId), {
          title: `${report.cateringList.flightNumber}: report approved`,
          body: "Catering approved the consumption report and completed reconciliation.",
          kind: "REPORT_APPROVED",
          actionPath: "history",
        });
      }
      if (status === ReportStatus.RETURNED) {
        const returned = { title: `${report.cateringList.flightNumber}: report needs correction`, body: body.reason!.trim(), kind: "REPORT_RETURNED" };
        await notifyUsers(tx, [report.cateringList.leadId], { ...returned, actionPath: "operations" });
        await notifyUsers(tx, report.cateringList.pursers.map((assignment) => assignment.userId), { ...returned, actionPath: "my-runs" });
      }
      const response = { id, status, version: report.version, ledgerPosted: status === ReportStatus.APPROVED };
      await tx.idempotencyKey.create({ data: { key, requestHash: hash, response, expiresAt: new Date(Date.now() + 30 * 86400000) } });
      await tx.auditEvent.create({ data: { actorId: actor.id, action: `RUN_REPORT_${status}`, entityType: "CateringRunReport", entityId: id, metadata: { revision: report.version, reason: body.reason || "" } } });
      return response;
    });
  }
  async flights(@Req() req: AuthedRequest) {
    const user = await authenticate(req);
    if (user.role === Role.PROCUREMENT)
      throw new ForbiddenException("Catering uses the catering work queue");
    const where =
      user.role === Role.ATTENDANT
        ? { assignments: { some: { userId: user.id, duty: "PURSER" } } }
        : user.role === Role.LEAD
          ? { leadId: user.id }
          : {};
    const flights = await prisma.flight.findMany({
      where,
      orderBy: { flightDate: "desc" },
      include: {
        sectors: { orderBy: { sequence: "asc" } },
        report: {
          select: {
            id: true,
            status: true,
            purserName: true,
            submittedAt: true,
          },
        },
        lead: { select: { id: true, name: true, email: true } },
        cateringList: { select: { id: true, name: true, status: true } },
        assignments:
          user.role === Role.ATTENDANT
            ? false
            : {
                where: { duty: "PURSER" },
                include: {
                  user: { select: { id: true, name: true, email: true } },
                },
              },
      },
    });
    if (user.role === Role.ATTENDANT) {
      const now = Date.now();
      for (const flight of flights) {
        if (flight.status === FlightStatus.CANCELLED || (flight.report && flight.report.status !== ReportStatus.DRAFT)) continue;
        const arrivals = flight.sectors.map((sector) => sector.scheduledArrival.getTime()).filter(Number.isFinite);
        if (!arrivals.length || Math.max(...arrivals) >= now) continue;
        const recent = await prisma.notification.findFirst({
          where: { userId: user.id, flightId: flight.id, kind: "LEFTOVERS_DUE", createdAt: { gte: new Date(now - 86_400_000) } },
          select: { id: true },
        });
        if (!recent) await prisma.notification.create({
          data: {
            userId: user.id,
            flightId: flight.id,
            kind: "LEFTOVERS_DUE",
            title: `${flight.flightNumber}: leftovers report due`,
            body: "The final scheduled arrival has passed. Review quantities and prepare the consolidated leftovers report.",
            actionPath: "my-flight",
          },
        });
      }
    }
    return flights;
  }
  // Legacy schedule-ingestion endpoint. Catering UI uses the read-only work queue instead.
  async createFlight(
    @Body() body: {flightNumber:string;flightDate:string;aircraft:string;origin:string;destination:string;scheduledArrival:string;economyPax:number;businessPax:number},
    @Req() req: AuthedRequest,
  ) {
    const actor=await authorizeMutation(req,[Role.PROCUREMENT]);
    const flightNumber = normalizeFlightNumber(body.flightNumber || "");
    const departure = parseIsoTimestamp(body.flightDate || "");
    const arrival = parseIsoTimestamp(body.scheduledArrival || "");
    const serviceDate = dateWindow(isoCalendarDate(body.flightDate || "") || "")?.start;
    if(
      !flightNumber ||
      !body.aircraft?.trim() ||
      !/^[A-Z]{3}$/.test(body.origin?.toUpperCase()) ||
      !/^[A-Z]{3}$/.test(body.destination?.toUpperCase()) ||
      !departure || !arrival || !serviceDate ||
      arrival <= departure ||
      !Number.isInteger(body.economyPax) ||
      !Number.isInteger(body.businessPax) ||
      body.economyPax < 0 ||
      body.businessPax < 0
    ) throw new BadRequestException("Invalid flight details");
    const duplicate = await prisma.flight.count({
      where: {
        flightNumber,
        serviceDate,
      },
    });
    if (duplicate) throw new ConflictException("Flight already exists for this date");
    const flight=await prisma.flight.create({data:{flightNumber,flightDate:departure,serviceDate,aircraft:body.aircraft.trim().toUpperCase(),status:"SCHEDULED",sectors:{create:{sequence:1,origin:body.origin.toUpperCase(),destination:body.destination.toUpperCase(),scheduledDeparture:departure,scheduledArrival:arrival,economyPax:body.economyPax,businessPax:body.businessPax}}},include:{sectors:true}});
    await audit(actor.id,"FLIGHT_CREATED","Flight",flight.id);return flight;
  }
  @Get("v1/procurement/leads") async procurementLeads(
    @Req() req: AuthedRequest,
  ) {
    await authenticate(req, [Role.PROCUREMENT]);
    return prisma.user.findMany({
      where: { role: Role.LEAD, active: true },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    });
  }
  async assignFlightLead(
    @Param("id") id: string,
    @Body() body: { leadId?: string | null },
    @Req() req: AuthedRequest,
  ) {
    const actor = await authorizeMutation(req, [Role.PROCUREMENT]);
    const flight = await prisma.flight.findUnique({
      where: { id },
      include: { sectors: true },
    });
    if (!flight) throw new NotFoundException("Operational record not found");
    if (body.leadId) {
      const lead = await prisma.user.findFirst({
        where: { id: body.leadId, role: Role.LEAD, active: true },
      });
      if (!lead) throw new BadRequestException("Active Cabin Services lead not found");
      const target = scheduleBounds(flight.sectors);
      const existing = await prisma.flight.findMany({
        where: {
          id: { not: id },
          leadId: body.leadId,
          status: { in: ["SCHEDULED", "BOARDING", "ACTIVE"] },
        },
        include: { sectors: true },
      });
      if (
        target &&
        existing.some((item) => {
          const other = scheduleBounds(item.sectors);
          return other ? schedulesOverlap(target, other) : false;
        })
      )
        throw new ConflictException(
          "This Cabin Services lead already has an overlapping operation",
        );
    }
    const updated = await prisma.flight.update({
      where: { id },
      data: { leadId: body.leadId || null, version: { increment: 1 } },
      include: { lead: { select: { id: true, name: true, email: true } } },
    });
    await audit(actor.id, "FLIGHT_LEAD_ASSIGNED", "Flight", id, {
      leadId: body.leadId || null,
    });
    return updated;
  }
  async procurementCateringWorkQueue(
    @Req() req: AuthedRequest,
  ) {
    await authenticate(req, [Role.PROCUREMENT]);
    const lists = await prisma.cateringList.findMany({
      include: {
        _count: { select: { lines: true } },
        createdBy: { select: { name: true } },
        flights: {
          select: {
            id: true,
            status: true,
            cateringListId: true,
            lead: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ serviceDate: "desc" }, { updatedAt: "desc" }],
    });
    const candidates = lists.length
      ? await prisma.flight.findMany({
          where: {
            OR: lists.map((list) => ({
              flightNumber: list.flightNumber,
              serviceDate: list.serviceDate,
            })),
          },
          select: {
            id: true,
            flightNumber: true,
            serviceDate: true,
            status: true,
            cateringListId: true,
            lead: { select: { id: true, name: true } },
          },
        })
      : [];
    const candidateByKey = new Map(
      candidates.map((flight) => [
        `${flight.flightNumber}|${flight.serviceDate.toISOString().slice(0, 10)}`,
        flight,
      ]),
    );
    return lists.map((list) => {
      const serviceDate = list.serviceDate.toISOString().slice(0, 10);
      const attachedFlight = list.flights[0] || null;
      const candidate = candidateByKey.get(`${list.flightNumber}|${serviceDate}`) || null;
      const matchingFlight = attachedFlight || (candidate?.cateringListId ? null : candidate);
      const canAttach = Boolean(candidate && candidate.status !== FlightStatus.CANCELLED && !candidate.cateringListId);
      const assignmentStatus = attachedFlight
        ? "ASSIGNED"
        : canAttach
          ? "READY_TO_ATTACH"
          : "WAITING_FOR_OPERATION";
      return {
        id: list.id,
        name: list.name,
        flightNumber: list.flightNumber,
        serviceDate,
        status: list.status,
        version: list.version,
        _count: list._count,
        createdBy: list.createdBy,
        assignmentStatus,
        matchingFlight: matchingFlight
          ? {
              id: matchingFlight.id,
              status: matchingFlight.status,
              lead: matchingFlight.lead,
            }
          : null,
      };
    });
  }
  @Get("v1/lead/attendants") async leadAttendants(@Req() req: AuthedRequest) {
    await authenticate(req, [Role.LEAD]);
    return prisma.user.findMany({
      where: { role: Role.ATTENDANT, active: true },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    });
  }
  async assignFlightCrew(
    @Param("id") id: string,
    @Body()
    body: {
      assignments?: Array<{ userId: string; duty: "PURSER" | "CABIN_CREW" }>;
      operationId?: string;
      version: number;
    },
    @Req() req: AuthedRequest,
  ) {
    const actor = await authorizeMutation(req, [Role.LEAD]);
    const flight = await requireLeadFlight(actor.id, id);
    const idemKey = scopedKey(actor.id, "PURSER_ASSIGN", id, body.operationId || "");
    const idemHash = requestHash({ assignments: body.assignments, version: body.version });
    const prior = assertReplay(await prisma.idempotencyKey.findUnique({ where: { key: idemKey } }), idemHash);
    if (prior) return prior;
    if (!Number.isInteger(body.version) || body.version !== flight.version)
      throw new ConflictException({ code: "VERSION_CONFLICT", message: "Flight assignment changed on the server" });
    if (flight.report && !canSubmitReport(flight.report.status))
      throw new ConflictException("Crew is locked after report submission");
    const submittedReport = await prisma.flightReport.findUnique({
      where: { flightId: id },
      select: { submittedAt: true },
    });
    if (submittedReport?.submittedAt)
      throw new ConflictException("Purser assignment is locked after first submission");
    const assignments = body.assignments || [];
    const userIds = assignments.map((item) => item.userId);
    if (new Set(userIds).size !== userIds.length)
      throw new BadRequestException("Each attendant may be assigned once");
    if (assignments.length !== 1 || assignments[0].duty !== "PURSER")
      throw new BadRequestException("Assign exactly one Flight Purser");
    const attendants = await prisma.user.findMany({
      where: { id: { in: userIds }, role: Role.ATTENDANT, active: true },
      select: { id: true },
    });
    if (attendants.length !== userIds.length)
      throw new BadRequestException("One or more attendants are unavailable");
    const target = scheduleBounds(flight.sectors);
    if (target && userIds.length) {
      const existing = await prisma.crewAssignment.findMany({
        where: {
          userId: { in: userIds },
          duty: "PURSER",
          flightId: { not: id },
          flight: { status: { in: ["SCHEDULED", "BOARDING", "ACTIVE"] } },
        },
        include: { flight: { include: { sectors: true } }, user: true },
      });
      const conflict = existing.find((assignment) => {
        const other = scheduleBounds(assignment.flight.sectors);
        return other ? schedulesOverlap(target, other) : false;
      });
      if (conflict)
        throw new ConflictException(
          `${conflict.user.name} is already assigned to an overlapping flight`,
        );
    }
    const result = await prisma.$transaction(async (tx) => {
      await lockFlight(tx, id);
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userIds[0]} FOR UPDATE`;
      const currentFlight = await tx.flight.findUnique({ where: { id }, select: { leadId: true, status: true, version: true } });
      if (!currentFlight || currentFlight.leadId !== actor.id) throw new ForbiddenException("This flight is not assigned to Cabin Services");
      if (currentFlight.status === FlightStatus.CANCELLED || currentFlight.version !== body.version) throw new ConflictException("Flight assignment changed or is cancelled");
      const txReport = await tx.flightReport.findUnique({ where: { flightId: id }, select: { submittedAt: true } });
      if (txReport?.submittedAt)
        throw new ConflictException("Purser assignment is locked after first submission");
      const available = await tx.user.findFirst({ where: { id: userIds[0], role: Role.ATTENDANT, active: true } });
      if (!available) throw new ConflictException("Flight Purser is no longer available");
      const otherAssignments = await tx.crewAssignment.findMany({ where: { userId: userIds[0], duty: "PURSER", flightId: { not: id }, flight: { status: { in: ["SCHEDULED", "BOARDING", "ACTIVE"] } } }, include: { flight: { include: { sectors: true } } } });
      if (target && otherAssignments.some((entry) => { const bounds = scheduleBounds(entry.flight.sectors); return bounds ? schedulesOverlap(target, bounds) : false; }))
        throw new ConflictException("This Flight Purser already has an overlapping flight");
      await tx.crewAssignment.updateMany({
        where: { flightId: id, duty: "PURSER" },
        data: { duty: "FORMER_PURSER" },
      });
      for (const assignment of assignments)
        await tx.crewAssignment.upsert({
          where: { flightId_userId: { flightId: id, userId: assignment.userId } },
          update: { duty: assignment.duty },
          create: { flightId: id, userId: assignment.userId, duty: assignment.duty },
        });
      const updated = await tx.flight.updateMany({
        where: { id, version: body.version },
        data: { version: { increment: 1 } },
      });
      if (updated.count !== 1) throw new ConflictException("Flight assignment changed on the server");
      const response = { flightId: id, assignments, version: body.version + 1 };
      await tx.idempotencyKey.create({ data: { key: idemKey, requestHash: idemHash, response, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
      return response;
    });
    await audit(actor.id, "FLIGHT_CREW_ASSIGNED", "Flight", id, {
      assignments,
      operationId: body.operationId,
    });
    return result;
  }
  async cateringOptions(
    @Param("id") id: string,
    @Req() req: AuthedRequest,
  ) {
    const actor = await authenticate(req, [Role.LEAD]);
    const flight = await requireLeadFlight(actor.id, id);
    const serviceDate = flight.serviceDate;
    return prisma.cateringList.findMany({
      where: {
        flightNumber: flight.flightNumber,
        serviceDate,
        status: "READY",
      },
      include: {
        _count: { select: { lines: true } },
        createdBy: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
  }
  async attachCateringList(
    @Param("id") id: string,
    @Param("listId") listId: string,
    @Body() body: { operationId?: string },
    @Req() req: AuthedRequest,
  ) {
    const actor = await authorizeMutation(req, [Role.LEAD]);
    return attachCateringToFlight(actor, id, listId, body.operationId || "", true);
  }
  async assignCateringList(
    @Param("listId") listId: string,
    @Body() body: { flightId?: string; operationId?: string },
    @Req() req: AuthedRequest,
  ) {
    const actor = await authorizeMutation(req, [Role.PROCUREMENT]);
    if (!body.flightId) throw new BadRequestException("Flight is required");
    return attachCateringToFlight(actor, body.flightId, listId, body.operationId || "", false);
  }
  @Get("v1/imports") async imports(@Req() req: AuthedRequest) {
    const actor = await authenticate(req, [Role.PROCUREMENT]);
    return prisma.importBatch.findMany({
      where: { actorId: actor.id, type: ImportType.CATERING },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        type: true,
        status: true,
        fileName: true,
        rowCount: true,
        errorCount: true,
        result: true,
        createdAt: true,
        committedAt: true,
        actor: { select: { name: true } },
      },
    });
  }
  @Get("v1/imports/:id/errors.csv") async importErrorsCsv(
    @Param("id") id: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = await authenticate(req, [Role.PROCUREMENT]);
    const batch = await prisma.importBatch.findFirst({
      where: { id, actorId: actor.id },
      select: { fileName: true, rows: true },
    });
    if (!batch) throw new NotFoundException("Import batch not found");
    const rows = Array.isArray(batch.rows) ? batch.rows as Array<{ row: number; data: Record<string, unknown>; errors: string[] }> : [];
    const output = ["row,errors,data", ...rows.filter((row) => row.errors.length).map((row) => [
      row.row,
      row.errors.join("; "),
      JSON.stringify(row.data),
    ].map(csvCell).join(","))].join("\n") + "\n";
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename="${batch.fileName.replace(/[^A-Za-z0-9_.-]+/g, "-")}-errors.csv"`);
    return output;
  }
  @Post("v1/imports/preview") async previewCateringImport(
    @Body() body: { type?: ImportType; fileName?: string; csv?: string },
    @Req() req: AuthedRequest,
  ) {
    await authorizeMutation(req, [Role.PROCUREMENT]);
    if (body.type !== ImportType.CATERING) throw new BadRequestException("Only catering imports are supported");
    return this.previewImport(body, req);
  }
  async previewImport(
    @Body() body: { type?: ImportType; fileName?: string; csv?: string },
    @Req() req: AuthedRequest,
  ) {
    const actor = await authorizeMutation(req, [Role.PROCUREMENT]);
    if (!body.type || !Object.values(ImportType).includes(body.type))
      throw new BadRequestException("Import type is required");
    if (body.type !== ImportType.FLIGHTS && body.type !== ImportType.CATERING)
      throw new ForbiddenException("Procurement may import flights and catering only");
    if (!body.csv?.trim()) throw new BadRequestException("CSV file is empty");
    const rows = await validateImport(body.type, body.csv);
    const errorCount = rows.filter((row) => row.errors.length).length;
    const checksum = createHash("sha256").update(body.csv).digest("hex");
    const existing = await prisma.importBatch.findFirst({
      where: {
        actorId: actor.id,
        type: body.type,
        checksum,
        status: ImportStatus.PREVIEWED,
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        type: true,
        status: true,
        fileName: true,
        rows: true,
        rowCount: true,
        errorCount: true,
        createdAt: true,
      },
    });
    if (existing) {
      return prisma.importBatch.update({
        where: { id: existing.id },
        data: {
          rows: publicImportRows(rows) as unknown as Prisma.InputJsonValue,
          rowCount: rows.length,
          errorCount,
        },
        select: {
          id: true,
          type: true,
          status: true,
          fileName: true,
          rows: true,
          rowCount: true,
          errorCount: true,
          createdAt: true,
        },
      });
    }
    const batch = await prisma.importBatch.create({
      data: {
        type: body.type,
        fileName: (body.fileName || `${body.type.toLowerCase()}.csv`).slice(0, 180),
        checksum,
        sourceText: body.csv,
        rows: publicImportRows(rows) as unknown as Prisma.InputJsonValue,
        rowCount: rows.length,
        errorCount,
        actorId: actor.id,
      },
      select: {
        id: true,
        type: true,
        status: true,
        fileName: true,
        rows: true,
        rowCount: true,
        errorCount: true,
        createdAt: true,
      },
    });
    await audit(actor.id, "IMPORT_PREVIEWED", "ImportBatch", batch.id, {
      type: batch.type,
      rows: batch.rowCount,
      errors: batch.errorCount,
    });
    return batch;
  }
  @Post("v1/imports/:id/commit") async commitCateringImport(@Param("id") id: string, @Req() req: AuthedRequest) {
    const actor = await authorizeMutation(req, [Role.PROCUREMENT]);
    const batch = await prisma.importBatch.findUnique({ where: { id }, select: { type: true, actorId: true } });
    if (!batch || batch.actorId !== actor.id) throw new NotFoundException("Import preview not found");
    if (batch.type !== ImportType.CATERING) throw new BadRequestException("Only catering imports are supported");
    return this.commitImport(id, req);
  }
  async commitImport(
    @Param("id") id: string,
    @Req() req: AuthedRequest,
  ) {
    const actor = await authorizeMutation(req, [Role.PROCUREMENT]);
    const batch = await prisma.importBatch.findUnique({ where: { id } });
    if (!batch) throw new NotFoundException("Import preview not found");
    if (batch.type !== ImportType.FLIGHTS && batch.type !== ImportType.CATERING)
      throw new ForbiddenException("Import type is not owned by Procurement");
    if (batch.actorId !== actor.id)
      throw new ForbiddenException("Import batch belongs to another user");
    if (batch.status === ImportStatus.COMMITTED) return batch.result;
    if (batch.status !== ImportStatus.PREVIEWED)
      throw new ConflictException("Import is no longer available to commit");
    let rows = await validateImport(batch.type, batch.sourceText);
    const invalid = rows.filter((row) => row.errors.length);
    if (invalid.length)
      throw new ConflictException({
        code: "IMPORT_REVALIDATION_FAILED",
        message: "Source data changed or contains validation errors",
        fieldErrors: Object.fromEntries(
          invalid.map((row) => [`row_${row.row}`, row.errors]),
        ),
      });

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ImportBatch" WHERE "id" = ${id} FOR UPDATE`;
      const currentBatch = await tx.importBatch.findUniqueOrThrow({ where: { id } });
      if (currentBatch.status === ImportStatus.COMMITTED) return currentBatch.result;
      if (batch.type === ImportType.CATERING) {
        const keys = [...new Map(
          rows
            .map((row) => {
              const serviceDate = dateWindow(row.data.flight_date || "");
              const flightNumber = normalizeFlightNumber(row.data.flight_number || "");
              return serviceDate && flightNumber
                ? [`${flightNumber}|${row.data.flight_date}`, { flightNumber, serviceDate: serviceDate.start }]
                : null;
            })
            .filter((entry): entry is [string, { flightNumber: string; serviceDate: Date }] => Boolean(entry)),
        ).values()];
        if (keys.length) {
          const lists = await tx.cateringList.findMany({
            where: { OR: keys.map(({ flightNumber, serviceDate }) => ({ flightNumber, serviceDate })) },
            select: { id: true },
          });
          for (const runId of lists.map((list) => list.id).sort()) await lockRun(tx, runId);
        }
      }
      for (const flightId of [...new Set(rows.map((row) => row.data.__flight_id).filter(Boolean))].sort()) await lockFlight(tx, flightId);
      const validatedRows = await validateImport(batch.type, batch.sourceText, tx);
      const failures = validatedRows.filter((row) => row.errors.length);
      if (failures.length) throw new ConflictException({ code: "IMPORT_REVALIDATION_FAILED", message: "Import dependencies changed; preview the file again", fieldErrors: Object.fromEntries(failures.map((row) => [`row_${row.row}`, row.errors])) });
      rows = validatedRows;
      const claimed = await tx.importBatch.updateMany({
        where: { id, status: ImportStatus.PREVIEWED },
        data: { status: ImportStatus.COMMITTED },
      });
      if (claimed.count !== 1)
        throw new ConflictException("Import is already being committed");
      const finish = async (value: Record<string, unknown>) => {
        await tx.importBatch.update({
          where: { id },
          data: {
            status: ImportStatus.COMMITTED,
            result: value as Prisma.InputJsonValue,
            rows: publicImportRows(rows) as unknown as Prisma.InputJsonValue,
            errorCount: 0,
            committedAt: new Date(),
          },
        });
        return value;
      };
      if (batch.type === ImportType.FLIGHTS) {
        const groups = new Map<string, CsvRow[]>();
        for (const row of rows) {
          const key = `${row.data.flight_number}|${row.data.flight_date}`;
          groups.set(key, [...(groups.get(key) || []), row]);
        }
        const ids: string[] = [];
        for (const group of groups.values()) {
          const ordered = [...group].sort(
            (left, right) =>
              Number(left.data.sector_sequence) - Number(right.data.sector_sequence),
          );
          const first = ordered[0].data;
          const flight = await tx.flight.create({
            data: {
              flightNumber: first.flight_number,
              flightDate: new Date(first.departure_iso),
              serviceDate: new Date(`${first.flight_date}T00:00:00.000Z`),
              aircraft: first.aircraft,
              status: "SCHEDULED",
              sectors: {
                create: ordered.map(({ data }) => ({
                  sequence: Number(data.sector_sequence),
                  origin: data.origin,
                  destination: data.destination,
                  scheduledDeparture: new Date(data.departure_iso),
                  scheduledArrival: new Date(data.arrival_iso),
                  economyPax: Number(data.economy_pax),
                  businessPax: Number(data.business_pax),
                })),
              },
            },
          });
          ids.push(flight.id);
        }
        return finish({ createdFlights: ids.length, ids });
      }
      if (batch.type === ImportType.CATERING) {
        const groups = new Map<string, CsvRow[]>();
        for (const row of rows) {
          const key = `${row.data.flight_number}|${row.data.flight_date}`;
          groups.set(key, [...(groups.get(key) || []), row]);
        }
        const ids: string[] = [];
        for (const group of groups.values()) {
          const first = group[0].data;
          const serviceDate = new Date(`${first.flight_date}T00:00:00.000Z`);
          const name = `${first.flight_number} · ${first.flight_date}`;
          const list = await tx.cateringList.upsert({
            where: {
              flightNumber_serviceDate: {
                flightNumber: first.flight_number,
                serviceDate,
              },
            },
            update: {
              name,
              status: "READY",
              createdById: actor.id,
              version: { increment: 1 },
            },
            create: {
              name,
              flightNumber: first.flight_number,
              serviceDate,
              createdById: actor.id,
            },
          });
          await tx.cateringListLine.deleteMany({
            where: { cateringListId: list.id },
          });
          await tx.cateringListLine.createMany({
            data: group.map(({ data }) => ({
              cateringListId: list.id,
              sectorSequence: Number(data.sector_sequence),
              cabin: data.cabin as Cabin,
              itemId: data.__item_id,
              suggested: Number(data.suggested),
              planned: Number(data.planned),
              approved: Number(data.approved),
              loaded: Number(data.loaded),
              overrideReason: data.override_reason.trim() || null,
            })),
          });
          ids.push(list.id);
        }
        return finish({
          importedLines: rows.length,
          cateringLists: ids.length,
          ids,
        });
      }
      throw new BadRequestException("Unsupported import type");
    });
    await audit(actor.id, "IMPORT_COMMITTED", "ImportBatch", id, {
      type: batch.type,
      result,
    });
    return result;
  }
  @Post("v1/imports/:id/cancel") async cancelImport(
    @Param("id") id: string,
    @Req() req: AuthedRequest,
  ) {
    const actor = await authorizeMutation(req, [Role.PROCUREMENT]);
    const batch = await prisma.importBatch.findUnique({ where: { id } });
    if (!batch) throw new NotFoundException("Import preview not found");
    if (batch.actorId !== actor.id)
      throw new ForbiddenException("Import batch belongs to another user");
    if (batch.status !== ImportStatus.PREVIEWED)
      throw new ConflictException("Only previewed imports may be cancelled");
    const cancelled = await prisma.importBatch.updateMany({
      where: { id, status: ImportStatus.PREVIEWED },
      data: { status: ImportStatus.CANCELLED },
    });
    if (cancelled.count !== 1)
      throw new ConflictException("Import is no longer available to cancel");
    await audit(actor.id, "IMPORT_CANCELLED", "ImportBatch", id);
    return { id, status: ImportStatus.CANCELLED };
  }
  async deprecatedFlightPreview() {
    throw new BadRequestException("Use POST /v1/imports/preview");
  }
  async deprecatedFlightCommit() {
    throw new BadRequestException("Use a server-issued import batch");
  }
  async manifest(
    @Param("id") id: string,
    @Req() req: AuthedRequest,
  ) {
    const user = await authenticate(req, [Role.ATTENDANT, Role.LEAD, Role.PROCUREMENT, Role.ADMIN]);
    if (user.role === Role.LEAD) await requireLeadFlight(user.id, id);
    let crewDuty: string | null = null;
    if (user.role === Role.ATTENDANT) {
      const assigned = await prisma.crewAssignment.findUnique({
        where: { flightId_userId: { flightId: id, userId: user.id } },
        select: { duty: true },
      });
      if (!assigned || assigned.duty !== "PURSER") throw new ForbiddenException("Flight not assigned to this Flight Purser");
      crewDuty = assigned.duty;
    }
    const flight = await prisma.flight.findUnique({
      where: { id },
      include: {
        sectors: true,
        manifests: {
          include: {
            sector: true,
            lines: {
              include: {
                item: {
                  select: {
                    id: true,
                    sku: true,
                    nameEn: true,
                    nameFr: true,
                    category: true,
                    unit: true,
                  },
                },
              },
            },
          },
        },
        report: { include: { lines: true } },
      },
    });
    if (!flight) throw new NotFoundException("Flight not found");
    return {
      ...flight,
      crewDuty,
    };
  }
  async leadLoadPlan(
    @Param("id") id: string,
    @Req() req: AuthedRequest,
  ) {
    const actor = await authenticate(req, [Role.LEAD]);
    const flight = await prisma.flight.findFirst({
      where: { id, leadId: actor.id },
      include: {
        sectors: { orderBy: { sequence: "asc" } },
        manifests: {
          include: {
            sector: true,
            lines: {
              include: {
                item: {
                  select: {
                    id: true,
                    sku: true,
                    nameEn: true,
                    nameFr: true,
                    category: true,
                    unit: true,
                  },
                },
              },
              orderBy: { item: { nameEn: "asc" } },
            },
          },
          orderBy: [{ sector: { sequence: "asc" } }, { cabin: "asc" }],
        },
        report: { select: { status: true } },
      },
    });
    if (!flight) throw new NotFoundException("Flight not found");
    const [forecasts] = await Promise.all([
      prisma.forecast.findMany({
        where: { flightId: id },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    return { flight, forecasts, crewSubmissionCount: flight.reportingStartedAt ? 1 : 0 };
  }
  async leadCrewStatus(
    @Param("id") id: string,
    @Req() req: AuthedRequest,
  ) {
    const actor = await authenticate(req, [Role.LEAD]);
    const flight = await requireLeadFlight(actor.id, id);
    const [assignments, report] = await Promise.all([
      prisma.crewAssignment.findMany({
        where: { flightId: id, duty: "PURSER" },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: [{ duty: "desc" }, { user: { name: "asc" } }],
      }),
      prisma.flightReport.findUnique({
        where: { flightId: id },
        select: { status: true, purserId: true, submittedAt: true, notes: true },
      }),
    ]);
    const crew = assignments.map((assignment) => {
      const submitted = report?.purserId === assignment.userId && report.status !== ReportStatus.DRAFT;
      return {
        assignmentId: assignment.id,
        user: assignment.user,
        duty: assignment.duty,
        status: submitted ? "SUBMITTED" : "PENDING",
        submittedAt: submitted ? report?.submittedAt || null : null,
        notes: submitted ? report?.notes || null : null,
      };
    });
    return {
      flight: {
        id: flight.id,
        flightNumber: flight.flightNumber,
        flightDate: flight.flightDate,
        reportStatus: flight.report?.status || null,
      },
      assigned: crew.length,
      submitted: crew.filter((item) => item.status === "SUBMITTED").length,
      allReported: crew.length > 0 && crew.every((item) => item.status === "SUBMITTED"),
      crew,
    };
  }
  async remindCrewMember(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Body() body: { operationId?: string },
    @Req() req: AuthedRequest,
  ) {
    const actor = await authorizeMutation(req, [Role.LEAD]);
    const flight = await requireLeadFlight(actor.id, id);
    const assignment = await prisma.crewAssignment.findUnique({
      where: { flightId_userId: { flightId: id, userId } },
      include: { user: { select: { name: true } } },
    });
    if (!assignment) throw new NotFoundException("Crew assignment not found");
    const report = await prisma.flightReport.findUnique({
      where: { flightId: id },
      select: { purserId: true, status: true },
    });
    if (report?.purserId === userId && report.status !== ReportStatus.DRAFT)
      throw new ConflictException("This Flight Purser has already reported");
    await prisma.notification.create({
      data: {
        userId,
        title: `${flight.flightNumber}: report reminder`,
        body: `${actor.name} requested your crew report for this flight.`,
        kind: "CREW_REMINDER",
        flightId: id,
        actionPath: "my-flight",
      },
    });
    await audit(actor.id, "CREW_REPORT_REMINDER_SENT", "Flight", id, {
      userId,
      operationId: body.operationId,
    });
    return { sent: true, attendant: assignment.user.name };
  }
  async saveLeadLoad(
    @Param("id") id: string,
    @Body()
    body: {
      operationId: string;
      version: number;
      lines: Array<{
        id: string;
        approved: number;
        loaded: number;
        overrideReason?: string;
      }>;
    },
    @Req() req: AuthedRequest,
  ) {
    const actor = await authorizeMutation(req, [Role.LEAD]);
    if (!body.operationId) throw new BadRequestException("Operation ID is required");
    const idemKey = scopedKey(actor.id, "LOAD_SAVE", id, body.operationId);
    const idemHash = requestHash({ version: body.version, lines: body.lines });
    const duplicate = await prisma.idempotencyKey.findUnique({
      where: { key: idemKey },
    });
    const replay = assertReplay(duplicate, idemHash);
    if (replay) return replay;
    const manifest = await prisma.manifest.findUnique({
      where: { id },
      include: {
        lines: true,
        flight: { include: { report: { select: { status: true } } } },
      },
    });
    if (!manifest) throw new NotFoundException("Manifest not found");
    if (manifest.flight.leadId !== actor.id)
      throw new ForbiddenException("This flight is not assigned to the Lead");
    const reportingStarted = await prisma.flight.findUnique({
      where: { id: manifest.flightId },
      select: { reportingStartedAt: true },
    });
    if (reportingStarted?.reportingStartedAt)
      throw new ConflictException(
        "The catering load is locked because crew reporting has started",
      );
    if (manifest.version !== body.version)
      throw new ConflictException({
        code: "VERSION_CONFLICT",
        message: "Load plan changed on the server",
        conflict: { serverVersion: manifest.version, clientVersion: body.version },
      });
    if (manifest.flight.report && !canSubmitReport(manifest.flight.report.status))
      throw new ConflictException("Flight report is already locked");
    for (const line of body.lines) {
      const source = manifest.lines.find((item) => item.id === line.id);
      if (!source) throw new BadRequestException("Unknown manifest line");
      if (
        !Number.isInteger(line.approved) ||
        !Number.isInteger(line.loaded) ||
        line.approved < 0 ||
        line.loaded < 0 ||
        line.loaded > line.approved
      )
        throw new BadRequestException("Invalid approved or loaded quantity");
      if (line.approved !== source.suggested && !line.overrideReason?.trim())
        throw new BadRequestException(
          "An override reason is required when approved differs from suggested",
        );
    }
    const response = await prisma.$transaction(async (tx) => {
      await lockFlight(tx, manifest.flightId);
      const txManifest = await tx.manifest.findUnique({ where: { id }, select: { version: true, flightId: true } });
      const txFlight = txManifest ? await tx.flight.findUnique({ where: { id: txManifest.flightId }, select: { leadId: true, status: true, reportingStartedAt: true, report: { select: { status: true } } } }) : null;
      if (!txManifest || !txFlight || txFlight.leadId !== actor.id)
        throw new ForbiddenException("This flight is not assigned to the Lead");
      if (txFlight.status === FlightStatus.CANCELLED || txFlight.reportingStartedAt || (txFlight.report && !canSubmitReport(txFlight.report.status)))
        throw new ConflictException("Catering load is locked");
      const claimed = await tx.manifest.updateMany({
        where: { id, version: body.version },
        data: { version: { increment: 1 } },
      });
      if (claimed.count !== 1)
        throw new ConflictException("Load plan changed on the server");
      for (const line of body.lines)
        await tx.manifestLine.update({
          where: { id: line.id },
          data: {
            approved: line.approved,
            loaded: line.loaded,
            overrideReason: line.overrideReason?.trim() || null,
          },
        });
      const updated = await tx.manifest.findUniqueOrThrow({ where: { id } });
      const result = { id, version: updated.version, savedLines: body.lines.length };
      await tx.idempotencyKey.create({
        data: {
          key: idemKey,
          requestHash: idemHash,
          response: result,
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
        },
      });
      return result;
    });
    await audit(actor.id, "LOAD_PLAN_UPDATED", "Manifest", id, {
      lines: body.lines.length,
    });
    return response;
  }
  async saveDraft(
    @Param("id") id: string,
    @Body()
    body: {
      operationId: string;
      version: number;
      lines: Array<{
        id: string;
        consumed: number;
        returned: number;
        spoiled: number;
        discarded: number;
        remarks?: string;
      }>;
    },
    @Req() req: AuthedRequest,
  ) {
    const user = await authorizeMutation(req, [Role.ATTENDANT]);
    const syncId = scopedKey(user.id, "DRAFT_SAVE", id, body.operationId);
    const duplicate = await prisma.syncOperation.findUnique({
      where: { id: syncId },
    });
    if (duplicate) {
      if (requestHash(duplicate.payload) !== requestHash(body))
        throw new ConflictException("Retry payload does not match the original request");
      return { applied: true, duplicate: true, version: duplicate.manifestVersion };
    }
    const manifest = await prisma.manifest.findUnique({
      where: { id },
      include: { lines: true, flight: { select: { status: true } } },
    });
    if (!manifest) throw new NotFoundException("Manifest not found");
    const assigned = await prisma.crewAssignment.findUnique({
      where: { flightId_userId: { flightId: manifest.flightId, userId: user.id } },
      select: { duty: true },
    });
    if (!assigned) throw new ForbiddenException("Flight not assigned");
    if (assigned.duty !== "PURSER")
      throw new ForbiddenException("Only the assigned Flight Purser may edit leftovers");
    const report = await prisma.flightReport.findUnique({
      where: { flightId: manifest.flightId },
      select: { status: true },
    });
    if (manifest.flight.status === FlightStatus.CANCELLED)
      throw new ConflictException("Cancelled flights are read-only");
    if (!canSubmitReport(report?.status || null))
      throw new ConflictException("This report is read-only");
    if (manifest.version !== body.version)
      throw new ConflictException({
        code: "VERSION_CONFLICT",
        message: "Manifest changed on the server",
        conflict: {
          serverVersion: manifest.version,
          clientVersion: body.version,
          serverLines: manifest.lines,
        },
      });
    for (const line of body.lines) {
      const original = manifest.lines.find((x) => x.id === line.id);
      if (!original) throw new BadRequestException("Unknown manifest line");
      const total =
        line.consumed + line.returned + line.spoiled + line.discarded;
      if (
        [line.consumed, line.returned, line.spoiled, line.discarded].some(
          (x) => !Number.isSafeInteger(x) || x < 0,
        ) ||
        total > original.loaded
      )
        throw new BadRequestException("Invalid reconciliation quantities");
    }
    const next = await prisma.$transaction(async (tx) => {
      await lockFlight(tx, manifest.flightId);
      const txManifest = await tx.manifest.findUnique({ where: { id }, select: { flightId: true, version: true } });
      const txAssignment = txManifest ? await tx.crewAssignment.findUnique({ where: { flightId_userId: { flightId: txManifest.flightId, userId: user.id } }, select: { duty: true } }) : null;
      const txFlight = txManifest ? await tx.flight.findUnique({ where: { id: txManifest.flightId }, select: { status: true, report: { select: { status: true } } } }) : null;
      if (!txManifest || !txAssignment || txAssignment.duty !== "PURSER")
        throw new ForbiddenException("Only the assigned Flight Purser may edit leftovers");
      if (!txFlight || txFlight.status === FlightStatus.CANCELLED || !canSubmitReport(txFlight.report?.status || null))
        throw new ConflictException("This report is read-only");
      const claimed = await tx.manifest.updateMany({
        where: { id, version: body.version },
        data: { version: { increment: 1 } },
      });
      if (claimed.count !== 1)
        throw new ConflictException("Manifest changed on the server");
      for (const line of body.lines)
        await tx.manifestLine.update({
          where: { id: line.id },
          data: {
            consumed: line.consumed,
            returned: line.returned,
            spoiled: line.spoiled,
            discarded: line.discarded,
            remarks: line.remarks?.trim() || null,
          },
        });
      const updated = await tx.manifest.findUniqueOrThrow({ where: { id } });
      await tx.flight.updateMany({
        where: { id: manifest.flightId, reportingStartedAt: null },
        data: { reportingStartedAt: new Date() },
      });
      await tx.syncOperation.create({
        data: {
          id: syncId,
          userId: user.id,
          flightId: manifest.flightId,
          manifestVersion: updated.version,
          payload: body as object,
        },
      });
      return updated;
    });
    return { applied: true, version: next.version };
  }
  async submitCrewCompletion(
    @Param("id") flightId: string,
    @Body() body: { operationId: string; notes?: string },
    @Req() req: AuthedRequest,
  ) {
    await authorizeMutation(req, [Role.ATTENDANT]);
    throw new ForbiddenException("Crew completion reports are retired; submit the consolidated leftovers report");
  }
  async submitReport(
    @Param("id") flightId: string,
    @Body()
    body: {
      operationId: string;
      manifestVersions: Record<string, number>;
      confirmed: boolean;
      notes?: string;
    },
    @Req() req: AuthedRequest,
  ) {
    const user = await authorizeMutation(req, [Role.ATTENDANT]);
    const assigned = await prisma.crewAssignment.findUnique({
      where: { flightId_userId: { flightId, userId: user.id } },
      include: {
        flight: { select: { flightNumber: true, status: true, leadId: true } },
      },
    });
    if (!assigned) throw new ForbiddenException("Flight not assigned");
    if (assigned.flight.status === FlightStatus.CANCELLED)
      throw new ConflictException("Cancelled flights are read-only");
    if (assigned.duty !== "PURSER")
      throw new ForbiddenException(
        "Only the assigned purser may submit the final catering reconciliation",
      );
    if (body.confirmed !== true)
      throw new BadRequestException("Purser confirmation is required before submission");
    if (!assigned.flight.leadId)
      throw new ConflictException("A Flight Lead must be assigned before submission");
    const idemKey = scopedKey(user.id, "REPORT_SUBMIT", flightId, body.operationId);
    const idemHash = requestHash({
      manifestVersions: body.manifestVersions,
      confirmed: body.confirmed,
      notes: body.notes || "",
    });
    const existingKey = await prisma.idempotencyKey.findUnique({
      where: { key: idemKey },
    });
    const replay = assertReplay(existingKey, idemHash);
    if (replay) return replay;
    const existingReport = await prisma.flightReport.findUnique({
      where: { flightId },
      select: { id: true, status: true },
    });
    if (!canSubmitReport(existingReport?.status || null))
      throw new ConflictException(
        "Only draft or returned reports may be submitted",
      );
    let manifests = await prisma.manifest.findMany({
      where: { flightId },
      include: { sector: true, lines: { include: { item: true } } },
    });
    if (!manifests.length) throw new NotFoundException("Manifest not found");
    if (
      manifests.some(
        (manifest) => body.manifestVersions?.[manifest.id] !== manifest.version,
      )
    )
      throw new ConflictException({
        code: "VERSION_CONFLICT",
        message: "Resolve draft conflicts before submission",
      });
    for (const line of manifests.flatMap((x) => x.lines)) {
      const unexplained =
        line.loaded -
        line.consumed -
        line.returned -
        line.spoiled -
        line.discarded;
      if (
        (line.spoiled > 0 || line.discarded > 0 || unexplained > 0) &&
        !line.remarks?.trim() &&
        !body.notes?.trim()
      )
        throw new BadRequestException(
          "Notes are required for spoilage, discarded stock or unexplained variance",
        );
    }
    const flightSnapshot = await prisma.flight.findUniqueOrThrow({
      where: { id: flightId },
      include: { sectors: { orderBy: { sequence: "asc" } } },
    });
    const result = await prisma.$transaction(async (tx) => {
      await lockFlight(tx, flightId);
      const txAssignment = await tx.crewAssignment.findUnique({ where: { flightId_userId: { flightId, userId: user.id } }, select: { duty: true } });
      const txFlight = await tx.flight.findUnique({ where: { id: flightId }, select: { status: true, leadId: true } });
      if (!txFlight || txFlight.status === FlightStatus.CANCELLED || !txFlight.leadId)
        throw new ConflictException("Flight is cancelled or has no assigned Cabin Services lead");
      const txFlightReport = await tx.flightReport.findUnique({ where: { flightId }, select: { id: true, status: true, version: true } });
      const txManifests = await tx.manifest.findMany({ where: { flightId }, include: { sector: true, lines: { include: { item: true } } } });
      if (!txAssignment || txAssignment.duty !== "PURSER") throw new ForbiddenException("Only the assigned Flight Purser may submit");
      if (!canSubmitReport(txFlightReport?.status || null)) throw new ConflictException("Only draft or returned reports may be submitted");
      if (txManifests.some((manifest) => body.manifestVersions?.[manifest.id] !== manifest.version))
        throw new ConflictException({ code: "VERSION_CONFLICT", message: "Resolve draft conflicts before submission" });
      if (!txManifests.length) throw new ConflictException("No catering manifest is available");
      manifests = txManifests;
      await tx.flight.updateMany({
        where: { id: flightId, reportingStartedAt: null },
        data: { reportingStartedAt: new Date() },
      });
      const report = await tx.flightReport.upsert({
        where: { flightId },
        create: {
          flightId,
          purserId: user.id,
          purserName: user.name,
          notes: body.notes,
          status: ReportStatus.SUBMITTED,
          submittedAt: new Date(),
          lines: {
            create: manifests.flatMap((x) =>
              x.lines.map((line) => ({
                manifestLineId: line.id,
                revision: 1,
                consumed: line.consumed,
                returned: line.returned,
                spoiled: line.spoiled,
                discarded: line.discarded,
                remarks: line.remarks,
                unexplained:
                  line.loaded -
                  line.consumed -
                  line.returned -
                  line.spoiled -
                  line.discarded,
              })),
            ),
          },
        },
        update: {
          purserId: user.id,
          purserName: user.name,
          notes: body.notes,
          status: ReportStatus.SUBMITTED,
          submittedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (existingReport) {
        await tx.reportLine.createMany({
          data: manifests.flatMap((manifest) =>
            manifest.lines.map((line) => ({
              reportId: report.id,
              manifestLineId: line.id,
              revision: report.version,
              consumed: line.consumed,
              returned: line.returned,
              spoiled: line.spoiled,
              discarded: line.discarded,
              remarks: line.remarks,
              unexplained:
                line.loaded -
                line.consumed -
                line.returned -
                line.spoiled -
                line.discarded,
            })),
          ),
        });
      }
      await tx.reportRevision.create({
        data: {
          reportId: report.id,
          revision: report.version,
          snapshot: {
            id: report.id,
            status: report.status,
            version: report.version,
            purser: { id: user.id, name: user.name, email: user.email },
            notes: body.notes || "",
            submittedAt: report.submittedAt?.toISOString() || null,
            approvedAt: report.approvedAt?.toISOString() || null,
            flight: {
              id: flightSnapshot.id,
              flightNumber: flightSnapshot.flightNumber,
              serviceDate: flightSnapshot.serviceDate.toISOString().slice(0, 10),
              aircraft: flightSnapshot.aircraft,
              status: flightSnapshot.status,
              sectors: flightSnapshot.sectors.map((sector) => ({
                sequence: sector.sequence,
                origin: sector.origin,
                destination: sector.destination,
                scheduledDeparture: sector.scheduledDeparture.toISOString(),
                scheduledArrival: sector.scheduledArrival.toISOString(),
                economyPax: sector.economyPax,
                businessPax: sector.businessPax,
              })),
            },
            lines: manifests.flatMap((manifest) => manifest.lines.map((line) => ({
              manifestLineId: line.id,
              sector: manifest.sector.sequence,
              origin: manifest.sector.origin,
              destination: manifest.sector.destination,
              cabin: manifest.cabin,
              sku: line.item.sku,
              item: line.item.nameEn,
              unit: line.item.unit,
              loaded: line.loaded,
              consumed: line.consumed,
              returned: line.returned,
              spoiled: line.spoiled,
              discarded: line.discarded,
              unexplained: line.loaded - line.consumed - line.returned - line.spoiled - line.discarded,
              remarks: line.remarks || "",
            }))),
            reviewHistory: [{
              decision: "SUBMITTED",
              actorName: user.name,
              reason: "",
              createdAt: report.submittedAt?.toISOString() || new Date().toISOString(),
            }],
          },
        },
      });
      const response = {
        id: report.id,
        status: report.status,
        version: report.version,
        submittedAt: report.submittedAt,
      };
      await tx.idempotencyKey.create({
        data: {
          key: idemKey,
          requestHash: idemHash,
          response,
          expiresAt: new Date(Date.now() + 7 * 86400000),
        },
      });
      await tx.notification.create({
        data: {
          userId: assigned.flight.leadId!,
          title: `${assigned.flight.flightNumber}: final report ready`,
          body: `${user.name} submitted the consolidated catering reconciliation.`,
          kind: "FINAL_REPORT",
          flightId,
          actionPath: "reports",
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: user.id,
          action: "REPORT_SUBMITTED",
          entityType: "Flight",
          entityId: flightId,
          metadata: { revision: report.version },
        },
      });
      return response;
    });
    return result;
  }
  async reportDetails(
    @Param("id") id: string,
    @Req() req: AuthedRequest,
    @Query("revision") revision?: string | number,
  ) {
    const actor = await authenticate(req);
    const parsedRevision = revision ? Number(revision) : undefined;
    if (parsedRevision !== undefined && (!Number.isInteger(parsedRevision) || parsedRevision < 1))
      throw new BadRequestException("revision must be a positive integer");
    if (actor.role === Role.ATTENDANT) {
      const assignment = await prisma.crewAssignment.findUnique({
        where: { flightId_userId: { flightId: id, userId: actor.id } },
        select: { duty: true },
      });
      if (!assignment || assignment.duty !== "PURSER")
        throw new ForbiddenException("Only the assigned Flight Purser may view this report");
    } else if (actor.role === Role.LEAD) {
      const flight = await prisma.flight.findUnique({ where: { id }, select: { leadId: true } });
      if (!flight || flight.leadId !== actor.id)
        throw new ForbiddenException("This flight is not assigned to the Cabin Services lead");
    } else if (!( [Role.PROCUREMENT, Role.ADMIN] as Role[]).includes(actor.role)) {
      throw new ForbiddenException("Insufficient permissions");
    }
    return loadReportData(id, parsedRevision);
  }
  async reportCsv(
    @Param("id") id: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const report = await this.reportDetails(id, req) as unknown as ReportSnapshot;
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    const reportDate = report.flight.serviceDate || "report";
    response.setHeader("Content-Disposition", `attachment; filename="${report.flight.flightNumber.replace(/[^A-Za-z0-9_-]+/g, "-")}-${reportDate}-leftovers.csv"`);
    return serializeReportCsv(report as unknown as ReportSnapshot);
  }
  async reportPdf(
    @Param("id") id: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const report = await this.reportDetails(id, req) as unknown as ReportSnapshot;
    response.setHeader("Content-Type", "application/pdf");
    const reportDate = report.flight.serviceDate || "report";
    response.setHeader("Content-Disposition", `attachment; filename="${report.flight.flightNumber.replace(/[^A-Za-z0-9_-]+/g, "-")}-${reportDate}-leftovers.pdf"`);
    return new StreamableFile(await renderReportPdf(report), { type: "application/pdf" });
  }
  async approvals(@Req() req: AuthedRequest) {
    const actor = await authenticate(req, [Role.LEAD]);
    const reports = await prisma.flightReport.findMany({
      where: {
        status: ReportStatus.SUBMITTED,
        flight: { leadId: actor.id },
      },
      include: {
        flight: { include: { sectors: true } },
        lines: true,
        purser: { select: { name: true } },
      },
      orderBy: { submittedAt: "asc" },
    });
    return reports.map((report) => ({
      ...report,
      lines: report.lines.filter((line) => line.revision === report.version),
    }));
  }
  async procurementReconciliations(
    @Req() req: AuthedRequest,
  ) {
    await authenticate(req, [Role.PROCUREMENT]);
    const reports = await prisma.flightReport.findMany({
      where: { status: ReportStatus.FORWARDED },
      select: {
        id: true,
        status: true,
        version: true,
        submittedAt: true,
        flight: {
          select: {
            id: true,
            flightNumber: true,
            flightDate: true,
            serviceDate: true,
            aircraft: true,
            status: true,
            sectors: true,
          },
        },
        lines: {
          select: {
            consumed: true,
            returned: true,
            spoiled: true,
            discarded: true,
            unexplained: true,
            revision: true,
          },
        },
      },
      orderBy: { submittedAt: "asc" },
    });
    return reports.map((report) => ({
      ...report,
      lines: report.lines.filter((line) => line.revision === report.version),
    }));
  }
  async decide(
    @Param("id") id: string,
    @Body()
    body: {
      decision: "FORWARDED" | "APPROVED" | "RETURNED" | "REJECTED";
      reason?: string;
      operationId: string;
      version: number;
    },
    @Req() req: AuthedRequest,
  ) {
    const actor = await authorizeMutation(req, [Role.LEAD, Role.PROCUREMENT]);
    const idemKey = scopedKey(actor.id, "REPORT_DECISION", id, body.operationId);
    const idemHash = requestHash({
      decision: body.decision,
      version: body.version,
      reason: body.reason || "",
    });
    if (!["APPROVED", "FORWARDED"].includes(body.decision) && !body.reason?.trim())
      throw new BadRequestException("Reason is required");
    const duplicate = await prisma.idempotencyKey.findUnique({
      where: { key: idemKey },
    });
    const replay = assertReplay(duplicate, idemHash);
    if (replay) return replay;
    const report = await prisma.flightReport.findUnique({
      where: { id },
      include: {
        lines: true,
        flight: {
          include: {
            manifests: {
              include: {
                lines: {
                  include: {
                    item: {
                      include: {
                        prices: { orderBy: { effectiveFrom: "desc" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const expectedStatus =
      actor.role === Role.LEAD
        ? ReportStatus.SUBMITTED
        : ReportStatus.FORWARDED;
    if (!report || report.status !== expectedStatus)
      throw new ConflictException("Report is no longer awaiting approval");
    if (!Number.isInteger(body.version) || body.version !== report.version)
      throw new ConflictException({ code: "VERSION_CONFLICT", message: "Report revision changed on the server" });
    if (!canDecideReport(actor.role, report.status, body.decision as ReportStatus))
      throw new ForbiddenException("Decision is not permitted for this role");
    if (actor.role === Role.LEAD && report.flight.leadId !== actor.id)
      throw new ForbiddenException("This flight is not assigned to the Lead");
    const latestLines = report.lines.filter(
      (line) => line.revision === report.version,
    );
    const manifestLines = report.flight.manifests.flatMap((item) => item.lines);
    const effectivePrices = new Map<string, bigint>();
    if (body.decision === "APPROVED") {
      for (const line of latestLines) {
        const source = manifestLines.find((item) => item.id === line.manifestLineId);
        if (!source)
          throw new ConflictException(
            "A reported catering line no longer exists; return the report for correction",
          );
        const price = effectivePriceAt(
          source.item.prices,
          report.flight.flightDate,
        );
        if (!price)
          throw new ConflictException(
            `No effective price exists for ${source.item.nameEn} on the flight date`,
          );
        effectivePrices.set(source.id, price.amountMinor);
      }
    }
    const result = await prisma.$transaction(async (tx) => {
      await lockFlight(tx, report.flightId);
      const status = body.decision as ReportStatus;
      const txReport = await tx.flightReport.findUnique({ where: { id }, select: { status: true, version: true, flight: { select: { leadId: true } } } });
      if (!txReport || txReport.status !== expectedStatus || txReport.version !== body.version)
        throw new ConflictException("Report is no longer awaiting approval");
      if (actor.role === Role.LEAD && txReport.flight.leadId !== actor.id)
        throw new ForbiddenException("This flight is not assigned to the Lead");
      const claimed = await tx.flightReport.updateMany({
        where: { id, status: expectedStatus, version: body.version },
        data: { status, approvedAt: status === ReportStatus.APPROVED ? new Date() : null },
      });
      if (claimed.count !== 1)
        throw new ConflictException("Report is no longer awaiting approval");
      const updated = await tx.flightReport.findUniqueOrThrow({ where: { id } });
      await tx.approval.create({
        data: {
          reportId: id,
          actorId: actor.id,
          actorName: actor.name,
          decision: status,
          revision: report.version,
          reason: body.reason,
        },
      });
      if (status === ReportStatus.APPROVED) {
        for (const line of latestLines) {
          const source = manifestLines.find(
            (x) => x.id === line.manifestLineId,
          );
          if (!source) throw new ConflictException("Reported catering line missing");
          const unitCost = effectivePrices.get(source.id)!;
          for (const [reason, qty] of [
            ["APPROVED_CONSUMPTION", line.consumed],
            ["RETURN", line.returned],
            ["SPOILAGE", line.spoiled],
            ["DISCARD", line.discarded],
            ["MISSING", line.unexplained],
          ] as const)
            if (qty > 0)
              await tx.stockMovement.create({
                data: {
                  itemId: source.itemId,
                  quantity: reason === "RETURN" ? qty : -qty,
                  reason,
                  flightId: report.flightId,
                  operationId: `${idemKey}:${source.id}:${reason}`,
                  unitCostMinor: unitCost,
                },
              });
        }
      }
      const response = {
        id,
        status: updated.status,
        ledgerPosted: status === ReportStatus.APPROVED,
      };
      await tx.idempotencyKey.create({
        data: {
          key: idemKey,
          requestHash: idemHash,
          response,
          expiresAt: new Date(Date.now() + 30 * 86400000),
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          action: "REPORT_" + body.decision,
          entityType: "FlightReport",
          entityId: id,
          metadata: { reason: body.reason, revision: report.version },
        },
      });
      return response;
    });
    return result;
  }
  @Get("v1/procurement/stock") async stock(@Req() req: AuthedRequest) {
    await authenticate(req, [Role.PROCUREMENT, Role.DIRECTOR]);
    const [items, runLines] = await Promise.all([
      prisma.catalogItem.findMany({
        include: {
          lots: true,
          movements: true,
          prices: { orderBy: { effectiveFrom: "desc" } },
        },
      }),
      prisma.cateringListLine.findMany({
        where: { cateringList: { status: { not: "CANCELLED" } } },
        select: { itemId: true, loaded: true, cateringList: { select: { report: { select: { status: true } } } } },
      }),
    ]);
    const reservedByItem = new Map<string, number>();
    for (const line of runLines) {
      const status = line.cateringList.report?.status;
      if (status !== ReportStatus.APPROVED && status !== ReportStatus.REJECTED)
        reservedByItem.set(line.itemId, (reservedByItem.get(line.itemId) || 0) + line.loaded);
    }
    return items.map((x) => {
      const onHand = onHandQuantity(
        x.lots.map((lot) => lot.quantity),
        x.movements,
      );
      const reserved = reservedByItem.get(x.id) || 0;
      const available = onHand - reserved;
      const currentPrice = effectivePriceAt(x.prices, new Date());
      return {
        id: x.id,
        sku: x.sku,
        name: x.nameEn,
        category: x.category,
        onHand,
        reserved,
        available,
        reorderPoint: x.reorderPoint,
        status: available <= x.reorderPoint ? "REORDER" : "HEALTHY",
        priceMinor: Number(currentPrice?.amountMinor || 0),
        currency: currentPrice?.currency || "RWF",
      };
    });
  }
  @Get("v1/procurement/waste") async procurementWaste(
    @Req() req: AuthedRequest,
  ) {
    await authenticate(req, [Role.PROCUREMENT]);
    const movements = await prisma.stockMovement.findMany({
      where: { reason: { in: ["SPOILAGE", "DISCARD", "MISSING"] } },
      include: { item: { select: { category: true } } },
      orderBy: { createdAt: "desc" },
    });
    const byReason = new Map<string, { quantity: number; amountMinor: number }>();
    const byCategory = new Map<string, number>();
    for (const movement of movements) {
      const amountMinor = Math.abs(movement.quantity) * Number(movement.unitCostMinor);
      const reason = byReason.get(movement.reason) || { quantity: 0, amountMinor: 0 };
      reason.quantity += Math.abs(movement.quantity);
      reason.amountMinor += amountMinor;
      byReason.set(movement.reason, reason);
      byCategory.set(
        movement.item.category,
        (byCategory.get(movement.item.category) || 0) + amountMinor,
      );
    }
    return {
      currency: "RWF",
      totalMinor: [...byReason.values()].reduce(
        (sum, item) => sum + item.amountMinor,
        0,
      ),
      byReason: [...byReason.entries()].map(([reason, value]) => ({ reason, ...value })),
      byCategory: [...byCategory.entries()]
        .map(([category, amountMinor]) => ({ category, amountMinor }))
        .sort((left, right) => right.amountMinor - left.amountMinor),
    };
  }
  @Get("v1/procurement/suppliers") async suppliers(@Req() req:AuthedRequest){await authenticate(req,[Role.PROCUREMENT]);const lots=await prisma.inventoryLot.findMany({where:{supplier:{not:null}},include:{item:{select:{nameEn:true}}}});const grouped=new Map<string,{name:string;lots:number;items:Set<string>}>();for(const lot of lots){const name=lot.supplier||"Unknown",entry=grouped.get(name)||{name,lots:0,items:new Set<string>()};entry.lots++;entry.items.add(lot.item.nameEn);grouped.set(name,entry)}return[...grouped.values()].map(x=>({name:x.name,lots:x.lots,items:[...x.items]}))}
  @Post("v1/procurement/items/:id/prices") async addPrice(@Param("id") id:string,@Body() body:{amountMinor:number;currency?:string;effectiveFrom:string},@Req() req:AuthedRequest){const actor=await authorizeMutation(req,[Role.PROCUREMENT]);if(!Number.isInteger(body.amountMinor)||body.amountMinor<0)throw new BadRequestException("Price must be a nonnegative integer");const price=await prisma.itemPrice.create({data:{itemId:id,amountMinor:BigInt(body.amountMinor),currency:body.currency||"RWF",effectiveFrom:new Date(body.effectiveFrom)}});await audit(actor.id,"ITEM_PRICE_CREATED","CatalogItem",id,{amountMinor:body.amountMinor,currency:body.currency||"RWF"});return{...price,amountMinor:Number(price.amountMinor)}}
  @Get("v1/dashboard/operations")
  @Header("Cache-Control", "private, no-store")
  async operationsDashboard(@Req() req: AuthedRequest) {
    await authenticate(req, [Role.DIRECTOR, Role.ADMIN]);
    const where: Prisma.CateringRunReportWhereInput = { status: { in: [ReportStatus.FORWARDED, ReportStatus.APPROVED] }, cateringList: { status: { not: "CANCELLED" } } };
    const [forwarded, approved, aggregates, reports] = await prisma.$transaction([
      prisma.cateringRunReport.count({ where: { ...where, status: ReportStatus.FORWARDED } }),
      prisma.cateringRunReport.count({ where: { ...where, status: ReportStatus.APPROVED } }),
      prisma.$queryRaw<Array<{ loaded: number; consumed: number; returned: number }>>`
        SELECT COALESCE(SUM(l."loaded"), 0)::double precision AS loaded,
               COALESCE(SUM(l."consumed"), 0)::double precision AS consumed,
               COALESCE(SUM(l."returned"), 0)::double precision AS returned
        FROM "CateringRunReportLine" l
        JOIN "CateringRunReport" r ON r."id" = l."reportId" AND r."version" = l."revision"
        JOIN "CateringList" c ON c."id" = r."cateringListId"
        WHERE r."status" IN ('FORWARDED', 'APPROVED') AND c."status" <> 'CANCELLED'`,
      prisma.cateringRunReport.findMany({
      where,
      include: { cateringList: { select: { flightNumber: true, serviceDate: true } }, lines: true },
      orderBy: { submittedAt: "desc" },
      take: 6,
    }),
    ]);
    const totals = aggregates[0];
    return {
      forwarded,
      approved,
      ...totals,
      consumptionRate: totals.loaded ? Number(((totals.consumed / totals.loaded) * 100).toFixed(1)) : 0,
      returnRate: totals.loaded ? Number(((totals.returned / totals.loaded) * 100).toFixed(1)) : 0,
      recent: reports.slice(0, 6).map((report) => ({
        id: report.id,
        flightNumber: report.cateringList.flightNumber,
        serviceDate: report.cateringList.serviceDate.toISOString().slice(0, 10),
        status: report.status,
        consumed: report.lines.filter((line) => line.revision === report.version).reduce((sum, line) => sum + line.consumed, 0),
        returned: report.lines.filter((line) => line.revision === report.version).reduce((sum, line) => sum + line.returned, 0),
      })),
    };
  }
  @Get("v1/dashboard/director")
  @Header("Cache-Control", "private, no-store")
  async dashboard(@Req() req: AuthedRequest) {
    await authenticate(req, [Role.DIRECTOR]);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [movements, runReportCount, runCount] = await Promise.all([
      prisma.stockMovement.findMany({
        include: { item: { select: { category: true } } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.cateringRunReport.count({ where: { status: ReportStatus.APPROVED, approvedAt: { gte: monthStart } } }),
      prisma.cateringList.count(),
    ]);
    const currentMovements = movements.filter((item) => item.createdAt >= monthStart);
    const spend = currentMovements
      .filter((x) => x.quantity < 0)
      .reduce((s, x) => s + Math.abs(x.quantity) * Number(x.unitCostMinor), 0);
    const waste = currentMovements
      .filter((x) => ["SPOILAGE", "DISCARD", "MISSING"].includes(x.reason))
      .reduce((s, x) => s + Math.abs(x.quantity) * Number(x.unitCostMinor), 0);
    const recoverablePct = Math.min(
      100,
      Math.max(0, Number(process.env.RECOVERABLE_WASTE_PCT || 25)),
    );
    const categories = new Map<string, number>();
    for (const movement of currentMovements.filter((item) => item.quantity < 0))
      categories.set(
        movement.item.category,
        (categories.get(movement.item.category) || 0) +
          Math.abs(movement.quantity) * Number(movement.unitCostMinor),
      );
    const months = new Map<string, number>();
    for (const movement of movements.filter((item) => item.quantity < 0)) {
      const month = movement.createdAt.toISOString().slice(0, 7);
      months.set(
        month,
        (months.get(month) || 0) +
          Math.abs(movement.quantity) * Number(movement.unitCostMinor),
      );
    }
    return {
      currency: "RWF",
      mtdSpendMinor: spend,
      wasteRate: spend ? Number(((waste / spend) * 100).toFixed(1)) : 0,
      costPerPaxMinor: null,
      annualizedSavingsMinor: Math.round(waste * 12 * (recoverablePct / 100)),
      recoverablePct,
      passengers: null,
      approvedReports: runReportCount,
      flights: runCount,
      categoryBreakdown: [...categories.entries()]
        .map(([category, amountMinor]) => ({ category, amountMinor }))
        .sort((left, right) => right.amountMinor - left.amountMinor),
      monthlyTrend: [...months.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(-12)
        .map(([month, amountMinor]) => ({ month, amountMinor })),
    };
  }
  @Get("v1/notifications") async notifications(@Req() req: AuthedRequest) {
    const user = await authenticate(req);
    return prisma.notification.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  }
  @Patch("v1/notifications/:id/read") async readNotification(
    @Param("id") id: string,
    @Req() req: AuthedRequest,
  ) {
    const user = await authorizeMutation(req);
    const updated = await prisma.notification.updateMany({
      where: { id, userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    if (!updated.count) {
      const exists = await prisma.notification.count({
        where: { id, userId: user.id },
      });
      if (!exists) throw new NotFoundException("Notification not found");
    }
    return { id, read: true };
  }
  @Patch("v1/notifications/read-all") async readAllNotifications(@Req() req: AuthedRequest) {
    const user = await authorizeMutation(req);
    const result = await prisma.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
    return { read: result.count };
  }
  @Get("v1/audit") async auditLog(@Req() req: AuthedRequest) {
    await authenticate(req, [Role.ADMIN]);
    return prisma.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }
  @Get("v1/admin/users") async adminUsers(@Req() req: AuthedRequest) {
    await authenticate(req, [Role.ADMIN]);
    return prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        passwordChangedAt: true,
      },
      orderBy: [{ active: "desc" }, { name: "asc" }],
    });
  }
}
@Module({ controllers: [AppController] })
export class AppModule {}

// Configures the Nest app without starting a listener, so it can run either
// as a long-lived Docker/local server (see main.ts) or as a Vercel Serverless
// Function invoked per-request (see /api/[...path].ts).
export async function createApp() {
  sameSiteCookie();
  if (process.env.NODE_ENV === "production") {
    const origins = (process.env.WEB_ORIGIN || "").split(",").map((origin) => origin.trim()).filter(Boolean);
    if (!origins.length) throw new Error("WEB_ORIGIN must be explicitly configured for a production build");
    const urls = origins.map((origin) => new URL(origin));
    const remote = urls.some((url) => !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    if (remote && (!secureCookie() || urls.some((url) => url.protocol !== "https:")))
      throw new Error("Production deployments require HTTPS WEB_ORIGIN values and COOKIE_SECURE=true");
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.useBodyParser("json", { limit: 3_000_000 });
  app.getHttpAdapter().getInstance().set("trust proxy", 1);
  app.useGlobalFilters(new ApiExceptionFilter());
  app.use(cookieParser());
  app.enableCors({
    origin: (process.env.WEB_ORIGIN || "http://localhost:3001")
      .split(",")
      .map((origin) => origin.trim()),
    credentials: true,
  });
  const config = new DocumentBuilder()
    .setTitle("WingsBalance API")
    .setVersion("1.0")
    .addCookieAuth("wb_session")
    .build();
  SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, config));
  await app.init();
  return app;
}
