import type { IncomingMessage, ServerResponse } from "node:http";
// The API build runs before the Next.js build (see vercel.json). A static
// import is intentional: Vercel must be able to trace this module into the
// serverless bundle.
import { createApp } from "../apps/api/dist/app.js";

type ExpressHandler = (req: IncomingMessage, res: ServerResponse) => void;

let cachedHandler: ExpressHandler | null = null;

async function getHandler(): Promise<ExpressHandler> {
  if (cachedHandler) return cachedHandler;
  const app = await createApp();
  cachedHandler = app
    .getHttpAdapter()
    .getInstance() as unknown as ExpressHandler;
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
