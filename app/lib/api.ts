export type Role = "ATTENDANT" | "LEAD" | "PROCUREMENT" | "DIRECTOR" | "ADMIN";
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
};
let csrf = "";
let offlineUserId = "";
let offlineRole: Role | "" = "";
const apiOrigin = (process.env.NEXT_PUBLIC_API_URL || "/api").replace(/\/+$/, "");
const DB = "wingsbalance-offline",
  STORE = "operations",
  CACHE_STORE = "assigned-cache";
export type OfflineDraft = { id: string; path: string; method: string; body: string; userId: string; createdAt: string; status: "QUEUED" | "CONFLICT" | "FAILED" };
const offlineChanged = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("rwandair-offline-change"));
};
function offlineDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE, { keyPath: "id" });
      if (!request.result.objectStoreNames.contains(CACHE_STORE))
        request.result.createObjectStore(CACHE_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function queue(path: string, options: RequestInit) {
  if (!offlineUserId) throw new Error("Sign in before saving an offline draft");
  const db = await offlineDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({
      id: operationId(),
      path,
      method: options.method,
      body: options.body,
      createdAt: new Date().toISOString(),
      status: "QUEUED",
      userId: offlineUserId,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  offlineChanged();
}
export async function offlineDrafts(): Promise<OfflineDraft[]> {
  if (!offlineUserId || typeof indexedDB === "undefined") return [];
  const db = await offlineDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => resolve((request.result as OfflineDraft[]).filter((entry) => entry.userId === offlineUserId));
    request.onerror = () => reject(request.error);
  });
}
export async function discardOfflineDraft(id: string) {
  if (!(await offlineDrafts()).some((entry) => entry.id === id)) throw new Error("Offline draft is not available to this user");
  const db = await offlineDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  offlineChanged();
}
async function cacheAssigned(path: string, payload: unknown) {
  if (!offlineUserId || offlineRole !== "ATTENDANT") return;
  if (path !== "/flights" && !/^\/flights\/[^/]+\/manifest$/.test(path)) return;
  const db = await offlineDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE, "readwrite");
    tx.objectStore(CACHE_STORE).put({
      key: `${offlineUserId}:${path}`,
      payload,
      cachedAt: new Date().toISOString(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function cachedAssigned<T>(path: string): Promise<T | undefined> {
  if (!offlineUserId || offlineRole !== "ATTENDANT") return undefined;
  const db = await offlineDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const request = db
      .transaction(CACHE_STORE)
      .objectStore(CACHE_STORE)
      .get(`${offlineUserId}:${path}`);
    request.onsuccess = () => resolve(request.result?.payload as T | undefined);
    request.onerror = () => reject(request.error);
  });
}
export function setCsrf(value: string, user?: SessionUser) {
  csrf = value;
  if (user) {
    offlineUserId = user.id;
    offlineRole = user.role;
    void replay();
  }
}
export async function clearOfflineSession() {
  csrf = "";
  offlineUserId = "";
  offlineRole = "";
  if (typeof indexedDB === "undefined") return;
  const db = await offlineDb();
  for (const store of [STORE, CACHE_STORE])
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const method = (options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrf)
    headers.set("x-csrf-token", csrf);
  let response: Response;
  try {
    response = await fetch(apiOrigin + "/v1" + path, {
      ...options,
      headers,
      credentials: "include",
      cache: "no-store",
    });
  } catch (error) {
    if (method === "GET") {
      const cached = await cachedAssigned<T>(path);
      if (cached !== undefined) return cached;
    }
    if (
      method === "PATCH" &&
      /^\/manifests\/[^/]+\/draft$/.test(path) &&
      typeof indexedDB !== "undefined"
    ) {
      await queue(path, options);
      const queued = new Error(
        "Draft queued offline. It will sync when connectivity returns.",
      ) as Error & { queued: boolean };
      queued.queued = true;
      throw queued;
    }
    throw error;
  }
  const payload = await response
    .json()
    .catch(() => ({ message: response.statusText }));
  if (!response.ok) {
    const error = new Error(payload.message || "Request failed") as Error & {
      status: number;
      payload: unknown;
    };
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  await cacheAssigned(path, payload).catch(() => {});
  return payload as T;
}

export async function download(path: string) {
  const response = await fetch(apiOrigin + "/v1" + path, {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || "Download failed");
  }
  return { blob: await response.blob(), fileName: response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] || "report.csv" };
}
export const operationId = () => crypto.randomUUID();
let replaying = false;
export async function replay() {
  if (typeof indexedDB === "undefined" || !csrf) return;
  if (replaying) return;
  replaying = true;
  try {
  const db = await offlineDb();
  const rows = (await offlineDrafts()).filter((row) => row.status === "QUEUED").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const row of rows) {
    try {
      await api(row.path, { method: row.method, body: row.body });
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(row.id);
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status === 409 || (status && status < 500)) {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put({
          ...row,
          status: status === 409 ? "CONFLICT" : "FAILED",
        });
      }
      break;
    }
  }
  } finally {
    replaying = false;
    offlineChanged();
  }
}
if (typeof window !== "undefined")
  window.addEventListener("online", () => void replay());
