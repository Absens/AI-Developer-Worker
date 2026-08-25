import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { chromium } from "playwright-core";

import { extractOzonProductReference } from "../src/domain/telegramAssistant/competitorResearch.js";
import { verifyOzonCanaryPage } from "../src/integrations/ozon/browserCanary.js";
import {
  assertAnonymousOzonStorageState,
  resolveOzonSessionBootstrapConfig,
  writeOzonStorageStateAtomically,
} from "../src/integrations/ozon/sessionState.js";

const config = resolveOzonSessionBootstrapConfig(process.env, process.cwd());
const reference = extractOzonProductReference(config.canaryUrl);
if (!reference) {
  throw new Error("The validated Ozon canary URL could not be parsed.");
}

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
});

try {
  const context = await browser.newContext({
    locale: "ru-RU",
    timezoneId: "Asia/Yekaterinburg",
  });
  const page = await context.newPage();

  stdout.write(
    "Открываю новую анонимную сессию Ozon. Не входите в аккаунт.\n",
  );
  await page.goto("https://www.ozon.ru/", { waitUntil: "domcontentloaded" });
  await page.goto(config.canaryUrl, { waitUntil: "domcontentloaded" });

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    await prompt.question(
      "Если Ozon показывает проверку, пройдите её в Chrome. Убедитесь, что карточка открылась, затем нажмите Enter здесь... ",
    );
  } finally {
    prompt.close();
  }

  const result = await verifyOzonCanaryPage(
    page,
    config.canaryUrl,
    reference.productId,
  );

  stdout.write(
    `Canary: HTTP ${result.status}, widgets ${result.widgetCount}, article matched ${result.productMatched ? "yes" : "no"}.\n`,
  );
  if (result.status !== 200 || result.widgetCount === 0 || !result.productMatched) {
    throw new Error(
      "Ozon canary failed; anonymous storage state was not saved.",
    );
  }

  const storageState = await context.storageState();
  assertAnonymousOzonStorageState(storageState);
  await writeOzonStorageStateAtomically(
    config.stateFile,
    storageState,
    process.cwd(),
  );
  stdout.write(`Anonymous Ozon state saved to ${config.stateFile}.\n`);
} finally {
  await browser.close();
}
