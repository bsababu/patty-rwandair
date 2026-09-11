export type Reconciliation={loaded:number;consumed:number;returned:number;spoiled:number;discarded:number};
export function unexplained(x:Reconciliation){const value=x.loaded-x.consumed-x.returned-x.spoiled-x.discarded;if(value<0)throw new Error('Accounted quantity cannot exceed loaded quantity');return value;}
export function wasteCostMinor(x:Reconciliation,unitCostMinor:number){return (x.spoiled+x.discarded+unexplained(x))*unitCostMinor;}
