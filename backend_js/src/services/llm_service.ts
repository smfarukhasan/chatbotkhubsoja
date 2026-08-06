import { prisma } from '../core/db.js';
import { getSettings } from '../config/settings.js';
import { logger } from '../core/logging.js';

export interface GenerateCompletionOptions {
  accountId: number;
  actorUserId: number | null;
  promptText: string;
  promptType: string;
  aiAgentId?: number | null;
  platformConnectionId?: number | null;
  featureName: string;
  referenceType?: string | null;
  referenceId?: string | null;
  instructions?: string | null;
  skipStyleExamples?: boolean;
  skipProducts?: boolean;
}

export interface GenerateCompletionResult {
  content: string;
  provider: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

export type CustomerIntent = 'purchase' | 'casual' | 'not_permitted';

export interface IntentEvaluation {
  intent: CustomerIntent;
  confidence: number;
  reason: string;
}

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
const INTERNAL_MODEL = 'internal-reply-model-v1';
const OPENAI_INPUT_RATE_PER_1K = 0.00015;
const OPENAI_OUTPUT_RATE_PER_1K = 0.0006;
const GROQ_INPUT_RATE_PER_1K = 0.00059;
const GROQ_OUTPUT_RATE_PER_1K = 0.00079;
const GEMINI_INPUT_RATE_PER_1K = 0.0003;
const GEMINI_OUTPUT_RATE_PER_1K = 0.0025;
const INTERNAL_RATE_PER_1K = 0.002;

// Tokenizer supports ASCII and Bengali script ranges.
const TOKEN_PATTERN = /[a-z0-9\u0980-\u09FF]+/g;

const tokenize = (text: string): string[] => (text || '').toLowerCase().match(TOKEN_PATTERN) || [];

const keywordOverlap = (a: string, b: string): number => {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  let score = 0;
  for (const token of tokensA) {
    if (token.length >= 3 && tokensB.has(token)) {
      score += 1;
    }
  }
  return score;
};

const capitalize = (value: string): string => {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
};

const roundTo6 = (value: number): number => Math.round(value * 1e6) / 1e6;

const GEMINI_RETRY_ATTEMPTS = 3;
const GEMINI_RETRY_BASE_DELAY_MS = 2000;

// Parse the suggested retry delay from a Gemini 429 error message, e.g. "retry in 17.17s".
const parseGeminiRetryDelay = (message: string): number => {
  const match = message.match(/retry in ([\d.]+)s/i);
  return match ? Math.ceil(parseFloat(match[1]) * 1000) : GEMINI_RETRY_BASE_DELAY_MS;
};

// POST to the Gemini generateContent API with retry-on-429 (free-tier quota exhaustion).
const postGemini = async (modelName: string, apiKey: string, body: any): Promise<Response> => {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < GEMINI_RETRY_ATTEMPTS; attempt++) {
    const response = await fetch(`${GEMINI_API_URL}/${modelName}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });

    if (response.status !== 429 || attempt === GEMINI_RETRY_ATTEMPTS - 1) {
      return response;
    }

    let retryAfterMs = GEMINI_RETRY_BASE_DELAY_MS * (attempt + 1);
    try {
      const errorBody: any = await response.clone().json();
      retryAfterMs = parseGeminiRetryDelay(errorBody?.error?.message || '');
    } catch {
      // Non-JSON error body; use the exponential default.
    }
    logger.warn(`Gemini 429 (quota) on attempt ${attempt + 1}; retrying in ${Math.round(retryAfterMs / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    lastError = new Error(`Gemini 429 after ${attempt + 1} attempts`);
  }
  throw lastError;
};

const truncateText = (text: string, maxLength: number): string => {
  if (!text) return '';
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
};

async function findFaqMatches(accountId: number, aiAgentId: number | null | undefined, promptText: string): Promise<any[]> {
  const where: any = { account_id: accountId, is_active: true };
  if (aiAgentId) {
    where.ai_agent_id = aiAgentId;
  }
  const faqRows = await prisma.faq_knowledge.findMany({
    where,
    take: 100,
  });
  return faqRows
    .map((row) => ({ row, score: keywordOverlap(promptText, row.question) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.row);
}

async function findStyleExamples(accountId: number, aiAgentId: number | null | undefined, promptText: string): Promise<any[]> {
  const where: any = {
    account_id: accountId,
    metadata_json: { path: '$.kind', equals: 'conversation_style' },
  };
  if (aiAgentId) {
    where.ai_agent_id = aiAgentId;
  }
  const styleRows = await prisma.ai_knowledge_sources.findMany({
    where,
    take: 100,
  });
  return styleRows
    .map((row) => ({ row, score: keywordOverlap(promptText, row.title) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.row);
}

export async function findProducts(accountId: number, platformConnectionId: number | null | undefined, promptText: string): Promise<any[]> {
  const where: any = { account_id: accountId, is_available: true };
  if (platformConnectionId) {
    where.platform_connection_id = platformConnectionId;
  }
  const productRows = await prisma.products.findMany({
    where,
    take: 100,
  });
  return productRows
    .map((row) => ({ row, score: keywordOverlap(promptText, `${row.name} ${row.category || ''} ${row.description || ''}`) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.row);
}

function generateInternalContent(options: {
  promptType: string;
  promptText: string;
  faqMatches: any[];
  agent: any;
}): string {
  const { promptType, promptText, faqMatches, agent } = options;

  if (promptType === 'POST_GENERATION') {
    const businessType = agent?.business_type || 'our business';
    const subject = agent?.name || capitalize(businessType);
    const titleMatch = promptText.match(/Title hint:\s*([^\n]+)/i);
    const title = titleMatch ? titleMatch[1].trim() : null;
    if (title) {
      return `${title}\n\n${capitalize(businessType)} update: we are excited to share the latest news and offers with our valued customers. For details or questions, message us anytime.`;
    }
    return `We are excited to share an update from ${subject}!\n\nOur team is always working to serve you better, and new announcements are on the way. Follow this page and message us with any questions.`;
  }

  if (faqMatches.length > 0) {
    return faqMatches[0].answer;
  }

  const nameMatch = promptText.match(/Customer name:\s*([^\n]+)/i);
  const customerName = nameMatch ? nameMatch[1].trim() : null;
  const latestMatch = promptText.match(/Latest message:\s*([^\n]+)/i);
  const latest = latestMatch ? latestMatch[1].trim() : '';

  const greeting = customerName && customerName !== 'Unknown' ? `Hi ${customerName},` : 'Hello,';
  const ack = latest
    ? `Thank you for your message about "${latest.slice(0, 120)}".`
    : 'Thank you for reaching out to us.';
  return `${greeting}\n\n${ack} I have noted your inquiry and will make sure the right team member gets back to you shortly. If you need immediate assistance, please share any additional details.`;
}

export async function generateCompletion(options: GenerateCompletionOptions): Promise<GenerateCompletionResult> {
  const settings = getSettings();
  const {
    accountId,
    actorUserId,
    promptText,
    promptType,
    aiAgentId,
    platformConnectionId,
    featureName,
    referenceType,
    referenceId,
    instructions,
  } = options;

  const agent = aiAgentId
    ? await prisma.ai_agents.findFirst({ where: { id: aiAgentId, account_id: accountId } })
    : null;
  const faqMatches = await findFaqMatches(accountId, aiAgentId, promptText);
  const styleExamples = options.skipStyleExamples ? [] : await findStyleExamples(accountId, aiAgentId, promptText);
  const productMatches = options.skipProducts ? [] : await findProducts(accountId, platformConnectionId, promptText);

  const contextParts: string[] = [];
  if (instructions && instructions.trim()) {
    contextParts.push(`Instructions:\n${instructions.trim()}`);
  }
  if (promptText && promptText.trim()) {
    contextParts.push(promptText.trim());
  }
  if (agent) {
    contextParts.push(`Business context:\nAgent name: ${agent.name}${agent.business_type ? `\nBusiness type: ${agent.business_type}` : ''}`);
  }
  if (faqMatches.length > 0) {
    contextParts.push(`Knowledge base:\n${faqMatches.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')}`);
  }
  if (productMatches.length > 0) {
    contextParts.push(
      `Product catalog (recommend ONLY from these; never invent prices or products; if the customer asks about something not listed, say it is not currently available):\n${productMatches
        .map((p) => {
          const priceText = p.price_text || (p.currency && p.price ? `${p.currency} ${p.price}` : null) || 'not listed';
          const description = truncateText(p.description || '', 200);
          const available = p.is_available ? 'yes' : 'no';
          return `Product: ${p.name}\nPrice: ${priceText}\nDescription: ${description}\nAvailable: ${available}`;
        })
        .join('\n\n')}`
    );
  }
  if (styleExamples.length > 0) {
    contextParts.push(`Style examples (match this tone of voice):\n${styleExamples.map((s) => truncateText(s.content_text || '', 600)).join('\n\n')}`);
  }
  const composedPrompt = contextParts.join('\n\n');

  const promptTokens = Math.ceil(composedPrompt.length / 4);

  let provider: string;
  let modelName: string;
  let content: string;
  let completionTokens: number;
  let estimatedCost: number;

  const providerSetting = (settings.llm_default_provider || 'internal').toLowerCase();
  const openaiApiKey = settings.openai_api_key;
  const groqApiKey = settings.groq_api_key;
  const geminiApiKey = settings.gemini_api_key;

  if (providerSetting === 'openai' && openaiApiKey) {
    try {
      modelName =
        settings.llm_default_model && settings.llm_default_model !== INTERNAL_MODEL
          ? settings.llm_default_model
          : OPENAI_DEFAULT_MODEL;
      const response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            {
              role: 'system',
              content: 'You are an AI assistant helping businesses automate customer conversations, comment replies, and social media posts. Respond naturally, helpfully, and professionally.',
            },
            { role: 'user', content: composedPrompt },
          ],
          temperature: 0.7,
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }
      const data: any = await response.json();
      content = data?.choices?.[0]?.message?.content ?? '';
      completionTokens = data?.usage?.completion_tokens ?? Math.ceil(content.length / 4);
      estimatedCost = roundTo6(
        (promptTokens / 1000) * OPENAI_INPUT_RATE_PER_1K + (completionTokens / 1000) * OPENAI_OUTPUT_RATE_PER_1K
      );
      provider = 'openai';
    } catch {
      // Fall back to the internal deterministic provider on any OpenAI error.
      provider = 'internal';
      modelName = INTERNAL_MODEL;
      content = generateInternalContent({ promptType, promptText, faqMatches, agent });
      completionTokens = Math.ceil(content.length / 4);
      estimatedCost = roundTo6(((promptTokens + completionTokens) / 1000) * INTERNAL_RATE_PER_1K);
    }
  } else if (providerSetting === 'groq' && groqApiKey) {
    try {
      modelName =
        settings.llm_default_model && settings.llm_default_model !== INTERNAL_MODEL
          ? settings.llm_default_model
          : GROQ_DEFAULT_MODEL;
      const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${groqApiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            {
              role: 'system',
              content: 'You are an AI assistant helping businesses automate customer conversations, comment replies, and social media posts. Respond naturally, helpfully, and professionally. Match the customer\u2019s language (Bangla or English).',
            },
            { role: 'user', content: composedPrompt },
          ],
          temperature: 0.7,
          max_tokens: 1024,
        }),
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Groq API error: ${response.status} ${response.statusText} ${errorText.slice(0, 300)}`);
      }
      const data: any = await response.json();
      content = data?.choices?.[0]?.message?.content ?? '';
      completionTokens = data?.usage?.completion_tokens ?? Math.ceil(content.length / 4);
      estimatedCost = roundTo6(
        (promptTokens / 1000) * GROQ_INPUT_RATE_PER_1K + (completionTokens / 1000) * GROQ_OUTPUT_RATE_PER_1K
      );
      provider = 'groq';
    } catch (err: any) {
      // Fall back to the internal deterministic provider on any Groq error.
      logger.error(`Groq generation failed, falling back to internal: ${err?.message || err}`);
      provider = 'internal';
      modelName = INTERNAL_MODEL;
      content = generateInternalContent({ promptType, promptText, faqMatches, agent });
      completionTokens = Math.ceil(content.length / 4);
      estimatedCost = roundTo6(((promptTokens + completionTokens) / 1000) * INTERNAL_RATE_PER_1K);
    }
  } else if (providerSetting === 'gemini' && geminiApiKey) {
    try {
      modelName =
        settings.llm_default_model && settings.llm_default_model !== INTERNAL_MODEL
          ? settings.llm_default_model
          : GEMINI_DEFAULT_MODEL;
      const response = await postGemini(modelName, geminiApiKey, {
        system_instruction: {
          parts: [
            {
              text: 'You are an AI assistant helping businesses automate customer conversations, comment replies, and social media posts. Respond naturally, helpfully, and professionally. Match the customer\u2019s language (Bangla or English).',
            },
          ],
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: composedPrompt }],
          },
        ],
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Gemini API error: ${response.status} ${response.statusText} ${errorText.slice(0, 300)}`);
      }
      const data: any = await response.json();
      content =
        data?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text ?? '').join('') ?? '';
      completionTokens =
        data?.usageMetadata?.candidatesTokenCount ?? Math.ceil(content.length / 4);
      estimatedCost = roundTo6(
        (promptTokens / 1000) * GEMINI_INPUT_RATE_PER_1K + (completionTokens / 1000) * GEMINI_OUTPUT_RATE_PER_1K
      );
      provider = 'gemini';
    } catch (err: any) {
      // Fall back to the internal deterministic provider on any Gemini error.
      logger.error(`Gemini generation failed, falling back to internal: ${err?.message || err}`);
      provider = 'internal';
      modelName = INTERNAL_MODEL;
      content = generateInternalContent({ promptType, promptText, faqMatches, agent });
      completionTokens = Math.ceil(content.length / 4);
      estimatedCost = roundTo6(((promptTokens + completionTokens) / 1000) * INTERNAL_RATE_PER_1K);
    }
  } else {
    provider = 'internal';
    modelName = INTERNAL_MODEL;
    content = generateInternalContent({ promptType, promptText, faqMatches, agent });
    completionTokens = Math.ceil(content.length / 4);
    estimatedCost = roundTo6(((promptTokens + completionTokens) / 1000) * INTERNAL_RATE_PER_1K);
  }

  const totalTokens = promptTokens + completionTokens;

  await prisma.llm_token_usage.create({
    data: {
      account_id: accountId,
      platform_connection_id: platformConnectionId ?? null,
      actor_user_id: actorUserId,
      provider,
      model_name: modelName,
      feature_name: featureName,
      reference_type: referenceType ?? null,
      reference_id: referenceId ?? null,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      estimated_cost: estimatedCost,
      request_count: 1,
      used_at: new Date(),
      metadata_json: {},
    },
  });

  await prisma.action_usage_logs.create({
    data: {
      account_id: accountId,
      platform_connection_id: platformConnectionId ?? null,
      actor_user_id: actorUserId,
      action_type: 'AI_REPLY_GENERATION',
      platform_type: null,
      reference_type: referenceType ?? null,
      reference_id: referenceId ?? null,
      quantity: 1,
      tokens_consumed: totalTokens,
      estimated_cost: estimatedCost,
      occurred_at: new Date(),
      metadata_json: {},
    },
  });

  return {
    content,
    provider,
    modelName,
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCost,
  };
}

// ---------------------------------------------------------------------------
// Customer-intent evaluation
// ---------------------------------------------------------------------------

export const DEFAULT_INTENT_POLICY_TEXT =
  'Do not promise discounts, free items, off-platform deals, credit, or anything not offered on the page; be honest about product details.';

const INTENT_KEYWORDS: Record<CustomerIntent, string[]> = {
  purchase: ['দাম', 'কত', 'অর্ডার', 'পাঠান', 'স্টক', 'ডেলিভারি', 'পেমেন্ট', 'বিক্রি', 'price', 'order', 'delivery', 'payment', 'stock', 'available'],
  not_permitted: ['ফ্রি', 'দিস', 'বিনামূল্যে', 'ছাড়', 'কিস্তি', 'ধার', 'give me free', 'discount', 'borrow'],
  casual: ['হ্যালো', 'কেমন', 'hello', 'hi', 'ki obosta'],
};

const INTENT_VALUES: CustomerIntent[] = ['purchase', 'casual', 'not_permitted'];

const INTENT_LABELS: Record<CustomerIntent, string> = {
  purchase: 'Purchase intent',
  casual: 'Casual/small talk',
  not_permitted: 'Not-permitted request',
};

function buildIntentSystemPrompt(policyText: string): string {
  return [
    'You are a customer-intent classifier for a business\'s social-media chat inbox. Classify the customer\'s overall intent from the conversation tail into exactly one category:',
    '- "purchase": the customer genuinely wants to buy — asking about price, stock, order, payment, or delivery.',
    '- "casual": the customer is just passing time — greetings, small talk, no buying intent.',
    '- "not_permitted": the customer is requesting something the page owner does not permit.',
    '',
    'Page policy:',
    policyText,
    '',
    'Reply with STRICT JSON only, no markdown, no extra text:',
    '{"intent":"purchase"|"casual"|"not_permitted","confidence":0.0,"reason":"short reason"}',
  ].join('\n');
}

function parseIntentEvaluation(raw: string): IntentEvaluation | null {
  if (!raw) return null;
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  let obj: any;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const intent = String(obj?.intent ?? '').toLowerCase();
  if (!INTENT_VALUES.includes(intent as CustomerIntent)) return null;
  const confidenceNum = Number(obj?.confidence);
  if (!Number.isFinite(confidenceNum)) return null;
  const confidence = Math.min(1, Math.max(0, confidenceNum));
  const reason =
    typeof obj?.reason === 'string' && obj.reason.trim()
      ? obj.reason.trim().slice(0, 300)
      : `${INTENT_LABELS[intent as CustomerIntent]} detected.`;
  return { intent: intent as CustomerIntent, confidence, reason };
}

function evaluateIntentHeuristic(tailText: string): IntentEvaluation {
  const lower = (tailText || '').toLowerCase();
  const tokens = new Set(tokenize(lower));
  const scores: Record<CustomerIntent, number> = { purchase: 0, casual: 0, not_permitted: 0 };
  const hits: Record<CustomerIntent, string[]> = { purchase: [], casual: [], not_permitted: [] };

  for (const intent of INTENT_VALUES) {
    for (const keyword of INTENT_KEYWORDS[intent]) {
      const lowerKeyword = keyword.toLowerCase();
      const matched = lowerKeyword.includes(' ')
        ? lower.includes(lowerKeyword)
        : tokens.has(lowerKeyword);
      if (matched) {
        scores[intent] += 1;
        hits[intent].push(keyword);
      }
    }
  }

  const ranked = INTENT_VALUES.map((intent) => ({ intent, score: scores[intent] })).sort(
    (a, b) => b.score - a.score
  );
  const top = ranked[0];
  const second = ranked[1];

  let confidence: number;
  if (top.score === 0) {
    confidence = 0.55;
  } else if (second.score === 0) {
    confidence = 0.9;
  } else {
    const margin = top.score - second.score;
    confidence = Math.min(0.95, 0.55 + 0.25 * margin);
  }

  const reason =
    hits[top.intent].length > 0
      ? `${INTENT_LABELS[top.intent]} — signals: ${hits[top.intent].join(', ')}.`
      : `${INTENT_LABELS[top.intent]} — no strong signals; default classification.`;

  return { intent: top.intent, confidence, reason };
}

export async function evaluateCustomerIntent(
  accountId: number,
  aiAgentId: number | null | undefined,
  tailText: string,
  policyText: string
): Promise<IntentEvaluation> {
  const settings = getSettings();
  const providerSetting = (settings.llm_default_provider || 'internal').toLowerCase();
  const openaiApiKey = settings.openai_api_key;
  const groqApiKey = settings.groq_api_key;
  const geminiApiKey = settings.gemini_api_key;

  if (providerSetting === 'openai' && openaiApiKey) {
    try {
      const modelName =
        settings.llm_default_model && settings.llm_default_model !== INTERNAL_MODEL
          ? settings.llm_default_model
          : OPENAI_DEFAULT_MODEL;
      const response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: 'system', content: buildIntentSystemPrompt(policyText) },
            { role: 'user', content: tailText || '(empty conversation tail)' },
          ],
          temperature: 0,
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenAI intent API error: ${response.status} ${response.statusText}`);
      }
      const data: any = await response.json();
      const raw = data?.choices?.[0]?.message?.content ?? '';
      const parsed = parseIntentEvaluation(raw);
      if (parsed) return parsed;
    } catch {
      // Fall through to the deterministic heuristic on any OpenAI failure.
    }
  } else if (providerSetting === 'groq' && groqApiKey) {
    try {
      const modelName =
        settings.llm_default_model && settings.llm_default_model !== INTERNAL_MODEL
          ? settings.llm_default_model
          : GROQ_DEFAULT_MODEL;
      const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${groqApiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: 'system', content: buildIntentSystemPrompt(policyText) },
            { role: 'user', content: tailText || '(empty conversation tail)' },
          ],
          temperature: 0,
          max_tokens: 200,
        }),
      });
      if (!response.ok) {
        throw new Error(`Groq intent API error: ${response.status} ${response.statusText}`);
      }
      const data: any = await response.json();
      const raw = data?.choices?.[0]?.message?.content ?? '';
      const parsed = parseIntentEvaluation(raw);
      if (parsed) return parsed;
    } catch (err: any) {
      // Fall through to the deterministic heuristic on any Groq failure.
      logger.error(`Groq intent evaluation failed, using heuristic: ${err?.message || err}`);
    }
  } else if (providerSetting === 'gemini' && geminiApiKey) {
    try {
      const modelName =
        settings.llm_default_model && settings.llm_default_model !== INTERNAL_MODEL
          ? settings.llm_default_model
          : GEMINI_DEFAULT_MODEL;
      const response = await postGemini(modelName, geminiApiKey, {
        system_instruction: { parts: [{ text: buildIntentSystemPrompt(policyText) }] },
        contents: [{ role: 'user', parts: [{ text: tailText || '(empty conversation tail)' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 200 },
      });
      if (!response.ok) {
        throw new Error(`Gemini intent API error: ${response.status} ${response.statusText}`);
      }
      const data: any = await response.json();
      const raw =
        data?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text ?? '').join('') ?? '';
      const parsed = parseIntentEvaluation(raw);
      if (parsed) return parsed;
    } catch (err: any) {
      // Fall through to the deterministic heuristic on any Gemini failure.
      logger.error(`Gemini intent evaluation failed, using heuristic: ${err?.message || err}`);
    }
  }

  return evaluateIntentHeuristic(tailText);
}

export async function resolveIntentPolicy(
  accountId: number,
  aiAgentId: number | null | undefined
): Promise<string | null> {
  let agentConnectionId: number | null = null;
  if (aiAgentId) {
    const agent = await prisma.ai_agents.findFirst({
      where: { id: aiAgentId, account_id: accountId },
      select: { platform_connection_id: true },
    });
    agentConnectionId = agent?.platform_connection_id ?? null;
  }

  const baseWhere = {
    account_id: accountId,
    prompt_type: 'INTENT_POLICY' as const,
    is_active: true,
  };

  const levels: Array<{ scope: string; where: any }> = [];
  if (aiAgentId && agentConnectionId) {
    levels.push({
      scope: 'agent+connection',
      where: { ai_agent_id: aiAgentId, platform_connection_id: agentConnectionId },
    });
  }
  if (agentConnectionId) {
    levels.push({
      scope: 'connection',
      where: { platform_connection_id: agentConnectionId, ai_agent_id: null },
    });
  }
  if (aiAgentId) {
    levels.push({
      scope: 'agent',
      where: { ai_agent_id: aiAgentId, platform_connection_id: null },
    });
  }
  levels.push({ scope: 'account', where: { ai_agent_id: null, platform_connection_id: null } });

  for (const level of levels) {
    const prompt = await prisma.ai_prompts.findFirst({
      where: { ...baseWhere, ...level.where },
      orderBy: { updated_at: 'desc' },
    });
    if (prompt) {
      return prompt.content;
    }
  }
  return null;
}

export function buildIntentRefusal(language: 'bn' | 'en' = 'bn'): string {
  if (language === 'en') {
    return 'Sorry, we are unable to support this request. Our policy does not allow it. Please let us know if we can help with anything else.';
  }
  return 'দুঃখিত, এই অনুরোধটি আমরা সাপোর্ট করতে পারছি না। আমাদের নিয়ম অনুযায়ী এটি সম্ভব নয়। অন্য কোনো বিষয়ে সাহায্য করতে চাইলে বলুন।';
}
