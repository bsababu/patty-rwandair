import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

type ExpressHandler = (req: IncomingMessage, res: ServerResponse) => void;

const appEntryUrl = pathToFileURL(
  path.join(process.cwd(), "apps/api/dist/app.js"),
).href;

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

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
) {
  if (req.url) req.url = req.url.replace(/^\/api/, "") || "/";
  const expressHandler = await getHandler();
  expressHandler(req, res);
}
