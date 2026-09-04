// scripts/critique/providers/types.ts
// A small provider interface so run.ts can treat OpenRouter and direct Gemini identically:
// give it a model id, a system prompt, and a user prompt; get back raw text or a thrown
// error. Routing (which provider owns which model id) lives in providers/index.ts.
export interface CriticRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface CriticResponse {
  text: string;
}

export interface CallOptions {
  apiKey: string;
  timeoutMs: number;
}

export interface Provider {
  name: 'openrouter' | 'gemini';
  /** True if this provider owns the given model id (routing only -- does not check the id
   *  is a real/current model, since that list is UNKNOWN-to-be-current by design; see
   *  docs/CRITIQUE-LOOP.md). */
  supports(model: string): boolean;
  call(req: CriticRequest, opts: CallOptions): Promise<CriticResponse>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
