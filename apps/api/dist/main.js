"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const app_1 = require("./app");
async function bootstrap() {
    const app = await (0, app_1.createApp)();
    await app.listen(Number(process.env.PORT || 4000), "0.0.0.0");
}
bootstrap().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
