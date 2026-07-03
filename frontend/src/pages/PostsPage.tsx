import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { LoadingPanel } from "../components/common/LoadingPanel";
import { CustomSelect } from "../components/common/CustomSelect";
import { PageHeader } from "../components/common/PageHeader";
import { useFacebookPageScope } from "../features/platformConnections/hooks/useFacebookPageScope";
import { approvePost, listPosts, publishPostNow, rejectPost, togglePostAiAutoReply } from "../features/posts/api/postApi";
import type { PostStatus, SocialPost } from "../shared/types/posts";

const STATUS_OPTIONS: Array<{ value: PostStatus; label: string }> = [
  { value: "draft", label: "Draft" },
  { value: "approved", label: "Approved" },
  { value: "scheduled", label: "Scheduled" },
  { value: "published", label: "Published" },
  { value: "failed", label: "Failed" },
  { value: "rejected", label: "Rejected" },
];

export function PostsPage() {
  const navigate = useNavigate();
  const {
    connections: facebookConnections,
    loadingConnections: loadingFacebookConnections,
    activeFacebookConnectionId,
    activeConnection,
  } = useFacebookPageScope();
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [statusFilter, setStatusFilter] = useState<PostStatus | "">("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPosts = async () => {
    if (loadingFacebookConnections) {
      return;
    }
    setLoading(true);
    if (facebookConnections.length === 0) {
      setPosts([]);
      setError(null);
      setLoading(false);
      return;
    }
    if (!activeFacebookConnectionId) {
      setPosts([]);
      setError(null);
      setLoading(false);
      return;
    }
    try {
      const response = await listPosts({
        status: statusFilter,
        platform_connection_id: activeFacebookConnectionId,
      });
      setPosts(response.items);
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to load posts.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPosts();
  }, [activeFacebookConnectionId, facebookConnections.length, loadingFacebookConnections, statusFilter]);

  const handleApprove = async (postId: number) => {
    await approvePost(postId);
    setMessage("Post approved.");
    await loadPosts();
  };

  const handleReject = async (postId: number) => {
    const reason = window.prompt("Enter rejection reason", "Needs revision");
    if (!reason) return;
    await rejectPost(postId, reason);
    setMessage("Post rejected.");
    await loadPosts();
  };

  const handlePublishNow = async (postId: number) => {
    await publishPostNow(postId);
    setMessage("Publish job queued.");
    await loadPosts();
  };

  const handleAiToggle = async (postId: number, currentEnabled: boolean) => {
    try {
      await togglePostAiAutoReply(postId, !currentEnabled);
      setMessage(!currentEnabled ? "AI auto-reply enabled." : "AI auto-reply disabled.");
      await loadPosts();
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to toggle AI.");
    }
  };

  const formatDateTime = (dateStr: string | null) => {
    if (!dateStr) return "Not scheduled";
    const date = new Date(dateStr);
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const ampm = hours >= 12 ? "pm" : "am";
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${day}-${month}-${year} ${hours}:${minutes}${ampm}`;
  };

  return (
    <section>
      <PageHeader
        eyebrow="Posts"
        title="Facebook post automation"
        description="Manage drafts, approvals, schedules, and publish workflows for Facebook-ready content with future AI and media publishing support."
      />

      {message ? <div className="panel success-panel">{message}</div> : null}
      {error ? <div className="panel error-panel">{error}</div> : null}
      {!loadingFacebookConnections && activeConnection ? (
        <div className="panel">Showing posts for {activeConnection.name}.</div>
      ) : null}
      {!loadingFacebookConnections && facebookConnections.length === 0 ? (
        <div className="panel">No connected Facebook Page is available for post management.</div>
      ) : null}

      <div className="panel posts-toolbar">
        <label className="posts-status-filter">
          Status filter
          <CustomSelect
            className="posts-status-filter-select"
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as PostStatus | "")}
            options={[{ value: "", label: "All statuses" }, ...STATUS_OPTIONS]}
          />
        </label>
        <button type="button" onClick={() => navigate("/posts/new")}>Create post</button>
      </div>

      <div className="table-card">
        <div className="table-card-header">
          <h3>Posts</h3>
          <span className="muted-copy small-copy">{posts.length} loaded</span>
        </div>
        {loading || loadingFacebookConnections ? (
          <LoadingPanel message="Loading posts..." hint="Reading draft, scheduled, and published content." compact />
        ) : null}
        {!loading && !loadingFacebookConnections && facebookConnections.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Generated by</th>
                <th>Schedule</th>
                <th>AI</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {posts.map((post) => (
                <tr key={post.id}>
                  <td>
                    <strong>{post.title || "Untitled post"}</strong>
                    <div className="muted-copy small-copy">{post.content.slice(0, 80)}{post.content.length > 80 ? "..." : ""}</div>
                  </td>
                  <td><span className={`status-pill post-status-${post.status}`}>{post.status}</span></td>
                  <td>{post.generated_by}{post.is_llm_generated ? " | AI" : ""}</td>
                  <td>{formatDateTime(post.scheduled_for)}</td>
                  <td>
                    <button
                      type="button"
                      className={`ai-toggle-btn ${post.ai_auto_reply_enabled ? "enabled" : ""}`}
                      onClick={() => handleAiToggle(post.id, post.ai_auto_reply_enabled)}
                      title={post.ai_auto_reply_enabled ? "AI auto-reply is ON" : "AI auto-reply is OFF"}
                    >
                      {post.ai_auto_reply_enabled ? "ON" : "OFF"}
                    </button>
                  </td>
                  <td className="table-actions">
                    <Link className="link-button" to={`/posts/${post.id}`}>Edit</Link>
                    {post.status === "draft" || post.status === "rejected" ? (
                      <button type="button" className="link-button" onClick={() => handleApprove(post.id)}>
                        Approve
                      </button>
                    ) : null}
                    {post.status !== "published" ? (
                      <button type="button" className="link-button" onClick={() => handlePublishNow(post.id)}>
                        Publish now
                      </button>
                    ) : null}
                    {post.status !== "published" ? (
                      <button type="button" className="link-button danger-link" onClick={() => handleReject(post.id)}>
                        Reject
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {posts.length === 0 ? (
                <tr>
                  <td colSpan={6}>No posts found.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  );
}
