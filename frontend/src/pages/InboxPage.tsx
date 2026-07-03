import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { CustomField, CustomTextArea } from "../components/common/CustomField";
import { LoadingPanel } from "../components/common/LoadingPanel";
import { CustomSelect } from "../components/common/CustomSelect";
import { EmojiPickerButton } from "../components/common/EmojiPickerButton";
import { PageHeader } from "../components/common/PageHeader";
import { listTeamMembers } from "../features/accounts/api/accountApi";
import { generateInboxReply } from "../features/ai/api/aiApi";
import {
  assignConversation,
  getConversation,
  listConversations,
  sendReply,
  updateConversationAiChat,
  updateConversationStatus,
} from "../features/inbox/api/inboxApi";
import { useAuthStore } from "../features/auth/store/authStore";
import type { TeamMember } from "../shared/types/account";
import type {
  AiChatMode,
  ConversationAiChatState,
  ConversationDetail,
  ConversationStatus,
  ConversationSummary,
  SenderType,
} from "../shared/types/inbox";
import type { PlatformType } from "../shared/types/platformConnection";

const STATUS_OPTIONS: Array<{ value: ConversationStatus; label: string }> = [
  { value: "open", label: "Open" },
  { value: "assigned", label: "Assigned" },
  { value: "paused", label: "Paused" },
  { value: "resolved", label: "Resolved" },
  { value: "escalated", label: "Escalated" },
];

const PLATFORM_OPTIONS: Array<{ value: PlatformType; label: string }> = [
  { value: "facebook_page", label: "Facebook" },
  { value: "whatsapp", label: "WhatsApp" },
];

const DELIVERY_LABELS: Record<string, string> = {
  pending: "Pending",
  queued: "Queued",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
};

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

const LONG_PRESS_MS = 450;

const AI_CHAT_TAG_LABELS: Record<AiChatMode, string> = {
  auto: "AutoChat",
  manual: "Manual",
  off: "Off AI Chat",
};

type AIChatModeSource = {
  ai_chat_mode: AiChatMode;
  ai_chat_manual_until: string | null;
};

type InboxPageProps = {
  defaultPlatform?: PlatformType;
  eyebrow?: string;
  title?: string;
  description?: string;
};

export function InboxPage({
  defaultPlatform,
  eyebrow = "Inbox",
  title = "Conversation inbox",
  description = "Review customer threads across Facebook Page and WhatsApp, coordinate assignment, and send human or AI-assisted replies inside the active account.",
}: InboxPageProps) {
  const isCompactInbox = defaultPlatform === "whatsapp";
  const activeAccountId = useAuthStore((state) => state.activeAccountId);
  const currentUser = useAuthStore((state) => state.user);

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [sending, setSending] = useState(false);
  const [generatingReply, setGeneratingReply] = useState(false);
  const [updatingMeta, setUpdatingMeta] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [replySenderType, setReplySenderType] = useState<Extract<SenderType, "human_admin" | "llm_bot">>("human_admin");
  const [assigneeUserId, setAssigneeUserId] = useState("unassigned");
  const [aiMenuConversationId, setAiMenuConversationId] = useState<number | null>(null);
  const [aiChatNow, setAiChatNow] = useState(() => Date.now());
  const [filters, setFilters] = useState({
    status: "" as ConversationStatus | "",
    platform: (defaultPlatform ?? "") as PlatformType | "",
    search: "",
  });
  const holdTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) ?? detail,
    [conversations, detail, selectedConversationId],
  );

  const hasActiveManualTimers = useMemo(() => {
    const items: AIChatModeSource[] = detail ? [...conversations, detail] : conversations;
    return items.some((item) => {
      if (item.ai_chat_mode !== "manual" || !item.ai_chat_manual_until) return false;
      const expiresAt = Date.parse(item.ai_chat_manual_until);
      return Number.isFinite(expiresAt) && expiresAt > Date.now();
    });
  }, [conversations, detail]);

  const loadConversations = async (preferredId?: number | null) => {
    setLoadingList(true);
    try {
      const response = await listConversations({
        status: filters.status,
        platform: filters.platform,
        search: filters.search || undefined,
      });
      setConversations(response.items);
      setError(null);

      const nextSelectedId = preferredId ?? selectedConversationId;
      if (nextSelectedId && response.items.some((conversation) => conversation.id === nextSelectedId)) {
        setSelectedConversationId(nextSelectedId);
      } else {
        setSelectedConversationId(response.items[0]?.id ?? null);
      }
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to load conversations.");
      setConversations([]);
      setSelectedConversationId(null);
    } finally {
      setLoadingList(false);
    }
  };

  const loadConversationDetail = async (conversationId: number) => {
    setLoadingDetail(true);
    try {
      const response = await getConversation(conversationId);
      setDetail(response);
      setAssigneeUserId(response.assigned_to?.user_id ? String(response.assigned_to.user_id) : "unassigned");
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to load conversation.");
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  useEffect(() => {
    loadConversations(null);
    listTeamMembers()
      .then(setTeamMembers)
      .catch(() => setTeamMembers([]));
  }, [activeAccountId, filters.status, filters.platform]);

  useEffect(() => {
    setFilters((current) => ({
      ...current,
      platform: (defaultPlatform ?? "") as PlatformType | "",
    }));
  }, [defaultPlatform]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      loadConversations(selectedConversationId);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [filters.search]);

  useEffect(() => {
    if (selectedConversationId) {
      loadConversationDetail(selectedConversationId);
    } else {
      setDetail(null);
    }
  }, [selectedConversationId]);

  useEffect(
    () => () => {
      if (holdTimerRef.current) {
        window.clearTimeout(holdTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!hasActiveManualTimers) return;
    const intervalId = window.setInterval(() => {
      setAiChatNow(Date.now());
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [hasActiveManualTimers]);

  const applyConversationUpdate = (updated: ConversationSummary) => {
    setConversations((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    setDetail((current) =>
      current && current.id === updated.id
        ? {
            ...current,
            ...updated,
          }
        : current,
    );
  };

  const applyConversationAiChatState = (conversationId: number, state: ConversationAiChatState) => {
    setConversations((current) =>
      current.map((item) =>
        item.id === conversationId
          ? {
              ...item,
              ai_chat_mode: state.ai_chat_mode,
              ai_chat_manual_until: state.ai_chat_manual_until,
            }
          : item,
      ),
    );
    setDetail((current) =>
      current && current.id === conversationId
        ? {
            ...current,
            ai_chat_mode: state.ai_chat_mode,
            ai_chat_manual_until: state.ai_chat_manual_until,
          }
        : current,
    );
  };

  const handleAssign = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedConversationId) return;
    setUpdatingMeta(true);
    try {
      const updated = await assignConversation(
        selectedConversationId,
        assigneeUserId !== "unassigned" ? Number(assigneeUserId) : null,
      );
      applyConversationUpdate(updated);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to update assignee.");
    } finally {
      setUpdatingMeta(false);
    }
  };

  const handleStatusChange = async (status: ConversationStatus) => {
    if (!selectedConversationId) return;
    setUpdatingMeta(true);
    try {
      const updated = await updateConversationStatus(selectedConversationId, { status });
      applyConversationUpdate(updated);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to update status.");
    } finally {
      setUpdatingMeta(false);
    }
  };

  const handleSendReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedConversationId || !reply.trim()) return;
    setSending(true);
    try {
      const message = await sendReply(selectedConversationId, {
        content: reply.trim(),
        sender_type: replySenderType,
      });
      setReply("");
      setDetail((current) =>
        current && current.id === selectedConversationId
          ? {
              ...current,
              latest_message_preview: message.content,
              latest_message_at: message.created_at,
              messages_total: current.messages_total + 1,
              messages: [...current.messages, message],
            }
          : current,
      );
      await loadConversations(selectedConversationId);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to send reply.");
    } finally {
      setSending(false);
    }
  };

  const handleGenerateReply = async () => {
    if (!selectedConversationId || !selectedConversation) return;
    setGeneratingReply(true);
    try {
      const result = await generateInboxReply({
        conversation_id: selectedConversationId,
        platform_connection_id: selectedConversation.platform_connection_id ?? undefined,
        persist_draft: false,
      });
      setReply(result.content);
      setReplySenderType("llm_bot");
      if (result.requires_approval) {
        setError("AI draft generated and requires human approval before sending.");
      } else {
        setError(null);
      }
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to generate AI reply.");
    } finally {
      setGeneratingReply(false);
    }
  };

  const formatDateTime = (value?: string | null) => {
    if (!value) return null;
    return DATE_TIME_FORMATTER.format(new Date(value));
  };

  const appendReplyEmoji = (emoji: string) => {
    setReply((current) => `${current}${emoji}`);
  };

  const clearHoldTimer = () => {
    if (holdTimerRef.current) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const openAiMenuWithHold = (conversationId: number) => {
    clearHoldTimer();
    longPressTriggeredRef.current = false;
    holdTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      setSelectedConversationId(conversationId);
      setAiMenuConversationId(conversationId);
    }, LONG_PRESS_MS);
  };

  const getAiChatActions = (mode: AiChatMode) =>
    mode === "auto"
      ? [
          { value: "auto" as const, label: "AutoChat" },
          { value: "manual" as const, label: "Manual" },
          { value: "off" as const, label: "Off AI Chat" },
        ]
      : [{ value: "on" as const, label: "On AI Chat" }];

  const handleAiChatModeChange = async (
    conversation: ConversationSummary,
    nextAction: "auto" | "manual" | "off" | "on",
  ) => {
    let mode: AiChatMode = nextAction === "on" ? "auto" : nextAction;
    let manualMinutes: number | undefined;

    if (nextAction === "manual") {
      const input = window.prompt("Manual mode কত মিনিট চলবে?", "15");
      if (input === null) return;
      const parsed = Number.parseInt(input, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        setError("Manual mode-এর জন্য valid মিনিট লিখতে হবে।");
        return;
      }
      manualMinutes = parsed;
      mode = "manual";
    }

    try {
      const state = await updateConversationAiChat(conversation.id, {
        mode,
        manual_minutes: manualMinutes,
      });
      applyConversationAiChatState(conversation.id, state);
      setAiMenuConversationId(null);
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to update AI chat mode.");
    }
  };

  const getEffectiveAiChatMode = (source: AIChatModeSource): AiChatMode => {
    if (source.ai_chat_mode === "off") return "off";
    if (source.ai_chat_mode !== "manual" || !source.ai_chat_manual_until) return "auto";
    const expiresAt = Date.parse(source.ai_chat_manual_until);
    if (!Number.isFinite(expiresAt) || expiresAt <= aiChatNow) return "auto";
    return "manual";
  };

  return (
    <section className={isCompactInbox ? "whatsapp-inbox-page" : undefined}>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
      />

      {error ? <div className="panel error-panel">{error}</div> : null}

      <div className={`inbox-page ${isCompactInbox ? "inbox-page-live whatsapp-inbox-shell" : ""}`.trim()}>
        <aside className="inbox-sidebar">
          <div className="table-card inbox-list">
            {isCompactInbox ? (
              <div className="inbox-toolbar">
                <div className="inbox-toolbar-copy">
                  <h2>Threads</h2>
                  <span className="muted-copy small-copy">{conversations.length} loaded</span>
                </div>
                <label className="inbox-search-field">
                  <CustomField
                    type="search"
                    value={filters.search}
                    onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                    placeholder="Search customer or latest message"
                  />
                </label>
                <label className="inbox-search-field">
                  <CustomSelect
                    value={filters.status}
                    onChange={(value) => setFilters((current) => ({ ...current, status: value as ConversationStatus | "" }))}
                    options={[{ value: "", label: "All statuses" }, ...STATUS_OPTIONS]}
                  />
                </label>
              </div>
            ) : (
              <>
                <div className="panel inbox-toolbar">
                  <label>
                    Status
                    <CustomSelect
                      value={filters.status}
                      onChange={(value) => setFilters((current) => ({ ...current, status: value as ConversationStatus | "" }))}
                      options={[{ value: "", label: "All statuses" }, ...STATUS_OPTIONS]}
                    />
                  </label>
                  {!defaultPlatform ? (
                    <label>
                      Platform
                      <CustomSelect
                        value={filters.platform}
                        onChange={(value) => setFilters((current) => ({ ...current, platform: value as PlatformType | "" }))}
                        options={[{ value: "", label: "All platforms" }, ...PLATFORM_OPTIONS]}
                      />
                    </label>
                  ) : null}
                  <label>
                    Search
                    <CustomField
                      type="search"
                      value={filters.search}
                      onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                      placeholder="Customer name or external ID"
                    />
                  </label>
                </div>

                <div className="table-card-header">
                  <h3>Threads</h3>
                  <span className="muted-copy small-copy">{conversations.length} loaded</span>
                </div>
              </>
            )}
            {loadingList ? (
              <LoadingPanel message="Loading conversations..." hint="Fetching the latest inbox threads." compact />
            ) : null}
            {!loadingList && conversations.length === 0 ? (
              <div className={isCompactInbox ? "inbox-state" : "panel"}>No conversations match the current filters.</div>
            ) : null}
            <div className="conversation-list">
              {conversations.map((conversation) => {
                const effectiveAiChatMode = getEffectiveAiChatMode(conversation);
                return (
                <div key={conversation.id} className="conversation-row-shell">
                  <button
                    type="button"
                    className={`conversation-row ${selectedConversationId === conversation.id ? "active" : ""}`}
                    onClick={() => {
                      if (longPressTriggeredRef.current) {
                        longPressTriggeredRef.current = false;
                        return;
                      }
                      setSelectedConversationId(conversation.id);
                      setAiMenuConversationId(null);
                    }}
                    onPointerDown={isCompactInbox ? () => openAiMenuWithHold(conversation.id) : undefined}
                    onPointerUp={isCompactInbox ? clearHoldTimer : undefined}
                    onPointerLeave={isCompactInbox ? clearHoldTimer : undefined}
                    onPointerCancel={isCompactInbox ? clearHoldTimer : undefined}
                    onContextMenu={
                      isCompactInbox
                        ? (event) => {
                            event.preventDefault();
                            clearHoldTimer();
                            longPressTriggeredRef.current = true;
                            setSelectedConversationId(conversation.id);
                            setAiMenuConversationId(conversation.id);
                          }
                        : undefined
                    }
                  >
                    <div className="conversation-row-top">
                      <strong>{conversation.customer_name || conversation.customer_external_id}</strong>
                      {isCompactInbox ? (
                        <div className="conversation-row-badges">
                          <span className={`conversation-ai-tag ai-mode-${effectiveAiChatMode}`}>
                            {AI_CHAT_TAG_LABELS[effectiveAiChatMode]}
                          </span>
                          {conversation.unread_count > 0 ? <span className="conversation-pill">{conversation.unread_count} unread</span> : null}
                        </div>
                      ) : (
                        <span className={`status-pill status-${conversation.status}`}>{conversation.status}</span>
                      )}
                    </div>
                    {!isCompactInbox ? (
                      <div className="muted-copy small-copy">
                        {conversation.platform_type === "facebook_page" ? "Facebook Page" : "WhatsApp"}
                        {" | "}
                        {conversation.assigned_to?.full_name || conversation.assigned_to?.email || "Unassigned"}
                      </div>
                    ) : null}
                    <p>{conversation.latest_message_preview || "No messages yet."}</p>
                  </button>
                  {isCompactInbox && aiMenuConversationId === conversation.id ? (
                    <div className="conversation-ai-menu">
                      {getAiChatActions(effectiveAiChatMode).map((action) => (
                        <button
                          key={action.value}
                          type="button"
                          className="ghost-button compact-button"
                          onClick={() => void handleAiChatModeChange(conversation, action.value)}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )})}
            </div>
          </div>
        </aside>

        <div className="inbox-main">
          {!selectedConversation ? (
            <div className={`${isCompactInbox ? "inbox-empty" : "panel inbox-empty"}`.trim()}>
              {isCompactInbox ? (
                <>
                  <h2>Select a thread</h2>
                  <p className="muted-copy">Choose a WhatsApp conversation from the left to view the full chat.</p>
                </>
              ) : (
                "Select a conversation to view the thread."
              )}
            </div>
          ) : (
            <>
              <div className={`${isCompactInbox ? "inbox-thread-header" : "panel inbox-thread-header"}`.trim()}>
                <div>
                  <h3>{selectedConversation.customer_name || selectedConversation.customer_external_id}</h3>
                  <p className="muted-copy">
                    {selectedConversation.customer_phone || selectedConversation.external_thread_id || selectedConversation.customer_external_id}
                  </p>
                </div>
                <div className={isCompactInbox ? "inbox-thread-meta" : "inbox-status-actions"}>
                  {isCompactInbox ? (
                    <>
                      <span className={`status-pill status-${selectedConversation.status}`}>{selectedConversation.status}</span>
                      <span className="conversation-pill">{detail?.messages_total ?? detail?.messages.length ?? 0} messages</span>
                      <span className="muted-copy small-copy">
                        {selectedConversation.latest_message_at
                          ? `Updated ${formatDateTime(selectedConversation.latest_message_at)}`
                          : "No timestamp"}
                      </span>
                    </>
                  ) : (
                    STATUS_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`ghost-button compact-button ${selectedConversation.status === option.value ? "status-active" : ""}`}
                        onClick={() => handleStatusChange(option.value)}
                        disabled={updatingMeta}
                      >
                        {option.label}
                      </button>
                    ))
                  )}
                </div>
              </div>

              {isCompactInbox ? (
                <div className="panel whatsapp-inbox-controls">
                  <div className="inbox-status-actions">
                    {STATUS_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`ghost-button compact-button ${selectedConversation.status === option.value ? "status-active" : ""}`}
                        onClick={() => handleStatusChange(option.value)}
                        disabled={updatingMeta}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <form className="compact-form-panel whatsapp-assign-form" onSubmit={handleAssign}>
                    <label>
                      <span className="muted-copy small-copy">Assign conversation</span>
                      <CustomSelect
                        value={assigneeUserId}
                        onChange={setAssigneeUserId}
                        disabled={updatingMeta}
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
                    <button type="submit" disabled={updatingMeta}>
                      {updatingMeta ? "Updating..." : "Save assignment"}
                    </button>
                  </form>
                </div>
              ) : null}

              <div className="inbox-thread-layout">
                <div className="table-card inbox-thread-card">
                  <div className="thread-scroll">
                    {loadingDetail ? (
                      <LoadingPanel message="Loading thread..." hint="Syncing message history and delivery state." compact />
                    ) : null}
                    {!loadingDetail &&
                      detail?.messages.map((message) => (
                        <article
                          key={message.id}
                          className={`message-bubble ${message.direction === "outbound" ? "outbound" : "inbound"} sender-${message.sender_type}`}
                        >
                          <div className="message-meta">
                            <strong>{message.sender_name || message.sender_type}</strong>
                            <span>{formatDateTime(message.created_at) ?? "Unknown time"}</span>
                          </div>
                          <p>{message.content}</p>
                          <span className={`message-delivery delivery-${message.delivery_status}`}>
                            {DELIVERY_LABELS[message.delivery_status]}
                          </span>
                        </article>
                      ))}
                  </div>

                  <form className="reply-box" onSubmit={handleSendReply}>
                    <div className="reply-toolbar">
                      <div className="reply-toolbar-main">
                        <CustomSelect
                          value={replySenderType}
                          onChange={(value) => setReplySenderType(value as Extract<SenderType, "human_admin" | "llm_bot">)}
                          options={[
                            { value: "human_admin", label: "Human reply" },
                            { value: "llm_bot", label: "AI reply" },
                          ]}
                          variant="compact"
                        />
                        <EmojiPickerButton onSelect={appendReplyEmoji} />
                        <span className="muted-copy small-copy">
                          Sending as {replySenderType === "human_admin" ? currentUser?.full_name || currentUser?.email : "AI Assistant"}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="secondary-action"
                        onClick={handleGenerateReply}
                        disabled={generatingReply || sending}
                      >
                        {generatingReply ? "Generating..." : "Generate AI reply"}
                      </button>
                    </div>
                    <CustomTextArea
                      value={reply}
                      onChange={(event) => setReply(event.target.value)}
                      rows={5}
                      placeholder="Write a reply..."
                    />
                    <div className="reply-actions">
                      <span className="muted-copy small-copy">{reply.trim().length}/5000</span>
                      <button type="submit" disabled={sending || !reply.trim()}>
                        {sending ? "Sending..." : "Send reply"}
                      </button>
                    </div>
                  </form>
                </div>

                {!isCompactInbox ? (
                  <aside className="panel inbox-customer-panel">
                    <h3>Customer</h3>
                    <dl className="detail-list">
                      <div>
                        <dt>Name</dt>
                        <dd>{selectedConversation.customer_name || "Unknown"}</dd>
                      </div>
                      <div>
                        <dt>External ID</dt>
                        <dd>{selectedConversation.customer_external_id}</dd>
                      </div>
                      <div>
                        <dt>Email</dt>
                        <dd>{selectedConversation.customer_email || "Not available"}</dd>
                      </div>
                      <div>
                        <dt>Phone</dt>
                        <dd>{selectedConversation.customer_phone || "Not available"}</dd>
                      </div>
                      <div>
                        <dt>Assigned to</dt>
                        <dd>{selectedConversation.assigned_to?.full_name || selectedConversation.assigned_to?.email || "Unassigned"}</dd>
                      </div>
                    </dl>

                    <form className="form-panel compact-form-panel" onSubmit={handleAssign}>
                      <label>
                        Assign conversation
                        <CustomSelect
                          value={assigneeUserId}
                          onChange={setAssigneeUserId}
                          disabled={updatingMeta}
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
                      <button type="submit" disabled={updatingMeta}>
                        {updatingMeta ? "Updating..." : "Save assignment"}
                      </button>
                    </form>
                  </aside>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
