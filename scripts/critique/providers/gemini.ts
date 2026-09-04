// scripts/critique/providers/gemini.ts
// Direct Google Gemini provider (generateContent), for model ids prefixed "gemini/" (e.g.
// "gemini/gemini-1.5-pro"). The prefix is stripped before building the URL; everything
// after "gemini/" is passed through as the model name Google's API expects.
import { postJson } from './fetchClient.js';
import type { CallOptions, CriticRequest, CriticResponse, Provider } from './types.js';
import { ProviderError } from './types.js';

function modelName(id: string): string {
  return id.replace(/^gemini\//, '');
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  error?: { message?: string };
}

function isGeminiResponse(v: unknown): v is GeminiResponse {
  return !!v && typeof v === 'object';
}

export const geminiProvider: Provider = {
  name: 'gemini',
  supports(model: string): boolean {
    return model.startsWith('gemini/');
  },
  async call(req: CriticRequest, opts: CallOptions): Promise<CriticResponse> {
    const name = modelName(req.model);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(name)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
    const body = {
      systemInstruction: { parts: [{ text: req.systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: req.userPrompt }] }],
    };
    let json: unknown;
    try {
      json = await postJson(url, {}, body, { timeoutMs: opts.timeoutMs, retries: 1 });
    } catch (err) {
      throw new ProviderError(`gemini call failed for model ${req.model}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isGeminiResponse(json)) throw new ProviderError(`gemini: unexpected response shape for model ${req.model}`);
    if (json.error?.message) throw new ProviderError(`gemini error for model ${req.model}: ${json.error.message}`);
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string' || text.length === 0) throw new ProviderError(`gemini: empty response for model ${req.model}`);
    return { text };
  },
};
