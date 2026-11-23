import React, { useState } from "react";
import type {
  ProviderCatalogEntry,
  ProviderId,
  WorkspaceInspection,
} from "../types";

interface WorkspaceBarProps {
  workspacePath: string;
  inspection: WorkspaceInspection | null;
  selectedPaths: string[];
  inspecting: boolean;
  inspectError: string | null;
  activeProviders: ProviderId[];
  allowReadOnlyTools: boolean;
  catalog: ProviderCatalogEntry[];
  disabled?: boolean;
  onChangePath: (path: string) => void;
  onInspect: () => void;
  onClearWorkspace: () => void;
  onChangeSelectedPaths: (paths: string[]) => void;
}

export const WorkspaceBar: React.FC<WorkspaceBarProps> = ({
  workspacePath,
  inspection,
  selectedPaths,
  inspecting,
  inspectError,
  activeProviders,
  allowReadOnlyTools,
  catalog,
  disabled,
  onChangePath,
  onInspect,
  onClearWorkspace,
  onChangeSelectedPaths,
}) => {
  const [showFiles, setShowFiles] = useState(false);
  const [showPerms, setShowPerms] = useState(false);

  const uniqueProviders = Array.from(new Set(activeProviders));
  const catalogById = new Map(catalog.map((c) => [c.id, c]));

  const toggleFile = (filePath: string) => {
    if (selectedPaths.length === 0 && inspection) {
      onChangeSelectedPaths(
        inspection.files.map((f) => f.path).filter((p) => p !== filePath),
      );
      return;
    }
    if (selectedPaths.includes(filePath)) {
      onChangeSelectedPaths(selectedPaths.filter((p) => p !== filePath));
    } else {
      onChangeSelectedPaths([...selectedPaths, filePath]);
    }
  };

  const includedCount = inspection
    ? selectedPaths.length > 0
      ? selectedPaths.length
      : inspection.files.length
    : 0;

  return (
    <div className="workspace-bar">
      <div className="workspace-row">
        <span className="section-label">Read-only repo snapshot</span>
        <input
          type="text"
          className="workspace-input"
          placeholder="/path/to/local/repository (optional)"
          disabled={disabled}
          value={workspacePath}
          onChange={(e) => onChangePath(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-xs btn-secondary"
          disabled={disabled || inspecting || !workspacePath.trim()}
          onClick={onInspect}
        >
          {inspecting ? "Inspecting..." : "Inspect Repo"}
        </button>
        {(workspacePath || inspection) && (
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            disabled={disabled}
            onClick={onClearWorkspace}
          >
            Clear
          </button>
        )}
      </div>

      {inspectError && <div className="error-inline">{inspectError}</div>}

      {inspection && (
        <div className="workspace-meta">
          <div className="workspace-badges">
            {inspection.gitBranch && (
              <span className="pill">branch: {inspection.gitBranch}</span>
            )}
            {inspection.gitCommit && (
              <span className="pill">
                rev: {inspection.gitCommit.slice(0, 8)}
                {inspection.gitDirty ? "*" : ""}
              </span>
            )}
            <span className="pill">
              {includedCount}/{inspection.files.length} files (
              {Math.round(inspection.totalBytes / 1024)} KB)
            </span>
            <span className="pill pill-accent">
              Providers receiving material: {uniqueProviders.join(", ")}
            </span>
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => setShowFiles((v) => !v)}
            >
              {showFiles ? "Hide files" : "Select files"}
            </button>
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => setShowPerms((v) => !v)}
            >
              {showPerms ? "Hide permissions" : "Effective permissions"}
            </button>
          </div>

          {showFiles && (
            <div className="workspace-files-box">
              <div className="files-actions">
                <button
                  type="button"
                  className="btn btn-xs btn-ghost"
                  onClick={() => onChangeSelectedPaths([])}
                >
                  Include all ({inspection.files.length})
                </button>
                <span className="muted-hint">
                  {selectedPaths.length === 0
                    ? "All inspected text files will be copied into a read-only snapshot."
                    : `${selectedPaths.length} specific file(s) selected for snapshot.`}
                </span>
              </div>
              <div className="files-grid">
                {inspection.files.map((f) => {
                  const checked =
                    selectedPaths.length === 0 || selectedPaths.includes(f.path);
                  return (
                    <label key={f.path} className="file-check" title={f.path}>
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={checked}
                        onChange={() => toggleFile(f.path)}
                      />
                      <span>{f.path}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {showPerms && (
            <div className="perms-grid">
              {uniqueProviders.map((pid) => {
                const entry = catalogById.get(pid);
                const policy = allowReadOnlyTools
                  ? entry?.readOnlyPolicies.withTools
                  : entry?.readOnlyPolicies.withoutTools;
                if (!policy) return null;
                return (
                  <div key={pid} className="perm-card">
                    <div className="perm-title">{pid}</div>
                    <div className="perm-summary">{policy.sandboxSummary}</div>
                    <div className="perm-line">
                      <strong>Allowed:</strong>{" "}
                      {policy.allowedOperations.join(", ")}
                    </div>
                    <div className="perm-line">
                      <strong>Blocked:</strong>{" "}
                      {policy.blockedOperations.join(", ")}
                    </div>
                    <div className="perm-flags">
                      {policy.flags.map((f) => (
                        <code key={f}>{f}</code>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
