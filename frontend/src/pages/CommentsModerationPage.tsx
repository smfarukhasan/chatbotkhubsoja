import { FormEvent, useEffect, useMemo, useState } from "react";

import { CustomField, CustomTextArea } from "../components/common/CustomField";
import { LoadingPanel } from "../components/common/LoadingPanel";
import { CustomSelect } from "../components/common/CustomSelect";
import { PageHeader } from "../components/common/PageHeader";
import { listTeamMembers } from "../features/accounts/api/accountApi";
import { generateCommentReply } from "../features/ai/api/aiApi";
import {
  createCommentReply,
  getComment,
  listComments,
  updateCommentStatus,
} from "../features/comments/api/commentsApi";
import { useAuthStore } from "../features/auth/store/authStore";
import { useFacebookPageScope } from "../features/platformConnections/hooks/useFacebookPageScope";
import { listPosts } from "../features/posts/api/postApi";
import type { TeamMember } from "../shared/types/account";
import type {
  CommentReplyStatus,
  CommentStatus,
  FacebookCommentDetail,
  FacebookCommentReply,
  FacebookCommentSummary,
} from "../shared/types/comments";
import type { SocialPost } from "../shared/types/posts";

const STATUS_OPTIONS: Array<{ value: CommentStatus; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "replied", label: "Replied" },
  { value: "ignored", label: "Ignored" },
  { value: "flagged", label: "Flagged" },
  { value: "need_review", label: "Needs review" },
];

const REPLY_STATUS_LABELS: Record<CommentReplyStatus, string> = {
  draft: "Draft",
  queued: "Queued",
  sent: "Sent",
  failed: "Failed",
};

export function CommentsModerationPage() {
  const activeAccountId = useAuthStore((state) => state.activeAccountId);
  const currentUser = useAuthStore((state) => state.user);
  const {
    connections: facebookConnections,
    loadingConnections: loadingFacebookConnections,
    activeFacebookConnectionId,
    activeConnection,
  } = useFacebookPageScope();

  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [selectedPostId, setSelectedPostId] = useState<number | null>(null);
  const [postComments, setPostComments] = useState<FacebookCommentSummary[]>([]);
  const [selectedCommentId, setSelectedCommentId] = useState<number | null>(null);
  const [detail, setDetail] = useState<FacebookCommentDetail | null>(null);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [loadingPostDetail, setLoadingPostDetail] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const [savingReply, setSavingReply] = useState(false);
  const [generatingReply, setGeneratingReply] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({ status: "" as CommentStatus | "", search: "" });
  const [replyText, setReplyText] = useState("");
  const [replyMode, setReplyMode] = useState<"human_admin" | "llm_bot">("human_admin");
  const [moderationNotes, setModerationNotes] = useState("");
  const [flaggedReason, setFlaggedReason] = useState("");
  const [assigneeUserId, setAssigneeUserId] = useState("unassigned");

  const filteredPosts = useMemo(() => {
    const term = filters.search.trim().toLowerCase();
    if (!term) return posts;
    return posts.filter((post) =>
      [post.title, post.content, post.external_post_id]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(term)),
    );
  }, [filters.search, posts]);

  const selectedPost = useMemo(
    () => filteredPosts.find((post) => post.id === selectedPostId) ?? null,
    [filteredPosts, selectedPostId],
  );

  const selectedComment = useMemo(() => {
    const summary = postComments.find((comment) => comment.id === selectedCommentId) ?? null;
    if (detail && detail.id === selectedCommentId) {
      return {
        ...summary,
        ...detail,
      } as FacebookCommentDetail;
    }
    return summary ?? detail;
  }, [detail, postComments, selectedCommentId]);

  const loadPosts = async (preferredPostId?: number | null) => {
    if (loadingFacebookConnections) {
      return;
    }
    setLoadingPosts(true);
    if (facebookConnections.length === 0 || !activeFacebookConnectionId) {
      setPosts([]);
      setPostComments([]);
      setDetail(null);
      setSelectedPostId(null);
      setSelectedCommentId(null);
      setError(null);
      setLoadingPosts(false);
      return;
    }

    try {
      const response = await listPosts({
        platform_connection_id: activeFacebookConnectionId,
        page_size: 100,
      });
      setPosts(response.items);
      setError(null);

      const nextPostId = preferredPostId ?? selectedPostId;
      const visiblePosts = response.items.filter((post) =>
        [post.title, post.content, post.external_post_id]
          .filter(Boolean)
          .some((value) => !filters.search.trim() || value!.toLowerCase().includes(filters.search.trim().toLowerCase())),
      );
      if (nextPostId && visiblePosts.some((item) => item.id === nextPostId)) {
        setSelectedPostId(nextPostId);
      } else {
        setSelectedPostId(visiblePosts[0]?.id ?? null);
      }
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to load Facebook posts.");
      setPosts([]);
      setSelectedPostId(null);
      setSelectedCommentId(null);
      setPostComments([]);
      setDetail(null);
    } finally {
      setLoadingPosts(false);
    }
  };

  const loadPostComments = async (post: SocialPost) => {
    setLoadingPostDetail(true);
    try {
      const response = await listComments({
        status: filters.status,
        platform_connection_id: activeFacebookConnectionId ?? undefined,
        post_external_id: post.external_post_id ?? undefined,
        page_size: 100,
      });
      setPostComments(response.items);
      setError(null);
      setSelectedCommentId((current) =>
        current && response.items.some((comment) => comment.id === current) ? current : response.items[0]?.id ?? null,
      );
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to load Facebook post details.");
      setPostComments([]);
      setSelectedCommentId(null);
    } finally {
      setLoadingPostDetail(false);
    }
  };

  const loadCommentDetail = async (commentId: number) => {
    setLoadingDetail(true);
    try {
      const response = await getComment(commentId);
      setDetail(response);
      setModerationNotes(response.moderation_notes || "");
      setFlaggedReason(response.flagged_reason || "");
      setAssigneeUserId(response.assigned_to?.user_id ? String(response.assigned_to.user_id) : "unassigned");
      setReplyText(response.ai_draft_reply || "");
      setReplyMode(response.ai_draft_reply ? "llm_bot" : "human_admin");
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to load comment.");
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  const refreshCurrentView = async (preferredCommentId?: number | null) => {
    const currentPostId = selectedPostId;
    const currentPost = selectedPost;
    if (!currentPostId || !currentPost) return;
    await loadPosts(currentPostId);
    await loadPostComments(currentPost);
    const nextCommentId = preferredCommentId ?? selectedCommentId;
    if (nextCommentId) {
      await loadCommentDetail(nextCommentId);
    }
  };

  useEffect(() => {
    void loadPosts(null);
    listTeamMembers().then(setTeamMembers).catch(() => setTeamMembers([]));
  }, [activeAccountId, activeFacebookConnectionId, facebookConnections.length, filters.status, loadingFacebookConnections]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadPosts(selectedPostId);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [activeFacebookConnectionId, filters.search, loadingFacebookConnections]);

  useEffect(() => {
    if (selectedPost) {
      void loadPostComments(selectedPost);
    } else {
      setPostComments([]);
      setDetail(null);
      setSelectedCommentId(null);
      setReplyText("");
    }
  }, [selectedPost]);

  useEffect(() => {
    if (selectedCommentId) {
      setReplyText("");
      void loadCommentDetail(selectedCommentId);
    } else {
      setDetail(null);
      setReplyText("");
    }
  }, [selectedCommentId]);

  const applyCommentUpdate = (updated: FacebookCommentSummary) => {
    setPostComments((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    setDetail((current) =>
      current && current.id === updated.id
        ? {
            ...current,
            ...updated,
          }
        : current,
    );
  };

  const handleStatusAction = async (status: CommentStatus) => {
    if (!selectedCommentId || !selectedComment) return;
    setSavingStatus(true);
    try {
      const updated = await updateCommentStatus(selectedCommentId, {
        status,
        assignee_user_id: selectedComment.assigned_to?.user_id ?? undefined,
        flagged_reason: flaggedReason || undefined,
        moderation_notes: moderationNotes || undefined,
      });
      applyCommentUpdate(updated);
      await refreshCurrentView(selectedCommentId);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to update comment.");
    } finally {
      setSavingStatus(false);
    }
  };

  const handleAssigneeSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedCommentId || !selectedComment) return;
    setSavingStatus(true);
    try {
      const updated = await updateCommentStatus(selectedCommentId, {
        status: selectedComment.status,
        assignee_user_id: assigneeUserId !== "unassigned" ? Number(assigneeUserId) : null,
        flagged_reason: flaggedReason || undefined,
        moderation_notes: moderationNotes || undefined,
      });
      applyCommentUpdate(updated);
      await refreshCurrentView(selectedCommentId);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to save assignee.");
    } finally {
      setSavingStatus(false);
    }
  };

  const handleReply = async (sendNow: boolean) => {
    if (!selectedCommentId || !replyText.trim()) return;
    setSavingReply(true);
    try {
      await createCommentReply(selectedCommentId, {
        content: replyText.trim(),
        sender_type: replyMode,
        send_now: sendNow,
        metadata_json: {
          source: sendNow ? "manual_moderation" : "draft_moderation",
        },
      });
      if (sendNow) {
        setReplyText("");
      }
      await refreshCurrentView(selectedCommentId);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to create reply.");
    } finally {
      setSavingReply(false);
    }
  };

  const handleGenerateReply = async () => {
    if (!selectedCommentId) return;
    setGeneratingReply(true);
    try {
      const result = await generateCommentReply({
        comment_id: selectedCommentId,
        persist_draft: false,
      });
      setReplyText(result.content);
      setReplyMode("llm_bot");
      if (result.requires_approval) {
        setError("AI draft generated and requires review before sending.");
      } else {
        setError(null);
      }
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to generate AI reply.");
    } finally {
      setGeneratingReply(false);
    }
  };

  return (
    <section>
      <PageHeader
        eyebrow="Comments"
        title="Facebook comment moderation"
        description="Browse Facebook posts, inspect their comments, and send manual or AI-assisted replies from one workspace."
      />

      {error ? <div className="panel error-panel">{error}</div> : null}
      {!loadingFacebookConnections && activeConnection ? (
        <div className="panel">Showing comments for {activeConnection.name}.</div>
      ) : null}
      {!loadingFacebookConnections && facebookConnections.length === 0 ? (
        <div className="panel">No connected Facebook Page is available for comment moderation.</div>
      ) : null}

      <div className="comments-page">
        <aside className="comments-sidebar">
          <div className="panel comments-toolbar">
            <label>
              Status
              <CustomSelect
                value={filters.status}
                onChange={(value) => setFilters((current) => ({ ...current, status: value as CommentStatus | "" }))}
                options={[{ value: "", label: "All statuses" }, ...STATUS_OPTIONS]}
              />
            </label>
            <label>
              Search
              <CustomField
                type="search"
                value={filters.search}
                onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                placeholder="Post title or comment text"
              />
            </label>
          </div>

          <div className="table-card comments-list">
            <div className="table-card-header">
              <h3>Posts</h3>
              <span className="muted-copy small-copy">{posts.length} loaded</span>
            </div>
            {loadingPosts || loadingFacebookConnections ? (
              <LoadingPanel message="Loading posts..." hint="Collecting Facebook posts with comment activity." compact />
            ) : null}
            {!loadingPosts && !loadingFacebookConnections && facebookConnections.length > 0 && filteredPosts.length === 0 ? (
              <div className="panel">No posts match the current filter.</div>
            ) : null}
            <div className="comment-list post-list">
              {filteredPosts.map((post) => (
                <button
                  key={post.id}
                  type="button"
                  className={`comment-row comment-post-row ${selectedPostId === post.id ? "active" : ""}`}
                  onClick={() => setSelectedPostId(post.id)}
                >
                  <div className="comment-row-top">
                    <strong>{post.title || post.external_post_id || `Post #${post.id}`}</strong>
                    <span className={`status-pill post-status-${post.status}`}>{post.status}</span>
                  </div>
                  <div className="muted-copy small-copy">
                    {post.published_at
                      ? `Published ${new Date(post.published_at).toLocaleString()}`
                      : post.scheduled_for
                        ? `Scheduled ${new Date(post.scheduled_for).toLocaleString()}`
                        : "Unpublished"}
                  </div>
                  <p>{post.content}</p>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <div className="comments-main">
          {!selectedPost ? (
            <div className="panel inbox-empty">Select a post to review comments and send replies.</div>
          ) : (
            <>
              <div className="panel comments-post-header">
                <div>
                  <h3>{selectedPost.title || selectedPost.external_post_id || `Post #${selectedPost.id}`}</h3>
                  <p className="muted-copy">
                    {selectedPost.external_post_id || "No external Facebook post ID yet"}
                  </p>
                </div>
                <div className="comments-status-actions">
                  <span className="status-pill">{postComments.length} comments</span>
                  <span className="status-pill">{postComments.filter((comment) => comment.status !== "replied").length} open</span>
                </div>
                <p className="comments-post-content">{selectedPost.content}</p>
                {selectedPost.media_urls.length > 0 ? (
                  <p className="muted-copy small-copy comments-post-meta">{selectedPost.media_urls.length} media attachment(s)</p>
                ) : null}
              </div>

              <div className="table-card comments-post-comments">
                <div className="table-card-header">
                  <h3>Comments</h3>
                  <span className="muted-copy small-copy">{postComments.length} loaded</span>
                </div>
                {loadingPostDetail ? (
                  <LoadingPanel message="Loading post comments..." hint="Preparing comments for the selected Facebook post." compact />
                ) : null}
                {!loadingPostDetail && postComments.length === 0 ? (
                  <div className="panel">No comments matched the current filter for this post.</div>
                ) : null}
                <div className="comment-list">
                  {postComments.map((comment) => (
                    <button
                      key={comment.id}
                      type="button"
                      className={`comment-row ${selectedCommentId === comment.id ? "active" : ""}`}
                      onClick={() => setSelectedCommentId(comment.id)}
                    >
                      <div className="comment-row-top">
                        <strong>{comment.commenter_name || comment.commenter_external_id}</strong>
                        <span className={`status-pill comment-status-${comment.status}`}>{comment.status.replace("_", " ")}</span>
                      </div>
                      <div className="muted-copy small-copy">
                        {comment.assigned_to?.full_name || comment.assigned_to?.email || "Unassigned"}
                        {" | "}
                        {comment.commented_at ? new Date(comment.commented_at).toLocaleString() : "No timestamp"}
                      </div>
                      <p>{comment.comment_text}</p>
                    </button>
                  ))}
                </div>
              </div>

              {!selectedComment ? (
                <div className="panel inbox-empty">Select a comment from the selected post to review reply history.</div>
              ) : (
                <>
                  <div className="panel comments-header">
                    <div>
                      <h3>{selectedComment.commenter_name || selectedComment.commenter_external_id}</h3>
                      <p className="muted-copy">
                        {selectedComment.commented_at ? new Date(selectedComment.commented_at).toLocaleString() : "No timestamp"}
                      </p>
                    </div>
                    <div className="comments-status-actions">
                      {STATUS_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={`ghost-button compact-button ${selectedComment.status === option.value ? "status-active" : ""}`}
                          onClick={() => handleStatusAction(option.value)}
                          disabled={savingStatus}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="comments-layout">
                    <div className="table-card comments-thread-card">
                      <div className="thread-scroll">
                        {loadingDetail ? (
                          <LoadingPanel message="Loading comment details..." hint="Syncing comment thread and reply history." compact />
                        ) : null}
                        {!loadingDetail && (
                          <>
                            <article className="comment-original-card">
                              <div className="message-meta">
                                <strong>Original comment</strong>
                                <span>{selectedComment.external_comment_id}</span>
                              </div>
                              <p>{selectedComment.comment_text}</p>
                            </article>

                            {detail?.replies.map((reply: FacebookCommentReply) => (
                              <article key={reply.id} className={`message-bubble ${reply.sender_type === "human_admin" ? "outbound" : "inbound"}`}>
                                <div className="message-meta">
                                  <strong>{reply.sender_type === "human_admin" ? currentUser?.full_name || "Admin" : "AI draft"}</strong>
                                  <span>{new Date(reply.created_at).toLocaleString()}</span>
                                </div>
                                <p>{reply.content}</p>
                                <span className={`message-delivery delivery-${reply.reply_status}`}>
                                  {REPLY_STATUS_LABELS[reply.reply_status]}
                                </span>
                              </article>
                            ))}
                          </>
                        )}
                      </div>

                      <div className="reply-box">
                        <div className="reply-toolbar">
                          <CustomSelect
                            value={replyMode}
                            onChange={(value) => setReplyMode(value as "human_admin" | "llm_bot")}
                            options={[
                              { value: "human_admin", label: "Human reply" },
                              { value: "llm_bot", label: "AI draft" },
                            ]}
                            variant="compact"
                          />
                          <span className="muted-copy small-copy">
                            {replyMode === "human_admin" ? "Manual moderator reply" : "Store or send AI-generated draft"}
                          </span>
                          <button
                            type="button"
                            className="secondary-action"
                            onClick={handleGenerateReply}
                            disabled={generatingReply || savingReply}
                          >
                            {generatingReply ? "Generating..." : "Generate AI reply"}
                          </button>
                        </div>
                        <CustomTextArea
                          value={replyText}
                          onChange={(event) => setReplyText(event.target.value)}
                          rows={6}
                          placeholder="Draft a reply..."
                        />
                        <div className="reply-actions">
                          <button type="button" className="secondary-action" onClick={() => handleReply(false)} disabled={savingReply || !replyText.trim()}>
                            {savingReply ? "Saving..." : "Save draft"}
                          </button>
                          <button type="button" onClick={() => handleReply(true)} disabled={savingReply || !replyText.trim()}>
                            {savingReply ? "Sending..." : "Send reply"}
                          </button>
                        </div>
                      </div>
                    </div>

                    <aside className="panel comments-side-panel">
                      <h3>Moderation</h3>
                      <dl className="detail-list">
                        <div>
                          <dt>Assigned to</dt>
                          <dd>{selectedComment.assigned_to?.full_name || selectedComment.assigned_to?.email || "Unassigned"}</dd>
                        </div>
                        <div>
                          <dt>Post</dt>
                          <dd>{selectedComment.post_title || selectedComment.post_external_id}</dd>
                        </div>
                        <div>
                          <dt>Flag reason</dt>
                          <dd>{selectedComment.flagged_reason || "None"}</dd>
                        </div>
                        <div>
                          <dt>AI draft</dt>
                          <dd>{selectedComment.ai_draft_reply || "No saved draft"}</dd>
                        </div>
                      </dl>

                      <form className="form-panel compact-form-panel" onSubmit={handleAssigneeSave}>
                        <label>
                          Assign moderator
                          <CustomSelect
                            value={assigneeUserId}
                            onChange={setAssigneeUserId}
                            disabled={savingStatus}
                            options={[
                              { value: "unassigned", label: "Unassigned" },
                              ...teamMembers.map((member) => ({
                                value: String(member.user_id),
                                label: `${member.full_name || member.email} (${member.role})`,
                              })),
                            ]}
                            variant="compact"
                          />
                        </label>
                        <label>
                          Flagged reason
                          <CustomField value={flaggedReason} onChange={(event) => setFlaggedReason(event.target.value)} />
                        </label>
                        <label>
                          Moderation notes
                          <CustomTextArea value={moderationNotes} rows={5} onChange={(event) => setModerationNotes(event.target.value)} />
                        </label>
                        <button type="submit" disabled={savingStatus}>
                          {savingStatus ? "Saving..." : "Save moderation"}
                        </button>
                      </form>
                    </aside>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
