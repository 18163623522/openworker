// Settings ▸ Sandbox (UX-051 A, UX-053 v5, OPE-207): one switch first; on reveals the
// sandbox type; a type that is the machine's choice reveals its options: the network
// (package registries and search, with the machine's own hosts; or everything), the config
// and keys copied into sandboxes, and the tool folders agents may read. A type that is not
// set up yet looks disabled and carries one "Set up" button: the Windows sandbox's opens its
// one-time elevated setup, OpenShell's opens the guided setup job (fixes what the app may
// fix, never as root; hands the rest over as commands; downloads the image with progress).
// Everything here is machine-level (the machine's config.toml through /v1/settings/sandbox);
// nothing is per project. A provider change rebuilds live sessions under the new rule
// (onProviderChanged carries their ids).
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  cancelSandboxSetup,
  getSandboxReadiness,
  getSandboxSettings,
  getSandboxSetup,
  runSandboxRemove,
  runSandboxSetup,
  setSandboxSettings,
  startSandboxSetup,
  type Machine,
  type SandboxCredentialEntry,
  type SandboxReadiness,
  type SandboxReadinessStep,
  type SandboxSettings,
  type SandboxSetupRowState,
  type SandboxSetupState,
  type SandboxToolchainEntry,
} from "../api";
import { chooseFolder } from "../tauri";
import { Toggle } from "./Toggle";
import { PanelHead } from "./IntegrationsView";

type T = (k: string, o?: Record<string, unknown>) => string;

const CARD = "rounded-xl2 border border-line bg-panel";
const FIELD_LABEL = "text-ui font-medium text-ink";
const INPUT =
  "flex-1 min-w-0 px-3 py-2 rounded-lg border border-line bg-paper text-ui text-ink outline-none focus:border-accent";
const BTN_ACCENT = "text-ui px-3 py-2 rounded-lg bg-accent text-white shrink-0 disabled:opacity-40";
const BTN_BORDERED = "text-ui px-3 py-2 rounded-lg border border-line bg-paper hover:border-lineStrong shrink-0 disabled:opacity-40";
const BTN_SMALL = "text-meta px-2.5 py-1 rounded-lg border border-line bg-paper hover:border-lineStrong shrink-0";
const TAG = "inline-flex items-center rounded px-1.5 text-label font-medium leading-5";
const FOOT = "flex items-center gap-3.5 pl-6 pr-4 py-3 bg-chrome border-t border-line rounded-b-xl2";

type SetupStage = "ask" | "working" | "done" | "failed";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className={"w-5 h-5 text-faint transition-transform shrink-0 " + (open ? "rotate-90" : "")} aria-hidden="true">
      <path d="M8 5l5 5-5 5" />
    </svg>
  );
}

const KEY_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9M17 6l3 3M14 9l2 2" />
  </svg>
);
const TOOL_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2-2z" />
  </svg>
);

// A panel that is one line until opened: chevron, icon, title and a one-line summary.
function Panel({
  id,
  open,
  onToggle,
  icon,
  title,
  summary,
  children,
}: {
  id: string;
  open: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  title: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <div className={CARD + " mb-2.5 relative"} data-testid={`sandbox-card-${id}`}>
      <button
        type="button"
        className={"w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-chrome rounded-xl2 " + (open ? "border-b border-line rounded-b-none" : "")}
        onClick={onToggle}
        aria-expanded={open}
        data-testid={`sandbox-card-${id}-toggle`}
      >
        <Chevron open={open} />
        <span className={"w-[34px] h-[34px] rounded-[9px] flex items-center justify-center shrink-0 " + (open ? "bg-accentSoft text-accent" : "bg-paper text-muted")}>{icon}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-ui font-medium text-ink">{title}</span>
          <span className="block text-meta text-muted" data-testid={`sandbox-card-${id}-summary`}>
            {summary}
          </span>
        </span>
      </button>
      {open ? <div data-testid={`sandbox-card-${id}-body`}>{children}</div> : null}
    </div>
  );
}

function Modal({ children, testid, wide }: { children: React.ReactNode; testid: string; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" data-testid={testid}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" />
      <div className={"absolute left-1/2 top-[10vh] -translate-x-1/2 max-w-[94vw] max-h-[80vh] rounded-xl2 border border-line bg-panel shadow-2xl overflow-auto p-6 " + (wide ? "w-[680px]" : "w-[640px]")}>
        {children}
      </div>
    </div>
  );
}

// The small square before an entry: the tool's own mark for a known CLI, else a file or folder.
const BADGES: Record<string, [string, string]> = {
  gh: ["gh", "bg-[#24292f] text-white"],
  aws: ["aws", "bg-[#232f3e] text-[#ff9900]"],
  "aws-credentials": ["aws", "bg-[#232f3e] text-[#ff9900]"],
  kube: ["K8s", "bg-[#326ce5] text-white"],
  npm: ["npm", "bg-[#cb3837] text-white"],
  docker: ["dkr", "bg-[#1d63ed] text-white"],
  gcloud: ["G", "bg-white text-[#4285f4] border border-lineStrong"],
  terraform: ["tf", "bg-[#7b42bc] text-white"],
};
function Badge({ name }: { name: string }) {
  const known = BADGES[name];
  if (known) {
    return <span className={"w-[26px] h-[26px] rounded-[7px] inline-flex items-center justify-center text-[9.5px] font-bold shrink-0 " + known[1]}>{known[0]}</span>;
  }
  return (
    <span className="w-[26px] h-[26px] rounded-[7px] inline-flex items-center justify-center shrink-0 bg-paper text-muted border border-line">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    </span>
  );
}

const SETUP_CHANGES = ["accounts", "rules", "folder", "record"] as const;

// "a, b and c", or "a, b, c and 5 more" past `max`.
function listText(t: T, names: string[], max: number): string {
  if (names.length <= 1) return names.join("");
  if (names.length > max) return t("settingsx.sandbox.list_more", { list: names.slice(0, max).join(", "), count: names.length - max });
  return t("settingsx.sandbox.list_and", { list: names.slice(0, -1).join(", "), last: names[names.length - 1] });
}

export function SandboxSection({ machine, onProviderChanged }: { machine?: Machine | null; onProviderChanged?: (sessionIds: string[]) => void }) {
  const { t } = useTranslation();
  const mid = machine?.id ?? null;
  const [cfg, setCfg] = useState<SandboxSettings | null>(null);
  const [error, setError] = useState<string>("");
  const [readiness, setReadiness] = useState<SandboxReadiness | null>(null);
  const [job, setJob] = useState<SandboxSetupState | null>(null);
  const [copied, setCopied] = useState<string>("");
  const notifiedRef = useRef(false);
  const [wantOn, setWantOn] = useState(false); // the switch is on, no type is the choice yet
  const [openFiles, setOpenFiles] = useState(false);
  const [openTools, setOpenTools] = useState(false);
  const [menu, setMenu] = useState(false); // the "Add…" menu of the files panel
  const [picking, setPicking] = useState(false); // the "A CLI's login" picker
  const [editing, setEditing] = useState<string | null>(null); // credential name being edited, "" = new
  const [hostsOpen, setHostsOpen] = useState(false);
  const [addingTool, setAddingTool] = useState(false);
  const [toolTitle, setToolTitle] = useState("");
  const [toolPath, setToolPath] = useState("~/");
  const [setupStage, setSetupStage] = useState<SetupStage | null>(null);
  const [setupOutcome, setSetupOutcome] = useState<{ checked?: string; error?: string }>({});
  const [openshellDialog, setOpenshellDialog] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);

  useEffect(() => {
    getSandboxSettings(mid).then(setCfg).catch(() => setCfg(null));
  }, [mid]);

  const save = async (patch: Parameters<typeof setSandboxSettings>[0]) => {
    const res = await setSandboxSettings(patch, mid);
    if (!res.ok) {
      setError(res.error || "could not save");
      return false;
    }
    setError("");
    setCfg(res as SandboxSettings);
    if ("provider" in patch) onProviderChanged?.(res.rebuilt_sessions ?? []);
    return true;
  };

  // OpenShell's checklist, loaded when its setup dialog opens and again after a run.
  const loadReadiness = () => {
    setReadiness(null);
    getSandboxReadiness(mid)
      .then(setReadiness)
      .catch(() => setReadiness({ platform: cfg?.platform ?? "", supported: false, steps: [], all_ok: false }));
  };
  useEffect(() => {
    if (openshellDialog) loadReadiness();
  }, [openshellDialog, mid]); // eslint-disable-line react-hooks/exhaustive-deps
  // A setup job may be running from before (the page was closed and reopened): adopt it.
  useEffect(() => {
    if (!cfg || cfg.platform === "win32") return;
    getSandboxSetup(mid)
      .then((s) => setJob(s.status === "idle" ? null : s))
      .catch(() => {});
  }, [mid, cfg?.platform]); // eslint-disable-line react-hooks/exhaustive-deps
  // Poll the job while it runs; on the way out, reload the checklist and the settings
  // (the job writes the config line last) and say so once.
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const timer = window.setInterval(() => {
      getSandboxSetup(mid)
        .then((s) => {
          setJob(s);
          if (s.status !== "running") {
            loadReadiness();
            getSandboxSettings(mid).then(setCfg).catch(() => {});
            if (s.status === "done" && !notifiedRef.current) {
              notifiedRef.current = true;
              try {
                if ("Notification" in window && Notification.permission === "granted") {
                  new Notification(t("settingsx.sandbox.notify_title"), { body: t("settingsx.sandbox.notify_body") });
                }
              } catch {
                /* notifications are a courtesy */
              }
            }
          }
        })
        .catch(() => {});
    }, 1000);
    return () => window.clearInterval(timer);
  }, [job?.status, mid]); // eslint-disable-line react-hooks/exhaustive-deps
  const startJob = async () => {
    notifiedRef.current = false;
    try {
      if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    } catch {
      /* ignore */
    }
    const s = await startSandboxSetup(mid).catch(() => null);
    if (s) setJob(s);
  };
  const cancelJob = async () => {
    const s = await cancelSandboxSetup(mid).catch(() => null);
    if (s) setJob(s);
  };
  const copy = (text: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(text);
        window.setTimeout(() => setCopied(""), 1500);
      })
      .catch(() => {});
  };

  if (!cfg) return null;
  const isWindows = cfg.platform === "win32";
  const isMac = cfg.platform === "darwin";
  const providerNames: Record<string, [string, string]> = {
    seatbelt: [t("settingsx.sandbox.provider_seatbelt"), t("settingsx.sandbox.provider_seatbelt_desc")],
    windows: [t("settingsx.sandbox.provider_windows"), t("settingsx.sandbox.provider_windows_desc")],
    openshell: [t("settingsx.sandbox.provider_openshell"), isMac ? t("settingsx.sandbox.provider_openshell_desc_mac") : t("settingsx.sandbox.provider_openshell_desc")],
  };
  const chosen = cfg.provider || cfg.effective_provider || "direct";
  const active = chosen !== "direct"; // a type is the machine's choice
  const on = active || wantOn;
  const setup = cfg.windows_setup;
  const setupReady = setup?.state === "ready";
  const types = cfg.providers.filter((p) => p.name !== "direct" && (p.name !== "seatbelt" || isMac) && (p.name !== "windows" || isWindows));
  const shipped = (name: string, key: "title" | "does", fallback?: string) => {
    const k = `settingsx.sandbox.${key}_${name}`;
    const v = t(k);
    return v === k ? fallback || "" : v;
  };
  const titleOf = (c: SandboxCredentialEntry) => c.title || shipped(c.name, "title", c.name);
  const doesOf = (c: SandboxCredentialEntry) => c.does || shipped(c.name, "does");
  const updateCredentials = (rows: SandboxCredentialEntry[]) => save({ credentials: rows.map(({ kind: _k, shipped: _s, ...row }) => row) });
  const updateToolchains = (rows: SandboxToolchainEntry[]) => save({ toolchains: rows.map(({ exists: _e, shipped: _s, ...row }) => row) });

  const flip = (next: boolean) => {
    if (next) {
      setWantOn(true);
      return;
    }
    setWantOn(false);
    if (active) void save({ provider: "direct" });
  };

  const openWindowsSetup = () => {
    setSetupOutcome({});
    setSetupStage("ask");
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

  const extraHosts = cfg.network_extra_hosts ?? [];
  const presets = cfg.credential_presets ?? [];
  const showTools = cfg.platform !== "linux" && chosen !== "openshell" && Boolean(cfg.toolchains);
  const toolsOn = (cfg.toolchains || []).filter((x) => x.enabled);
  const filesOn = cfg.credentials.filter((c) => c.enabled);
  const filesSummary = filesOn.length ? t("settingsx.sandbox.files_sum", { list: listText(t, filesOn.map(titleOf), 3) }) : t("settingsx.sandbox.files_sum_none");
  const toolsSummary = toolsOn.length ? t("settingsx.sandbox.tools_sum", { list: listText(t, toolsOn.map((x) => x.title || x.name), 3) }) : t("settingsx.sandbox.tools_sum_none");
  const keyNote = isWindows ? t("settingsx.sandbox.credman_note") : isMac ? t("settingsx.sandbox.keychain_note") : t("settingsx.sandbox.files_foot");
  const addMenu = (
    <span className="relative">
      <button className={BTN_SMALL} onClick={() => setMenu(!menu)} aria-expanded={menu} data-testid="sandbox-credential-add">
        {t("settingsx.sandbox.add_menu")}
      </button>
      {menu ? (
        <>
          <span className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
          <span className="absolute right-0 bottom-9 z-20 w-[300px] rounded-xl border border-line bg-panel shadow-xl p-1.5 text-left" role="menu" data-testid="sandbox-add-menu">
            {(
              [
                ["cli", () => setPicking(true)],
                ["file", () => setEditing("")],
              ] as const
            ).map(([k, go]) => (
              <button
                key={k}
                role="menuitem"
                className="block w-full text-left px-3 py-2 rounded-lg hover:bg-chrome"
                onClick={() => {
                  setMenu(false);
                  go();
                }}
                data-testid={`sandbox-add-${k}`}
              >
                <span className="block text-ui font-medium text-ink">{t(`settingsx.sandbox.add_${k}`)}</span>
                <span className="block text-meta text-muted">{t(`settingsx.sandbox.add_${k}_desc`)}</span>
              </button>
            ))}
          </span>
        </>
      ) : null}
    </span>
  );

  return (
    <section data-testid="sandbox-section">
      <PanelHead title={t("settingsx.sandbox.title")} sub={machine ? t("settingsx.sandbox.sub_machine", { name: machine.name }) : t("settingsx.sandbox.sub")} />
      {error ? <div className="mb-3 text-meta text-danger">{error}</div> : null}

      {/* 1. The switch */}
      <div className={CARD + " mb-5"}>
        <div className="flex items-start gap-3.5 px-4 py-3.5">
          <span className="mt-0.5">
            <Toggle checked={on} onChange={flip} title={t("settingsx.sandbox.switch_title")} />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-ui font-medium text-ink">{t("settingsx.sandbox.switch_title")}</span>
            <span className="block text-meta text-muted max-w-[640px]">{t("settingsx.sandbox.switch_desc")}</span>
          </span>
        </div>
      </div>
      {cfg.refused ? <div className="-mt-3 mb-4 text-meta text-danger">{t("settingsx.sandbox.refused", { why: cfg.refused })}</div> : null}

      {/* 2. The type, once the switch is on */}
      {on ? (
        <>
          <div className={FIELD_LABEL + " mb-2"}>{t("settingsx.sandbox.type")}</div>
          <div className={CARD + " mb-5 divide-y divide-line"} role="radiogroup" aria-label={t("settingsx.sandbox.type")}>
            {types.map((p) => {
              const [label, desc] = providerNames[p.name] ?? [p.name, ""];
              const isActive = chosen === p.name;
              const win = p.name === "windows";
              const os = p.name === "openshell";
              // Ready to choose: usable, and for Windows set up. Otherwise the row looks
              // disabled and its one button sets it up, where this machine can.
              const ready = win ? setupReady && p.usable : p.usable;
              const canSetUp = win ? !setupReady && Boolean(setup?.can_elevate) : os && !isWindows && !p.usable;
              const why = ready || canSetUp ? "" : win && setup && !setup.can_elevate ? t("settingsx.sandbox.needs_admin_why", { command: setup.command }) : p.why;
              const osRunning = os && job?.status === "running";
              return (
                <div key={p.name} className="flex items-start gap-3 px-4 py-3" data-testid={`sandbox-type-${p.name}`}>
                  <label className={"flex items-start gap-3 flex-1 min-w-0 " + (ready ? "cursor-pointer" : "")}>
                    <input
                      type="radio"
                      name="sandbox-provider"
                      className={"mt-1 " + (ready || isActive ? "" : "opacity-50")}
                      checked={isActive}
                      disabled={!ready && !isActive}
                      onChange={() => void save({ provider: p.name })}
                      data-testid={`sandbox-provider-${p.name}`}
                    />
                    <span className="flex-1 min-w-0">
                      <span className={"block text-ui " + (ready || isActive ? "text-ink" : "text-ink/50")}>{label}</span>
                      <span className={"block text-meta " + (ready || isActive ? "text-muted" : "text-muted/60")}>{desc}</span>
                      {why ? (
                        <span className="block text-meta text-warnInk mt-1" data-testid={`sandbox-provider-${p.name}-why`}>
                          {why}
                        </span>
                      ) : null}
                      {isActive && os && p.state === "needs_download" ? (
                        <span className="block text-meta text-warnInk mt-1" data-testid={`sandbox-provider-${p.name}-hint`}>
                          {t("settingsx.sandbox.needs_download_hint")}
                        </span>
                      ) : null}
                      {win && setupReady ? (
                        <span className="block text-meta text-muted mt-1.5" data-testid="sandbox-windows-setup-line">
                          {setUpOnText ? t("settingsx.sandbox.set_up_on", { date: setUpOnText }) : t("settingsx.sandbox.set_up_done")}
                          <span className="mx-1.5 text-faint">·</span>
                          <button type="button" className="text-accent hover:underline" onClick={() => setRemoving(true)} data-testid="sandbox-remove-setup">
                            {t("settingsx.sandbox.remove_setup")}
                          </button>
                        </span>
                      ) : null}
                    </span>
                  </label>
                  {canSetUp ? (
                    <button
                      className={BTN_SMALL + " self-center"}
                      onClick={() => (win ? openWindowsSetup() : setOpenshellDialog(true))}
                      data-testid={`sandbox-setup-${p.name}`}
                    >
                      {osRunning ? t("settingsx.sandbox.setup_running") : t("settingsx.sandbox.set_up")}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      {/* 3. The type's own options */}
      {active ? (
        <>
          <div className={FIELD_LABEL + " mb-2"}>{t("settingsx.sandbox.network")}</div>
          <div className={CARD + " mb-5 divide-y divide-line"} role="radiogroup" aria-label={t("settingsx.sandbox.network")}>
            {(["standard", "open"] as const).map((name) => (
              <label key={name} className="flex items-start gap-3 px-4 py-2.5 cursor-pointer">
                <input
                  type="radio"
                  name="sandbox-network"
                  className="mt-1"
                  checked={cfg.network_profile === name}
                  onChange={() => save({ network_profile: name })}
                  data-testid={`sandbox-network-${name}`}
                />
                <span className="flex-1 min-w-0">
                  <span className={"block text-ui " + (name === "open" ? "text-warnInk" : "text-ink")}>{t(`settingsx.sandbox.profile_${name}`)}</span>
                  <span className="block text-meta text-muted">
                    {t(`settingsx.sandbox.profile_${name}_desc`)}
                    {name === "standard" ? (
                      <>
                        <button
                          type="button"
                          className="ml-1.5 text-accent hover:underline"
                          onClick={(e) => {
                            e.preventDefault();
                            setHostsOpen(true);
                          }}
                          data-testid="sandbox-network-customize"
                        >
                          {t("settingsx.sandbox.customize")}
                        </button>
                        {extraHosts.length ? <span className="text-faint"> · {t("settingsx.sandbox.hosts_added", { count: extraHosts.length })}</span> : null}
                      </>
                    ) : null}
                  </span>
                </span>
              </label>
            ))}
          </div>

          <Panel id="files" open={openFiles} onToggle={() => setOpenFiles(!openFiles)} icon={KEY_ICON} title={t("settingsx.sandbox.files_panel")} summary={filesSummary}>
            {cfg.credentials.length ? (
              <div className="divide-y divide-line">
                {cfg.credentials.map((c) => (
                  <div key={c.name} className="group flex items-start gap-3 pl-6 pr-4 py-3" data-testid={`sandbox-credential-${c.name}`}>
                    <span className="mt-0.5">
                      <Toggle checked={c.enabled} onChange={(next) => updateCredentials(cfg.credentials.map((x) => (x.name === c.name ? { ...x, enabled: next } : x)))} title={titleOf(c)} />
                    </span>
                    <Badge name={c.name} />
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center flex-wrap gap-2 text-ui text-ink">
                        {titleOf(c)}
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
                        {doesOf(c)}{" "}
                        {c.hosts && c.hosts.length && cfg.network_profile !== "open" ? <span className="text-faint">{t("settingsx.sandbox.also_allows", { hosts: c.hosts.join(", ") })}</span> : null}
                      </span>
                    </span>
                    <span className="text-meta text-muted shrink-0 whitespace-nowrap opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button className="hover:text-ink" onClick={() => setEditing(c.name)} data-testid={`sandbox-credential-${c.name}-edit`}>
                        {t("settingsx.sandbox.edit")}
                      </button>
                      <span className="mx-1.5 text-faint">·</span>
                      <button className="hover:text-ink" onClick={() => updateCredentials(cfg.credentials.filter((x) => x.name !== c.name))} data-testid={`sandbox-credential-${c.name}-remove`}>
                        {t("settingsx.sandbox.remove")}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-6 py-4 text-ui text-muted" data-testid="sandbox-files-empty">
                {t("settingsx.sandbox.files_empty")}
              </div>
            )}
            <div className={FOOT}>
              <span className="text-meta text-faint flex-1">{cfg.credentials.length ? keyNote : t("settingsx.sandbox.files_foot")}</span>
              {addMenu}
            </div>
          </Panel>

          {showTools ? (
            <Panel id="tools" open={openTools} onToggle={() => setOpenTools(!openTools)} icon={TOOL_ICON} title={t("settingsx.sandbox.tools_panel")} summary={toolsSummary}>
              <div className="divide-y divide-line">
                {cfg.toolchains.map((tc) => (
                  <div key={tc.name} className="flex items-center gap-3 pl-6 pr-4 py-2" data-testid={`sandbox-toolchain-${tc.name}`}>
                    <Toggle checked={tc.enabled} onChange={(next) => updateToolchains(cfg.toolchains.map((x) => (x.name === tc.name ? { ...x, enabled: next } : x)))} title={tc.title || tc.name} />
                    <span className="flex-1 min-w-0 text-ui text-ink">
                      {tc.title || tc.name}
                      {tc.exists === false ? <span className="text-meta text-faint"> · {t("settingsx.sandbox.toolchain_missing")}</span> : null}
                      {!tc.shipped ? <span className="text-meta text-faint"> · {t("settingsx.sandbox.added_by_you")}</span> : null}
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
              {addingTool ? (
                <div className="pl-6 pr-4 py-3 border-t border-line" data-testid="sandbox-toolchain-editor">
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
                      {t("settingsx.sandbox.add_button")}
                    </button>
                  </div>
                </div>
              ) : null}
              <div className={FOOT}>
                <span className="text-meta text-faint flex-1">{t("settingsx.sandbox.tools_foot")}</span>
                <button className={BTN_SMALL} onClick={() => setAddingTool(true)} data-testid="sandbox-toolchain-add">
                  {t("settingsx.sandbox.add_toolchain")}
                </button>
              </div>
            </Panel>
          ) : null}
          <div className="text-meta text-faint mt-5">{t("settingsx.sandbox.saved_in", { path: cfg.config_path })}</div>
        </>
      ) : null}

      {/* Customize: the machine's own hosts */}
      {hostsOpen ? (
        <HostsDialog
          t={t}
          hosts={extraHosts}
          builtin={cfg.network_profiles.find((n) => n.name === "standard")?.hosts ?? []}
          onCancel={() => setHostsOpen(false)}
          onSave={async (next) => {
            if (await save({ network_extra_hosts: next })) setHostsOpen(false);
          }}
          error={error}
        />
      ) : null}

      {/* Add a CLI's login */}
      {picking ? (
        <Modal testid="sandbox-cli-picker" wide>
          <h3 className="text-heading font-semibold mb-1.5">{t("settingsx.sandbox.cli_title")}</h3>
          <p className="text-ui text-muted mb-3.5 leading-relaxed">{t("settingsx.sandbox.cli_intro")}</p>
          <div className="rounded-lg border border-line divide-y divide-line">
            {presets.length ? (
              [...presets]
                .sort((a, b) => Number(!a.kind) - Number(!b.kind))
                .map((p) => (
                  <div key={p.name} className="flex items-center gap-3 px-3 py-2.5" data-testid={`sandbox-preset-${p.name}`} data-found={p.kind ? "yes" : "no"}>
                    <Badge name={p.name} />
                    <span className="flex-1 min-w-0">
                      <span className={"block text-ui font-medium " + (p.kind ? "text-ink" : "text-faint")}>{titleOf(p)}</span>
                      <span className={"block text-meta " + (p.kind ? "text-muted" : "text-faint")}>
                        {p.kind ? `${p.path} · ${doesOf(p).replace(/\.$/, "")}` : isMac ? t("settingsx.sandbox.not_on_mac") : isWindows ? t("settingsx.sandbox.not_on_pc") : t("settingsx.sandbox.credential_missing")}
                      </span>
                    </span>
                    {p.kind ? (
                      <button
                        className={BTN_SMALL}
                        onClick={() => updateCredentials([...cfg.credentials, { name: p.name, enabled: true }])}
                        data-testid={`sandbox-preset-${p.name}-add`}
                      >
                        {t("settingsx.sandbox.add_button")}
                      </button>
                    ) : (
                      <span className="text-meta text-faint">{t("settingsx.sandbox.not_found")}</span>
                    )}
                  </div>
                ))
            ) : (
              <div className="px-3 py-3 text-ui text-muted">{t("settingsx.sandbox.cli_all_added")}</div>
            )}
          </div>
          <div className="flex items-center gap-2 mt-4">
            <span className="text-meta text-faint">{t("settingsx.sandbox.cli_not_listed")}</span>
            <span className="flex-1" />
            <button
              className={BTN_BORDERED}
              onClick={() => {
                setPicking(false);
                setEditing("");
              }}
            >
              {t("settingsx.sandbox.cli_file_button")}
            </button>
            <button
              className={BTN_ACCENT}
              onClick={() => {
                setPicking(false);
                setOpenFiles(true);
              }}
              data-testid="sandbox-cli-done"
            >
              {t("settingsx.sandbox.done")}
            </button>
          </div>
        </Modal>
      ) : null}

      {/* Add or edit a file or folder */}
      {editing !== null ? (
        <CredentialEditor
          entry={editing ? cfg.credentials.find((c) => c.name === editing) ?? null : null}
          titleOf={titleOf}
          doesOf={doesOf}
          onCancel={() => setEditing(null)}
          onSave={(row) => {
            const rows = editing ? cfg.credentials.map((x) => (x.name === editing ? row : x)) : [...cfg.credentials, row];
            setEditing(null);
            setOpenFiles(true);
            updateCredentials(rows);
          }}
        />
      ) : null}

      {/* OpenShell's setup dialog */}
      {openshellDialog ? (
        <OpenShellDialog
          t={t}
          readiness={readiness}
          job={job}
          ready={Boolean(cfg.providers.find((p) => p.name === "openshell")?.usable) && chosen === "openshell"}
          onStart={startJob}
          onCancel={cancelJob}
          onCheck={() => {
            setJob(null);
            loadReadiness();
          }}
          onClose={() => setOpenshellDialog(false)}
          copy={copy}
          copied={copied}
        />
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

// "Customize…": the hosts this machine adds to "Package registries and search", which the
// user adds and removes, above the shipped ones, which are read-only.
function HostsDialog({
  t,
  hosts,
  builtin,
  onCancel,
  onSave,
  error,
}: {
  t: T;
  hosts: string[];
  builtin: string[];
  onCancel: () => void;
  onSave: (hosts: string[]) => void;
  error: string;
}) {
  const [list, setList] = useState<string[]>(hosts);
  const [draft, setDraft] = useState("");
  const [bad, setBad] = useState(false);
  const add = () => {
    const host = cleanHost(draft);
    if (!host) {
      setBad(true);
      return;
    }
    setBad(false);
    setDraft("");
    if (!list.includes(host)) setList([...list, host]);
  };
  const rows: string[][] = [];
  for (let i = 0; i < builtin.length; i += 4) rows.push(builtin.slice(i, i + 4));
  return (
    <Modal testid="sandbox-hosts-dialog" wide>
      <h3 className="text-heading font-semibold mb-1.5">{t("settingsx.sandbox.hosts_title")}</h3>
      <p className="text-ui text-muted mb-3.5 leading-relaxed">{t("settingsx.sandbox.hosts_intro")}</p>
      <div className="text-label font-medium text-faint mb-1.5">{t("settingsx.sandbox.hosts_yours")}</div>
      {list.length ? (
        <div className="rounded-lg border border-line divide-y divide-line mb-2">
          {list.map((h) => (
            <div key={h} className="flex items-center gap-2.5 px-3 py-1.5 text-meta font-mono text-ink" data-testid={`sandbox-host-${h}`}>
              {h}
              <button className="ml-auto text-meta font-sans text-muted hover:text-ink" onClick={() => setList(list.filter((x) => x !== h))}>
                {t("settingsx.sandbox.remove")}
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2 mb-1">
        <input
          className={INPUT + " font-mono" + (bad ? " border-danger" : "")}
          value={draft}
          placeholder={t("settingsx.sandbox.hosts_placeholder")}
          onChange={(e) => {
            setDraft(e.target.value);
            setBad(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          data-testid="sandbox-host-input"
        />
        <button className={BTN_BORDERED} onClick={add} disabled={!draft.trim()} data-testid="sandbox-host-add">
          {t("settingsx.sandbox.add_button")}
        </button>
      </div>
      {bad ? <div className="text-meta text-danger mb-1">{t("settingsx.sandbox.hosts_bad")}</div> : null}
      {error ? <div className="text-meta text-danger mb-1">{error}</div> : null}
      <div className="text-label font-medium text-faint mt-3.5 mb-1.5">{t("settingsx.sandbox.hosts_builtin")}</div>
      <div className="rounded-lg border border-line divide-y divide-line">
        {rows.map((r) => (
          <div key={r.join()} className="px-3 py-1.5 text-meta font-mono text-muted">
            {r.join(" · ")}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-4">
        <span className="text-meta text-faint max-w-[340px]">{t("settingsx.sandbox.hosts_note")}</span>
        <span className="flex-1" />
        <button className={BTN_BORDERED} onClick={onCancel}>
          {t("settingsx.sandbox.cancel")}
        </button>
        <button className={BTN_ACCENT} onClick={() => onSave(list)} data-testid="sandbox-hosts-save">
          {t("settingsx.sandbox.save")}
        </button>
      </div>
    </Modal>
  );
}

// The same rule as the server's network_profiles.clean_host: "host:port", 443 when bare.
export function cleanHost(text: string): string {
  let s = text.trim().toLowerCase().replace(/\.$/, "");
  if (s.includes("://")) s = s.split("://", 2)[1].split("/", 1)[0];
  let host = s;
  let port = "443";
  const at = s.lastIndexOf(":");
  if (at >= 0) {
    host = s.slice(0, at);
    port = s.slice(at + 1);
  }
  const name = host.startsWith("*.") ? host.slice(2) : host;
  const labels = name.split(".");
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || labels.length < 2 || !labels.every((l) => /^[a-z0-9-]+$/.test(l))) return "";
  return `${host}:${Number(port)}`;
}

// OpenShell's setup (OPE-207, UX-053 v5): the steps first, then the job's rows with its
// progress. A command with Copy shows only where the app cannot do the step itself.
function OpenShellDialog({
  t,
  readiness,
  job,
  ready,
  onStart,
  onCancel,
  onCheck,
  onClose,
  copy,
  copied,
}: {
  t: T;
  readiness: SandboxReadiness | null;
  job: SandboxSetupState | null;
  ready: boolean;
  onStart: () => void;
  onCancel: () => void;
  onCheck: () => void;
  onClose: () => void;
  copy: (text: string) => void;
  copied: string;
}) {
  const rows: (SandboxReadinessStep & { state?: SandboxSetupRowState })[] = job && job.status !== "idle" ? job.rows : readiness?.steps ?? [];
  const running = job?.status === "running";
  const done = job?.status === "done" || (ready && !job);
  const needsYou = job?.status === "needs_you";
  const stopped = job?.status === "failed" || job?.status === "cancelled";
  const elapsed = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`);
  const [title, intro] = done
    ? [t("settingsx.sandbox.os_done_title"), t("settingsx.sandbox.os_done_intro")]
    : running
      ? [t("settingsx.sandbox.os_running_title"), t("settingsx.sandbox.os_running_intro")]
      : needsYou
        ? [t("settingsx.sandbox.os_needs_you_title"), t("settingsx.sandbox.os_needs_you_intro")]
        : stopped
          ? [t("settingsx.sandbox.os_stopped_title"), job?.status === "cancelled" ? t("settingsx.sandbox.setup_cancelled") : t("settingsx.sandbox.setup_failed", { error: job?.error })]
          : [t("settingsx.sandbox.os_title"), t("settingsx.sandbox.os_intro")];
  return (
    <Modal testid="sandbox-openshell-dialog">
      <h3 className="text-heading font-semibold mb-1.5">{title}</h3>
      <p className="text-ui text-muted mb-3.5 leading-relaxed" data-testid={job && job.status !== "idle" ? `sandbox-setup-${job.status}` : undefined}>
        {intro}
      </p>
      {!running && !done && !job ? <div className="text-label font-medium text-faint mb-1.5">{t("settingsx.sandbox.os_steps")}</div> : null}
      {!readiness && !job ? (
        <div className="rounded-lg border border-line bg-paper px-3 py-2.5 text-ui text-muted flex items-center gap-2.5">
          <span className="w-4 h-4 rounded-full border-2 border-lineStrong border-t-accent animate-spin shrink-0" />
          {t("settingsx.sandbox.readiness_loading")}
        </div>
      ) : (
        <ul className="rounded-lg border border-line divide-y divide-line" data-testid="sandbox-readiness">
          {rows.map((r) => {
            const state: SandboxSetupRowState = r.state ?? (r.ok ? "ok" : "pending");
            const good = state === "ok" || state === "fixed";
            const showCommand = !good && r.command && (!r.fixable || state === "needs_you" || state === "failed");
            return (
              <li key={r.key} className="px-3 py-2.5" data-testid={`sandbox-readiness-row-${r.key}`} data-state={state}>
                <div className="flex items-start gap-2">
                  <span className={"shrink-0 w-4 " + (good ? "text-ok" : state === "fixing" ? "text-accent" : state === "pending" ? "text-faint" : "text-warnInk")} aria-hidden>
                    {good ? "✓" : state === "fixing" ? "⟳" : state === "pending" ? "○" : "!"}
                  </span>
                  <span className="flex-1 min-w-0 text-ui text-ink">{r.what}</span>
                  <span className="text-meta text-muted shrink-0">{t(`settingsx.sandbox.step_${!job && state === "pending" ? "todo" : state}`)}</span>
                </div>
                {r.key === "openshell" && running && state === "fixing" && job?.progress ? (
                  <div className="mt-1 ml-6 text-meta text-muted font-mono break-all" data-testid="sandbox-install-progress">
                    {t("settingsx.sandbox.install_progress", { elapsed: elapsed(job.progress.elapsed_s) })}
                    {job.progress.last_line ? ` · ${job.progress.last_line}` : ""}
                  </div>
                ) : null}
                {r.key === "image" && running && state === "fixing" && job?.progress ? (
                  <div className="mt-1.5 ml-6" data-testid="sandbox-download-progress">
                    <div className="h-1.5 rounded bg-line overflow-hidden">
                      <div className="h-full bg-accent transition-all" style={{ width: job.progress.layers_total ? `${Math.round((100 * job.progress.layers_done) / job.progress.layers_total)}%` : "5%" }} />
                    </div>
                    <div className="text-meta text-muted mt-1">
                      {job.progress.layers_total
                        ? t("settingsx.sandbox.download_progress", { done: job.progress.layers_done, total: job.progress.layers_total, elapsed: elapsed(job.progress.elapsed_s) })
                        : t("settingsx.sandbox.download_progress_unknown", { elapsed: elapsed(job.progress.elapsed_s) })}
                    </div>
                  </div>
                ) : null}
                {!good && r.hint ? <div className="mt-1 ml-6 text-meta text-muted">{r.hint}</div> : null}
                {showCommand ? (
                  <div className="mt-1.5 ml-6 flex items-start gap-2 rounded-lg border border-line bg-paper px-2.5 py-1.5" data-testid={`sandbox-readiness-command-${r.key}`}>
                    <code className="text-meta font-mono text-ink break-all flex-1 min-w-0">{r.command}</code>
                    <button className="text-meta text-accent shrink-0" onClick={() => copy(r.command)}>
                      {copied === r.command ? t("settingsx.sandbox.copied") : t("settingsx.sandbox.copy")}
                    </button>
                  </div>
                ) : null}
                {!good && r.docs ? (
                  <a className="mt-1 ml-6 inline-block text-meta text-accent" href={r.docs} target="_blank" rel="noreferrer" data-testid={`sandbox-readiness-docs-${r.key}`}>
                    {r.key === "docker" ? t("settingsx.sandbox.get_docker") : t("settingsx.sandbox.guide")}
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center gap-2 mt-4">
        <span className="text-meta text-faint max-w-[340px] leading-relaxed">{done ? "" : running ? t("settingsx.sandbox.os_close_note") : t("settingsx.sandbox.setup_never_root")}</span>
        <span className="flex-1" />
        {done ? (
          <button className={BTN_ACCENT} onClick={onClose} data-testid="sandbox-openshell-done">
            {t("settingsx.sandbox.done")}
          </button>
        ) : running ? (
          <>
            <button className={BTN_BORDERED} onClick={onCancel} data-testid="sandbox-setup-cancel">
              {t("settingsx.sandbox.setup_cancel")}
            </button>
            <button className={BTN_ACCENT} onClick={onClose}>
              {t("settingsx.sandbox.close")}
            </button>
          </>
        ) : (
          <>
            <button className={BTN_BORDERED} onClick={onClose} data-testid="sandbox-openshell-close">
              {job ? t("settingsx.sandbox.close") : t("settingsx.sandbox.cancel")}
            </button>
            {job ? (
              <button className={BTN_BORDERED} onClick={onCheck} data-testid="sandbox-setup-check">
                {t("settingsx.sandbox.setup_again")}
              </button>
            ) : null}
            <button className={BTN_ACCENT} onClick={onStart} disabled={!rows.length} data-testid="sandbox-setup-start">
              {job ? t("settingsx.sandbox.try_again") : t("settingsx.sandbox.set_up")}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

function validPath(path: string): boolean {
  return (path.startsWith("~/") || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) && path.length >= 3;
}

// Add or edit one entry: a file or a folder under the home folder, what is in it, the
// hosts its tool needs, and what it lets the agent do.
export function CredentialEditor({
  entry,
  titleOf,
  doesOf,
  onCancel,
  onSave,
}: {
  entry: SandboxCredentialEntry | null;
  titleOf?: (c: SandboxCredentialEntry) => string;
  doesOf?: (c: SandboxCredentialEntry) => string;
  onCancel: () => void;
  onSave: (row: SandboxCredentialEntry) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(entry ? (titleOf ? titleOf(entry) : entry.title ?? "") : "");
  const [path, setPath] = useState(entry?.path ?? "~/");
  const [hosts, setHosts] = useState((entry?.hosts ?? []).join("\n"));
  const [does, setDoes] = useState(entry ? (doesOf ? doesOf(entry) : entry.does ?? "") : "");
  const [label, setLabel] = useState<"credential" | "configuration">(entry?.label === "configuration" ? "configuration" : "credential");
  const slug = entry?.name || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const valid = Boolean(slug) && validPath(path);
  return (
    <Modal testid="sandbox-credential-editor" wide>
      <h3 className="text-heading font-semibold mb-1.5">{entry ? t("settingsx.sandbox.file_title_edit") : t("settingsx.sandbox.file_title")}</h3>
      <p className="text-ui text-muted mb-3.5 leading-relaxed">{t("settingsx.sandbox.file_intro")}</p>
      <div className="grid gap-3">
        <label className="block">
          <span className="block text-meta text-muted mb-1">
            {t("settingsx.sandbox.field_path")} <span className="text-faint">{t("settingsx.sandbox.field_path_hint")}</span>
          </span>
          <span className="flex gap-2">
            <input className={INPUT + " font-mono"} value={path} onChange={(e) => setPath(e.target.value)} data-testid="sandbox-credential-path" />
            <button
              className={BTN_BORDERED}
              onClick={async (e) => {
                e.preventDefault();
                const picked = await chooseFolder();
                if (picked) setPath(picked);
              }}
            >
              {t("settingsx.sandbox.browse")}
            </button>
          </span>
        </label>
        <label className="block">
          <span className="block text-meta text-muted mb-1">{t("settingsx.sandbox.field_title")}</span>
          <input className={INPUT + " w-full"} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("settingsx.sandbox.field_title_example")} data-testid="sandbox-credential-title" />
        </label>
        <div>
          <span className="block text-meta text-muted mb-1">{t("settingsx.sandbox.field_label")}</span>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("settingsx.sandbox.field_label")}>
            {(["credential", "configuration"] as const).map((k) => (
              <label key={k} className={"flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer " + (label === k ? "border-accent bg-accentSoft" : "border-line")}>
                <input type="radio" name="sandbox-credential-label" className="mt-1" checked={label === k} onChange={() => setLabel(k)} data-testid={`sandbox-credential-label-${k}`} />
                <span>
                  <span className="block text-ui text-ink font-medium">{t(`settingsx.sandbox.label_${k}_title`)}</span>
                  <span className="block text-meta text-muted">{t(`settingsx.sandbox.label_${k}_desc`)}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <label className="block">
          <span className="block text-meta text-muted mb-1">{t("settingsx.sandbox.field_hosts")}</span>
          <textarea className={INPUT + " w-full font-mono"} rows={2} value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder={t("settingsx.sandbox.field_hosts_example")} />
        </label>
        <label className="block">
          <span className="block text-meta text-muted mb-1">{t("settingsx.sandbox.field_does")}</span>
          <input className={INPUT + " w-full"} value={does} onChange={(e) => setDoes(e.target.value)} placeholder={t("settingsx.sandbox.field_does_example")} />
        </label>
      </div>
      <div className="flex items-center gap-2 mt-4">
        <span className="text-meta text-faint max-w-[340px]">{t("settingsx.sandbox.editor_note")}</span>
        <span className="flex-1" />
        <button className={BTN_BORDERED} onClick={onCancel}>
          {t("settingsx.sandbox.cancel")}
        </button>
        <button
          className={BTN_ACCENT}
          disabled={!valid}
          data-testid="sandbox-credential-save"
          onClick={() =>
            onSave({
              name: slug,
              title: title && title !== (entry && titleOf ? titleOf({ ...entry, title: undefined }) : "") ? title : entry?.title,
              path,
              hosts: hosts
                .split(/[\s,]+/)
                .map((h) => cleanHost(h) || h.trim())
                .filter(Boolean),
              does: does && does !== (entry && doesOf ? doesOf({ ...entry, does: undefined }) : "") ? does : entry?.does,
              label,
              enabled: entry?.enabled ?? true,
            })
          }
        >
          {entry ? t("settingsx.sandbox.save") : t("settingsx.sandbox.add_button")}
        </button>
      </div>
    </Modal>
  );
}
