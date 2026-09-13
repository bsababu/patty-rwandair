import "reflect-metadata";
import {
  BadRequestException,
  ArgumentsHost,
  Body,
  Catch,
  ConflictException,
  Controller,
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
  Put,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
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
  importHeaders,
  nonnegativeInteger,
  normalizeFlightNumber,
  type CsvRow,
} from "./imports";

const prisma = new PrismaClient();
const SESSION_SECONDS = 8 * 60 * 60;
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

const MAX_IMPORT_BYTES = 1_000_000;

async function validateImport(type: ImportType, sourceText: string) {
  if (type === ImportType.CREW)
    throw new BadRequestException("Crew CSV imports are not supported; assign crew from the Lead workspace");
  if (Buffer.byteLength(sourceText, "utf8") > MAX_IMPORT_BYTES)
    throw new BadRequestException("CSV exceeds the 1 MB pilot limit");

  let rows: CsvRow[];
  try {
    rows = csvRecords(sourceText, importHeaders[type]);
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
    Awaited<ReturnType<typeof prisma.catalogItem.findUnique>>
  >();
  async function cachedFlight(number: string, date: string) {
    const key = `${number}|${date}`;
    if (!flightCache.has(key)) flightCache.set(key, await findFlight(number, date));
    return flightCache.get(key) || null;
  }

  for (const row of rows) {
    const data = row.data;
    const flightNumber = normalizeFlightNumber(data.flight_number || "");
    const window = dateWindow(data.flight_date || "");
    if (!flightNumber) row.errors.push("Invalid RwandAir flight number");
    else data.flight_number = flightNumber;
    if (!window) row.errors.push("flight_date must use YYYY-MM-DD");

    if (type === ImportType.FLIGHTS) {
      const sequence = nonnegativeInteger(data.sector_sequence);
      const economyPax = nonnegativeInteger(data.economy_pax);
      const businessPax = nonnegativeInteger(data.business_pax);
      const departure = new Date(data.departure_iso);
      const arrival = new Date(data.arrival_iso);
      if (!data.aircraft.trim()) row.errors.push("Aircraft is required");
      if (!sequence || sequence < 1) row.errors.push("Invalid sector sequence");
      if (!/^[A-Z]{3}$/.test(data.origin.toUpperCase()))
        row.errors.push("Invalid origin airport code");
      if (!/^[A-Z]{3}$/.test(data.destination.toUpperCase()))
        row.errors.push("Invalid destination airport code");
      if (Number.isNaN(departure.valueOf()) || Number.isNaN(arrival.valueOf()))
        row.errors.push("Invalid departure or arrival timestamp");
      else if (arrival <= departure)
        row.errors.push("Arrival must be after departure");
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
      const sequence = nonnegativeInteger(data.sector_sequence);
      const cabin = data.cabin.toUpperCase();
      if (!sequence || sequence < 1) row.errors.push("Invalid sector sequence");
      if (![Cabin.ECONOMY, Cabin.BUSINESS].includes(cabin as Cabin))
        row.errors.push("Cabin must be ECONOMY or BUSINESS");
      data.cabin = cabin;
      data.item_sku = data.item_sku.toUpperCase();
      for (const field of ["suggested", "planned", "approved", "loaded"])
        if (nonnegativeInteger(data[field]) === null)
          row.errors.push(`${field} must be a nonnegative integer`);
      const suggested = nonnegativeInteger(data.suggested);
      const approved = nonnegativeInteger(data.approved);
      const loaded = nonnegativeInteger(data.loaded);
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
      if (flightNumber && window) {
        const flight = await cachedFlight(flightNumber, data.flight_date);
        if (!flight) row.errors.push("Unknown flight and date");
        else {
          const sector = flight.sectors.find((item) => item.sequence === sequence);
          if (!sector) row.errors.push("Unknown sector sequence");
          else data.__sector_id = sector.id;
          if (flight.report && !canSubmitReport(flight.report.status))
            row.errors.push("Flight report is already locked");
          data.__flight_id = flight.id;
        }
      }
      if (!itemCache.has(data.item_sku))
        itemCache.set(
          data.item_sku,
          await prisma.catalogItem.findUnique({ where: { sku: data.item_sku } }),
        );
      const item = itemCache.get(data.item_sku);
      if (!item?.active) row.errors.push("Unknown or inactive catering SKU");
      else data.__item_id = item.id;
      const duplicateKey = `${data.__sector_id}|${cabin}|${data.item_sku}`;
      if (seen.has(duplicateKey)) row.errors.push("Duplicate catering line in file");
      seen.add(duplicateKey);
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
      });
    }
  }
  return rows;
}

async function findFlight(flightNumber: string, date: string) {
  const window = dateWindow(date);
  if (!window) return null;
  const flights = await prisma.flight.findMany({
    where: {
      flightNumber,
      flightDate: { gte: window.start, lt: window.end },
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

function publicImportRows(rows: CsvRow[]) {
  return rows.map((row) => ({
    ...row,
    data: Object.fromEntries(
      Object.entries(row.data).filter(([key]) => !key.startsWith("__")),
    ),
  }));
}

@Catch()
class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : null;
    const details = typeof raw === "object" && raw ? raw as Record<string, unknown> : {};
    const message = typeof raw === "string" ? raw : typeof details.message === "string" ? details.message : status === 500 ? "Internal server error" : "Request failed";
    response.status(status).json({code: details.code || "HTTP_" + status,message,fieldErrors: details.fieldErrors,conflict: details.conflict,requestId: request.headers["x-request-id"] || randomUUID()});
  }
}

@Controller()
class AppController {
  @Get("health") health() {
    return {
      status: "ok",
      service: "wingsbalance-api",
      time: new Date().toISOString(),
    };
  }
  @Get("ready") async ready() {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ready", database: "connected" };
    } catch {
      throw new ServiceUnavailableException("Dependencies unavailable");
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

  @Get("v1/navigation") async navigation(@Req() req: AuthedRequest) {
    const user = await authenticate(req);
    const items: Record<Role, string[]> = {
      ATTENDANT: ["my-flight", "history"],
      LEAD: ["operations", "attendants", "catering", "load-planning", "reports"],
      PROCUREMENT: ["dashboard", "uploads", "reconciliation", "stock", "waste"],
      DIRECTOR: ["executive", "costs", "insights"],
      ADMIN: ["users", "audit"],
    };
    return { items: items[user.role] };
  }
  @Get("v1/flights") async flights(@Req() req: AuthedRequest) {
    const user = await authenticate(req);
    const where =
      user.role === Role.ATTENDANT
        ? { assignments: { some: { userId: user.id } } }
        : user.role === Role.LEAD
          ? { leadId: user.id }
          : {};
    return prisma.flight.findMany({
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
                include: {
                  user: { select: { id: true, name: true, email: true } },
                },
              },
      },
    });
  }
  @Post("v1/flights") async createFlight(
    @Body() body: {flightNumber:string;flightDate:string;aircraft:string;origin:string;destination:string;scheduledArrival:string;economyPax:number;businessPax:number},
    @Req() req: AuthedRequest,
  ) {
    const actor=await authorizeMutation(req,[Role.PROCUREMENT]);
    const flightNumber = normalizeFlightNumber(body.flightNumber || "");
    const departure = new Date(body.flightDate);
    const arrival = new Date(body.scheduledArrival);
    if(
      !flightNumber ||
      !body.aircraft?.trim() ||
      !/^[A-Z]{3}$/.test(body.origin?.toUpperCase()) ||
      !/^[A-Z]{3}$/.test(body.destination?.toUpperCase()) ||
      Number.isNaN(departure.valueOf()) ||
      Number.isNaN(arrival.valueOf()) ||
      arrival <= departure ||
      !Number.isInteger(body.economyPax) ||
      !Number.isInteger(body.businessPax) ||
      body.economyPax < 0 ||
      body.businessPax < 0
    ) throw new BadRequestException("Invalid flight details");
    const duplicate = await prisma.flight.count({
      where: {
        flightNumber,
        flightDate: { gte: new Date(departure.toISOString().slice(0, 10)), lt: new Date(new Date(departure.toISOString().slice(0, 10)).valueOf() + 86_400_000) },
      },
    });
    if (duplicate) throw new ConflictException("Flight already exists for this date");
    const flight=await prisma.flight.create({data:{flightNumber,flightDate:departure,aircraft:body.aircraft.trim().toUpperCase(),status:"SCHEDULED",sectors:{create:{sequence:1,origin:body.origin.toUpperCase(),destination:body.destination.toUpperCase(),scheduledDeparture:departure,scheduledArrival:arrival,economyPax:body.economyPax,businessPax:body.businessPax}}},include:{sectors:true}});
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
  @Patch("v1/procurement/flights/:id/lead") async assignFlightLead(
    @Param("id") id: string,
    @Body() body: { leadId?: string | null },
    @Req() req: AuthedRequest,
  ) {
    const actor = await authorizeMutation(req, [Role.PROCUREMENT]);
    const flight = await prisma.flight.findUnique({
      where: { id },
      include: { sectors: true },
    });
    if (!flight) throw new NotFoundException("Flight not found");
    if (body.leadId) {
      const lead = await prisma.user.findFirst({
        where: { id: body.leadId, role: Role.LEAD, active: true },
      });
      if (!lead) throw new BadRequestException("Active Lead account not found");
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
          "This Lead already has a flight during the selected time window",
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
  @Get("v1/procurement/catering-lists") async procurementCateringLists(
    @Req() req: AuthedRequest,
  ) {
    await authenticate(req, [Role.PROCUREMENT]);
    return prisma.cateringList.findMany({
      include: {
        _count: { select: { lines: true, flights: true } },
        createdBy: { select: { name: true } },
      },
      orderBy: [{ serviceDate: "desc" }, { name: "asc" }],
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
  @Put("v1/lead/flights/:id/crew") async assignFlightCrew(
    @Param("id") id: string,
    @Body()
    body: {
      assignments?: Array<{ userId: string; duty: "PURSER" | "CABIN_CREW" }>;
      operationId?: string;
    },
    @Req() req: AuthedRequest,
  ) {
    const actor = await authorizeMutation(req, [Role.LEAD]);
    const flight = await requireLeadFlight(actor.id, id);
    if (flight.report && !canSubmitReport(flight.report.status))
      throw new ConflictException("Crew is locked after report submission");
    const startedReports = await prisma.crewSubmission.count({
      where: { flightId: id },
    });
    if (startedReports)
      throw new ConflictException(
        "Crew assignment is locked because crew reporting has started",
      );
    const assignments = body.assignments || [];
    const userIds = assignments.map((item) => item.userId);
    if (new Set(userIds).size !== userIds.length)
      throw new BadRequestException("Each attendant may be assigned once");
    if (assignments.length && assignments.filter((item) => item.duty === "PURSER").length !== 1)
      throw new BadRequestException("Select exactly one purser");
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
    await prisma.$transaction(async (tx) => {
      await tx.crewAssignment.deleteMany({ where: { flightId: id } });
      if (assignments.length)
        await tx.crewAssignment.createMany({
          data: assignments.map((item) => ({ flightId: id, ...item })),
        });
      await tx.flight.update({
        where: { id },
        data: { version: { increment: 1 } },
      });
    });
    await audit(actor.id, "FLIGHT_CREW_ASSIGNED", "Flight", id, {
      assignments,
      operationId: body.operationId,
    });
    return { flightId: id, assignments };
  }
  @Get("v1/lead/flights/:id/catering-options") async cateringOptions(
    @Param("id") id: string,
    @Req() req: AuthedRequest,
  ) {
    const actor = await authenticate(req, [Role.LEAD]);
    const flight = await requireLeadFlight(actor.id, id);
    const serviceDate = new Date(`${flight.flightDate.toISOString().slice(0, 10)}T00:00:00.000Z`);
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
  @Post("v1/lead/flights/:id/catering/:listId") async attachCateringList(
    @Param("id") id: string,
    @Param("listId") listId: string,
    @Body() body: { operationId?: string },
    @Req() req: AuthedRequest,
  ) {
    const actor = await authorizeMutation(req, [Role.LEAD]);
    if (!body.operationId) throw new BadRequestException("Operation ID is required");
    const duplicate = await prisma.idempotencyKey.findUnique({
      where: { key: body.operationId },
    });
    if (duplicate) return duplicate.response;
    const flight = await requireLeadFlight(actor.id, id);
    if (flight.report && flight.report.status !== ReportStatus.DRAFT)
      throw new ConflictException("Catering is locked after report submission");
    if (await prisma.crewSubmission.count({ where: { flightId: id } }))
      throw new ConflictException(
        "Catering is locked because crew reporting has started",
      );
    const list = await prisma.cateringList.findUnique({
      where: { id: listId },
      include: { lines: true },
    });
    if (!list || list.status !== "READY")
      throw new NotFoundException("Catering list not found");
    const current = await prisma.flight.findUnique({
      where: { id },
      select: { cateringListId: true },
    });
    if (current?.cateringListId === list.id)
      return { flightId: id, cateringList: { id: list.id, name: list.name } };
    const date = flight.flightDate.toISOString().slice(0, 10);
    if (
      list.flightNumber !== flight.flightNumber ||
      list.serviceDate.toISOString().slice(0, 10) !== date
    )
      throw new BadRequestException(
        "Catering list name and service date must match the flight",
      );
    for (const line of list.lines)
      if (!flight.sectors.some((sector) => sector.sequence === line.sectorSequence))
        throw new BadRequestException("Catering list contains an unknown sector");
    await prisma.$transaction(async (tx) => {
      const manifests = await tx.manifest.findMany({ where: { flightId: id } });
      await tx.manifestLine.deleteMany({
        where: { manifestId: { in: manifests.map((item) => item.id) } },
      });
      await tx.manifest.deleteMany({ where: { flightId: id } });
      const groups = new Map<string, typeof list.lines>();
      for (const line of list.lines) {
        const key = `${line.sectorSequence}|${line.cabin}`;
        groups.set(key, [...(groups.get(key) || []), line]);
      }
      for (const lines of groups.values()) {
        const first = lines[0];
        const sector = flight.sectors.find(
          (item) => item.sequence === first.sectorSequence,
        );
        if (!sector) continue;
        await tx.manifest.create({
          data: {
            flightId: id,
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
      await tx.flight.update({
        where: { id },
        data: { cateringListId: list.id, version: { increment: 1 } },
      });
      const response = {
        flightId: id,
        cateringList: { id: list.id, name: list.name },
      };
      await tx.idempotencyKey.create({
        data: {
          key: body.operationId!,
          response,
          expiresAt: new Date(Date.now() + 30 * 86400000),
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          action: "CATERING_LIST_ATTACHED",
          entityType: "Flight",
          entityId: id,
          metadata: { cateringListId: list.id },
        },
      });
    });
    return { flightId: id, cateringList: { id: list.id, name: list.name } };
  }
  @Get("v1/imports") async imports(@Req() req: AuthedRequest) {
    const actor = await authenticate(req, [Role.PROCUREMENT]);
    return prisma.importBatch.findMany({
      where: { actorId: actor.id },
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
  @Post("v1/imports/preview") async previewImport(
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
    if (existing) return existing;
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
  @Post("v1/imports/:id/commit") async commitImport(
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
    const rows = await validateImport(batch.type, batch.sourceText);
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
      let assignments = 0;
      for (const { data } of rows) {
        await tx.crewAssignment.upsert({
          where: {
            flightId_userId: {
              flightId: data.__flight_id,
              userId: data.__user_id,
            },
          },
          update: { duty: data.duty },
          create: {
            flightId: data.__flight_id,
            userId: data.__user_id,
            duty: data.duty,
          },
        });
        assignments += 1;
      }
      return finish({ assignments });
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
  @Post("v1/imports/flights/preview") async deprecatedFlightPreview() {
    throw new BadRequestException("Use POST /v1/imports/preview");
  }
  @Post("v1/imports/flights/commit") async deprecatedFlightCommit() {
    throw new BadRequestException("Use a server-issued import batch");
  }
  @Get("v1/flights/:id/manifest") async manifest(
    @Param("id") id: string,
    @Req() req: AuthedRequest,
  ) {
    const user = await authenticate(req);
    let crewDuty: string | null = null;
    if (user.role === Role.ATTENDANT) {
      const assigned = await prisma.crewAssignment.findUnique({
        where: { flightId_userId: { flightId: id, userId: user.id } },
        select: { duty: true },
      });
      if (!assigned) throw new ForbiddenException("Flight not assigned");
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
    const [crewSubmission, assignments, submittedCount] =
      user.role === Role.ATTENDANT
        ? await Promise.all([
            prisma.crewSubmission.findUnique({
              where: { flightId_userId: { flightId: id, userId: user.id } },
            }),
            prisma.crewAssignment.findMany({
              where: { flightId: id },
              select: {
                id: true,
                duty: true,
                user: { select: { id: true, name: true } },
              },
              orderBy: { user: { name: "asc" } },
            }),
            prisma.crewSubmission.count({ where: { flightId: id } }),
          ])
        : [null, [], 0];
    return {
      ...flight,
      crewDuty,
      crewSubmission,
      crew: assignments.map((assignment) => ({
        id: assignment.id,
        name: assignment.user.name,
        duty: assignment.duty,
        submitted: assignment.user.id === user.id
          ? Boolean(crewSubmission)
          : false,
      })),
      crewProgress: { assigned: assignments.length, submitted: submittedCount },
    };
  }
  @Get("v1/lead/flights/:id/load-plan") async leadLoadPlan(
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
    const [forecasts, crewSubmissionCount] = await Promise.all([
      prisma.forecast.findMany({
        where: { flightId: id },
        orderBy: { createdAt: "desc" },
      }),
      prisma.crewSubmission.count({ where: { flightId: id } }),
    ]);
    return { flight, forecasts, crewSubmissionCount };
  }
  @Get("v1/lead/flights/:id/crew-status") async leadCrewStatus(
    @Param("id") id: string,
    @Req() req: AuthedRequest,
  ) {
    const actor = await authenticate(req, [Role.LEAD]);
    const flight = await requireLeadFlight(actor.id, id);
    const [assignments, submissions] = await Promise.all([
      prisma.crewAssignment.findMany({
        where: { flightId: id },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: [{ duty: "desc" }, { user: { name: "asc" } }],
      }),
      prisma.crewSubmission.findMany({ where: { flightId: id } }),
    ]);
    const byUser = new Map(submissions.map((item) => [item.userId, item]));
    const crew = assignments.map((assignment) => {
      const submission = byUser.get(assignment.userId);
      return {
        assignmentId: assignment.id,
        user: assignment.user,
        duty: assignment.duty,
        status: submission ? "SUBMITTED" : "PENDING",
        submittedAt: submission?.submittedAt || null,
        notes: submission?.notes || null,
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
  @Post("v1/lead/flights/:id/crew/:userId/remind") async remindCrewMember(
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
    const submitted = await prisma.crewSubmission.count({
      where: { flightId: id, userId },
    });
    if (submitted)
      throw new ConflictException("This attendant has already reported");
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
  @Patch("v1/lead/manifests/:id/load") async saveLeadLoad(
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
    const duplicate = await prisma.idempotencyKey.findUnique({
      where: { key: body.operationId },
    });
    if (duplicate) return duplicate.response;
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
    const crewSubmissionCount = await prisma.crewSubmission.count({
      where: { flightId: manifest.flightId },
    });
    if (crewSubmissionCount)
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
      for (const line of body.lines)
        await tx.manifestLine.update({
          where: { id: line.id },
          data: {
            approved: line.approved,
            loaded: line.loaded,
            overrideReason: line.overrideReason?.trim() || null,
          },
        });
      const updated = await tx.manifest.update({
        where: { id },
        data: { version: { increment: 1 } },
      });
      const result = { id, version: updated.version, savedLines: body.lines.length };
      await tx.idempotencyKey.create({
        data: {
          key: body.operationId,
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
  @Patch("v1/manifests/:id/draft") async saveDraft(
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
    const duplicate = await prisma.syncOperation.findUnique({
      where: { id: body.operationId },
    });
    if (duplicate) return { applied: true, duplicate: true };
    const manifest = await prisma.manifest.findUnique({
      where: { id },
      include: { lines: true, flight: { select: { status: true } } },
    });
    if (!manifest) throw new NotFoundException("Manifest not found");
    const assigned = await prisma.crewAssignment.count({
      where: { flightId: manifest.flightId, userId: user.id },
    });
    if (!assigned) throw new ForbiddenException("Flight not assigned");
    const report = await prisma.flightReport.findUnique({
      where: { flightId: manifest.flightId },
      select: { status: true },
    });
    if (manifest.flight.status === FlightStatus.COMPLETED || manifest.flight.status === FlightStatus.CANCELLED)
      throw new ConflictException("Completed and cancelled flights are read-only");
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
          (x) => x < 0,
        ) ||
        total > original.loaded
      )
        throw new BadRequestException("Invalid reconciliation quantities");
    }
    const next = await prisma.$transaction(async (tx) => {
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
      const updated = await tx.manifest.update({
        where: { id },
        data: { version: { increment: 1 } },
      });
      await tx.syncOperation.create({
        data: {
          id: body.operationId,
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
  @Post("v1/flights/:id/crew-submissions") async submitCrewCompletion(
    @Param("id") flightId: string,
    @Body() body: { operationId: string; notes?: string },
    @Req() req: AuthedRequest,
  ) {
    const user = await authorizeMutation(req, [Role.ATTENDANT]);
    if (!body.operationId) throw new BadRequestException("Operation ID is required");
    if ((body.notes || "").length > 1000)
      throw new BadRequestException("Crew notes must not exceed 1000 characters");
    const duplicate = await prisma.idempotencyKey.findUnique({
      where: { key: body.operationId },
    });
    if (duplicate) return duplicate.response;
    const assignment = await prisma.crewAssignment.findUnique({
      where: { flightId_userId: { flightId, userId: user.id } },
      include: {
        flight: {
          select: {
            flightNumber: true,
            status: true,
            leadId: true,
            report: { select: { status: true } },
          },
        },
      },
    });
    if (!assignment) throw new ForbiddenException("Flight not assigned");
    if (assignment.flight.status === FlightStatus.COMPLETED || assignment.flight.status === FlightStatus.CANCELLED)
      throw new ConflictException("Completed and cancelled flights are read-only");
    if (!assignment.flight.leadId)
      throw new ConflictException("A Flight Lead must be assigned before reporting");
    if (!canSubmitReport(assignment.flight.report?.status || null))
      throw new ConflictException("This report is read-only");
    const existing = await prisma.crewSubmission.findUnique({
      where: { flightId_userId: { flightId, userId: user.id } },
    });
    if (existing)
      return {
        id: existing.id,
        status: "SUBMITTED",
        submittedAt: existing.submittedAt,
        alreadySubmitted: true,
      };
    const assigned = await prisma.crewAssignment.count({ where: { flightId } });
    const result = await prisma.$transaction(async (tx) => {
      const submission = await tx.crewSubmission.create({
        data: {
          flightId,
          userId: user.id,
          duty: assignment.duty,
          notes: body.notes?.trim() || null,
        },
      });
      const submitted = await tx.crewSubmission.count({ where: { flightId } });
      const response = {
        id: submission.id,
        status: "SUBMITTED",
        submittedAt: submission.submittedAt,
        progress: { assigned, submitted },
      };
      await tx.notification.create({
        data: {
          userId: assignment.flight.leadId!,
          title: `${assignment.flight.flightNumber}: crew report received`,
          body: `${user.name} reported. ${submitted}/${assigned} assigned crew complete.`,
          kind: "CREW_REPORT",
          flightId,
          actionPath: "attendants",
        },
      });
      await tx.idempotencyKey.create({
        data: {
          key: body.operationId,
          response,
          expiresAt: new Date(Date.now() + 30 * 86400000),
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: user.id,
          action: "CREW_REPORT_SUBMITTED",
          entityType: "Flight",
          entityId: flightId,
          metadata: { duty: assignment.duty },
        },
      });
      return response;
    });
    return result;
  }
  @Post("v1/flights/:id/reports") async submitReport(
    @Param("id") flightId: string,
    @Body()
    body: {
      operationId: string;
      manifestVersions: Record<string, number>;
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
    if (assigned.flight.status === FlightStatus.COMPLETED || assigned.flight.status === FlightStatus.CANCELLED)
      throw new ConflictException("Completed and cancelled flights are read-only");
    if (assigned.duty !== "PURSER")
      throw new ForbiddenException(
        "Only the assigned purser may submit the final catering reconciliation",
      );
    if (!assigned.flight.leadId)
      throw new ConflictException("A Flight Lead must be assigned before submission");
    const existingKey = await prisma.idempotencyKey.findUnique({
      where: { key: body.operationId },
    });
    if (existingKey) return existingKey.response;
    const existingReport = await prisma.flightReport.findUnique({
      where: { flightId },
      select: { id: true, status: true },
    });
    if (!canSubmitReport(existingReport?.status || null))
      throw new ConflictException(
        "Only draft or returned reports may be submitted",
      );
    const crew = await prisma.crewAssignment.findMany({
      where: { flightId },
      include: {
        user: { select: { name: true } },
      },
    });
    const crewSubmissions = await prisma.crewSubmission.findMany({
      where: { flightId },
      select: { userId: true },
    });
    const submittedUsers = new Set(crewSubmissions.map((item) => item.userId));
    const missingCrew = crew.filter((item) => !submittedUsers.has(item.userId));
    if (missingCrew.length)
      throw new ConflictException({
        code: "CREW_REPORTS_PENDING",
        message: `${missingCrew.length} assigned crew report${missingCrew.length === 1 ? " is" : "s are"} still pending`,
        conflict: { missingCrew: missingCrew.map((item) => item.user.name) },
      });
    const manifests = await prisma.manifest.findMany({
      where: { flightId },
      include: { lines: true },
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
        (line.spoiled > 0 || unexplained > 0) &&
        !line.remarks?.trim() &&
        !body.notes?.trim()
      )
        throw new BadRequestException(
          "Notes are required for spoilage or unexplained variance",
        );
    }
    const result = await prisma.$transaction(async (tx) => {
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
      const response = {
        id: report.id,
        status: report.status,
        submittedAt: report.submittedAt,
      };
      await tx.idempotencyKey.create({
        data: {
          key: body.operationId,
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
  @Get("v1/approvals") async approvals(@Req() req: AuthedRequest) {
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
  @Get("v1/procurement/reconciliations") async procurementReconciliations(
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
  @Patch("v1/reports/:id/decision") async decide(
    @Param("id") id: string,
    @Body()
    body: {
      decision: "FORWARDED" | "APPROVED" | "RETURNED" | "REJECTED";
      reason?: string;
      operationId: string;
    },
    @Req() req: AuthedRequest,
  ) {
    const actor = await authorizeMutation(req, [Role.LEAD, Role.PROCUREMENT]);
    if (!["APPROVED", "FORWARDED"].includes(body.decision) && !body.reason?.trim())
      throw new BadRequestException("Reason is required");
    const duplicate = await prisma.idempotencyKey.findUnique({
      where: { key: body.operationId },
    });
    if (duplicate) return duplicate.response;
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
      const status = body.decision as ReportStatus;
      const updated = await tx.flightReport.update({
        where: { id },
        data: {
          status,
          approvedAt: status === ReportStatus.APPROVED ? new Date() : null,
        },
      });
      await tx.approval.create({
        data: {
          reportId: id,
          actorId: actor.id,
          decision: status,
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
                  operationId: `${body.operationId}:${source.id}:${reason}`,
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
          key: body.operationId,
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
    const [items, manifestLines] = await Promise.all([
      prisma.catalogItem.findMany({
        include: {
          lots: true,
          movements: true,
          prices: { orderBy: { effectiveFrom: "desc" } },
        },
      }),
      prisma.manifestLine.findMany({
        select: {
          itemId: true,
          loaded: true,
          manifest: {
            select: {
              flight: {
                select: {
                  status: true,
                  report: { select: { status: true } },
                },
              },
            },
          },
        },
      }),
    ]);
    const reservedByItem = new Map<string, number>();
    for (const line of manifestLines) {
      const reportStatus = line.manifest.flight.report?.status;
      if (
        line.manifest.flight.status !== "CANCELLED" &&
        reportStatus !== ReportStatus.APPROVED &&
        reportStatus !== ReportStatus.REJECTED
      )
        reservedByItem.set(
          line.itemId,
          (reservedByItem.get(line.itemId) || 0) + line.loaded,
        );
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
  @Get("v1/forecasts/:flightId") async forecasts(@Param("flightId") flightId:string,@Req() req:AuthedRequest){const actor=await authenticate(req,[Role.LEAD,Role.PROCUREMENT]);if(actor.role===Role.LEAD)await requireLeadFlight(actor.id,flightId);return prisma.forecast.findMany({where:{flightId},orderBy:{createdAt:"desc"}})}
  @Patch("v1/forecasts/:id/override") async overrideForecast(@Param("id") id:string,@Body() body:{approved:number;reason:string},@Req() req:AuthedRequest){const actor=await authorizeMutation(req,[Role.LEAD,Role.PROCUREMENT]);if(!Number.isInteger(body.approved)||body.approved<0||!body.reason?.trim())throw new BadRequestException("Approved quantity and override reason are required");const forecast=await prisma.forecast.findUnique({where:{id},select:{flightId:true}});if(!forecast)throw new NotFoundException("Forecast not found");if(actor.role===Role.LEAD){const flight=await prisma.flight.findUnique({where:{id:forecast.flightId},select:{leadId:true}});if(!flight||flight.leadId!==actor.id)throw new ForbiddenException("This flight is not assigned to the Lead");}const result=await prisma.forecast.update({where:{id},data:{approved:body.approved,explanation:{set:body.reason}}});await audit(actor.id,"FORECAST_OVERRIDDEN","Forecast",id,{approved:body.approved,reason:body.reason});return result}
  @Get("v1/dashboard/director")
  @Header("Cache-Control", "private, no-store")
  async dashboard(@Req() req: AuthedRequest) {
    await authenticate(req, [Role.DIRECTOR]);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [movements, approvedReports, flights] = await Promise.all([
      prisma.stockMovement.findMany({
        include: { item: { select: { category: true } } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.flightReport.findMany({
        where: {
          status: ReportStatus.APPROVED,
          approvedAt: { gte: monthStart },
        },
        include: { flight: { include: { sectors: true } } },
      }),
      prisma.flight.count(),
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
    const passengers = approvedReports.reduce(
      (total, report) =>
        total +
        report.flight.sectors.reduce(
          (sum, sector) => sum + sector.economyPax + sector.businessPax,
          0,
        ),
      0,
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
      costPerPaxMinor: passengers ? Math.round(spend / passengers) : 0,
      annualizedSavingsMinor: Math.round(waste * 12 * (recoverablePct / 100)),
      recoverablePct,
      passengers,
      approvedReports: approvedReports.length,
      flights,
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
  const app = await NestFactory.create(AppModule);
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
