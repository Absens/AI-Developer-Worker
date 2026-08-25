import { stat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { chromium } from "playwright-core";

import { extractOzonProductReference } from "../src/domain/telegramAssistant/competitorResearch.js";
import { verifyOzonCanaryPage } from "../src/integrations/ozon/browserCanary.js";
import {
  maxOzonStateCandidateBytes,
  normalizeOzonStateCandidate,
  parseOzonStateCandidateJson,
  resolveOzonStateImportConfig,
} from "../src/integrations/ozon/stateImport.js";
import { writeOzonStorageStateAtomically } from "../src/integrations/ozon/sessionState.js";

const isWithin = (parent: string, candidate: string): boolean => {
  const relativePath = relative(parent, candidate);
  return relativePath === "" || (
    !relativePath.startsWith("..") && !isAbsolute(relativePath)
  );
};

const config = resolveOzonStateImportConfig(process.env, process.cwd());
const [repositoryRealPath, candidateRealPath] = await Promise.all([
  realpath(process.cwd()),
  realpath(config.candidateFile),
]);
if (isWithin(repositoryRealPath, candidateRealPath)) {
  throw new Error("The resolved Ozon state candidate must be outside the repository.");
}

const candidateStat = await stat(candidateRealPath);
if (!candidateStat.isFile() || candidateStat.size > maxOzonStateCandidateBytes) {
  throw new Error("Ozon state candidate is not a regular bounded file.");
}
const candidate = normalizeOzonStateCandidate(parseOzonStateCandidateJson(
  await readFile(candidateRealPath, "utf8"),
));
const reference = extractOzonProductReference(config.canaryUrl);
if (!reference) {
  throw new Error("The validated Ozon canary URL could not be parsed.");
}

stdout.write(
  `Candidate accepted structurally: ${candidate.cookies.length} cookies, ` +
  `${candidate.origins[0]?.localStorage.length ?? 0} local storage entries.\n`,
);
const browser = await chromium.launch({ channel: "chrome", headless: false });

try {
  const context = await browser.newContext({
    storageState: candidate,
    locale: "ru-RU",
    timezoneId: "Asia/Yekaterinburg",
  });
  const page = await context.newPage();
  await page.goto("https://www.ozon.ru/", { waitUntil: "domcontentloaded" });
  await page.goto(config.canaryUrl, { waitUntil: "domcontentloaded" });

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    await prompt.question(
      "Если Ozon показывает проверку, пройдите её. Не входите в аккаунт. " +
      "Когда карточка откроется, нажмите Enter здесь... ",
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
    `Canary: HTTP ${result.status}, widgets ${result.widgetCount}, ` +
    `article matched ${result.productMatched ? "yes" : "no"}.\n`,
  );
  if (result.status !== 200 || result.widgetCount === 0 || !result.productMatched) {
    throw new Error("Ozon canary failed; imported state was not activated.");
  }

  const activatedState = normalizeOzonStateCandidate(await context.storageState());
  await writeOzonStorageStateAtomically(
    config.stateFile,
    activatedState,
    process.cwd(),
  );
  stdout.write(
    `Anonymous Ozon state activated at ${config.stateFile}. Values were not logged.\n`,
  );
} finally {
  await browser.close();
}
