import "reflect-metadata";
import { createApp } from "./app";

async function bootstrap() {
  const app = await createApp();
  await app.listen(Number(process.env.PORT || 4000), "0.0.0.0");
}
bootstrap().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
