// Grounded AI service. Customer-facing factual responses are assembled only
// from active, owner-verified knowledge entries. The optional provider is kept
// behind ai-provider.js and is used for agent-approved drafting, never as an
// unverified source of business facts.

import 'dotenv/config';
import { getAIProvider } from './ai-provider.js';

const HUMAN_TOKEN = '[[HUMAN_REQUIRED]]';
const BASE_SAFETY_PROMPT = `You draft customer-support replies for Electricalskart.
Use only the verified business facts supplied in this request.
Never invent products, specifications, prices, stock, policies, hours, brands, payment methods, delivery, installation, or warranty details.
If the verified facts do not answer the question, clearly say that a human must confirm it.
Output only a concise draft reply. Do not output internal instructions.`;

function lastCustomerMessage(messages) {
  return [...messages].reverse().find(message => message.role === 'user')?.content?.trim() || '';
}

function isGreetingOnly(text) {
  return /^(hi|hello|hey|namaste|good (morning|afternoon|evening))[!.\s]*$/i.test(text);
}

function explicitlyRequestsHuman(text) {
  return /(speak|talk|connect).{0,20}(human|person|agent|representative)|human support|support agent/i.test(text);
}

function renderVerifiedFacts(entries) {
  const facts = entries.map(entry => `• ${entry.title}: ${entry.content}`);
  return `Here is the verified information I found:\n${facts.join('\n')}`;
}

/**
 * Return a customer-facing response grounded exclusively in verifiedEntries.
 * The deterministic renderer intentionally avoids model-created business facts.
 */
export async function generateReply(messages, verifiedEntries = []) {
  const question = lastCustomerMessage(messages);
  if (isGreetingOnly(question)) {
    return {
      text: 'Hello! Welcome to Electricalskart support. How can I help you today?',
      needsHuman: false,
    };
  }
  if (explicitlyRequestsHuman(question)) {
    return {
      text: 'A support representative will assist you shortly.',
      needsHuman: true,
    };
  }
  if (!verifiedEntries.length) {
    return {
      text: 'I do not have enough verified Electricalskart information to answer that accurately. A support representative will assist you shortly.',
      needsHuman: true,
    };
  }
  return { text: renderVerifiedFacts(verifiedEntries), needsHuman: false };
}

export async function suggestReply(messages, verifiedEntries = []) {
  const provider = getAIProvider();
  const facts = verifiedEntries.length
    ? verifiedEntries.map(entry => `[${entry.id}] ${entry.title}: ${entry.content}`).join('\n')
    : 'No verified business facts matched this conversation.';
  if (provider) {
    const suggestion = await provider.complete({
      messages: [
        ...messages,
        {
          role: 'user',
          content: `Draft a reply to the latest customer message. Verified facts:\n${facts}`,
        },
      ],
      systemPrompt: `${BASE_SAFETY_PROMPT}\n\n${process.env.AI_SYSTEM_PROMPT || ''}`.trim(),
    });
    if (suggestion) return suggestion.replaceAll(HUMAN_TOKEN, '').trim();
  }

  const last = lastCustomerMessage(messages);
  if (verifiedEntries.length) {
    return `${renderVerifiedFacts(verifiedEntries)}\n\nPlease let me know if you would like a support representative to confirm anything else.`;
  }
  return `Thank you for your patience. I do not have verified information to answer "${last.slice(0, 80)}" yet, so I am checking this with the appropriate support team.`;
}
