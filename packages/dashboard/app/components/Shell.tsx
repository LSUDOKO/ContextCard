"use client";

// The shell: a quiet left rail. Wordmark up top; the bottom stack carries the
// DataHub connection dot, the theme toggle, and the avatar. The avatar menu
// holds the DataHub connection fact, the sign-out, and the wallet-level danger
// verb (nuke). The menu PORTALS to document.body (the house rule for every
// floating surface).

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@/lib/api";
import { useAuth } from "../providers";
import { DangerModal, type DangerPhase } from "./Confirm";
import { ThemeToggle } from "./Theme";

export function Cockpit({
  back,
  nukeable = false,
  aggregate,
  children,
}: {
  back?: { href: string; label: string };
  nukeable?: boolean;
  aggregate?: string;
  children: React.ReactNode;
}) {
  const { clear } = useAuth();
  return (
    <div className="app">
      <aside className="rail">
        <Link className="brand" href="/">
          DataCards
        </Link>
        {back && (
          <Link className="railback" href={back.href} title={back.label} aria-label={back.label}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </Link>
        )}
        <div className="railfoot">
          <Link className="raillink" href="/docs" title="Documentation" aria-label="Documentation">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 18.5z" />
              <path d="M5 17.5A1.5 1.5 0 0 1 6.5 16H19" />
              <path d="M8.5 7.5h7M8.5 10.5h7" />
            </svg>
          </Link>
          <ThemeToggle />
          <ProfileMenu onLogout={clear} nukeable={nukeable} aggregate={aggregate} />
        </div>
      </aside>
      <div className="maincol">{children}</div>
    </div>
  );
}

function ProfileMenu({ onLogout, nukeable, aggregate }: { onLogout: () => void; nukeable: boolean; aggregate?: string }) {
  const [open, setOpen] = useState(false);
  const [nukeOpen, setNukeOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [hub, setHub] = useState<{ connected: boolean; user: string | null } | null>(null);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .me()
      .then((m) => {
        if (live) setHub({ connected: m.connected, user: m.user?.displayName ?? m.user?.username ?? null });
      })
      .catch(() => {
        if (live) setHub({ connected: false, user: null });
      });
    return () => {
      live = false;
    };
  }, [open]);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<React.CSSProperties | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [open]);
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setAnchor(
        window.innerWidth < 1100
          ? { right: 12, top: r.bottom + 10, transformOrigin: "right top" }
          : { left: r.right + 14, bottom: window.innerHeight - r.bottom - 6, transformOrigin: "left bottom" },
      );
    }
    setOpen((v) => !v);
  };
  return (
    <div className="profile">
      <button ref={btnRef} className="avatarbtn" onClick={toggle} aria-label="Account" data-testid="profile">
        <span className="avatar" />
      </button>
      {mounted &&
        createPortal(
          <AnimatePresence>
            {open && anchor && (
              <>
                <div className="scrim" onClick={() => setOpen(false)} />
                <motion.div
                  className="promenu"
                  initial={{ opacity: 0, x: -8, scale: 0.97 }}
                  animate={{ opacity: 1, x: 0, scale: 1, transition: { type: "spring", stiffness: 480, damping: 34 } }}
                  exit={{ opacity: 0, x: -6, scale: 0.98, transition: { duration: 0.12 } }}
                  style={anchor}
                >
                  <div className="prowho">
                    <span className="avatar" />
                    <span className="prowhocol">
                      <span className="em">Steward</span>
                      {aggregate && <span className="proagg">{aggregate}</span>}
                    </span>
                  </div>
                  <div className="proitem" style={{ cursor: "default" }}>
                    <span className={`net ${hub === null ? "" : hub.connected ? "on" : ""}`} />
                    {hub === null ? "Checking DataHub…" : hub.connected ? `DataHub · ${hub.user ?? "connected"}` : "DataHub · unreachable"}
                  </div>
                  <button
                    className="proitem"
                    onClick={() => {
                      setOpen(false);
                      onLogout();
                    }}
                    data-testid="logout"
                  >
                    Sign Out
                  </button>
                  {nukeable && (
                    <div className="prodanger">
                      <button className="proitem danger" onClick={() => { setOpen(false); setNukeOpen(true); }} data-testid="nuke">
                        Nuke All Cards
                      </button>
                      <p className="pronote">Revokes every card and sub-card · agents holding them lose all context access, permanently.</p>
                    </div>
                  )}
                </motion.div>
              </>
            )}
          </AnimatePresence>,
          document.body,
        )}
      <NukeModal open={nukeOpen} onNuked={() => undefined} onClose={() => setNukeOpen(false)} />
    </div>
  );
}

function NukeModal({ onNuked, open, onClose }: { onNuked: () => void | Promise<void>; open: boolean; onClose: () => void }) {
  const [phase, setPhase] = useState<DangerPhase>("confirm");
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setErr(null);
    try {
      setPhase("busy");
      await api.nuke();
      setPhase("done");
      await onNuked();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  return (
    <DangerModal
      open={open}
      phase={phase}
      prefix="nuke"
      title="Nuke every card?"
      body="Revokes every card and sub-card you ever issued. Agents holding them lose all authority, permanently."
      confirmLabel="Yes, Nuke Everything"
      busyNote="Revoking the whole tree…"
      doneTitle="Every card is dead"
      doneNote="Nuked. Every card is revoked; every agent's access is dead."
      errorNote={err ? `Nuke failed: ${err}` : undefined}
      onConfirm={go}
      onClose={() => {
        onClose();
        setPhase("confirm");
      }}
    />
  );
}
