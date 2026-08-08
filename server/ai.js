// AI service layer — abstracts the LLM provider behind a simple interface.
// Defaults to a local/rule-based fallback when no API key is configured so the
// application remains fully functional out-of-the-box (no fake responses — the
// fallback explicitly escalates whenever it cannot answer confidently).

import 'dotenv/config';

const SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT || '';
const HUMAN_TOKEN = '[[HUMAN_REQUIRED]]';

const KB = `
Electricalskart is an electrical appliances and consumer electronics retailer in India.
We sell: fans, lights (LED, decorative, panel lights, flood lights), switches & switchgear, wires & cables, MCBs, RCCBs, distribution boards, water heaters (geysers), RO water purifiers, irons, mixer grinders, ceiling fans, exhaust fans, LED bulbs, tube lights, inverters & batteries, stabilizers, extension boards, doorbells, and small home appliances.
Brands we typically carry: Havells, Philips, Crompton, Bajaj, Orient, Anchor by Panasonic, Syska, V-Guard, Luminous, Microtek, Prestige, Usha, Wipro, GM Modular.
Free home installation is available for large appliances (geysers, RO purifiers, fans) within the city service area.
Service / warranty: most products carry manufacturer warranty; we help with warranty claims.
Store hours: Monday–Saturday 10am–8pm, Sunday 11am–4pm.
We accept cash, UPI, cards, and EMI on select cards.
For order status, returns, complaints, bulk orders, dealer pricing, custom electrical installations, onsite service booking, or price quotes — a human support agent must assist.
`.trim();

function detectEscalation(text) {
  const t = text.toLowerCase();
  const keywords = [
    'complain','complaint','refund','return','cancel',
    'my order','order status','track order',
    'warranty claim','broken','damaged','not working',
    'price','quote','discount','offer','bulk','dealer',
    'service booking','technician','visit my home','onsite','install at',
    'speak to human','talk to agent','call me','call support','human agent',
    'negotiate','custom','special request'
  ];
  return keywords.some(k => t.includes(k));
}

function localFallbackReply(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const q = lastUser.toLowerCase();

  if (/^(hi|hello|hey|namaste|hola)\b/.test(q)) {
    return `Hello! Welcome to Electricalskart support. How can I help you today? You can ask about our products, brands, installation, store hours, or click "Call Now" to speak with a support agent.`;
  }
  if (/hour|timing|open|close|when/.test(q)) {
    return `Our store hours are Monday–Saturday 10am–8pm, and Sunday 11am–4pm IST. For anything specific like ordering or bulk enquiries, I'll connect you to an agent. ${HUMAN_TOKEN}`;
  }
  if (/brand|company|which company/.test(q)) {
    return `We carry trusted brands including Havells, Philips, Crompton, Bajaj, Orient, Anchor by Panasonic, Syska, V-Guard, Luminous, Microtek, Usha, Wipro, GM Modular, and Prestige. If you're looking for a specific product, let me know!`;
  }
  if (/ro|water purifier|purifier/.test(q)) {
    return `We stock RO water purifiers from brands like Havells, V-Guard, and others, suitable for home and office use. For specific model availability, exact pricing and installation in your area, I'll have a support agent assist you. ${HUMAN_TOKEN}`;
  }
  if (/geyser|water heater/.test(q)) {
    return `We offer water heaters (geysers) in storage and instant variants across brands like Havells, Bajaj, V-Guard, Crompton, and Usha. For pricing, model selection and free installation booking, an agent will help. ${HUMAN_TOKEN}`;
  }
  if (/fan|ceiling fan|exhaust/.test(q)) {
    return `We have ceiling fans, table fans, pedestal fans, and exhaust fans from Havells, Crompton, Usha, Orient and Bajaj. Most models include standard installation. For exact model pricing and availability, I'll connect you to an agent. ${HUMAN_TOKEN}`;
  }
  if (/install|installation/.test(q)) {
    return `Free home installation is available for large appliances (geysers, RO purifiers, fans) within our city service area. To book an installation, I'll connect you to a support agent. ${HUMAN_TOKEN}`;
  }
  if (/payment|upi|card|emi|cash/.test(q)) {
    return `We accept cash, UPI, all major debit/credit cards, and EMI on select cards. For order-specific payment help, I'll connect you to an agent. ${HUMAN_TOKEN}`;
  }
  if (/delivery|shipping/.test(q)) {
    return `We offer local delivery within the city. For delivery timelines and charges for your order, I'll connect you to an agent. ${HUMAN_TOKEN}`;
  }
  if (/warranty|service|repair/.test(q)) {
    return `Most products come with manufacturer warranty and we assist with warranty claims and service. To raise a service request I'll connect you to an agent. ${HUMAN_TOKEN}`;
  }
  if (/bulk|dealer|wholesale/.test(q)) {
    return `For bulk / dealer pricing a support agent will assist you shortly. ${HUMAN_TOKEN}`;
  }
  if (/light|led|bulb|tube/.test(q)) {
    return `We have a wide range of LED bulbs, tube lights, panel lights, flood lights and decorative lights from Philips, Syska, Havells, Wipro, Crompton, Bajaj and others. For specific models and pricing I'll connect you to an agent. ${HUMAN_TOKEN}`;
  }
  if (/wire|cable|mcb|rccb|switch|switchgear|distribution board|db/.test(q)) {
    return `We stock wires & cables, MCBs, RCCBs, switches, modular switchgear and distribution boards from brands like Havells, Anchor, GM, L&T, Finolex and Polycab. For your project requirements I'll connect you to an agent. ${HUMAN_TOKEN}`;
  }
  if (/inverter|battery|stabilizer/.test(q)) {
    return `We carry inverters, batteries and voltage stabilizers from Luminous, Microtek, V-Guard and Exide. For sizing and exact pricing I'll connect you to an agent. ${HUMAN_TOKEN}`;
  }
  if (/product|sell|what do you (sell|have)|categories|items/.test(q)) {
    return `We offer a wide range of electrical & home appliances: fans, LED lights, switches & switchgear, wires & cables, MCBs/RCCBs, geysers, RO water purifiers, mixer grinders, irons, inverters, batteries, stabilizers, doorbells and more, across top brands like Havells, Philips, Crompton, Bajaj, Orient, Anchor, Syska, V-Guard and Luminous. For specific product availability and pricing, I'll connect you to an agent. ${HUMAN_TOKEN}`;
  }
  // Default: don't guess
  return `I'd like to make sure I give you accurate information, so I'll connect you to a support representative who can help with "${lastUser}". ${HUMAN_TOKEN}`;
}

async function openAIChat(messages) {
  const key = process.env.AI_API_KEY;
  if (!key) return null; // no key configured
  const base = process.env.AI_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT + '\n\nReference knowledge:\n' + KB },
          ...messages,
        ],
      }),
    });
    if (!res.ok) {
      console.warn('[ai] provider error', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn('[ai] provider fetch failed', err.message);
    return null;
  }
}

/**
 * Returns { text, needsHuman }
 */
export async function generateReply(messages) {
  // Keyword pre-check: if user is clearly asking for human/order/complaint, escalate fast.
  const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  let text = null;
  const provider = (process.env.AI_PROVIDER || '').toLowerCase();
  if (keyConfigured() && provider !== 'local') {
    text = await openAIChat(messages);
  }
  if (!text) text = localFallbackReply(messages);

  // Detect explicit token first
  let needsHuman = text.includes(HUMAN_TOKEN);
  text = text.replace(HUMAN_TOKEN, '').trim();
  if (!needsHuman) needsHuman = detectEscalation(lastUser);

  return { text, needsHuman };
}

export async function suggestReply(messages) {
  const augmented = [
    ...messages,
    {
      role: 'user',
      content:
        '[INTERNAL] Draft a short, polite reply the support agent can send to the customer. Output only the reply, no explanations.',
    },
  ];
  if (keyConfigured()) {
    const t = await openAIChat(augmented);
    if (t) return t;
  }
  // Local fallback suggestion: echo a brief helpful line
  const last = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  return `Thank you for your patience. Regarding "${last.slice(0, 80)}", I'm checking that for you now and will get back in a moment.`;
}

function keyConfigured() {
  return !!(process.env.AI_API_KEY && process.env.AI_API_KEY.length > 10);
}
