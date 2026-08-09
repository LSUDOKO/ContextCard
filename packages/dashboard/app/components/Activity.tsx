"use client";

// The access feed: every tool call the hero card (or its sub-cards) made against
// DataHub, newest first, attributed to the card that made it. Refusals show with
// their reason; each row is a ledger debit.

import type { AccessEntry } from "@/lib/api";
import { fmtClock, shortHex } from "./ui";

export type FeedRow = { entry: AccessEntry; cardName: string };

function shortUrn(u: string | null): string {
  if (!u) return "";
  if (u.length <= 46) return u;
  return shortHex(u, 26, 10);
}

export function Activity({ feed, empty }: { feed: FeedRow[]; empty?: React.ReactNode }) {
  if (feed.length === 0) {
    return (
      <div className="feed">
        <p className="feedempty">
          {empty ?? "No calls yet · connect this card to an agent and its every search, read and write lands here."}
        </p>
      </div>
    );
  }
  return (
    <div className="feed">
      {feed.map(({ entry, cardName }) => {
        const refused = entry.status === "refused";
        const failed = entry.status === "failed";
        return (
          <div className={`feedrow${refused || failed ? " bad" : ""}`} key={entry.id}>
            <span className={`fk ${entry.tool}`}>{entry.tool}</span>
            <span className="ft">{entry.target ? <span className="fturn mono">{shortUrn(entry.target)}</span> : null}</span>
            <span className="fm">{entry.memo ?? ""}</span>
            <span className="fc">
              <b className={refused ? "dangerword" : failed ? "dangerword" : undefined}>{refused ? "refused" : failed ? "failed" : "ok"}</b>
              <i className="fdot" />
              <span className="fcard">{cardName}</span>
              <span className="fclock num">{fmtClock(entry.at)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
