"use client";

// /shop: standalone demo merchant ("s0nder supply co."), a sibling storefront on
// the DataCards design system (same tokens, light + INK dark) with an honest foot
// note: test-mode Visa, Stripe test settlement. An agent fills the checkout form
// via browser automation (data-testids below); the fiat lane authorizes the charge
// against the card's spend budget behind the scenes. No admin token, no dashboard
// chrome — plain fetch against the server's public /shop routes. Also served at
// the shop.* host (proxy.ts rewrites it here).

import { useEffect, useState } from "react";
import s from "./shop.module.css";

const API = process.env.NEXT_PUBLIC_DATACARDS_API ?? "http://localhost:4070/api";
const BASE = API.replace(/\/api\/?$/, "");

type Product = { id: string; name: string; price: string };
type Catalog = { merchant: string; products: Product[] };
type CheckoutResult = {
  approved: boolean;
  reason: string;
  authorization_id?: string;
  product?: Product;
  last4?: string;
  remaining_spend?: number | null;
};

export default function ShopPage() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Product | null>(null);
  const [number, setNumber] = useState("");
  const [expMonth, setExpMonth] = useState("");
  const [expYear, setExpYear] = useState("");
  const [cvc, setCvc] = useState("");
  const [paying, setPaying] = useState(false);
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [payErr, setPayErr] = useState<string | null>(null);

  useEffect(() => {
    document.title = catalog?.merchant ?? "s0nder supply co.";
  }, [catalog]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${BASE}/shop/products`, { cache: "no-store" });
        if (!res.ok) throw new Error(`http ${res.status}`);
        setCatalog((await res.json()) as Catalog);
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const pick = (p: Product) => {
    setPicked(p);
    setResult(null);
    setPayErr(null);
  };

  const pay = async () => {
    if (!picked) return;
    setPaying(true);
    setPayErr(null);
    try {
      const res = await fetch(`${BASE}/shop/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          product_id: picked.id,
          card: { number, exp_month: Number(expMonth), exp_year: Number(expYear), cvc },
        }),
      });
      // declines come back 200 { approved: false }; only malformed/disabled are non-2xx
      const body = (await res.json().catch(() => null)) as CheckoutResult | null;
      if (!res.ok) throw new Error(body?.reason ?? `http ${res.status}`);
      setResult(body);
    } catch (e) {
      setPayErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPaying(false);
    }
  };

  const tryAgain = () => {
    setResult(null);
    setPayErr(null);
  };

  const formReady = number.trim() !== "" && expMonth.trim() !== "" && expYear.trim() !== "" && cvc.trim() !== "";
  const products = catalog?.products ?? [];
  const declined = result && !result.approved;

  return (
    <div className={s.wrap}>
      <div className={s.inner}>
        <div className={s.brand}>{catalog?.merchant ?? "s0nder supply co."}</div>
        <div className={s.tag}>Everyday goods, shipped fast · pay with a card&apos;s test Visa</div>

        <div className={s.grid}>
          {!catalog && !loadErr && [0, 1, 2, 3].map((i) => (
            <div className={s.skel} key={i}>
              <i />
              <i />
              <i />
            </div>
          ))}
          {loadErr && <p className="err">{loadErr} · start the server with a test-mode STRIPE_SECRET_KEY</p>}
          {products.map((p) => (
            <div className={s.product} key={p.id}>
              <span className={s.pname}>{p.name}</span>
              <span className={s.pprice}>${p.price}</span>
              <button
                className={`dbtn ${s.buy}${picked?.id === p.id ? " active" : ""}`}
                onClick={() => pick(p)}
                data-testid={`shop-product-${p.id}`}
              >
                {picked?.id === p.id ? "Picked" : "Buy"}
              </button>
            </div>
          ))}
        </div>

        <div className={s.panel}>
          <div className={s.ptitle}>
            {picked ? `Checkout · ${picked.name}` : "Pick a product to check out"}
          </div>
          <div className={s.fields}>
            <label className={s.field}>
              Card Number
              <input
                inputMode="numeric"
                placeholder="4242 4242 4242 4242"
                value={number}
                autoComplete="off"
                data-testid="shop-card-number"
                onChange={(e) => setNumber(e.target.value)}
              />
            </label>
            <div className={s.exprow}>
              <label className={s.field}>
                Expiry · MM
                <input inputMode="numeric" placeholder="12" value={expMonth} data-testid="shop-exp-month" onChange={(e) => setExpMonth(e.target.value)} />
              </label>
              <label className={s.field}>
                Expiry · YY
                <input inputMode="numeric" placeholder="29" value={expYear} data-testid="shop-exp-year" onChange={(e) => setExpYear(e.target.value)} />
              </label>
              <label className={s.field}>
                CVC
                <input inputMode="numeric" placeholder="123" value={cvc} data-testid="shop-cvc" onChange={(e) => setCvc(e.target.value)} />
              </label>
            </div>
          </div>
          <div className={s.payrow}>
            <button className={`dbtn ${s.pay}`} disabled={!picked || !formReady || paying} onClick={pay} data-testid="shop-pay">
              {paying ? "Authorizing…" : picked ? `Pay $${picked.price}` : "Pick a Product"}
            </button>
          </div>

          {payErr && (
            <div className={`${s.result} ${s.declined}`} data-testid="shop-pay-error">
              {payErr}
            </div>
          )}
          {result && (
            <div className={`${s.result} ${declined ? s.declined : s.approved}`} data-testid="shop-result">
              {declined ? `Declined · ${result.reason}` : `Approved · ${result.product?.name} · $${result.product?.price}`}
              {result.last4 && <span> · Visa •••• {result.last4}</span>}
              {result.remaining_spend !== undefined && result.remaining_spend !== null && (
                <span> · ${(result.remaining_spend / 100).toFixed(2)} spend left</span>
              )}
              {result.authorization_id && <span className={s.authid}>authorization {result.authorization_id}</span>}
              {declined && (
                <button className={`mghost ${s.again}`} onClick={tryAgain} data-testid="shop-try-again">
                  Try Another Card
                </button>
              )}
            </div>
          )}
          {!result && !payErr && (
            <p className={s.quiet}>
              Checkout matches the card&apos;s test Visa and authorizes against its spend budget — a frozen or
              over-budget card declines with the card&apos;s own refusal.
            </p>
          )}
        </div>

        <div className={s.foot}>
          Test-mode Stripe Issuing · purchases are real Stripe test authorizations against the linked card&apos;s
          budget, never live money. Get the card number from an agent&apos;s <b>card_credentials</b> tool, or{" "}
          <a href="/">open the dashboard</a> and issue a card with a spend budget.
        </div>
      </div>
    </div>
  );
}
