import type { PlatformType } from "./platformConnection";

export type PostStatus = "draft" | "approved" | "scheduled" | "published" | "failed" | "rejected";
export type PostGeneratedBy = "human_admin" | "llm_bot" | "system";

export type SocialPost = {
  id: number;
  account_id: number;
  platform_connection_id: number | null;
  ai_agent_id: number | null;
  ai_prompt_id: number | null;
  created_by_user_id: number | null;
  approved_by_user_id: number | null;
  rejected_by_user_id: number | null;
  platform_type: PlatformType;
  status: PostStatus;
  generated_by: PostGeneratedBy;
  title: string | null;
  content: string;
  media_urls: string[];
  external_post_id: string | null;
  is_llm_generated: boolean;
  requires_approval: boolean;
  ai_auto_reply_enabled: boolean;
  scheduled_for: string | null;
  published_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  last_error: string | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type SocialPostListResponse = {
  items: SocialPost[];
  total: number;
  page: number;
  page_size: number;
};
