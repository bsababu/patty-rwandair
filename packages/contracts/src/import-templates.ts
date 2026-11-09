/** The Catering Run template keeps the everyday upload to four columns. */
export const importTemplates = {
  FLIGHTS: [
    "flight_number,flight_date,aircraft,sector_sequence,origin,destination,departure_iso,arrival_iso,economy_pax,business_pax",
    "WB700,2026-11-04,A330-300,1,KGL,NBO,2026-11-04T08:00:00+02:00,2026-11-04T10:30:00+03:00,220,24",
    "WB700,2026-11-04,A330-300,2,NBO,KGL,2026-11-04T12:00:00+03:00,2026-11-04T12:30:00+02:00,215,22",
  ].join("\n") + "\n",
  CATERING: [
    "flight_number,service_date,item,loaded",
    "WB700,2026-11-04,Chicken brochette meal,108",
    "WB700,2026-11-04,Akagera still water,154",
  ].join("\n") + "\n",
} as const;
