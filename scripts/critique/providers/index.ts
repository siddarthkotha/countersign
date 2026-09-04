// scripts/critique/providers/index.ts
// Routes a model id to the provider that owns it, and names which env var holds that
// provider's API key.
import { geminiProvider } from './gemini.js';
import { openRouterProvider } from './openrouter.js';
import type { Provider } from './types.js';

export const PROVIDERS: Provider[] = [geminiProvider, openRouterProvider];

export function providerFor(model: string): Provider {
  const p = PROVIDERS.find((prov) => prov.supports(model));
  // openRouterProvider.supports() is "anything not gemini/", so this can only be
  // unreachable if PROVIDERS is edited to remove that catch-all.
  if (!p) throw new Error(`providers: no provider claims model id "${model}"`);
  return p;
}

export function apiKeyEnvVar(provider: Provider): 'OPENROUTER_API_KEY' | 'GEMINI_API_KEY' {
  return provider.name === 'gemini' ? 'GEMINI_API_KEY' : 'OPENROUTER_API_KEY';
}
