import { Button } from "@/components/ui/button";
import { DotMatrixLoader } from "@/components/ui/dot-matrix-loader";
import { cn } from "@/lib/utils";
import { Check, Copy, Download, Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { readWwxArtifact } from "./store";
import type { ArtifactKind, ArtifactSummary } from "./types";

type ViewerArtifact = Pick<
  ArtifactSummary,
  "id" | "label" | "path" | "kind" | "filename" | "dataUrl" | "description" | "content" | "size" | "mtime"
>;

type ArtifactPreviewState = {
  status: "ready" | "unsupported" | "error";
  content: string;
  blob?: number[] | null;
  dataUrl?: string;
};

type WwxArtifactViewerProps = {
  artifact: ViewerArtifact | null;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
  emptyMessage?: string;
};

const TEXT_KINDS = new Set<ArtifactKind>([
  "angles",
  "strategy",
  "manifest",
  "report",
  "heartbeat",
  "log",
  "markdown",
  "json",
  "csv",
  "upload",
  "other",
]);
const LARGE_TEXT_PREVIEW_LIMIT = 40_000;
const artifactPreviewCache = new Map<string, ArtifactPreviewState>();
const markdownComponents = {
  pre: MarkdownPre,
  code: MarkdownCode,
  table: MarkdownTable,
  thead: MarkdownThead,
  tbody: MarkdownTbody,
  tr: MarkdownTr,
  th: MarkdownTh,
  td: MarkdownTd,
};

export function WwxArtifactViewer({
  artifact,
  expanded = false,
  onExpandedChange,
  className,
  emptyMessage = "Select an artifact to preview it here.",
}: WwxArtifactViewerProps) {
  const preview = useArtifactPreview(artifact);
  const [copied, setCopied] = useState(false);
  const filename = artifact ? artifactBasename(artifact.filename ?? artifact.label) : "Preview";
  const canCopy = Boolean(artifact);
  const canDownload = preview.status === "ready" && Boolean(artifact);
  const canExpand = Boolean(artifact && onExpandedChange);
  const isMarkdown = Boolean(
    artifact &&
      (artifact.kind === "markdown" ||
        artifact.kind === "angles" ||
        artifact.kind === "upload" ||
        artifact.filename?.endsWith(".md") ||
        artifact.label.endsWith(".md") ||
        artifact.path.endsWith(".md")),
  );

  const copyArtifact = useCallback(async () => {
    if (!canCopy || !artifact) return;
    await navigator.clipboard.writeText(preview.content || artifact.path);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [artifact?.path, canCopy, preview.content]);

  const downloadArtifact = useCallback(() => {
    if (!artifact || preview.status !== "ready") return;
    const blob = preview.blob?.length
      ? new Blob([new Uint8Array(preview.blob)])
      : new Blob([preview.content], { type: textMimeFor(filename) });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [artifact, filename, preview]);

  if (!artifact) {
    return (
      <section
        className={cn(
          "flex min-h-[320px] min-w-0 flex-1 items-center justify-center rounded-md border border-dashed border-white/15 bg-[#15161a] p-3 text-[11px] text-slate-400",
          className,
        )}
      >
        {emptyMessage}
      </section>
    );
  }

  return (
    <section
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-white/15 bg-[#191a1e]",
        expanded && "h-full",
        className,
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-white/10 bg-[#15161a] px-2 py-1.5">
        <div className="min-w-0 truncate text-[10px] font-medium text-slate-400" title={artifact.path}>
          {filename}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="rounded-md text-slate-500 hover:bg-white/10 hover:text-slate-100"
            title="Copy artifact"
            aria-label="Copy artifact"
            disabled={!canCopy}
            onClick={() => void copyArtifact()}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="rounded-md text-slate-500 hover:bg-white/10 hover:text-slate-100"
            title="Download artifact"
            aria-label="Download artifact"
            disabled={!canDownload}
            onClick={downloadArtifact}
          >
            <Download size={13} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="rounded-md text-slate-500 hover:bg-white/10 hover:text-slate-100"
            title={expanded ? "Restore artifact preview" : "Expand artifact preview"}
            aria-label={expanded ? "Restore artifact preview" : "Expand artifact preview"}
            disabled={!canExpand}
            onClick={() => onExpandedChange?.(!expanded)}
          >
            {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </Button>
        </div>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden bg-[#1c1d21]">
        {preview.status === "loading" ? (
          <div className="px-3 py-2 text-[11px] text-slate-400">
            <DotMatrixLoader label="Loading preview" />
          </div>
        ) : artifact.kind === "image" ? (
          <div className="flex h-full min-h-[320px] min-w-0 items-center justify-center overflow-hidden">
            <img
              src={preview.dataUrl ?? artifact.dataUrl ?? ""}
              alt={artifact.label}
              className="block h-full max-h-full w-full max-w-full object-contain"
              loading="lazy"
            />
          </div>
        ) : artifact.kind === "directory" ? (
          <div className="flex min-h-[220px] min-w-0 flex-1 p-3 text-[11px] leading-relaxed text-slate-400">
            {artifact.description ?? "Generated files are inside this folder."}
          </div>
        ) : preview.status === "ready" && preview.content.length > LARGE_TEXT_PREVIEW_LIMIT ? (
          <LargeTextPreview
            content={preview.content}
            note={
              isMarkdown
                ? "Large markdown file shown as plain text for smoother scrolling."
                : "Large text file shown in raw mode for smoother scrolling."
            }
          />
        ) : preview.status === "ready" && isMarkdown ? (
          <Streamdown
            className="markdown-preview artifact-markdown-preview h-full overflow-auto break-words px-3 py-2 text-[11.5px] leading-relaxed"
            components={markdownComponents}
            controls={false}
          >
            {preview.content || "(empty file)"}
          </Streamdown>
        ) : (
          <pre className="h-full max-w-full overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[10px] leading-relaxed text-slate-200">
            {preview.status === "ready"
              ? preview.content || "(empty file)"
              : "Preview unavailable for this file."}
          </pre>
        )}
      </div>
    </section>
  );
}

function useArtifactPreview(artifact: ViewerArtifact | null): {
  status: "idle" | "loading" | "ready" | "unsupported" | "error";
  content: string;
  blob?: number[] | null;
  dataUrl?: string;
} {
  const [state, setState] = useState<{
    status: "idle" | "loading" | "ready" | "unsupported" | "error";
    content: string;
    blob?: number[] | null;
    dataUrl?: string;
  }>({ status: "idle", content: "" });

  useEffect(() => {
    let cancelled = false;
    const cacheKey = artifact
      ? [
          artifact.id,
          artifact.mtime ?? "no-mtime",
          artifact.size ?? "no-size",
          artifact.filename ?? artifact.label,
        ].join(":")
      : null;

    if (!artifact) {
      setState({ status: "idle", content: "" });
      return;
    }

    if (cacheKey) {
      const cached = artifactPreviewCache.get(cacheKey);
      if (cached) {
        setState(cached);
        return;
      }
    }

    if (artifact.content !== undefined) {
      const nextState = { status: "ready", content: artifact.content } as const;
      if (cacheKey) artifactPreviewCache.set(cacheKey, nextState);
      setState(nextState);
      return;
    }

    setState({ status: "loading", content: "" });
    void readWwxArtifact(artifact.id)
      .then((result) => {
        if (cancelled) return;
        if (result.contentText !== undefined && result.contentText !== null) {
          const nextState = {
            status: "ready",
            content: result.contentText,
            blob: null,
          } as const;
          if (cacheKey) artifactPreviewCache.set(cacheKey, nextState);
          setState(nextState);
          return;
        }
        if (result.contentBlob?.length) {
          const dataUrl = artifact.kind === "image" ? blobToDataUrl(result.contentBlob, imageMimeFor(artifact)) : undefined;
          const nextState = {
            status: "ready",
            content: "",
          blob: result.contentBlob,
          dataUrl,
        } as const;
          if (cacheKey) artifactPreviewCache.set(cacheKey, nextState);
          setState(nextState);
          return;
        }
        const nextState = {
          status: TEXT_KINDS.has(artifact.kind) ? "ready" : "unsupported",
          content: "",
        } as const;
        if (cacheKey) artifactPreviewCache.set(cacheKey, nextState);
        setState(nextState);
      })
      .catch(() => {
        if (!cancelled) {
          const nextState = { status: "error", content: "" } as const;
          if (cacheKey) artifactPreviewCache.set(cacheKey, nextState);
          setState(nextState);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [artifact?.content, artifact?.filename, artifact?.id, artifact?.kind, artifact?.label, artifact?.mtime, artifact?.size]);

  return state;
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  return (
    <pre className="my-2 overflow-auto rounded-md border border-white/12 bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-slate-200">
      {children}
    </pre>
  );
}

function MarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <table className="my-0 w-full border-collapse border border-slate-500/55 text-left text-slate-200">
      {children}
    </table>
  );
}

function MarkdownThead({ children }: { children?: ReactNode }) {
  return <thead className="bg-[#252a2f] text-slate-50">{children}</thead>;
}

function MarkdownTbody({ children }: { children?: ReactNode }) {
  return <tbody>{children}</tbody>;
}

function MarkdownTr({ children }: { children?: ReactNode }) {
  return <tr className="border-b border-slate-500/45 last:border-b-0">{children}</tr>;
}

function MarkdownTh({ children }: { children?: ReactNode }) {
  return (
    <th className="border-r border-slate-500/45 px-3 py-2 text-left text-[11px] font-semibold last:border-r-0">
      {children}
    </th>
  );
}

function MarkdownTd({ children }: { children?: ReactNode }) {
  return (
    <td className="border-r border-slate-500/35 px-3 py-2 align-top text-[11px] last:border-r-0">
      {children}
    </td>
  );
}

function MarkdownCode({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  if (!className?.includes("language-")) {
    return (
      <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[11px] text-slate-100">
        {children}
      </code>
    );
  }
  return <code className="font-mono text-[11px] text-slate-200">{children}</code>;
}

function LargeTextPreview({ content, note }: { content: string; note: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-white/10 bg-[#15161a] px-3 py-2 text-[11px] text-slate-400">
        {note}
      </div>
      <textarea
        readOnly
        spellCheck={false}
        wrap="off"
        value={content}
        className="min-h-0 flex-1 resize-none border-0 bg-[#101114] p-3 font-mono text-[11px] leading-relaxed text-slate-200 outline-none"
      />
    </div>
  );
}

function artifactBasename(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function imageMimeFor(artifact: ViewerArtifact): string {
  const name = (artifact.filename ?? artifact.label).toLowerCase();
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".svg")) return "image/svg+xml";
  return "image/png";
}

function textMimeFor(filename: string): string {
  if (filename.endsWith(".json")) return "application/json;charset=utf-8";
  if (filename.endsWith(".md") || filename.endsWith(".markdown")) return "text/markdown;charset=utf-8";
  if (filename.endsWith(".csv")) return "text/csv;charset=utf-8";
  return "text/plain;charset=utf-8";
}

function blobToDataUrl(blob: number[], mime: string): string {
  const bytes = new Uint8Array(blob);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mime};base64,${window.btoa(binary)}`;
}
