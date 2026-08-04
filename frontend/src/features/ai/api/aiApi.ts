import { apiClient } from "../../../lib/api/client";
import type {
  AIAgent,
  AIAgentOverview,
  AIGenerationResponse,
  AIKnowledgeSource,
  AIPrompt,
  FAQKnowledge,
  PromptResolution,
} from "../../../shared/types/ai";

export async function listAIAgents(): Promise<AIAgentOverview[]> {
  const response = await apiClient.get<AIAgentOverview[]>("/ai/agents");
  return response.data;
}

export async function getAIAgent(agentId: number): Promise<AIAgentOverview> {
  const response = await apiClient.get<AIAgentOverview>(`/ai/agents/${agentId}`);
  return response.data;
}

export async function createAIAgent(payload: Record<string, unknown>): Promise<AIAgent> {
  const response = await apiClient.post<AIAgent>("/ai/agents", payload);
  return response.data;
}

export async function updateAIAgent(agentId: number, payload: Record<string, unknown>): Promise<AIAgent> {
  const response = await apiClient.put<AIAgent>(`/ai/agents/${agentId}`, payload);
  return response.data;
}

export async function listAIPrompts(params: { ai_agent_id?: number; platform_connection_id?: number } = {}): Promise<AIPrompt[]> {
  const response = await apiClient.get<AIPrompt[]>("/ai/prompts", { params });
  return response.data;
}

export async function createAIPrompt(payload: Record<string, unknown>): Promise<AIPrompt> {
  const response = await apiClient.post<AIPrompt>("/ai/prompts", payload);
  return response.data;
}

export async function updateAIPrompt(promptId: number, payload: Record<string, unknown>): Promise<AIPrompt> {
  const response = await apiClient.put<AIPrompt>(`/ai/prompts/${promptId}`, payload);
  return response.data;
}

export async function resolvePrompts(params: { ai_agent_id?: number; platform_connection_id?: number } = {}): Promise<PromptResolution[]> {
  const response = await apiClient.get<PromptResolution[]>("/ai/prompts/resolve/current", { params });
  return response.data;
}

export async function listKnowledgeSources(
  params: { ai_agent_id?: number; kind?: string } = {},
): Promise<AIKnowledgeSource[]> {
  const response = await apiClient.get<AIKnowledgeSource[]>("/ai/knowledge-sources", { params });
  return response.data;
}

export type CreateConversationStyleExamplesResponse = {
  items: AIKnowledgeSource[];
  skipped: number;
};

export async function createConversationStyleExamples(
  conversationIds: number[],
  aiAgentId?: number | null,
): Promise<CreateConversationStyleExamplesResponse> {
  const response = await apiClient.post<CreateConversationStyleExamplesResponse>("/ai/knowledge-sources/from-conversations", {
    conversation_ids: conversationIds,
    ai_agent_id: aiAgentId ?? null,
  });
  return response.data;
}

export async function deleteKnowledgeSource(sourceId: number): Promise<void> {
  await apiClient.delete(`/ai/knowledge-sources/${sourceId}`);
}

export async function createKnowledgeSource(payload: Record<string, unknown>): Promise<AIKnowledgeSource> {
  const response = await apiClient.post<AIKnowledgeSource>("/ai/knowledge-sources", payload);
  return response.data;
}

export async function updateKnowledgeSource(sourceId: number, payload: Record<string, unknown>): Promise<AIKnowledgeSource> {
  const response = await apiClient.put<AIKnowledgeSource>(`/ai/knowledge-sources/${sourceId}`, payload);
  return response.data;
}

export async function listFAQKnowledge(params: { ai_agent_id?: number } = {}): Promise<FAQKnowledge[]> {
  const response = await apiClient.get<FAQKnowledge[]>("/ai/faq", { params });
  return response.data;
}

export async function createFAQKnowledge(payload: Record<string, unknown>): Promise<FAQKnowledge> {
  const response = await apiClient.post<FAQKnowledge>("/ai/faq", payload);
  return response.data;
}

export async function updateFAQKnowledge(faqId: number, payload: Record<string, unknown>): Promise<FAQKnowledge> {
  const response = await apiClient.put<FAQKnowledge>(`/ai/faq/${faqId}`, payload);
  return response.data;
}

export async function generateInboxReply(payload: {
  conversation_id: number;
  ai_agent_id?: number;
  platform_connection_id?: number;
  instructions?: string;
  send_now?: boolean;
  persist_draft?: boolean;
}): Promise<AIGenerationResponse> {
  const response = await apiClient.post<AIGenerationResponse>("/ai/generation/inbox-reply", payload);
  return response.data;
}

export async function generateCommentReply(payload: {
  comment_id: number;
  ai_agent_id?: number;
  instructions?: string;
  send_now?: boolean;
  persist_draft?: boolean;
}): Promise<AIGenerationResponse> {
  const response = await apiClient.post<AIGenerationResponse>("/ai/generation/comment-reply", payload);
  return response.data;
}

export async function generatePostDraft(payload: {
  platform_connection_id?: number;
  ai_agent_id?: number;
  post_id?: number;
  title_hint?: string;
  instructions?: string;
  persist_draft?: boolean;
}): Promise<AIGenerationResponse> {
  const response = await apiClient.post<AIGenerationResponse>("/ai/generation/post", payload);
  return response.data;
}
