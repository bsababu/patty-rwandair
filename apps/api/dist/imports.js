"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.optionalImportHeaders = exports.importHeaders = void 0;
exports.parseCsv = parseCsv;
exports.csvRecords = csvRecords;
exports.normalizeFlightNumber = normalizeFlightNumber;
exports.dateWindow = dateWindow;
exports.isoCalendarDate = isoCalendarDate;
exports.parseIsoTimestamp = parseIsoTimestamp;
exports.nonnegativeInteger = nonnegativeInteger;
exports.importHeaders = {
    FLIGHTS: [
        "flight_number",
        "flight_date",
        "aircraft",
        "sector_sequence",
        "origin",
        "destination",
        "departure_iso",
        "arrival_iso",
        "economy_pax",
        "business_pax",
    ],
    CATERING: [
        "flight_number",
        "loaded",
    ],
};
exports.optionalImportHeaders = {
    CATERING: [
        "service_date",
        "flight_date",
        "item",
        "item_sku",
        "cabin",
        "sector_sequence",
        "suggested",
        "planned",
        "approved",
        "override_reason",
    ],
};
function parseCsv(source) {
    const records = [];
    let record = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        if (quoted) {
            if (character === '"' && source[index + 1] === '"') {
                field += '"';
                index += 1;
            }
            else if (character === '"')
                quoted = false;
            else
                field += character;
            continue;
        }
        if (character === '"')
            quoted = true;
        else if (character === ",") {
            record.push(field.trim());
            field = "";
        }
        else if (character === "\n") {
            record.push(field.trim());
            if (record.some((value) => value.length))
                records.push(record);
            record = [];
            field = "";
        }
        else if (character !== "\r")
            field += character;
    }
    if (quoted)
        throw new Error("CSV contains an unclosed quoted field");
    record.push(field.trim());
    if (record.some((value) => value.length))
        records.push(record);
    return records;
}
function csvRecords(source, required, optional = []) {
    const records = parseCsv(source);
    if (records.length < 2)
        throw new Error("CSV contains no data rows");
    const headers = records[0].map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, "") : value).trim().toLowerCase());
    if (headers.some((header) => !header))
        throw new Error("CSV column names must not be empty");
    const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index);
    if (duplicates.length)
        throw new Error(`Duplicate CSV columns: ${[...new Set(duplicates)].join(", ")}`);
    const missing = required.filter((header) => !headers.includes(header));
    if (missing.length)
        throw new Error(`Missing CSV columns: ${missing.join(", ")}`);
    const unknown = headers.filter((header) => !required.includes(header) && !optional.includes(header));
    if (unknown.length)
        throw new Error(`Unknown CSV columns: ${unknown.join(", ")}`);
    return records.slice(1).map((values, index) => ({
        row: index + 2,
        data: Object.fromEntries(headers.map((header, column) => [header, values[column] || ""])),
        errors: values.length !== headers.length ? [values.length > headers.length ? "Too many columns" : "Too few columns"] : [],
    }));
}
function normalizeFlightNumber(value) {
    const match = value.trim().toUpperCase().match(/^WB\s*(\d{2,4})$/);
    return match ? `WB ${match[1]}` : null;
}
function dateWindow(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        return null;
    const start = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(start.valueOf()))
        return null;
    if (start.toISOString().slice(0, 10) !== value)
        return null;
    return { start, end: new Date(start.valueOf() + 86_400_000) };
}
function isoCalendarDate(value) {
    const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})T/);
    return match ? match[1] : null;
}
/** Parse an ISO timestamp with an explicit offset without accepting Date's calendar rollover. */
function parseIsoTimestamp(value) {
    const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/);
    if (!match || !dateWindow(match[1]))
        return null;
    if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] || 0) > 59)
        return null;
    if (match[6] !== "Z" && (Number(match[8]) > 14 || Number(match[9]) > 59 || (Number(match[8]) === 14 && Number(match[9]) !== 0)))
        return null;
    const parsed = new Date(value.trim());
    return Number.isNaN(parsed.valueOf()) ? null : parsed;
}
function nonnegativeInteger(value) {
    if (!/^\d+$/.test(value))
        return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}
