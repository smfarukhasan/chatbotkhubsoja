import type { PlatformType } from "./platformConnection";

export type CommentStatus = "pending" | "replied" | "ignored" | "flagged" | "need_review";
export type CommentReplyStatus = "draft" | "queued" | "sent" | "failed";
export type CommentSenderType = "llm_bot" | "human_admin" | "system" | "customer";

export type CommentAssignee = {
  user_id: number;
  full_name: string | null;
  email: string;
};

export type FacebookCommentReply = {
  id: number;
  account_id: number;
  comment_id: number;
  created_by_user_id: number | null;
  sender_type: CommentSenderType;
  reply_status: CommentReplyStatus;
  content: string;
  external_reply_id: string | null;
  error_message: string | null;
  sent_at: string | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type FacebookCommentSummary = {
  id: number;
  account_id: number;
  platform_connection_id: number | null;
  platform_type: PlatformType;
  status: CommentStatus;
  post_external_id: string;
  post_title: string | null;
  post_url: string | null;
  external_comment_id: string;
  parent_external_comment_id: string | null;
  commenter_external_id: string;
  commenter_name: string | null;
  commenter_avatar_url: string | null;
  comment_text: string;
  ai_draft_reply: string | null;
  flagged_reason: string | null;
  moderation_notes: string | null;
  commented_at: string | null;
  last_replied_at: string | null;
  metadata_json: Record<string, unknown>;
  assigned_to: CommentAssignee | null;
  reply_count: number;
  created_at: string;
  updated_at: string;
};

export type FacebookCommentDetail = FacebookCommentSummary & {
  replies: FacebookCommentReply[];
};

export type FacebookCommentListResponse = {
  items: FacebookCommentSummary[];
  total: number;
  page: number;
  page_size: number;
};

export type FacebookCommentPostSummary = {
  post_external_id: string;
  platform_connection_id: number | null;
  post_title: string | null;
  post_url: string | null;
  post_content: string | null;
  media_urls: string[];
  comment_count: number;
  pending_count: number;
  latest_comment_at: string | null;
  latest_comment_preview: string | null;
};

export type FacebookCommentPostDetail = FacebookCommentPostSummary & {
  comments: FacebookCommentSummary[];
};

export type FacebookCommentPostListResponse = {
  items: FacebookCommentPostSummary[];
  total: number;
  page: number;
  page_size: number;
};
