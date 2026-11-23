import React from "react";
import type {
  ChatRecord,
  ProviderCatalogEntry,
  ProviderCheckResult,
} from "../types";

interface SidebarProps {
  chats: ChatRecord[];
  activeChatId: string | null;
  providers: ProviderCatalogEntry[];
  checkResults: ProviderCheckResult[];
  checkingProviders: boolean;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onDeleteChat: (chatId: string) => void;
  onCheckProviders: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  chats,
  activeChatId,
  providers,
  checkResults,
  checkingProviders,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onCheckProviders,
}) => {
  const checkByProvider = new Map(checkResults.map((r) => [r.provider, r]));

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand">
          <span className="brand-dot" />
          <div>
            <h1>Council AI</h1>
            <span className="brand-sub">Lead-directed agent team</span>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-full"
          onClick={onNewChat}
        >
          + New Chat
        </button>
      </div>

      <div className="sidebar-section">
        <div className="section-label">Conversations</div>
        <div className="chat-list">
          {chats.length === 0 && (
            <div className="muted-empty">No conversations yet.</div>
          )}
          {chats.map((chat) => (
            <div
              key={chat.id}
              className={`chat-item ${chat.id === activeChatId ? "active" : ""}`}
            >
              <button
                type="button"
                className="chat-select"
                onClick={() => onSelectChat(chat.id)}
              >
                <span className="chat-title">{chat.title}</span>
                {chat.workspacePath && (
                  <span className="chat-ws">
                    {chat.workspacePath.split("/").pop()}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="chat-delete"
                title="Delete chat"
                onClick={() => onDeleteChat(chat.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="sidebar-section sidebar-footer">
        <div className="section-row">
          <span className="section-label">CLI Providers</span>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={checkingProviders}
            onClick={onCheckProviders}
          >
            {checkingProviders ? "Testing..." : "Test Live"}
          </button>
        </div>
        <div className="provider-health-list">
          {providers.map((p) => {
            const check = checkByProvider.get(p.id);
            const found = Boolean(p.discovery.executablePath);
            const statusText = check
              ? check.outcome
              : found
                ? "ready"
                : "missing";
            const statusClass =
              statusText === "ok" || statusText === "ready"
                ? "badge-ok"
                : statusText === "login_required"
                  ? "badge-warn"
                  : "badge-err";
            return (
              <div key={p.id} className="provider-health-row">
                <div>
                  <div className="provider-name">{p.id}</div>
                  <div className="provider-ver">
                    {p.discovery.version ?? (found ? "detected" : "not found")}
                  </div>
                </div>
                <span className={`badge ${statusClass}`}>{statusText}</span>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
};
