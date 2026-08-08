import 'dotenv/config';

const SUPPORTED_PROVIDERS = new Set(['openai', 'openai-compatible']);

export function validateAIConfiguration(environment = process.env) {
  const provider = (environment.AI_PROVIDER || '').trim().toLowerCase();
  if (!provider || provider === 'local') return { provider: 'local' };
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported AI_PROVIDER "${provider}". Supported values: local, openai-compatible.`);
  }
  if (!environment.AI_API_KEY || environment.AI_API_KEY.length < 10) {
    throw new Error(`AI_API_KEY is required when AI_PROVIDER=${provider}.`);
  }
  return {
    provider,
    apiKey: environment.AI_API_KEY,
    model: environment.AI_MODEL || 'gpt-4o-mini',
    baseUrl: (environment.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    timeoutMs: Math.min(Math.max(Number.parseInt(environment.AI_TIMEOUT_MS || '15000', 10), 1000), 60_000),
  };
}

export function getAIProvider(environment = process.env) {
  const config = validateAIConfiguration(environment);
  if (config.provider === 'local') return null;
  return {
    name: config.provider,
    async complete({ messages, systemPrompt }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            temperature: 0.2,
            messages: [
              { role: 'system', content: systemPrompt },
              ...messages,
            ],
          }),
        });
        if (!response.ok) {
          console.warn(`[ai] Provider request failed with status ${response.status}.`);
          return null;
        }
        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim() || null;
      } catch (error) {
        console.warn(`[ai] Provider request failed: ${error.name === 'AbortError' ? 'timeout' : error.message}`);
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
