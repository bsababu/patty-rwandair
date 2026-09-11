export type CsvRow = {
  row: number;
  data: Record<string, string>;
  errors: string[];
};

export const importHeaders = {
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
    "flight_date",
    "sector_sequence",
    "cabin",
    "item_sku",
    "suggested",
    "planned",
    "approved",
    "loaded",
    "override_reason",
  ],
} as const;

export function parseCsv(source: string) {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      record.push(field.trim());
      field = "";
    } else if (character === "\n") {
      record.push(field.trim());
      if (record.some((value) => value.length)) records.push(record);
      record = [];
      field = "";
    } else if (character !== "\r") field += character;
  }
  if (quoted) throw new Error("CSV contains an unclosed quoted field");
  record.push(field.trim());
  if (record.some((value) => value.length)) records.push(record);
  return records;
}

export function csvRecords(source: string, required: readonly string[]) {
  const records = parseCsv(source);
  if (records.length < 2) throw new Error("CSV contains no data rows");
  const headers = records[0].map((value, index) =>
    (index === 0 ? value.replace(/^\uFEFF/, "") : value).trim().toLowerCase(),
  );
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`Missing CSV columns: ${missing.join(", ")}`);
  return records.slice(1).map((values, index) => ({
    row: index + 2,
    data: Object.fromEntries(headers.map((header, column) => [header, values[column] || ""])),
    errors: values.length > headers.length ? ["Too many columns"] : [],
  })) satisfies CsvRow[];
}

export function normalizeFlightNumber(value: string) {
  const match = value.trim().toUpperCase().match(/^WB\s*(\d{2,4})$/);
  return match ? `WB ${match[1]}` : null;
}

export function dateWindow(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const start = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(start.valueOf())) return null;
  return { start, end: new Date(start.valueOf() + 86_400_000) };
}

export function nonnegativeInteger(value: string) {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
