import { apiClient } from "../../../lib/api/client";
import type {
  AiChatMode,
  ConversationDetail,
  ConversationAiChatState,
  ConversationListResponse,
  ConversationStatus,
  ConversationSummary,
  InboxMessage,
  LiveFacebookConversationListResponse,
  LiveFacebookMessage,
  LiveFacebookMessageListResponse,
  MessageListResponse,
  SenderType,
} from "../../../shared/types/inbox";
import type { PlatformType } from "../../../shared/types/platformConnection";

export async function listConversations(params?: {
  status?: ConversationStatus | "";
  platform?: PlatformType | "";
  search?: string;
  page?: number;
  page_size?: number;
}): Promise<ConversationListResponse> {
  const sanitizedParams = Object.fromEntries(
    Object.entries(params ?? {}).filter(([, value]) => value !== "" && value !== undefined && value !== null),
  );
  const response = await apiClient.get<ConversationListResponse>("/inbox/conversations", { params: sanitizedParams });
  return response.data;
}

export async function getConversation(conversationId: number): Promise<ConversationDetail> {
  const response = await apiClient.get<ConversationDetail>(`/inbox/conversations/${conversationId}`);
  return response.data;
}

export async function listConversationMessages(
  conversationId: number,
  params?: { page?: number; page_size?: number },
): Promise<MessageListResponse> {
  const response = await apiClient.get<MessageListResponse>(`/inbox/conversations/${conversationId}/messages`, { params });
  return response.data;
}

export async function assignConversation(
  conversationId: number,
  assigneeUserId: number | null,
): Promise<ConversationSummary> {
  const response = await apiClient.post<ConversationSummary>(`/inbox/conversations/${conversationId}/assign`, {
    assignee_user_id: assigneeUserId,
  });
  return response.data;
}

export async function updateConversationStatus(
  conversationId: number,
  payload: { status: ConversationStatus; paused_until?: string | null },
): Promise<ConversationSummary> {
  const response = await apiClient.patch<ConversationSummary>(`/inbox/conversations/${conversationId}/status`, payload);
  return response.data;
}

export async function updateConversationAiChat(
  conversationId: number,
  payload: { mode: AiChatMode; manual_minutes?: number },
): Promise<ConversationAiChatState> {
  const response = await apiClient.patch<ConversationAiChatState>(`/inbox/conversations/${conversationId}/ai-chat`, payload);
  return response.data;
}

export async function sendReply(
  conversationId: number,
  payload: { content: string; sender_type: Extract<SenderType, "human_admin" | "llm_bot"> },
): Promise<InboxMessage> {
  const response = await apiClient.post<InboxMessage>(`/inbox/conversations/${conversationId}/reply`, payload);
  return response.data;
}

export async function listLiveFacebookConversations(params?: {
  connection_id?: number;
  page_size?: number;
  after?: string;
}): Promise<LiveFacebookConversationListResponse> {
  const response = await apiClient.get<LiveFacebookConversationListResponse>("/inbox/facebook/live/conversations", { params });
  return response.data;
}

export async function listLiveFacebookMessages(
  conversationId: string,
  params: {
    connection_id: number;
    page_size?: number;
    after?: string;
  },
): Promise<LiveFacebookMessageListResponse> {
  const response = await apiClient.get<LiveFacebookMessageListResponse>(
    `/inbox/facebook/live/conversations/${encodeURIComponent(conversationId)}/messages`,
    { params },
  );
  return response.data;
}

export async function sendLiveFacebookReply(payload: {
  connection_id: number;
  recipient_id: string;
  content: string;
}): Promise<LiveFacebookMessage> {
  const response = await apiClient.post<LiveFacebookMessage>("/inbox/facebook/live/reply", payload);
  return response.data;
}

export async function updateLiveFacebookConversationAiChat(
  conversationId: string,
  payload: {
    connection_id: number;
    customer_external_id: string;
    customer_name?: string | null;
    mode: AiChatMode;
    manual_minutes?: number;
  },
): Promise<ConversationAiChatState> {
  const response = await apiClient.patch<ConversationAiChatState>(
    `/inbox/facebook/live/conversations/${encodeURIComponent(conversationId)}/ai-chat`,
    payload,
  );
  return response.data;
}
