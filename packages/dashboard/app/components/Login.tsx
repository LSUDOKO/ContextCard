"use client";

// The sign-in screen: the steward enters the server's DATACARDS_ADMIN_TOKEN.
// Same stage as before — the split title card, the tilted card object with the
// flowing silk under the pointer, the aurora weather — but the gate is a token,
// not a wallet. The token is sent as Bearer on every /api call and never ships
// in the bundle.

import { useState } from "react";
import { ChipDots, Guilloche } from "./ui";
import s from "./login.module.css";

export function Login({ onSubmit, error }: { onSubmit: (token: string) => void; error?: string | null }) {
  const [token, setToken] = useState("");
  const [hover, setHover] = useState(false);
  return (
    <main className={s.stage} data-testid="login-screen">
      <div className={s.aurora} aria-hidden>
        <i className={s.beamA} />
        <i className={s.beamB} />
        <i className={s.beamC} />
      </div>

      <section className={s.type}>
        <h1 className={`rv ${s.wm}`} style={{ animationDelay: ".05s" }}>
          DataCards
        </h1>
        <p className={`rv ${s.tag}`} style={{ animationDelay: ".13s" }}>
          Context, lent not given.
        </p>
        <p className={`rv ${s.lede}`} style={{ animationDelay: ".21s" }}>
          Scoped, revocable access cards for your agents · they borrow the catalog, never the keys, and die on
          revoke.
        </p>
        <p className={`rv ${s.quiet}`} style={{ animationDelay: ".27s" }}>
          Enter the steward token from your server&apos;s DATACARDS_ADMIN_TOKEN
        </p>
        <span className={`rv ${s.ctarow}`} style={{ animationDelay: ".36s" }}>
          <input
            type="password"
            style={{
              width: 240,
              padding: "11px 14px",
              borderRadius: 10,
              border: "1px solid var(--hairline-strong)",
              background: "var(--canvas)",
              color: "var(--ink)",
              fontSize: 14,
              outline: "none",
            }}
            autoFocus
            value={token}
            placeholder="paste the admin token"
            data-testid="token-input"
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && token.trim()) onSubmit(token.trim());
            }}
          />
          <button
            className={`primary ${s.cta}`}
            disabled={!token.trim()}
            onClick={() => onSubmit(token.trim())}
            data-testid="login"
          >
            Sign In
          </button>
        </span>
        {error && <p className={`rv ${s.lede}`} style={{ color: "var(--danger, #d64a45)", animationDelay: ".4s" }}>{error}</p>}
      </section>

      <section className={s.counter} aria-hidden>
        <div className={`rv ${s.frame}`} style={{ animationDelay: ".3s" }}>
          <div className={s.tilt} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
            <div className={`card ${s.cardobj}`}>
              <div className="band">
                <Guilloche width={472} height={88} animate={hover} />
              </div>
              <div className="inner">
                <div className="row1">
                  <span className="wm">datacards</span>
                </div>
                <ChipDots />
                <div className="num">
                  <span>4</span>
                  <span>0</span>
                  <span>0</span>
                  <span>0</span>
                  <span className="brandmark">context</span>
                </div>
                <div className="holderline">
                  <span className="hname">Agent Card</span>
                  <span className="hexp">∞</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
