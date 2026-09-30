import '../../../only';
import { z } from 'zod';
import { IntegrationError } from '../../../../application/ports/integration-error';

type Fetch = typeof fetch;

const envelope = z.object({
  code: z.number(),
  result: z.boolean().optional(),
  success: z.boolean().optional(),
  message: z.string().nullable().optional(),
  data: z.unknown(),
}).passthrough();

const authentication = envelope.extend({
  data: z.object({
    accessToken: z.string().min(1),
    accessTokenExpiryDate: z.string().min(1),
  }).passthrough(),
});

function isSuccess(value: z.infer<typeof envelope>) {
  return value.result === true || value.success === true;
}

function providerError(status: number, value?: z.infer<typeof envelope>) {
  const message = value?.message?.toLowerCase() ?? '';
  const code = value?.code;
  if (status === 401 || status === 403 || code === 1600001 || code === 1601000) {
    return new IntegrationError('authentication', 'cj');
  }
  if (status === 429 || message.includes('rate limit')) {
    return new IntegrationError('rate_limited', 'cj');
  }
  if (status === 404 || message.includes('not find') || message.includes('not exist')) {
    return new IntegrationError('not_found', 'cj');
  }
  return new IntegrationError('unavailable', 'cj');
}

export class CjClient {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private authenticationInFlight: Promise<string> | null = null;
  private requestQueue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly baseUrl = 'https://developers.cjdropshipping.com/api2.0/v1',
    private readonly minimumRequestIntervalMs = 1_100,
  ) {}

  private async waitForRequestSlot() {
    if (this.minimumRequestIntervalMs <= 0) return;
    const previous = this.requestQueue;
    let release = () => {};
    this.requestQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const wait = Math.max(0, this.nextRequestAt - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.nextRequestAt = Date.now() + this.minimumRequestIntervalMs;
    release();
  }

  private async parseResponse(response: Response) {
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new IntegrationError('invalid_payload', 'cj');
    }
    const parsed = envelope.safeParse(raw);
    if (!parsed.success) throw new IntegrationError('invalid_payload', 'cj');
    if (!response.ok || !isSuccess(parsed.data)) {
      throw providerError(response.status, parsed.data);
    }
    return parsed.data;
  }

  private async authenticate() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken;
    if (this.authenticationInFlight) return this.authenticationInFlight;
    this.authenticationInFlight = this.requestAccessToken().finally(() => {
      this.authenticationInFlight = null;
    });
    return this.authenticationInFlight;
  }

  private async requestAccessToken() {
    await this.waitForRequestSlot();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/authentication/getAccessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: this.apiKey }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new IntegrationError('unavailable', 'cj');
    }
    const parsed = authentication.safeParse(await this.parseResponse(response));
    if (!parsed.success) throw new IntegrationError('invalid_payload', 'cj');
    this.accessToken = parsed.data.data.accessToken;
    const expiry = Date.parse(parsed.data.data.accessTokenExpiryDate);
    this.accessTokenExpiresAt = Number.isFinite(expiry) ? expiry - 60_000 : Date.now();
    return this.accessToken;
  }

  async get(
    path: string,
    retryAuthentication = true,
  ): Promise<z.infer<typeof envelope>> {
    const token = await this.authenticate();
    await this.waitForRequestSlot();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: { 'CJ-Access-Token': token },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new IntegrationError('unavailable', 'cj');
    }
    if (response.status === 401 && retryAuthentication) {
      this.accessToken = null;
      this.accessTokenExpiresAt = 0;
      return this.get(path, false);
    }
    return this.parseResponse(response);
  }
}
