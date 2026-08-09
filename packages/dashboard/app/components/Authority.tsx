"use client";

// Connect affordances: the credential surface (UrlBox) and the per-harness install
// chips (ConnectChips). The card URL is the credential · every snippet embeds it;
// treat them all as secrets.

import { useState } from "react";
import { IconCheck, IconCopy } from "./ui";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="dbtn quiet"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <IconCheck /> : <IconCopy />}
      {copied ? "Copied" : label}
    </button>
  );
}

function IconOpen() {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.5 2H2.2A1.2 1.2 0 0 0 1 3.2v6.6A1.2 1.2 0 0 0 2.2 11h6.6A1.2 1.2 0 0 0 10 9.8V7.5" />
      <path d="M7 1h4v4M11 1L5.5 6.5" />
    </svg>
  );
}

/** The credential surface: a quiet inset box, the copy action riding inside it. */
export function UrlBox({ url, testid }: { url: string; testid?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ovurl">
      <span className="u" data-testid={testid}>
        {url}
      </span>
      <button
        className={`ovcopy${copied ? " done" : ""}`}
        aria-label="Copy URL"
        title="Copy URL"
        onClick={async () => {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
    </div>
  );
}

export function ConnectChips({ url, cardName }: { url: string; cardName: string }) {
  const [done, setDone] = useState<string | null>(null);
  const slug = cardName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "card";
  const name = `datacards-${slug}`;
  const cli = `claude mcp add --transport http ${name} ${url}`;
  const codex = `codex mcp add ${name} --url ${url}`;
  const openclaw = `openclaw mcp add ${name} --url ${url} --transport streamable-http`;
  const json = JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }, null, 2);
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${
    typeof window === "undefined" ? "" : btoa(JSON.stringify({ url }))
  }`;
  const claudeAiLink = `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent(name)}&connectorUrl=${encodeURIComponent(url)}`;
  const vscodeLink = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, type: "http", url }))}`;

  const copy = (key: string, text: string) => async () => {
    await navigator.clipboard.writeText(text);
    setDone(key);
    setTimeout(() => setDone((k) => (k === key ? null : k)), 1500);
  };
  const harnesses: { key: string; label: string; title: string; glyph: "copy" | "open"; act: () => void }[] = [
    { key: "cc", label: "Claude Code", title: "Copy the claude mcp add command", glyph: "copy", act: () => void copy("cc", cli)() },
    { key: "cai", label: "claude.ai", title: "Open a prefilled connector dialog", glyph: "open", act: () => void window.open(claudeAiLink, "_blank", "noopener") },
    { key: "cdx", label: "Codex", title: "Copy the codex mcp add command", glyph: "copy", act: () => void copy("cdx", codex)() },
    { key: "cur", label: "Cursor", title: "Open Cursor's install prompt", glyph: "open", act: () => void (window.location.href = cursorLink) },
    { key: "vsc", label: "VS Code", title: "Open VS Code's install prompt", glyph: "open", act: () => void (window.location.href = vscodeLink) },
    { key: "ocl", label: "OpenClaw", title: "Copy the openclaw mcp add command", glyph: "copy", act: () => void copy("ocl", openclaw)() },
    { key: "json", label: "JSON", title: "Copy mcpServers JSON for any other client", glyph: "copy", act: () => void copy("json", json)() },
  ];

  return (
    <div data-testid="connect-panel">
      <div className="hlabel">Add to Your Agent</div>
      <div className="hgrid">
        {harnesses.map((h) => (
          <button key={h.key} className={`hrow${done === h.key ? " done" : ""}`} title={h.title} onClick={h.act}>
            <span>{h.label}</span>
            {done === h.key ? <IconCheck /> : h.glyph === "copy" ? <IconCopy /> : <IconOpen />}
          </button>
        ))}
      </div>
      <p className="bchint">An arrow opens that harness prefilled · the rest copy an install command (JSON fits any other client)</p>
    </div>
  );
}
