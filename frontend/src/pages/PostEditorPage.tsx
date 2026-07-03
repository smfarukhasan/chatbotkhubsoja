import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { CustomField, CustomTextArea } from "../components/common/CustomField";
import { LoadingPanel } from "../components/common/LoadingPanel";
import { CustomSelect } from "../components/common/CustomSelect";
import { PageHeader } from "../components/common/PageHeader";
import { generatePostDraft, listAIAgents, listAIPrompts } from "../features/ai/api/aiApi";
import { approvePost, createPost, deletePost, getPost, publishPostNow, rejectPost, schedulePost, updatePost } from "../features/posts/api/postApi";
import { useFacebookPageScope } from "../features/platformConnections/hooks/useFacebookPageScope";
import type { AIAgentOverview, AIPrompt } from "../shared/types/ai";
import type { PlatformConnection } from "../shared/types/platformConnection";
import type { PostGeneratedBy, SocialPost } from "../shared/types/posts";

function toLocalDateTimeInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

export function PostEditorPage() {
  const navigate = useNavigate();
  const params = useParams();
  const postId = params.postId ? Number(params.postId) : null;
  const isEditing = Number.isFinite(postId);
  const { connections: facebookConnections, activeFacebookConnectionId } = useFacebookPageScope();

  const [post, setPost] = useState<SocialPost | null>(null);
  const [connections, setConnections] = useState<PlatformConnection[]>([]);
  const [agents, setAgents] = useState<AIAgentOverview[]>([]);
  const [prompts, setPrompts] = useState<AIPrompt[]>([]);
  const [loading, setLoading] = useState(Boolean(isEditing));
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generationHint, setGenerationHint] = useState("");
  const [form, setForm] = useState({
    title: "",
    content: "",
    media_urls: "",
    platform_connection_id: "",
    ai_agent_id: "",
    ai_prompt_id: "",
    generated_by: "human_admin" as PostGeneratedBy,
    is_llm_generated: false,
    requires_approval: false,
    metadata_json: "{\n  \"campaign\": \"default\"\n}",
    scheduled_for: "",
  });

  const loadDependencies = async () => {
    const [agentResponse, promptResponse] = await Promise.all([
      listAIAgents(),
      listAIPrompts(),
    ]);
    setAgents(agentResponse);
    setPrompts(promptResponse.filter((item) => item.prompt_type === "post_generation"));
  };

  useEffect(() => {
    loadDependencies().catch(() => setError("Unable to load post dependencies."));
  }, [facebookConnections]);

  useEffect(() => {
    setConnections(facebookConnections);
  }, [facebookConnections]);

  useEffect(() => {
    if (!isEditing || !postId) return;
    setLoading(true);
    getPost(postId)
      .then((response) => {
        setPost(response);
        setForm({
          title: response.title || "",
          content: response.content,
          media_urls: response.media_urls.join("\n"),
          platform_connection_id: response.platform_connection_id ? String(response.platform_connection_id) : "",
          ai_agent_id: response.ai_agent_id ? String(response.ai_agent_id) : "",
          ai_prompt_id: response.ai_prompt_id ? String(response.ai_prompt_id) : "",
          generated_by: response.generated_by,
          is_llm_generated: response.is_llm_generated,
          requires_approval: response.requires_approval,
          metadata_json: JSON.stringify(response.metadata_json, null, 2),
          scheduled_for: toLocalDateTimeInput(response.scheduled_for),
        });
      })
      .catch((err: any) => setError(err.response?.data?.detail ?? "Unable to load post."))
      .finally(() => setLoading(false));
  }, [isEditing, postId]);

  const eligiblePrompts = useMemo(
    () => prompts.filter((prompt) => !form.ai_agent_id || prompt.ai_agent_id === Number(form.ai_agent_id)),
    [prompts, form.ai_agent_id],
  );

  const visibleConnections = useMemo(() => {
    if (!activeFacebookConnectionId) {
      return connections;
    }
    return connections.filter(
      (connection) =>
        connection.id === activeFacebookConnectionId || String(connection.id) === form.platform_connection_id,
    );
  }, [activeFacebookConnectionId, connections, form.platform_connection_id]);

  useEffect(() => {
    if (isEditing || !activeFacebookConnectionId) {
      return;
    }
    setForm((current) =>
      current.platform_connection_id
        ? current
        : { ...current, platform_connection_id: String(activeFacebookConnectionId) },
    );
  }, [activeFacebookConnectionId, isEditing]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload = {
        title: form.title || null,
        content: form.content,
        media_urls: form.media_urls.split("\n").map((item) => item.trim()).filter(Boolean),
        platform_connection_id: form.platform_connection_id ? Number(form.platform_connection_id) : null,
        ai_agent_id: form.ai_agent_id ? Number(form.ai_agent_id) : null,
        ai_prompt_id: form.ai_prompt_id ? Number(form.ai_prompt_id) : null,
        generated_by: form.generated_by,
        is_llm_generated: form.is_llm_generated,
        requires_approval: form.requires_approval,
        metadata_json: JSON.parse(form.metadata_json),
      };
      const saved = isEditing && postId ? await updatePost(postId, payload) : await createPost(payload);
      setPost(saved);
      setMessage(isEditing ? "Post updated." : "Post created.");
      if (!isEditing) {
        navigate(`/posts/${saved.id}`, { replace: true });
      }
    } catch (err: any) {
      setError(err.response?.data?.detail ?? err.message ?? "Unable to save post.");
    } finally {
      setSaving(false);
    }
  };

  const handleSchedule = async () => {
    if (!post) return;
    if (!form.scheduled_for) {
      setError("Choose a future schedule time first.");
      return;
    }
    const saved = await schedulePost(post.id, new Date(form.scheduled_for).toISOString());
    setPost(saved);
    setMessage("Post scheduled.");
  };

  const handlePublishNow = async () => {
    if (!post) return;
    const saved = await publishPostNow(post.id);
    setPost(saved);
    setMessage("Publish job queued.");
  };

  const handleDelete = async () => {
    if (!post) return;
    if (!window.confirm("Delete this post?")) return;
    await deletePost(post.id);
    navigate("/posts");
  };

  const handleGeneratePost = async () => {
    setGenerating(true);
    setError(null);
    try {
      const result = await generatePostDraft({
        platform_connection_id: form.platform_connection_id ? Number(form.platform_connection_id) : undefined,
        ai_agent_id: form.ai_agent_id ? Number(form.ai_agent_id) : undefined,
        post_id: post?.id ?? undefined,
        title_hint: form.title || undefined,
        instructions: generationHint || undefined,
        persist_draft: false,
      });
      setForm((current) => ({
        ...current,
        content: result.content,
        generated_by: "llm_bot",
        is_llm_generated: true,
        requires_approval: result.requires_approval,
      }));
      setMessage(result.requires_approval ? "AI draft generated. Approval is required before publish." : "AI draft generated.");
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to generate post.");
    } finally {
      setGenerating(false);
    }
  };

  const handleApprove = async () => {
    if (!post) return;
    const saved = await approvePost(post.id);
    setPost(saved);
    setMessage("Post approved.");
  };

  const handleReject = async () => {
    if (!post) return;
    const reason = window.prompt("Enter rejection reason", post.rejection_reason || "Needs revision");
    if (!reason) return;
    const saved = await rejectPost(post.id, reason);
    setPost(saved);
    setMessage("Post rejected.");
  };

  return (
    <section>
      <PageHeader
        eyebrow="Post Editor"
        title={isEditing ? "Edit Facebook post" : "Create Facebook post"}
        description="Build manual or AI-generated Facebook posts, keep them in draft, route them through approval, schedule publishing, and leave real Facebook delivery to the pluggable publisher service."
      />

      {message ? <div className="panel success-panel">{message}</div> : null}
      {error ? <div className="panel error-panel">{error}</div> : null}
      {loading ? <LoadingPanel message="Loading post..." hint="Preparing post details and workflow controls." /> : null}

      {!loading ? (
        <div className="dashboard-grid posts-editor-layout">
          <form className="panel form-panel" onSubmit={handleSubmit}>
            <h3>Post content</h3>
            <label>
              Title
              <CustomField value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} />
            </label>
            <label>
              Body
              <CustomTextArea value={form.content} rows={10} onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))} required />
            </label>
            <label>
              Generation hint
              <CustomTextArea
                value={generationHint}
                rows={3}
                onChange={(event) => setGenerationHint(event.target.value)}
                placeholder="Optional direction for AI generation (campaign theme, tone, CTA)."
              />
            </label>
            <button type="button" className="secondary-action" onClick={handleGeneratePost} disabled={generating || saving}>
              {generating ? "Generating..." : "Generate post with AI"}
            </button>
            <label>
              Media URLs
              <CustomTextArea
                value={form.media_urls}
                rows={5}
                onChange={(event) => setForm((current) => ({ ...current, media_urls: event.target.value }))}
                placeholder="One media URL per line"
              />
            </label>
            <label>
              Facebook connection
              <CustomSelect
                value={form.platform_connection_id}
                onChange={(value) => setForm((current) => ({ ...current, platform_connection_id: value }))}
                options={[
                  { value: "", label: "No connection selected" },
                  ...visibleConnections.map((connection) => ({ value: String(connection.id), label: connection.name })),
                ]}
              />
            </label>
            <label>
              AI agent
              <CustomSelect
                value={form.ai_agent_id}
                onChange={(value) => setForm((current) => ({ ...current, ai_agent_id: value }))}
                options={[
                  { value: "", label: "No AI agent" },
                  ...agents.map((agent) => ({ value: String(agent.id), label: agent.name })),
                ]}
              />
            </label>
            <label>
              Linked prompt
              <CustomSelect
                value={form.ai_prompt_id}
                onChange={(value) => setForm((current) => ({ ...current, ai_prompt_id: value }))}
                options={[
                  { value: "", label: "No prompt" },
                  ...eligiblePrompts.map((prompt) => ({ value: String(prompt.id), label: `${prompt.title} (v${prompt.version})` })),
                ]}
              />
            </label>
            <label>
              Generated by
              <CustomSelect
                value={form.generated_by}
                onChange={(value) => setForm((current) => ({ ...current, generated_by: value as PostGeneratedBy }))}
                options={[
                  { value: "human_admin", label: "Human admin" },
                  { value: "llm_bot", label: "LLM bot" },
                  { value: "system", label: "System" },
                ]}
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.is_llm_generated}
                onChange={(event) => setForm((current) => ({ ...current, is_llm_generated: event.target.checked }))}
              />
              AI generated
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.requires_approval}
                onChange={(event) => setForm((current) => ({ ...current, requires_approval: event.target.checked }))}
              />
              Requires approval before publish
            </label>
            <label>
              Metadata JSON
              <CustomTextArea value={form.metadata_json} rows={6} onChange={(event) => setForm((current) => ({ ...current, metadata_json: event.target.value }))} />
            </label>
            <button type="submit" disabled={saving}>{saving ? "Saving..." : isEditing ? "Save changes" : "Create post"}</button>
          </form>

          <div className="panel form-panel">
            <h3>Workflow</h3>
            {post ? (
              <>
                <div className="panel subtle-panel">
                  <strong>Status</strong>
                  <p className="muted-copy">
                    <span className={`status-pill post-status-${post.status}`}>{post.status}</span>
                  </p>
                  <p className="muted-copy">
                    Scheduled: {post.scheduled_for ? new Date(post.scheduled_for).toLocaleString() : "Not scheduled"}
                  </p>
                  <p className="muted-copy">
                    Published: {post.published_at ? new Date(post.published_at).toLocaleString() : "Not published"}
                  </p>
                </div>
                <label>
                  Schedule publish
                  <CustomField
                    type="datetime-local"
                    value={form.scheduled_for}
                    onChange={(event) => setForm((current) => ({ ...current, scheduled_for: event.target.value }))}
                  />
                </label>
                <button type="button" onClick={handleSchedule}>Schedule</button>
                <button type="button" onClick={handleApprove}>Approve</button>
                <button type="button" className="secondary-action" onClick={handleReject}>Reject</button>
                <button type="button" onClick={handlePublishNow}>Publish now</button>
                <button type="button" className="secondary-action" onClick={handleDelete}>Delete post</button>
                <Link className="text-link secondary-link" to="/posts">Back to posts</Link>
              </>
            ) : (
              <p className="muted-copy">Save the post first to access approval, scheduling, and publish actions.</p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
