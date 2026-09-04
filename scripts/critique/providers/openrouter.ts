// scripts/critique/providers/openrouter.ts
// OpenRouter provider: OpenAI-compatible chat completions. Owns every model id that does
// NOT start with "gemini/" (that prefix is reserved for the direct Gemini provider). Model
// ids are passed straight through to OpenRouter as-is (e.g. "openai/gpt-4o", "x-ai/grok-2",
// "perplexity/sonar-pro", "google/gemini-pro") -- OpenRouter's own id space already encodes
// the vendor, so no further mapping happens here.
import { postJson } from './fetchClient.js';
import type { CallOptions, CriticRequest, CriticResponse, Provider } from './types.js';
import { ProviderError } from './types.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

interface OpenRouterResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

function isOpenRouterResponse(v: unknown): v is OpenRouterResponse {
  return !!v && typeof v === 'object';
}

export const openRouterProvider: Provider = {
  name: 'openrouter',
  supports(model: string): boolean {
    return !model.startsWith('gemini/');
  },
  async call(req: CriticRequest, opts: CallOptions): Promise<CriticResponse> {
    const body = {
      model: req.model,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userPrompt },
      ],
    };
    const headers = {
      Authorization: `Bearer ${opts.apiKey}`,
      // OpenRouter asks for these two for attribution; harmless if ignored.
      'HTTP-Referer': 'https://github.com/countersign',
      'X-Title': 'Countersign critique loop',
    };
    let json: unknown;
    try {
      json = await postJson(ENDPOINT, headers, body, { timeoutMs: opts.timeoutMs, retries: 1 });
    } catch (err) {
      throw new ProviderError(`openrouter call failed for model ${req.model}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isOpenRouterResponse(json)) throw new ProviderError(`openrouter: unexpected response shape for model ${req.model}`);
    if (json.error?.message) throw new ProviderError(`openrouter error for model ${req.model}: ${json.error.message}`);
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.length === 0) throw new ProviderError(`openrouter: empty response for model ${req.model}`);
    return { text };
  },
};
