// Recomputes every Memory.embedding with the current embedding model.
// Run after switching embedding providers — vectors from different models aren't comparable.
// Usage: pnpm memories:reembed
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/shared/db/index.js";
import { memories } from "../src/shared/db/schema.js";
import { AIService } from "../src/shared/services/ai.service.js";

const ai = new AIService();
const rows = await db.select({ id: memories.id, value: memories.value }).from(memories);

let failed = 0;
for (const [i, row] of rows.entries()) {
  try {
    const embedding = await ai.generateEmbedding(row.value);
    await db.update(memories).set({ embedding: embedding as any }).where(eq(memories.id, row.id));
    console.log(`[${i + 1}/${rows.length}] ${row.id}`);
  } catch (err) {
    failed++;
    console.error(`[${i + 1}/${rows.length}] ${row.id} failed:`, err);
  }
}

console.log(`Done: ${rows.length - failed} re-embedded, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
