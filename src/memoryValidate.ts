import { parseMemoryConfig } from "./config.js";
import { FileMemoryStore } from "./domain/memoryStore.js";
import { Logger } from "./utils/logger.js";

const main = async (): Promise<void> => {
  const memoryConfig = parseMemoryConfig(process.env);
  const store = new FileMemoryStore(memoryConfig, new Logger());
  const result = await store.validateAll();

  if (result.issues.length === 0) {
    console.log(
      `Memory validation passed. repositories=${result.repositoryCount} dir=${memoryConfig.dir}`,
    );
    return;
  }

  console.error(
    `Memory validation failed. repositories=${result.repositoryCount} dir=${memoryConfig.dir}`,
  );
  for (const issue of result.issues) {
    console.error(
      `- ${issue.repositoryName ?? "unknown"} ${issue.file}: ${issue.message}`,
    );
  }
  process.exitCode = 1;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
