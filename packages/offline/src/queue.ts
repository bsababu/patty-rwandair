const DB='wingsbalance-offline',STORE='operations';
export async function enqueue(operation:unknown){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(operation);tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error);});}
export async function pending(){const db=await open();return new Promise<unknown[]>((resolve,reject)=>{const req=db.transaction(STORE).objectStore(STORE).getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function open(){return new Promise<IDBDatabase>((resolve,reject)=>{const req=indexedDB.open(DB,1);req.onupgradeneeded=()=>req.result.createObjectStore(STORE,{keyPath:'id'});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
