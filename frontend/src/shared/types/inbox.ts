import type { PlatformType } from "./platformConnection";

export type ConversationStatus = "open" | "assigned" | "paused" | "resolved" | "escalated";
export type SenderType = "customer" | "llm_bot" | "human_admin" | "system";
export type MessageDirection = "inbound" | "outbound";
export type MessageDeliveryStatus = "pending" | "queued" | "sent" | "delivered" | "failed";
export type AiChatMode = "auto" | "manual" | "off";

export type ConversationAssignee = {
  user_id: number;
  full_name: string | null;
  email: string;
};

export type InboxMessage = {
  id: number;
  account_id: number;
  conversation_id: number;
  created_by_user_id: number | null;
  sender_type: SenderType;
  direction: MessageDirection;
  delivery_status: MessageDeliveryStatus;
  sender_name: string | null;
  sender_external_id: string | null;
  external_message_id: string | null;
  content: string;
  error_message: string | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ConversationSummary = {
  id: number;
  account_id: number;
  platform_connection_id: number | null;
  platform_type: PlatformType;
  status: ConversationStatus;
  external_thread_id: string | null;
  customer_external_id: string;
  customer_name: string | null;
  customer_avatar_url: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  subject: string | null;
  latest_message_preview: string | null;
  latest_message_at: string | null;
  paused_until: string | null;
  resolved_at: string | null;
  last_inbound_at: string | null;
  ai_chat_mode: AiChatMode;
  ai_chat_manual_until: string | null;
  unread_count: number;
  assigned_to: ConversationAssignee | null;
  created_at: string;
  updated_at: string;
};

export type ConversationDetail = ConversationSummary & {
  messages_total: number;
  messages: InboxMessage[];
};

export type ConversationListResponse = {
  items: ConversationSummary[];
  total: number;
  page: number;
  page_size: number;
};

export type MessageListResponse = {
  items: InboxMessage[];
  total: number;
  page: number;
  page_size: number;
};

export type LiveFacebookParticipant = {
  id: string;
  name: string | null;
  email: string | null;
};

export type LiveFacebookConversation = {
  id: string;
  platform_connection_id: number;
  connection_name: string;
  page_id: string;
  customer_external_id: string;
  customer_name: string | null;
  latest_message_preview: string | null;
  latest_message_at: string | null;
  ai_chat_mode: AiChatMode;
  ai_chat_manual_until: string | null;
  unread_count: number;
  message_count: number;
  link: string | null;
  participants: LiveFacebookParticipant[];
};

export type ConversationAiChatState = {
  ai_chat_mode: AiChatMode;
  ai_chat_manual_until: string | null;
};

export type LiveFacebookConversationListResponse = {
  items: LiveFacebookConversation[];
  total: number;
  page_size: number;
  next_cursor: string | null;
};

export type LiveFacebookMessage = {
  id: string;
  conversation_id: string;
  platform_connection_id: number;
  created_at: string | null;
  sender_name: string | null;
  sender_external_id: string | null;
  direction: MessageDirection;
  content: string;
  recipients: LiveFacebookParticipant[];
  raw_delivery_label: string;
};

export type LiveFacebookMessageListResponse = {
  items: LiveFacebookMessage[];
  total: number;
  page_size: number;
  next_cursor: string | null;
};
