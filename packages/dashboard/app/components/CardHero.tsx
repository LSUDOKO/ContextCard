"use client";

// The DataCard face — the deck's object. One face, no flip: the budget figure
// (calls left this period) is the headline, scope chips read what the agent may
// touch, the silk band flows under the pointer.

import { useState } from "react";
import type { CardState } from "@/lib/api";
import { ChipDots, Guilloche, StatusPill } from "./ui";

const typeWord = (t: string) => t.toLowerCase();

function scopeSummary(card: CardState): string {
  const s = card.terms.scope;
  if (!s) return "Full catalog reads";
  const parts: string[] = [];
  if (s.domains?.length) parts.push(`${s.domains.length} domain${s.domains.length === 1 ? "" : "s"}`);
  if (s.platforms?.length) parts.push(`${s.platforms.length} platform${s.platforms.length === 1 ? "" : "s"}`);
  if (s.entityTypes?.length) parts.push(`${s.entityTypes.length} type${s.entityTypes.length === 1 ? "" : "s"}`);
  if (s.entities?.length) parts.push(`${s.entities.length} entit${s.entities.length === 1 ? "y" : "ies"}`);
  if (s.glossaryTerms?.length) parts.push(`${s.glossaryTerms.length} term${s.glossaryTerms.length === 1 ? "" : "s"}`);
  if (!parts.length) return "Full catalog reads";
  if (s.lineageDepth) parts.push(`lineage ≤${s.lineageDepth}`);
  return parts.join(" · ");
}

export function CardFace({ card, dimmed = false }: { card: CardState; dimmed?: boolean }) {
  const [hover, setHover] = useState(false);
  const remaining = card.remaining_this_period ?? card.remaining_lifetime;
  const cap =
    card.terms.budget?.period?.amount ??
    card.terms.budget?.lifetime?.amount ??
    (card.remaining_lifetime !== null && card.remaining_this_period === null ? card.remaining_lifetime : null);
  const head = remaining !== null ? String(remaining) : "∞";
  const headLabel =
    card.terms.budget?.period
      ? `calls / ${card.terms.budget.period.seconds <= 86400 ? "day" : card.terms.budget.period.seconds <= 604800 ? "wk" : "mo"}`
      : card.terms.budget?.lifetime
        ? "calls lifetime"
        : "calls";
  return (
    <div
      className={`dcard${card.status === "active" ? "" : " dead"}`}
      style={{ opacity: dimmed ? 0.55 : 1 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="band">
        <Guilloche width={472} height={88} animate={hover && card.status !== "revoked" && card.status !== "nuked"} />
      </div>
      <div className="inner">
        <div className="row1">
          <span className="wm">datacards</span>
          <StatusPill status={card.status} />
        </div>
        <ChipDots />
        <div className="dcfigure">
          <span className="dcnum num">{head}</span>
          <span className="dclbl">{headLabel}</span>
        </div>
        <div className="dcscope">{scopeSummary(card)}</div>
        <div className="holderline">
          <span className="hname">{card.name}</span>
          <span className="hexp">
            {card.expires_at
              ? `expires ${new Date(card.expires_at * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
              : "no expiry"}
          </span>
        </div>
      </div>
    </div>
  );
}

export { typeWord };
