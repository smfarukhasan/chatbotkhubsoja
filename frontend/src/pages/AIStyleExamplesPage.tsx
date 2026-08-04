import { FormEvent, useEffect, useState } from "react";

import { LoadingPanel } from "../components/common/LoadingPanel";
import { CustomSelect } from "../components/common/CustomSelect";
import { PageHeader } from "../components/common/PageHeader";
import {
  createConversationStyleExamples,
  deleteKnowledgeSource,
  listAIAgents,
  listKnowledgeSources,
} from "../features/ai/api/aiApi";
import { getConversation, listConversationMessages, listConversations } from "../features/inbox/api/inboxApi";
import type { AIAgentOverview, AIKnowledgeSource } from "../shared/types/ai";
import type { ConversationDetail, ConversationSummary, InboxMessage } from "../shared/types/inbox";

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

function extractErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as { response?: { data?: { detail?: unknown } }; message?: unknown };
    const detail = candidate.response?.data?.detail;
    if (typeof detail === "string") return detail;
    if (typeof candidate.message === "string") return candidate.message;
  }
  return "Something went wrong.";
}

function formatDateTime(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return DATE_TIME_FORMATTER.format(date);
}

function truncate(value: string | null, maxLength: number): string {
  if (!value) return "No message preview";
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function conversationLabel(conversation: ConversationSummary): string {
  return conversation.customer_name || conversation.customer_external_id || `Conversation #${conversation.id}`;
}

type StylePreview = {
  conversation: ConversationDetail;
  messages: InboxMessage[];
};

export function AIStyleExamplesPage() {
  const [agents, setAgents] = useState<AIAgentOverview[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [sources, setSources] = useState<AIKnowledgeSource[]>([]);
  const [agentId, setAgentId] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<StylePreview | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSources = async () => {
    const sourceResponse = await listKnowledgeSources({ kind: "conversation_style" });
    setSources(sourceResponse);
  };

  useEffect(() => {
    let cancelled = false;

    const loadInitial = async () => {
      setLoadingList(true);
      setError(null);
      try {
        const [agentResponse, conversationResponse, sourceResponse] = await Promise.all([
          listAIAgents(),
          listConversations({ page_size: 100 }),
          listKnowledgeSources({ kind: "conversation_style" }),
        ]);
        if (cancelled) return;
        setAgents(agentResponse);
        setConversations(conversationResponse.items);
        setSources(sourceResponse);
      } catch (err) {
        if (!cancelled) {
          setError(extractErrorMessage(err));
        }
      } finally {
        if (!cancelled) {
          setLoadingList(false);
        }
      }
    };

    void loadInitial();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleConversation = (conversationId: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      return next;
    });
  };

  const loadPreview = async (conversationId: number) => {
    setLoadingPreview(true);
    setError(null);
    try {
      const [conversation, messageResponse] = await Promise.all([
        getConversation(conversationId),
        listConversationMessages(conversationId, { page_size: 100 }),
      ]);
      setPreview({ conversation, messages: messageResponse.items });
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleTrain = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedIds.size === 0) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await createConversationStyleExamples([...selectedIds], agentId ? Number(agentId) : null);
      const trainedCount = response.items.length;
      const skippedText = response.skipped > 0 ? ` (${response.skipped} skipped)` : "";
      setMessage(`Trained on ${trainedCount} conversation${trainedCount === 1 ? "" : "s"}${skippedText}.`);
      setSelectedIds(new Set());
      await loadSources();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (source: AIKnowledgeSource) => {
    if (!window.confirm(`Delete style example "${source.title}"?`)) {
      return;
    }
    setDeletingId(source.id);
    setError(null);
    setMessage(null);
    try {
      await deleteKnowledgeSource(source.id);
      setMessage("Style example deleted.");
      await loadSources();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setDeletingId(null);
    }
  };

  const styleMetadata = (source: AIKnowledgeSource): { customerName: string | null; pairCount: number | null } => {
    const metadata = source.metadata_json;
    return {
      customerName: typeof metadata.customer_name === "string" ? metadata.customer_name : null,
      pairCount: typeof metadata.pair_count === "number" ? metadata.pair_count : null,
    };
  };

  const selectedCount = selectedIds.size;

  return (
    <section>
      <PageHeader
        eyebrow="Style"
        title="Style examples"
        description="Select real customer conversations so the AI can learn how the owner replies and match the brand's tone."
      />

      {message ? <div className="panel success-panel">{message}</div> : null}
      {error ? <div className="panel error-panel">{error}</div> : null}

      {loadingList ? (
        <LoadingPanel message="Loading conversations..." hint="Fetching inbox threads and saved style examples." compact />
      ) : (
        <div className="connections-page-stack">
          <form className="panel form-panel connection-form ai-style-form" onSubmit={handleTrain}>
            <h3 className="ai-style-form-title">Train from conversations</h3>
            <label>
              Agent
              <CustomSelect
                value={agentId}
                onChange={setAgentId}
                disabled={saving}
                options={[
                  { value: "", label: "Account-level" },
                  ...agents.map((agent) => ({ value: String(agent.id), label: agent.name })),
                ]}
              />
            </label>
            <div className="ai-style-conversation-list">
              {conversations.map((conversation) => (
                <div className="ai-style-conversation-row" key={conversation.id}>
                  <input
                    id={`style-conversation-${conversation.id}`}
                    type="checkbox"
                    checked={selectedIds.has(conversation.id)}
                    onChange={() => toggleConversation(conversation.id)}
                  />
                  <label htmlFor={`style-conversation-${conversation.id}`} className="ai-style-conversation-copy">
                    <strong>{conversationLabel(conversation)}</strong>
                    <span className="muted-copy small-copy">{truncate(conversation.latest_message_preview, 90)}</span>
                  </label>
                  <button
                    type="button"
                    className="link-button"
                    disabled={loadingPreview}
                    onClick={() => void loadPreview(conversation.id)}
                  >
                    Preview
                  </button>
                </div>
              ))}
              {conversations.length === 0 ? (
                <div className="ai-style-row-empty">No conversations available yet.</div>
              ) : null}
            </div>
            <button type="submit" className="ai-style-train-button" disabled={saving || selectedCount === 0}>
              {saving ? "Training..." : `Train on selected (${selectedCount})`}
            </button>
          </form>

          <div className="table-card">
            <div className="table-card-header">
              <h3>Conversation preview</h3>
              {preview ? <span className="muted-copy small-copy">{conversationLabel(preview.conversation)}</span> : null}
            </div>
            <div className="thread-scroll">
              {loadingPreview ? (
                <LoadingPanel message="Loading thread..." hint="Fetching conversation messages." compact />
              ) : null}
              {!loadingPreview && preview ? (
                preview.messages.length > 0 ? (
                  preview.messages.map((message) => (
                    <article
                      key={message.id}
                      className={`message-bubble ${message.direction === "outbound" ? "outbound" : "inbound"} sender-${message.sender_type}`}
                    >
                      <div className="message-meta">
                        <strong>{message.sender_name || message.sender_type}</strong>
                        <span>
                          {message.direction} · {formatDateTime(message.created_at) ?? "Unknown time"}
                        </span>
                      </div>
                      <p>{message.content}</p>
                    </article>
                  ))
                ) : (
                  <div className="ai-style-row-empty">No messages in this conversation yet.</div>
                )
              ) : null}
              {!loadingPreview && !preview ? (
                <div className="ai-style-row-empty">Pick a conversation to preview its thread before training.</div>
              ) : null}
            </div>
          </div>

          <div className="table-card">
            <div className="table-card-header">
              <h3>Saved style examples</h3>
              <span className="muted-copy small-copy">{sources.length} saved</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Agent</th>
                  <th>Customer</th>
                  <th>Pairs</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => {
                  const { customerName, pairCount } = styleMetadata(source);
                  return (
                    <tr key={source.id}>
                      <td>
                        <strong>{source.title}</strong>
                        <div className="muted-copy small-copy">{source.status}</div>
                      </td>
                      <td>{agents.find((agent) => agent.id === source.ai_agent_id)?.name || "Account-level"}</td>
                      <td>{customerName ?? "—"}</td>
                      <td>{pairCount ?? "—"}</td>
                      <td>{formatDateTime(source.created_at) ?? "—"}</td>
                      <td>
                        <button
                          type="button"
                          className="link-button danger-link"
                          disabled={deletingId === source.id}
                          onClick={() => void handleDelete(source)}
                        >
                          {deletingId === source.id ? "Deleting..." : "Delete"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {sources.length === 0 ? (
                  <tr>
                    <td colSpan={6}>No style examples yet.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
