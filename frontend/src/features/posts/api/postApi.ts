import { apiClient } from "../../../lib/api/client";
import type { PostStatus, SocialPost, SocialPostListResponse } from "../../../shared/types/posts";

export async function listPosts(params?: {
  status?: PostStatus | "";
  platform_connection_id?: number;
  page?: number;
  page_size?: number;
}): Promise<SocialPostListResponse> {
  const response = await apiClient.get<SocialPostListResponse>("/posts", { params });
  return response.data;
}

export async function getPost(postId: number): Promise<SocialPost> {
  const response = await apiClient.get<SocialPost>(`/posts/${postId}`);
  return response.data;
}

export async function createPost(payload: Record<string, unknown>): Promise<SocialPost> {
  const response = await apiClient.post<SocialPost>("/posts", payload);
  return response.data;
}

export async function updatePost(postId: number, payload: Record<string, unknown>): Promise<SocialPost> {
  const response = await apiClient.put<SocialPost>(`/posts/${postId}`, payload);
  return response.data;
}

export async function deletePost(postId: number): Promise<void> {
  await apiClient.delete(`/posts/${postId}`);
}

export async function approvePost(postId: number, note?: string): Promise<SocialPost> {
  const response = await apiClient.post<SocialPost>(`/posts/${postId}/approve`, { note });
  return response.data;
}

export async function rejectPost(postId: number, reason: string): Promise<SocialPost> {
  const response = await apiClient.post<SocialPost>(`/posts/${postId}/reject`, { reason });
  return response.data;
}

export async function schedulePost(postId: number, scheduledFor: string): Promise<SocialPost> {
  const response = await apiClient.post<SocialPost>(`/posts/${postId}/schedule`, { scheduled_for: scheduledFor });
  return response.data;
}

export async function publishPostNow(postId: number): Promise<SocialPost> {
  const response = await apiClient.post<SocialPost>(`/posts/${postId}/publish-now`);
  return response.data;
}

export async function togglePostAiAutoReply(postId: number, enabled: boolean): Promise<SocialPost> {
  const response = await apiClient.patch<SocialPost>(`/posts/${postId}/ai-auto-reply`, { ai_auto_reply_enabled: enabled });
  return response.data;
}
