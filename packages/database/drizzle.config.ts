import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: ["./src/schema.ts", "./src/schema-context.ts", "./src/schema-handoff.ts", "./src/schema-turn-outputs.ts"],
	out: "./migrations",
});
