import { cp } from "node:fs/promises";
await cp("server/migrations", "build/server/migrations", { recursive: true });
