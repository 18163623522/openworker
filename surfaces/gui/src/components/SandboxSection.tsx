// Settings ▸ Sandbox (UX-051 A, UX-053 v3): one switch first; on reveals the sandbox type;
// a ready type reveals only its own options (network, the files an agent may be given,
// the tool folders the sandbox may read). Choosing the Windows sandbox opens its setup
// dialog, which runs the one-time elevated setup and proves the wall before the choice
// takes effect. Everything here is machine-level (the machine's config.toml through
// /v1/settings/sandbox); nothing is per project.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getSandboxSettings,
  runSandboxRemove,
  runSandboxSetup,
  setSandboxSettings,
  type Machine,
  type SandboxCredentialEntry,
  type SandboxSettings,
  type SandboxToolchainEntry,
} from "../api";
import { chooseFolder } from "../tauri";
import { Toggle } from "./Toggle";
import { PanelHead } from "./IntegrationsView";

const CARD = "rounded-xl2 border border-line bg-panel";
const FIELD_LABEL = "text-ui font-medium text-ink";
const FIELD_HELP = "text-meta text-muted mt-1.5 leading-relaxed";
const INPUT =
  "flex-1 min-w-0 px-3 py-2 rounded-lg border border-line bg-paper text-ui text-ink outline-none focus:border-accent";
const BTN_ACCENT = "text-ui px-3 py-2 rounded-lg bg-accent text-white shrink-0 disabled:opacity-40";
const BTN_BORDERED = "text-ui px-3 py-2 rounded-lg border border-line bg-paper hover:border-lineStrong shrink-0";
const TAG = "inline-flex items-center rounded px-1.5 text-label font-medium leading-5";

type SetupStage = "ask" | "working" | "done" | "failed";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={"w-5 h-5 text-faint transition-transform shrink-0 " + (open ? "rotate-90" : "")}
      aria-hidden="true"
    >
      <path d="M8 5l5 5-5 5" />
    </svg>
  );
}

// A card that is one line until opened: chevron, title, one sentence, and a summary on
// the right. The body is the card's own list plus a foot with its action.
function DisclosureCard({
  id,
  open,
  onToggle,
  title,
  desc,
  summary,
  children,
}: {
  id: string;
  open: boolean;
  onToggle: () => void;
  title: string;
  desc: string;
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={CARD + " mb-2.5"} data-testid={`sandbox-card-${id}`}>
      <button
        type="button"
        className={"w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-chrome rounded-xl2 " + (open ? "border-b border-line rounded-b-none" : "")}
        onClick={onToggle}
        aria-expanded={open}
        data-testid={`sandbox-card-${id}-toggle`}
      >
        <Chevron open={open} />
        <span className="flex-1 min-w-0">
          <span className="block text-ui font-medium text-ink">{title}</span>
          <span className="block text-meta text-muted">{desc}</span>
        </span>
        <span className="text-meta text-faint text-right shrink-0 max-w-[360px] flex flex-wrap justify-end gap-1.5">{summary}</span>
      </button>
      {open ? <div data-testid={`sandbox-card-${id}-body`}>{children}</div> : null}
    </div>
  );
}

function Chip({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span className={"inline-flex items-center gap-1.5 rounded-full border px-2 py-px text-meta whitespace-nowrap " + (on ? "border-lineStrong text-muted" : "border-dashed border-lineStrong text-faint")}>
      {on ? <span className="w-1.5 h-1.5 rounded-full bg-ok" /> : null}
      {children}
    </span>
  );
}

function Modal({ children, testid }: { children: React.ReactNode; testid: string }) {
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" data-testid={testid}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" />
      <div className="absolute left-1/2 top-[12vh] -translate-x-1/2 w-[640px] max-w-[94vw] max-h-[80vh] rounded-xl2 border border-line bg-panel shadow-2xl overflow-auto p-6">
        {children}
      </div>
    </div>
  );
}

const SETUP_CHANGES = ["accounts", "rules", "folder", "record"] as const;

export function SandboxSection({ machine }: { machine?: Machine | null }) {
  const { t } = useTranslation();
  const mid = machine?.id ?? null;
  const [cfg, setCfg] = useState<SandboxSettings | null>(null);
  const [error, setError] = useState<string>("");
  const [wantOn, setWantOn] = useState(false); // the switch is on, no type is ready yet
  const [openCard, setOpenCard] = useState<"files" | "tools" | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // credential name being edited, "" = new
  const [addingTool, setAddingTool] = useState(false); // the "Add a folder" editor of the toolchain list
  const [toolTitle, setToolTitle] = useState("");
  const [toolPath, setToolPath] = useState("~/");
  const [setupStage, setSetupStage] = useState<SetupStage | null>(null);
  const [setupOutcome, setSetupOutcome] = useState<{ checked?: string; error?: string }>({});
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);

  useEffect(() => {
    getSandboxSettings(mid).then(setCfg).catch(() => setCfg(null));
  }, [mid]);

  const save = async (patch: Parameters<typeof setSandboxSettings>[0]) => {
    const res = await setSandboxSettings(patch, mid);
    if (!res.ok) {
      setError(res.error || "could not save");
      return;
    }
    setError("");
    setCfg(res as SandboxSettings);
  };

  if (!cfg) return null;
  const isWindows = cfg.platform === "win32";
  const isMac = cfg.platform === "darwin";
  const providerNames: Record<string, [string, string]> = {
    seatbelt: [t("settingsx.sandbox.provider_seatbelt"), t("settingsx.sandbox.provider_seatbelt_desc")],
    windows: [t("settingsx.sandbox.provider_windows"), t("settingsx.sandbox.provider_windows_desc")],
    openshell: [t("settingsx.sandbox.provider_openshell"), t("settingsx.sandbox.provider_openshell_desc")],
  };
  const chosen = cfg.provider || cfg.effective_provider || "direct";
  const active = chosen !== "direct"; // a type is the machine's choice
  const on = active || wantOn;
  const setup = cfg.windows_setup;
  const setupReady = setup?.state === "ready";
  const types = cfg.providers.filter((p) => p.name !== "direct" && (p.name !== "seatbelt" || isMac) && (p.name !== "windows" || isWindows));
  const anyType = types.some((p) => p.usable || (p.name === "windows" && setup?.can_elevate));
  const shipped = (name: string, key: "title" | "does", fallback?: string) => {
    const k = `settingsx.sandbox.${key}_${name}`;
    const v = t(k);
    return v === k ? fallback || "" : v;
  };
  const updateCredentials = (rows: SandboxCredentialEntry[]) =>
    save({ credentials: rows.map(({ kind: _k, shipped: _s, ...row }) => row) });
  const updateToolchains = (rows: SandboxToolchainEntry[]) =>
    save({ toolchains: rows.map(({ exists: _e, shipped: _s, ...row }) => row) });

  const switchStatus = !on
    ? t("settingsx.sandbox.switch_off")
    : active
      ? t("settingsx.sandbox.switch_on", { type: providerNames[chosen]?.[0] ?? chosen })
      : anyType
        ? t("settingsx.sandbox.switch_choose")
        : t("settingsx.sandbox.switch_none");

  const flip = (next: boolean) => {
    if (next) {
      setWantOn(true);
      return;
    }
    setWantOn(false);
    if (active) void save({ provider: "direct" });
  };

  const chooseType = (name: string) => {
    if (name === "windows" && !setupReady) {
      if (setup?.can_elevate) {
        setSetupOutcome({});
        setSetupStage("ask");
      }
      return;
    }
    void save({ provider: name });
  };

  const runSetup = async () => {
    setSetupStage("working");
    const res = await runSandboxSetup(mid);
    if (res.ok) {
      setCfg(res as SandboxSettings);
      setWantOn(false);
      setSetupOutcome({ checked: res.checked });
      setSetupStage("done");
    } else {
      if (res.platform) setCfg(res as SandboxSettings);
      setSetupOutcome({ error: res.error || "setup did not finish" });
      setSetupStage("failed");
    }
  };

  const runRemove = async () => {
    setRemoveBusy(true);
    const res = await runSandboxRemove(mid);
    setRemoveBusy(false);
    if (res.ok) {
      setCfg(res as SandboxSettings);
      setWantOn(false);
      setRemoving(false);
    } else {
      setError(res.error || "could not remove the setup");
      setRemoving(false);
    }
  };

  const setUpOn = setup?.set_up_at ? new Date(setup.set_up_at) : null;
  const setUpOnText = setUpOn && !Number.isNaN(setUpOn.getTime()) ? setUpOn.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";

  // The network list: Open first where it is the default (Windows).
  const profiles = isWindows ? [...cfg.network_profiles].sort((a, b) => (a.name === "open" ? -1 : b.name === "open" ? 1 : 0)) : cfg.network_profiles;
  const showTools = cfg.platform !== "linux" && chosen !== "openshell" && Boolean(cfg.toolchains);
  const toolsOn = (cfg.toolchains || []).filter((x) => x.enabled);

  return (
    <section data-testid="sandbox-section">
      <PanelHead
        title={t("settingsx.sandbox.title")}
        sub={machine ? t("settingsx.sandbox.sub_machine", { name: machine.name }) : isWindows ? t("settingsx.sandbox.sub_windows") : t("settingsx.sandbox.sub")}
      />
      {error ? <div className="mb-3 text-meta text-danger">{error}</div> : null}

      {/* 1. The switch */}
      <div className={CARD + " mb-1"}>
        <div className="flex items-start gap-3.5 px-4 py-3.5">
          <span className="mt-0.5">
            <Toggle checked={on} onChange={flip} title={t("settingsx.sandbox.switch_title")} />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-ui font-medium text-ink">{t("settingsx.sandbox.switch_title")}</span>
            <span className="block text-meta text-muted max-w-[640px]">{t("settingsx.sandbox.switch_desc")}</span>
          </span>
          <span
            className={"text-meta shrink-0 whitespace-nowrap pt-0.5 " + (active ? "text-ok" : on && !anyType ? "text-warnInk" : "text-faint")}
            data-testid="sandbox-switch-status"
          >
            {switchStatus}
          </span>
        </div>
      </div>
      {!on ? <div className={FIELD_HELP + " mb-4"}>{t("settingsx.sandbox.switch_help_off")}</div> : <div className="mb-4" />}
      {cfg.refused ? <div className="mb-4 text-meta text-danger">{t("settingsx.sandbox.refused", { why: cfg.refused })}</div> : null}

      {/* 2. The type, once the switch is on */}
      {on ? (
        <>
          <div className={FIELD_LABEL + " mb-2"}>{t("settingsx.sandbox.type")}</div>
          <div className={CARD + " mb-1 divide-y divide-line"} role="radiogroup" aria-label={t("settingsx.sandbox.type")}>
            {types.map((p) => {
              const [label, desc] = providerNames[p.name] ?? [p.name, ""];
              const isActive = chosen === p.name;
              const win = p.name === "windows";
              const canPick = p.usable || (win && Boolean(setup?.can_elevate));
              const why = !p.usable ? (win && setup && !setup.can_elevate ? t("settingsx.sandbox.needs_admin_why", { command: setup.command }) : win && setup?.can_elevate ? "" : p.why) : "";
              const status = win
                ? setupReady
                  ? t("settingsx.sandbox.status_ready")
                  : setup?.can_elevate
                    ? t("settingsx.sandbox.status_setup")
                    : t("settingsx.sandbox.status_needs_admin")
                : p.usable
                  ? t("settingsx.sandbox.status_ready")
                  : t("settingsx.sandbox.status_unavailable");
              return (
                <label key={p.name} className={"flex items-start gap-3 px-4 py-3 " + (canPick ? "cursor-pointer" : "opacity-60")}>
                  <input
                    type="radio"
                    name="sandbox-provider"
                    className="mt-1"
                    checked={isActive}
                    disabled={!canPick && !isActive}
                    onChange={() => chooseType(p.name)}
                    data-testid={`sandbox-provider-${p.name}`}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-ui text-ink">{label}</span>
                    <span className="block text-meta text-muted">{desc}</span>
                    {why ? (
                      <span className="block text-meta text-warnInk mt-1" data-testid={`sandbox-provider-${p.name}-why`}>
                        {why}
                      </span>
                    ) : null}
                    {win && setupReady ? (
                      <span className="block text-meta text-muted mt-1.5" data-testid="sandbox-windows-setup-line">
                        {setUpOnText ? t("settingsx.sandbox.set_up_on", { date: setUpOnText }) : t("settingsx.sandbox.set_up")}
                        <span className="mx-1.5 text-faint">·</span>
                        <button type="button" className="text-accent hover:underline" onClick={() => setRemoving(true)} data-testid="sandbox-remove-setup">
                          {t("settingsx.sandbox.remove_setup")}
                        </button>
                      </span>
                    ) : null}
                  </span>
                  <span className={"text-meta shrink-0 whitespace-nowrap pt-0.5 " + (win && !setupReady && setup && !setup.can_elevate ? "text-warnInk" : isActive || (win ? setupReady : p.usable) ? "text-ok" : "text-faint")}>
                    {status}
                  </span>
                </label>
              );
            })}
          </div>
          <div className={FIELD_HELP + " mb-4"}>
            {!active ? (anyType ? t("settingsx.sandbox.type_help") : t("settingsx.sandbox.type_help_admin")) : ""}
          </div>
        </>
      ) : null}

      {/* 3. The type's own options */}
      {active ? (
        <>
          <div className={FIELD_LABEL + " mb-2"}>{t("settingsx.sandbox.network")}</div>
          <div className={CARD + " divide-y divide-line"} role="radiogroup" aria-label={t("settingsx.sandbox.network")}>
            {profiles.map((np) => (
              <label key={np.name} className="flex items-start gap-3 px-4 py-2.5 cursor-pointer">
                <input
                  type="radio"
                  name="sandbox-network"
                  className="mt-1"
                  checked={cfg.network_profile === np.name}
                  onChange={() => save({ network_profile: np.name })}
                  data-testid={`sandbox-network-${np.name}`}
                />
                <span className="flex-1 min-w-0 flex items-baseline gap-3">
                  <span className="text-ui text-ink">{t(`settingsx.sandbox.profile_${np.name}`)}</span>
                  <span className="text-meta text-muted ml-auto text-right">
                    {t(`settingsx.sandbox.profile_${np.name}_desc`)}
                    {np.name === "open" && isWindows ? " " + t("settingsx.sandbox.profile_open_default") : ""}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className={FIELD_HELP + " mb-5"}>
            {chosen === "windows" ? t("settingsx.sandbox.network_help_windows") : chosen === "openshell" ? t("settingsx.sandbox.network_help_openshell") : t("settingsx.sandbox.network_help")}
          </div>

          <div className={FIELD_LABEL}>{t("settingsx.sandbox.credentials")}</div>
          <div className={FIELD_HELP + " mb-2.5 mt-0.5"}>{t("settingsx.sandbox.credentials_intro")}</div>
          <DisclosureCard
            id="files"
            open={openCard === "files"}
            onToggle={() => setOpenCard(openCard === "files" ? null : "files")}
            title={isWindows ? t("settingsx.sandbox.files_title_windows") : isMac ? t("settingsx.sandbox.files_title_mac") : t("settingsx.sandbox.files_title")}
            desc={t("settingsx.sandbox.files_desc")}
            summary={
              cfg.credentials.length ? (
                cfg.credentials.map((c) => (
                  <Chip key={c.name} on={c.enabled}>
                    {c.title || shipped(c.name, "title", c.name)}
                  </Chip>
                ))
              ) : (
                <span>{t("settingsx.sandbox.none_yet")}</span>
              )
            }
          >
            <div className="divide-y divide-line">
              {cfg.credentials.map((c) => (
                <div key={c.name} className="flex items-start gap-3 pl-6 pr-4 py-3" data-testid={`sandbox-credential-${c.name}`}>
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={c.enabled}
                    onChange={(e) => updateCredentials(cfg.credentials.map((x) => (x.name === c.name ? { ...x, enabled: e.target.checked } : x)))}
                    aria-label={c.title || shipped(c.name, "title", c.name)}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center flex-wrap gap-2 text-ui text-ink">
                      {c.title || shipped(c.name, "title", c.name)}
                      <code className="text-meta text-muted font-mono">{c.path}</code>
                      {c.kind ? (
                        <span className={TAG + " bg-accentSoft text-accent"} data-testid={`sandbox-credential-${c.name}-kind`}>
                          {t(c.kind === "folder" ? "settingsx.sandbox.kind_folder" : "settingsx.sandbox.kind_file")}
                        </span>
                      ) : (
                        <span className="text-meta text-faint">{t("settingsx.sandbox.credential_missing")}</span>
                      )}
                      <span className={TAG + " " + (c.label === "configuration" ? "bg-paper text-muted" : "bg-warnSoft text-warnInk")}>
                        {t(c.label === "configuration" ? "settingsx.sandbox.label_configuration" : "settingsx.sandbox.label_credential")}
                      </span>
                    </span>
                    <span className="block text-meta text-muted">
                      {c.does ? c.does : shipped(c.name, "does")}{" "}
                      {c.hosts && c.hosts.length && cfg.network_profile !== "open" ? (
                        <span className="text-faint">{t("settingsx.sandbox.also_allows", { hosts: c.hosts.join(", ") })}</span>
                      ) : null}
                    </span>
                  </span>
                  <span className="text-meta text-muted shrink-0 whitespace-nowrap">
                    <button className="hover:text-ink" onClick={() => setEditing(c.name)}>
                      {t("settingsx.sandbox.edit")}
                    </button>
                    <span className="mx-1.5 text-faint">·</span>
                    <button className="hover:text-ink" onClick={() => updateCredentials(cfg.credentials.filter((x) => x.name !== c.name))}>
                      {t("settingsx.sandbox.remove")}
                    </button>
                  </span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3.5 pl-6 pr-4 py-3 bg-chrome border-t border-line rounded-b-xl2">
              <span className="text-meta text-faint flex-1">
                {t("settingsx.sandbox.files_foot")} {isWindows ? t("settingsx.sandbox.credman_note") : isMac ? t("settingsx.sandbox.keychain_note") : ""}
              </span>
              <button className={BTN_BORDERED + " text-meta px-2.5 py-1"} onClick={() => setEditing("")} data-testid="sandbox-credential-add">
                {t("settingsx.sandbox.add")}
              </button>
            </div>
          </DisclosureCard>
          {editing !== null ? (
            <CredentialEditor
              entry={editing ? cfg.credentials.find((c) => c.name === editing) ?? null : null}
              onCancel={() => setEditing(null)}
              onSave={(row) => {
                const rows = editing ? cfg.credentials.map((x) => (x.name === editing ? row : x)) : [...cfg.credentials, row];
                setEditing(null);
                updateCredentials(rows);
              }}
            />
          ) : null}

          {showTools ? (
            <>
              <div className={FIELD_LABEL + " mt-5 mb-2"}>{t("settingsx.sandbox.tools")}</div>
              <DisclosureCard
                id="tools"
                open={openCard === "tools"}
                onToggle={() => setOpenCard(openCard === "tools" ? null : "tools")}
                title={t("settingsx.sandbox.toolchains")}
                desc={t("settingsx.sandbox.tools_desc")}
                summary={
                  <span data-testid="sandbox-tools-summary">
                    {t("settingsx.sandbox.tools_count", { on: toolsOn.length, total: (cfg.toolchains || []).length })}
                    {toolsOn.length ? " · " + toolsOn.slice(0, 6).map((x) => x.title || x.name).join(", ") + (toolsOn.length > 6 ? "…" : "") : ""}
                  </span>
                }
              >
                <div className="divide-y divide-line">
                  {cfg.toolchains.map((tc) => (
                    <div key={tc.name} className="flex items-start gap-3 pl-6 pr-4 py-2.5" data-testid={`sandbox-toolchain-${tc.name}`}>
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={tc.enabled}
                        onChange={(e) => updateToolchains(cfg.toolchains.map((x) => (x.name === tc.name ? { ...x, enabled: e.target.checked } : x)))}
                        aria-label={tc.title || tc.name}
                      />
                      <span className="flex-1 min-w-0">
                        <span className={"block text-ui " + (tc.exists === false ? "text-muted" : "text-ink")}>
                          {tc.title || tc.name}
                          {tc.exists === false ? <span className="text-meta text-faint"> · {t("settingsx.sandbox.toolchain_missing")}</span> : null}
                          {!tc.shipped ? <span className="text-meta text-faint"> · {t("settingsx.sandbox.added_by_you")}</span> : null}
                        </span>
                      </span>
                      <code className="text-meta text-muted font-mono shrink-0">{tc.path}</code>
                      {!tc.shipped ? (
                        <button className="text-meta text-muted hover:text-ink shrink-0" onClick={() => updateToolchains(cfg.toolchains.filter((x) => x.name !== tc.name))}>
                          {t("settingsx.sandbox.remove")}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3.5 pl-6 pr-4 py-3 bg-chrome border-t border-line rounded-b-xl2">
                  <span className="text-meta text-faint flex-1">{isWindows ? t("settingsx.sandbox.tools_foot_windows") : t("settingsx.sandbox.toolchains_help")}</span>
                  <button className={BTN_BORDERED + " text-meta px-2.5 py-1"} onClick={() => setAddingTool(true)} data-testid="sandbox-toolchain-add">
                    {t("settingsx.sandbox.add_toolchain")}
                  </button>
                </div>
              </DisclosureCard>
              {addingTool ? (
                <div className={CARD + " p-4 mt-3"} data-testid="sandbox-toolchain-editor">
                  <div className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-2 items-center">
                    <label className="text-ui text-muted">{t("settingsx.sandbox.field_title")}</label>
                    <input className={INPUT} value={toolTitle} onChange={(e) => setToolTitle(e.target.value)} />
                    <label className="text-ui text-muted">{t("settingsx.sandbox.field_toolchain_path")}</label>
                    <div className="flex gap-2">
                      <input className={INPUT + " font-mono"} value={toolPath} onChange={(e) => setToolPath(e.target.value)} />
                      <button
                        className={BTN_BORDERED}
                        onClick={async () => {
                          const picked = await chooseFolder();
                          if (picked) setToolPath(picked);
                        }}
                      >
                        {t("settingsx.sandbox.browse")}
                      </button>
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 mt-3">
                    <button className={BTN_BORDERED} onClick={() => setAddingTool(false)}>
                      {t("settingsx.sandbox.cancel")}
                    </button>
                    <button
                      className={BTN_ACCENT}
                      disabled={!validPath(toolPath)}
                      onClick={() => {
                        const slug = (toolTitle || toolPath).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
                        setAddingTool(false);
                        setToolTitle("");
                        setToolPath("~/");
                        updateToolchains([...cfg.toolchains, { name: slug, title: toolTitle || undefined, path: toolPath, enabled: true }]);
                      }}
                    >
                      {t("settingsx.sandbox.done")}
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
          <div className={FIELD_HELP + " mt-4"}>{t("settingsx.sandbox.saved_in", { path: cfg.config_path })}</div>
        </>
      ) : null}

      {/* The Windows setup dialog */}
      {setupStage ? (
        <Modal testid="sandbox-setup-dialog">
          {setupStage === "ask" ? (
            <>
              <h3 className="text-heading font-semibold mb-1.5">{t("settingsx.sandbox.setup_title")}</h3>
              <p className="text-ui text-muted mb-3.5 leading-relaxed">{t("settingsx.sandbox.setup_intro")}</p>
              <div className="text-label font-medium text-faint mb-1.5">{t("settingsx.sandbox.setup_changes")}</div>
              <div className="grid gap-2.5">
                {SETUP_CHANGES.map((k) => (
                  <div key={k} className="text-ui leading-relaxed">
                    {t(`settingsx.sandbox.setup_change_${k}`)}
                    <div className="text-meta text-muted">{t(`settingsx.sandbox.setup_change_${k}_desc`)}</div>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2 mt-4">
                <span className="text-meta text-faint max-w-[320px] leading-relaxed">{t("settingsx.sandbox.setup_not_now_note")}</span>
                <span className="flex-1" />
                <button
                  className={BTN_BORDERED}
                  onClick={() => {
                    setSetupStage(null);
                    setWantOn(false);
                  }}
                  data-testid="sandbox-setup-not-now"
                >
                  {t("settingsx.sandbox.not_now")}
                </button>
                <button className={BTN_ACCENT} onClick={runSetup} data-testid="sandbox-setup-now">
                  {t("settingsx.sandbox.set_up_now")}
                </button>
              </div>
            </>
          ) : setupStage === "working" ? (
            <>
              <h3 className="text-heading font-semibold mb-1.5">{t("settingsx.sandbox.setup_working_title")}</h3>
              <p className="text-ui text-muted mb-3.5 leading-relaxed">{t("settingsx.sandbox.setup_working_intro")}</p>
              <div className="rounded-lg border border-line bg-paper px-3 py-2.5 text-ui text-muted flex items-center gap-2.5">
                <span className="w-4 h-4 rounded-full border-2 border-lineStrong border-t-accent animate-spin shrink-0" />
                {t("settingsx.sandbox.setup_waiting")}
              </div>
            </>
          ) : setupStage === "done" ? (
            <>
              <h3 className="text-heading font-semibold mb-1.5">{t("settingsx.sandbox.setup_done_title")}</h3>
              <p className="text-ui text-muted mb-3.5 leading-relaxed">{t("settingsx.sandbox.setup_done_intro")}</p>
              <div className="rounded-lg border border-okLine bg-okSoft px-3 py-2.5 text-ui text-ok leading-relaxed" data-testid="sandbox-setup-done-box">
                {t("settingsx.sandbox.setup_done_box", { checked: setupOutcome.checked || "" })}
              </div>
              <div className="flex justify-end mt-4">
                <button className={BTN_ACCENT} onClick={() => setSetupStage(null)} data-testid="sandbox-setup-done">
                  {t("settingsx.sandbox.done")}
                </button>
              </div>
            </>
          ) : (
            <>
              <h3 className="text-heading font-semibold mb-1.5">{t("settingsx.sandbox.setup_failed_title")}</h3>
              <p className="text-ui text-muted mb-3.5 leading-relaxed">{t("settingsx.sandbox.setup_failed_intro")}</p>
              <div className="rounded-lg border border-line bg-paper px-3 py-2.5 text-meta text-danger font-mono whitespace-pre-wrap break-words" data-testid="sandbox-setup-error">
                {setupOutcome.error}
              </div>
              <div className="flex justify-end gap-2 mt-4">
                <button
                  className={BTN_BORDERED}
                  onClick={() => {
                    setSetupStage(null);
                    setWantOn(false);
                  }}
                >
                  {t("settingsx.sandbox.close")}
                </button>
                <button className={BTN_ACCENT} onClick={() => setSetupStage("ask")}>
                  {t("settingsx.sandbox.try_again")}
                </button>
              </div>
            </>
          )}
        </Modal>
      ) : null}

      {/* The Remove setup confirmation */}
      {removing ? (
        <Modal testid="sandbox-remove-dialog">
          <h3 className="text-heading font-semibold mb-1.5">{t("settingsx.sandbox.remove_title")}</h3>
          <p className="text-ui text-muted mb-3.5 leading-relaxed">{t("settingsx.sandbox.remove_intro")}</p>
          <div className="text-label font-medium text-faint mb-1.5">{t("settingsx.sandbox.remove_what")}</div>
          <div className="grid gap-2.5">
            {SETUP_CHANGES.map((k) => (
              <div key={k} className="text-ui leading-relaxed">
                {t(`settingsx.sandbox.setup_change_${k}`)}
                <div className="text-meta text-muted">{t(`settingsx.sandbox.remove_change_${k}_desc`)}</div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-4">
            <span className="text-meta text-faint max-w-[320px] leading-relaxed">{t("settingsx.sandbox.remove_keep_note")}</span>
            <span className="flex-1" />
            <button className={BTN_BORDERED} onClick={() => setRemoving(false)} disabled={removeBusy}>
              {t("settingsx.sandbox.cancel")}
            </button>
            <button className={BTN_ACCENT} onClick={runRemove} disabled={removeBusy} data-testid="sandbox-remove-confirm">
              {removeBusy ? t("settingsx.sandbox.setup_waiting") : t("settingsx.sandbox.remove")}
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

function validPath(path: string): boolean {
  return (path.startsWith("~/") || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) && path.length >= 3;
}

// Add or edit one entry: a file or a folder under the home folder, what is in it, the
// hosts its tool needs, and what it lets the agent do.
export function CredentialEditor({
  entry,
  onCancel,
  onSave,
}: {
  entry: SandboxCredentialEntry | null;
  onCancel: () => void;
  onSave: (row: SandboxCredentialEntry) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(entry?.title ?? "");
  const [name, setName] = useState(entry?.name ?? "");
  const [path, setPath] = useState(entry?.path ?? "~/");
  const [hosts, setHosts] = useState((entry?.hosts ?? []).join("\n"));
  const [does, setDoes] = useState(entry?.does ?? "");
  const [label, setLabel] = useState<"credential" | "configuration">(entry?.label === "configuration" ? "configuration" : "credential");
  const slug = entry?.name || name || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const valid = Boolean(slug) && validPath(path);
  return (
    <div className={CARD + " p-4 mt-3"} data-testid="sandbox-credential-editor">
      <div className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-2 items-center">
        <label className="text-ui text-muted">{t("settingsx.sandbox.field_title")}</label>
        <input
          className={INPUT}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (!entry) setName("");
          }}
        />
        <label className="text-ui text-muted">{t("settingsx.sandbox.field_path")}</label>
        <div className="flex gap-2">
          <input className={INPUT + " font-mono"} value={path} onChange={(e) => setPath(e.target.value)} />
          <button
            className={BTN_BORDERED}
            onClick={async () => {
              const picked = await chooseFolder();
              if (picked) setPath(picked);
            }}
          >
            {t("settingsx.sandbox.browse")}
          </button>
        </div>
        <label className="text-ui text-muted self-start pt-2">{t("settingsx.sandbox.field_label")}</label>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("settingsx.sandbox.field_label")}>
          {(["credential", "configuration"] as const).map((k) => (
            <label key={k} className={"flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer " + (label === k ? "border-accent bg-accentSoft" : "border-line")}>
              <input type="radio" name="sandbox-credential-label" className="mt-1" checked={label === k} onChange={() => setLabel(k)} data-testid={`sandbox-credential-label-${k}`} />
              <span>
                <span className="block text-ui text-ink">{t(`settingsx.sandbox.label_${k}_title`)}</span>
                <span className="block text-meta text-muted">{t(`settingsx.sandbox.label_${k}_desc`)}</span>
              </span>
            </label>
          ))}
        </div>
        <label className="text-ui text-muted self-start pt-2">{t("settingsx.sandbox.field_hosts")}</label>
        <textarea className={INPUT + " font-mono"} rows={3} value={hosts} onChange={(e) => setHosts(e.target.value)} />
        <label className="text-ui text-muted">{t("settingsx.sandbox.field_does")}</label>
        <input className={INPUT} value={does} onChange={(e) => setDoes(e.target.value)} />
      </div>
      <div className="flex items-center gap-2 mt-3">
        <span className="text-meta text-faint">{t("settingsx.sandbox.editor_note")}</span>
        <span className="flex-1" />
        <button className={BTN_BORDERED} onClick={onCancel}>
          {t("settingsx.sandbox.cancel")}
        </button>
        <button
          className={BTN_ACCENT}
          disabled={!valid}
          onClick={() =>
            onSave({
              name: slug,
              title: title || undefined,
              path,
              hosts: hosts
                .split(/\s+/)
                .map((h) => h.trim())
                .filter(Boolean),
              does: does || undefined,
              label,
              enabled: entry?.enabled ?? true,
            })
          }
        >
          {t("settingsx.sandbox.done")}
        </button>
      </div>
    </div>
  );
}
