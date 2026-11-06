/** Both downloads use the same service and sectors so they can be tested together. */
export const importTemplates = {
  FLIGHTS: [
    "flight_number,flight_date,aircraft,sector_sequence,origin,destination,departure_iso,arrival_iso,economy_pax,business_pax",
    "WB700,2026-11-04,A330-300,1,KGL,NBO,2026-11-04T08:00:00+02:00,2026-11-04T10:30:00+03:00,220,24",
    "WB700,2026-11-04,A330-300,2,NBO,KGL,2026-11-04T12:00:00+03:00,2026-11-04T12:30:00+02:00,215,22",
  ].join("\n") + "\n",
  CATERING: [
    "flight_number,flight_date,sector_sequence,cabin,item_sku,suggested,planned,approved,loaded,override_reason",
    "WB700,2026-11-04,1,ECONOMY,MEAL-CHK,104,108,108,108,Passenger safety buffer approved",
    "WB700,2026-11-04,1,ECONOMY,WATER-500,150,154,154,154,Passenger safety buffer approved",
    "WB700,2026-11-04,1,BUSINESS,MEAL-CHK,12,16,16,16,Business cabin service buffer",
  ].join("\n") + "\n",
} as const;
