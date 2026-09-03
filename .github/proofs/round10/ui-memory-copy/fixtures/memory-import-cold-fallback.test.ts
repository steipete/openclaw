/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { i18n, t } from "../lib/translate.ts";

afterEach(() => vi.unstubAllGlobals());

async function assertEnglishFallback(loadConsumer: () => Promise<unknown>) {
  vi.stubGlobal("localStorage", createStorageMock());
  await loadConsumer();
  // Existing locale API models a valid sparse catalog without modifying browser artifacts.
  i18n.registerTranslation("de", { common: { cancel: "Abbrechen" } });
  await i18n.setLocale("de");
  expect(i18n.getLocale()).toBe("de");
  expect(t("common.cancel")).toBe("Abbrechen");
  expect(t("memoryImport.adminRequired")).toBe("Memory import requires operator.admin access.");
}

// Execute each case in a separate process; never warm one consumer through its sibling.
it("cold Settings owner preserves English fallback", async () => {
  await assertEnglishFallback(() => import("../../pages/config/memory.ts"));
});

it("cold Import owner preserves English fallback", async () => {
  await assertEnglishFallback(() => import("../../pages/memory-import/view.ts"));
});
