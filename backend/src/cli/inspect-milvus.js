import { pathToFileURL } from "node:url";
import { getConfig } from "../config.js";
import { createMilvusClient, inspectCollection } from "../rag/ebook/milvus-retriever.js";

export async function main() {
  const config = getConfig();
  const collectionName = process.argv[2] || config.milvus.collectionName;
  const client = createMilvusClient(config.milvus);

  try {
    const report = await inspectCollection(client, collectionName);
    console.log(`Collection: ${report.name}`);
    console.log(`Rows: ${report.rowCount}`);
    console.log(`Load state: ${report.loadState}`);
    console.log("Fields:");
    for (const field of report.fields) {
      const details = [
        field.primaryKey ? "primary key" : "",
        field.dimension ? `dim=${field.dimension}` : "",
        field.maxLength ? `max=${field.maxLength}` : "",
      ].filter(Boolean).join(", ");
      console.log(`  - ${field.name}: ${field.type}${details ? ` (${details})` : ""}`);
    }
    console.log("Indexes:");
    for (const index of report.indexes) {
      console.log(
        `  - ${index.name} on ${index.field}: ${index.state}, ${index.indexedRows}/${index.totalRows}`,
      );
      console.log(`    ${JSON.stringify(index.params)}`);
    }
  } finally {
    await client.closeConnection();
  }
}

const isEntryPoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((error) => {
    console.error(`Milvus 检查失败：${error.message}`);
    process.exitCode = 1;
  });
}
