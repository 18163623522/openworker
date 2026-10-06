// Models & Keys, the provider cards (UX-055): three groups by kind — on your own
// hardware, subscriptions, API keys — connected cards first in each group, then a
// thin "not set up" rule, a search box over all three, and more air in each card.
// The card grid and the open-in-place detail are the page's existing shape; only the
// order, the grouping and the spacing change here.
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ProviderInfo } from "../../api";
import { ProviderMark, type ProviderSetupState } from "../../providers/ProviderSetup";

type Kind = "local" | "subscription" | "api_key";
const KINDS: Kind[] = ["local", "subscription", "api_key"];

export function providerKind(p: ProviderInfo): Kind {
  return p.kind || "api_key";
}

/** Connected = usable now: a key or sign-in stored, or a keyless local server that
 * answers (the setup state's `keylessOk`). */
export function providerConnected(p: ProviderInfo, keylessOk: Set<string>): boolean {
  if (p.auth === "oauth") return !!p.signed_in;
  if (!p.needs_key) return !!p.alive || keylessOk.has(p.name);
  return p.configured;
}

/** How many of the picker's models belong to a provider. */
export function modelCountFor(name: string, models: string[], known: string[]): number {
  return models.filter((id) => {
    const i = id.indexOf(":");
    const prov = i > 0 && known.includes(id.slice(0, i)) ? id.slice(0, i) : "openai";
    return prov === name;
  }).length;
}

export function ProviderGroups({
  ps,
  tp,
  models,
}: {
  ps: ProviderSetupState;
  tp: string;
  models: string[]; // the picker's models, for the count on each card
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const known = ps.providers.map((p) => p.name);
  const q = query.trim().toLowerCase();
  const shown = ps.ordered.filter((p) => !q || p.title.toLowerCase().includes(q) || p.name.includes(q));
  const card =
    "flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-4 min-h-[74px] text-left hover:border-lineStrong transition-colors";

  const cardFor = (p: ProviderInfo) => {
    const connected = providerConnected(p, ps.keylessOk);
    const count = connected ? modelCountFor(p.name, models, known) : 0;
    return (
      <button key={p.name} className={card} data-testid={`${tp}-provider-${p.name}`} onClick={() => ps.openProvider(p.name)}>
        <ProviderMark name={p.name} title={p.title} />
        <span className="min-w-0 flex-1">
          <span className="block text-ui font-semibold leading-tight truncate">{p.title}</span>
          {connected && count > 0 ? (
            <span className="block text-meta text-ok font-medium truncate">
              {t(p.needs_key || p.auth === "oauth" ? "provider.connected_count" : "provider.running_count", { count })}
            </span>
          ) : connected && !p.needs_key && p.auth !== "oauth" ? (
            <span className="block text-meta text-ok font-medium truncate">{t("provider.running")}</span>
          ) : !connected && !p.needs_key && p.auth !== "oauth" && p.kind === "local" && p.name !== "ollama" ? (
            <span className="block text-meta text-faint truncate">{t("provider.not_connected")}</span>
          ) : (
            ps.statusFor(p, { lastUsed: true })
          )}
        </span>
        <span className="text-faint text-body">›</span>
      </button>
    );
  };

  return (
    <div data-testid="provider-groups">
      <label className="flex items-center gap-2 rounded-lg border border-lineStrong bg-panel px-3 py-2 mb-5">
        <span className="text-faint text-meta">⌕</span>
        <input
          className="flex-1 bg-transparent outline-none text-ui"
          placeholder={t("manage.search_providers")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="provider-search"
        />
      </label>
      {KINDS.map((kind) => {
        const inKind = shown.filter((p) => providerKind(p) === kind);
        if (inKind.length === 0) return null;
        const connected = inKind.filter((p) => providerConnected(p, ps.keylessOk));
        const rest = inKind.filter((p) => !providerConnected(p, ps.keylessOk));
        return (
          <section key={kind} className="mb-6" data-testid={`provider-group-${kind}`}>
            <div className="text-label text-faint font-semibold tracking-wide uppercase mb-2.5">{t(`manage.group_${kind}`)}</div>
            {connected.length > 0 && (
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">{connected.map(cardFor)}</div>
            )}
            {connected.length > 0 && rest.length > 0 && (
              <div className="flex items-center gap-3 my-3.5 text-label text-faint" data-testid={`provider-rule-${kind}`}>
                <span className="flex-1 border-t border-lineStrong" />
                {t("manage.not_set_up_rule")}
                <span className="flex-1 border-t border-lineStrong" />
              </div>
            )}
            {rest.length > 0 && <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">{rest.map(cardFor)}</div>}
          </section>
        );
      })}
    </div>
  );
}
