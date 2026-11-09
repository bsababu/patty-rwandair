"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const client_1 = require("@prisma/client");
const app_1 = require("./app");
(0, node_test_1.default)("validates the minimal catering template without an optional cabin", async () => {
    const database = {
        catalogItem: {
            findFirst: async () => ({ id: "item-1", sku: "MEAL-CHK", nameEn: "Chicken brochette meal", active: true }),
        },
        cateringList: {
            findUnique: async () => null,
        },
    };
    const rows = await (0, app_1.validateImport)(client_1.ImportType.CATERING, "flight_number,service_date,item,loaded\nWB700,2026-11-04,Chicken brochette meal,108\n", database);
    strict_1.default.deepEqual(rows[0].errors, []);
    strict_1.default.equal(rows[0].data.cabin, "ECONOMY");
    strict_1.default.equal(rows[0].data.suggested, "108");
    strict_1.default.equal(rows[0].data.approved, "108");
});
