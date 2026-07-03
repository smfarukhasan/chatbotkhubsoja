import { apiClient } from "../../../lib/api/client";
import type {
  CommentStatus,
  FacebookCommentDetail,
  FacebookCommentListResponse,
  FacebookCommentPostDetail,
  FacebookCommentPostListResponse,
  FacebookCommentReply,
  FacebookCommentSummary,
} from "../../../shared/types/comments";

export async function listComments(params?: {
  status?: CommentStatus | "";
  platform_connection_id?: number;
  post_external_id?: string;
  search?: string;
  page?: number;
  page_size?: number;
}): Promise<FacebookCommentListResponse> {
  const response = await apiClient.get<FacebookCommentListResponse>("/comments", { params });
  return response.data;
}

export async function getComment(commentId: number): Promise<FacebookCommentDetail> {
  const response = await apiClient.get<FacebookCommentDetail>(`/comments/${commentId}`);
  return response.data;
}

export async function listCommentPosts(params?: {
  status?: CommentStatus | "";
  platform_connection_id?: number;
  search?: string;
  page?: number;
  page_size?: number;
}): Promise<FacebookCommentPostListResponse> {
  const response = await apiClient.get<FacebookCommentPostListResponse>("/comments/posts", { params });
  return response.data;
}

export async function getCommentPost(
  postExternalId: string,
  params?: {
    status?: CommentStatus | "";
    platform_connection_id?: number;
  },
): Promise<FacebookCommentPostDetail> {
  const response = await apiClient.get<FacebookCommentPostDetail>(`/comments/posts/${encodeURIComponent(postExternalId)}`, {
    params,
  });
  return response.data;
}

export async function updateCommentStatus(
  commentId: number,
  payload: {
    status: CommentStatus;
    assignee_user_id?: number | null;
    flagged_reason?: string | null;
    moderation_notes?: string | null;
    metadata_json?: Record<string, unknown>;
  },
): Promise<FacebookCommentSummary> {
  const response = await apiClient.patch<FacebookCommentSummary>(`/comments/${commentId}/status`, payload);
  return response.data;
}

export async function createCommentReply(
  commentId: number,
  payload: {
    content: string;
    sender_type: "human_admin" | "llm_bot";
    send_now: boolean;
    metadata_json?: Record<string, unknown>;
  },
): Promise<FacebookCommentReply> {
  const response = await apiClient.post<FacebookCommentReply>(`/comments/${commentId}/replies`, payload);
  return response.data;
}
