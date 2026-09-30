import '../../only';
import { z } from 'zod';
import type { QueryExpansion } from '../../../domain/discovery';
import type {
  QueryExpansionInput,
  QueryExpansionProvider,
} from '../../../application/ports/query-expansion-provider';

const expansionOutput = z.object({
  expansions: z.array(z.object({
    query: z.string().min(1).max(200),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(300),
  })).max(8),
});

const ollamaResponse = z.object({ response: z.string() }).passthrough();

export class OllamaQueryExpansionProvider implements QueryExpansionProvider {
  readonly name = 'ollama';

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async expand(input: QueryExpansionInput): Promise<QueryExpansion[]> {
    const schema = z.toJSONSchema(expansionOutput);
    const prompt = [
      'Generate conservative ecommerce supplier-catalog search expansions.',
      `Original query: ${JSON.stringify(input.originalQuery)}`,
      `Profile: ${JSON.stringify(input.profile.name)}`,
      `Category hints: ${JSON.stringify(input.profile.search.categoryHints)}`,
      `Known synonyms: ${JSON.stringify(input.profile.search.synonyms)}`,
      `Excluded terms: ${JSON.stringify(input.profile.search.negativeTerms)}`,
      `Return at most ${input.maximumExpansions} expansions. Preserve the original buying intent.`,
      'Do not add brands, claims, audiences, or product categories unsupported by the input.',
      `Return JSON matching this schema: ${JSON.stringify(schema)}`,
    ].join('\n');
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          format: schema,
          options: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error('Ollama query expansion is unavailable.');
    }
    if (!response.ok) throw new Error('Ollama query expansion is unavailable.');
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new Error('Ollama returned malformed JSON.'); }
    const envelope = ollamaResponse.safeParse(raw);
    if (!envelope.success) throw new Error('Ollama returned an invalid response.');
    let content: unknown;
    try { content = JSON.parse(envelope.data.response); } catch { throw new Error('Ollama returned invalid structured output.'); }
    const parsed = expansionOutput.safeParse(content);
    if (!parsed.success) throw new Error('Ollama returned invalid structured output.');
    return parsed.data.expansions.slice(0, input.maximumExpansions).map((expansion) => ({
      ...expansion,
      source: 'local_model' as const,
    }));
  }
}
