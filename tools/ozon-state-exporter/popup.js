"use strict";

const button = document.querySelector("#export");
const status = document.querySelector("#status");

const showStatus = (message, error = false) => {
  status.textContent = message;
  status.className = error ? "warning" : "";
};

button.addEventListener("click", async () => {
  button.disabled = true;
  showStatus("Проверяю активную вкладку…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== "number" || !tab.url) {
      throw new Error("Не удалось определить активную вкладку.");
    }
    const url = new URL(tab.url);
    if (url.hostname !== "www.ozon.ru" ||
      !/^\/product\/[a-z0-9-]+-\d{5,15}\/?$/iu.test(url.pathname)) {
      throw new Error("Откройте каноническую карточку на www.ozon.ru.");
    }
    const [{ result: localStorageEntries }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => Object.entries(localStorage).map(([name, value]) => ({ name, value })),
    });
    const cookies = await chrome.cookies.getAll({ url: "https://www.ozon.ru/" });
    const candidate = globalThis.OzonStateSanitizer.buildCandidate({
      cookies,
      localStorage: Array.isArray(localStorageEntries) ? localStorageEntries : [],
    });
    const blobUrl = URL.createObjectURL(new Blob(
      [JSON.stringify(candidate, null, 2)],
      { type: "application/json" },
    ));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `ozon-storage-state-candidate-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1_000);
    showStatus("Candidate сохранён. Cookie values не отображались и не передавались по сети.");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    button.disabled = false;
  }
});
