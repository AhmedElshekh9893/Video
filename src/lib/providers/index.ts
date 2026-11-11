// فهرس المزودين — الوصول الموحد حسب معرف المزود
import type { ProviderAdapter, GenInput } from "./types";
import { kieAdapter } from "./kie";
import { cometapiAdapter, cometCreateImageSync } from "./cometapi";
import { ProviderError } from "../keys";
import type { ApiKeyRow } from "../keys-db";

const ADAPTERS: Record<string, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

export function getAdapter(provider: string): ProviderAdapter {
  const a = ADAPTERS[provider];
  if (!a) throw new ProviderError(500, `مزود غير معروف: ${provider}`);
  return a;
}

// غلاف موحد للصور المتزامنة (CometAPI فقط حاليًا)
export async function createImageSync(
  provider: string,
  key: ApiKeyRow,
  providerModel: string,
  input: GenInput
): Promise<{ urls: string[] }> {
  if (provider === "cometapi") return cometCreateImageSync(key, providerModel, input);
  throw new ProviderError(500, `المزود ${provider} لا يدعم الصور المتزامنة`);
}
