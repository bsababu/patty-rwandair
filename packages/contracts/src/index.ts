export type Role='ATTENDANT'|'LEAD'|'PROCUREMENT'|'DIRECTOR'|'ADMIN';
export type Cabin='ECONOMY'|'BUSINESS';
export type ReportStatus='DRAFT'|'SUBMITTED'|'FORWARDED'|'RETURNED'|'REJECTED'|'APPROVED';
export interface OfflineOperation{id:string;flightId:string;manifestVersion:number;createdAt:string;payload:Record<string,unknown>}
export interface Money{amountMinor:number;currency:'RWF'|string}
export interface ForecastSuggestion{flightId:string;itemId:string;cabin:Cabin;baseline:number;safetyBuffer:number;suggested:number;confidence:'LOW'|'MEDIUM'|'HIGH';sampleSize:number;explanation:string}
