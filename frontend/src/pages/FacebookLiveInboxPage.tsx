import { useEffect, useMemo, useRef, useState } from "react";

import { CustomField, CustomTextArea } from "../components/common/CustomField";
import { EmojiPickerButton } from "../components/common/EmojiPickerButton";
import { LoadingPanel } from "../components/common/LoadingPanel";
import {
  listLiveFacebookConversations,
  listLiveFacebookMessages,
  sendLiveFacebookReply,
  updateLiveFacebookConversationAiChat,
} from "../features/inbox/api/inboxApi";
import { useFacebookPageScope } from "../features/platformConnections/hooks/useFacebookPageScope";
import type {
  AiChatMode,
  ConversationAiChatState,
  LiveFacebookConversation,
  LiveFacebookMessage,
} from "../shared/types/inbox";

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

export function FacebookLiveInboxPage() {
  const {
    connections: facebookConnections,
    loadingConnections: loadingFacebookConnections,
    activeFacebookConnectionId,
    activeConnection,
  } = useFacebookPageScope();

  const [conversations, setConversations] = useState<LiveFacebookConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LiveFacebookMessage[]>([]);
  const [conversationNextCursor, setConversationNextCursor] = useState<string | null>(null);
  const [messageNextCursor, setMessageNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [reply, setReply] = useState("");
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiMenuConversationId, setAiMenuConversationId] = useState<string | null>(null);
  const [aiChatNow, setAiChatNow] = useState(() => Date.now());
  const holdTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);

  const filteredConversations = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return conversations;
    return conversations.filter((conversation) =>
      [
        conversation.customer_name,
        conversation.customer_external_id,
        conversation.latest_message_preview,
        conversation.connection_name,
      ]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(term)),
    );
  }, [conversations, search]);

  const selectedConversation = useMemo(
    () => filteredConversations.find((conversation) => conversation.id === selectedConversationId) ?? null,
    [filteredConversations, selectedConversationId],
  );

  const hasActiveManualTimers = useMemo(
    () =>
      conversations.some((item) => {
        if (item.ai_chat_mode !== "manual" || !item.ai_chat_manual_until) return false;
        const expiresAt = Date.parse(item.ai_chat_manual_until);
        return Number.isFinite(expiresAt) && expiresAt > Date.now();
      }),
    [conversations],
  );

  useEffect(() => {
    if (loadingFacebookConnections) {
      return;
    }
    setLoadingConversations(true);
    if (facebookConnections.length === 0) {
      setConversations([]);
      setMessages([]);
      setConversationNextCursor(null);
      setMessageNextCursor(null);
      setSelectedConversationId(null);
      setError(null);
      setLoadingConversations(false);
      return;
    }
    if (!activeFacebookConnectionId) {
      setConversations([]);
      setMessages([]);
      setConversationNextCursor(null);
      setMessageNextCursor(null);
      setSelectedConversationId(null);
      setError(null);
      setLoadingConversations(false);
      return;
    }
    listLiveFacebookConversations({
      connection_id: activeFacebookConnectionId,
      page_size: 50,
    })
      .then((response) => {
        setConversations(response.items);
        setConversationNextCursor(response.next_cursor);
        setError(null);
        setSelectedConversationId((current) =>
          current && response.items.some((item) => item.id === current) ? current : response.items[0]?.id ?? null,
        );
      })
      .catch((err: any) => {
        setError(err.response?.data?.detail ?? "Unable to load Facebook conversations.");
        setConversations([]);
        setConversationNextCursor(null);
        setSelectedConversationId(null);
      })
      .finally(() => setLoadingConversations(false));
  }, [activeFacebookConnectionId, facebookConnections.length, loadingFacebookConnections]);

  useEffect(() => {
    if (!selectedConversation) {
      setMessages([]);
      setMessageNextCursor(null);
      setReply("");
      return;
    }
    setLoadingMessages(true);
    listLiveFacebookMessages(selectedConversation.id, {
      connection_id: selectedConversation.platform_connection_id,
      page_size: 100,
    })
      .then((response) => {
        setMessages(response.items);
        setMessageNextCursor(response.next_cursor);
        setError(null);
      })
      .catch((err: any) => {
        setError(err.response?.data?.detail ?? "Unable to load Facebook messages.");
        setMessages([]);
        setMessageNextCursor(null);
      })
      .finally(() => setLoadingMessages(false));
  }, [selectedConversation]);

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

  const handleLoadMoreConversations = async () => {
    if (!conversationNextCursor || loadingMoreConversations) return;
    if (!activeFacebookConnectionId) return;
    setLoadingMoreConversations(true);
    try {
      const response = await listLiveFacebookConversations({
        connection_id: activeFacebookConnectionId,
        page_size: 50,
        after: conversationNextCursor,
      });
      setConversations((current) => {
        const merged = new Map(current.map((item) => [item.id, item] as const));
        response.items.forEach((item) => merged.set(item.id, item));
        return Array.from(merged.values()).sort((a, b) => {
          const left = a.latest_message_at ? new Date(a.latest_message_at).getTime() : 0;
          const right = b.latest_message_at ? new Date(b.latest_message_at).getTime() : 0;
          return right - left;
        });
      });
      setConversationNextCursor(response.next_cursor);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to load more Facebook conversations.");
    } finally {
      setLoadingMoreConversations(false);
    }
  };

  const handleLoadMoreMessages = async () => {
    if (!selectedConversation || !messageNextCursor || loadingMoreMessages) return;
    setLoadingMoreMessages(true);
    try {
      const response = await listLiveFacebookMessages(selectedConversation.id, {
        connection_id: selectedConversation.platform_connection_id,
        page_size: 100,
        after: messageNextCursor,
      });
      setMessages((current) => {
        const merged = new Map(current.map((item) => [item.id, item] as const));
        response.items.forEach((item) => merged.set(item.id, item));
        return Array.from(merged.values()).sort((a, b) => {
          const left = a.created_at ? new Date(a.created_at).getTime() : 0;
          const right = b.created_at ? new Date(b.created_at).getTime() : 0;
          return left - right;
        });
      });
      setMessageNextCursor(response.next_cursor);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to load older Facebook messages.");
    } finally {
      setLoadingMoreMessages(false);
    }
  };

  const handleSendReply = async () => {
    if (!selectedConversation || !reply.trim()) return;
    setSending(true);
    try {
      const sentMessage = await sendLiveFacebookReply({
        connection_id: selectedConversation.platform_connection_id,
        recipient_id: selectedConversation.customer_external_id,
        content: reply.trim(),
      });
      setMessages((current) =>
        [...current, sentMessage].sort((a, b) => {
          const left = a.created_at ? new Date(a.created_at).getTime() : 0;
          const right = b.created_at ? new Date(b.created_at).getTime() : 0;
          return left - right;
        }),
      );
      setConversations((current) =>
        current.map((item) =>
          item.id === selectedConversation.id
            ? {
                ...item,
                latest_message_preview: reply.trim(),
                latest_message_at: sentMessage.created_at,
                message_count: item.message_count + 1,
              }
            : item,
        ),
      );
      setReply("");
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "Unable to send Facebook reply.");
    } finally {
      setSending(false);
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

  const openAiMenuWithHold = (conversationId: string) => {
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

  const applyConversationAiChatState = (conversationId: string, state: ConversationAiChatState) => {
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
  };

  const handleAiChatModeChange = async (
    conversation: LiveFacebookConversation,
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
      const state = await updateLiveFacebookConversationAiChat(conversation.id, {
        connection_id: conversation.platform_connection_id,
        customer_external_id: conversation.customer_external_id,
        customer_name: conversation.customer_name,
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
    <section className="facebook-live-inbox-page">
      {error ? <div className="panel error-panel">{error}</div> : null}

      <div className="inbox-page inbox-page-live">
        <aside className="inbox-sidebar">
          <div className="table-card inbox-list">
            <div className="inbox-toolbar">
              <div className="inbox-toolbar-copy">
                <h2>Threads</h2>
                <span className="muted-copy small-copy">{filteredConversations.length} loaded</span>
              </div>
              <label className="inbox-search-field">
                <CustomField
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search customer or latest message"
                />
              </label>
            </div>

            {loadingFacebookConnections || loadingConversations ? (
              <LoadingPanel
                message="Loading Facebook threads..."
                hint="Fetching live conversation history from connected pages."
                compact
              />
            ) : null}
            {!loadingFacebookConnections && facebookConnections.length === 0 ? (
              <div className="inbox-state">No connected Facebook Page is available for live inbox browsing.</div>
            ) : null}
            {!loadingConversations && !loadingFacebookConnections && facebookConnections.length > 0 && filteredConversations.length === 0 ? (
              <div className="inbox-state">No Facebook conversations matched the current filters.</div>
            ) : null}
            <div className="conversation-list">
              {filteredConversations.map((conversation) => {
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
                    onPointerDown={() => openAiMenuWithHold(conversation.id)}
                    onPointerUp={clearHoldTimer}
                    onPointerLeave={clearHoldTimer}
                    onPointerCancel={clearHoldTimer}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      clearHoldTimer();
                      longPressTriggeredRef.current = true;
                      setSelectedConversationId(conversation.id);
                      setAiMenuConversationId(conversation.id);
                    }}
                  >
                    <div className="conversation-row-top">
                      <strong>{conversation.customer_name || conversation.customer_external_id}</strong>
                      <span className={`conversation-ai-tag ai-mode-${effectiveAiChatMode}`}>
                        {AI_CHAT_TAG_LABELS[effectiveAiChatMode]}
                      </span>
                    </div>
                    <p>{conversation.latest_message_preview || "No preview available."}</p>
                  </button>
                  {aiMenuConversationId === conversation.id ? (
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
            {conversationNextCursor ? (
              <div className="inbox-list-footer">
                <button type="button" className="secondary-action" onClick={handleLoadMoreConversations} disabled={loadingMoreConversations}>
                  {loadingMoreConversations ? "Loading..." : "Load more threads"}
                </button>
              </div>
            ) : null}
          </div>
        </aside>

        <div className="inbox-main">
          {!selectedConversation ? (
            <div className="inbox-empty">
              <h2>Select a thread</h2>
              <p className="muted-copy">Pick any conversation from the left to open the live message history.</p>
            </div>
          ) : (
            <>
              <div className="inbox-thread-header">
                <div>
                  <h2>{selectedConversation.customer_name || selectedConversation.customer_external_id}</h2>
                  <p className="muted-copy">
                    {selectedConversation.connection_name}
                    {" | "}
                    {selectedConversation.customer_external_id}
                  </p>
                </div>
                <div className="inbox-thread-meta">
                  <span className="conversation-pill">{selectedConversation.message_count} messages</span>
                  <span className="conversation-pill">{selectedConversation.unread_count} unread</span>
                  <span className="muted-copy small-copy">
                    {selectedConversation.latest_message_at
                      ? `Updated ${formatDateTime(selectedConversation.latest_message_at)}`
                      : "No timestamp"}
                  </span>
                </div>
              </div>

              <div className="inbox-thread-layout">
                <div className="table-card inbox-thread-card">
                  <div className="thread-scroll">
                    {loadingMessages ? (
                      <LoadingPanel
                        message="Loading live messages..."
                        hint="Reading the selected thread directly from Facebook."
                        compact
                      />
                    ) : null}
                    {!loadingMessages && messageNextCursor ? (
                      <div className="thread-scroll-footer thread-scroll-footer-top">
                        <button type="button" className="secondary-action" onClick={handleLoadMoreMessages} disabled={loadingMoreMessages}>
                          {loadingMoreMessages ? "Loading..." : "Load older messages"}
                        </button>
                      </div>
                    ) : null}
                    {!loadingMessages &&
                      messages.map((message) => {
                        const isCustomerMessage = message.direction === "inbound";
                        return (
                        <article
                          key={message.id}
                          className={`message-bubble ${message.direction === "outbound" ? "outbound" : "inbound"} ${isCustomerMessage ? "sender-customer" : "sender-human_admin"}`}
                        >
                          <div className="message-meta">
                            <strong>{message.sender_name || message.sender_external_id || "Unknown sender"}</strong>
                            <span>{formatDateTime(message.created_at) ?? "Unknown time"}</span>
                          </div>
                          <p>{message.content}</p>
                        </article>
                        );
                      })}
                    {!loadingMessages && messages.length > 0 ? <div className="thread-end-spacer" aria-hidden="true" /> : null}
                  </div>

                  <form
                    className="reply-box"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleSendReply();
                    }}
                  >
                    <div className="reply-toolbar">
                      <div className="reply-toolbar-main">
                        <EmojiPickerButton onSelect={appendReplyEmoji} />
                        <span className="muted-copy small-copy">
                          Replying live as {selectedConversation.connection_name}
                        </span>
                      </div>
                    </div>
                    <CustomTextArea
                      value={reply}
                      onChange={(event) => setReply(event.target.value)}
                      rows={5}
                      placeholder="Write a Facebook reply..."
                    />
                    <div className="reply-actions">
                      <span className="muted-copy small-copy">{reply.trim().length}/5000</span>
                      <button type="submit" disabled={sending || !reply.trim()}>
                        {sending ? "Sending..." : "Send reply"}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
