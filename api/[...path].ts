import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Vercel builds apps/api separately (see vercel.json) and this function runs
// the same NestJS app as a single serverless function on the Next.js domain,
// avoiding a second hosted origin and cross-site cookies.
const appEntryUrl = pathToFileURL(
  path.join(process.cwd(), "apps/api/dist/app.js"),
).href;

type ExpressHandler = (req: IncomingMessage, res: ServerResponse) => void;
let cachedHandler: ExpressHandler | null = null;

async function getHandler(): Promise<ExpressHandler> {
  if (cachedHandler) return cachedHandler;
  const { createApp } = (await import(appEntryUrl)) as {
    createApp: () => Promise<{
      getHttpAdapter: () => { getInstance: () => ExpressHandler };
    }>;
  };
  const app = await createApp();
  cachedHandler = app.getHttpAdapter().getInstance();
  return cachedHandler;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  // Nest routes are declared without an "/api" prefix (e.g. "v1/auth/login");
  // strip it here the same way Nginx and the local Next.js rewrite do.
  if (req.url) req.url = req.url.replace(/^\/api/, "") || "/";
  const expressHandler = await getHandler();
  expressHandler(req, res);
}
