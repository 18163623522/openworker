// Settings ▸ Sandbox (UX-051 A, UX-053 v5, OPE-207): one switch first; on reveals the type;
// a chosen type reveals its options. The page shows what the machine reports and writes back
// the changes: provider, network profile and the machine's own hosts, the credential list,
// the toolchain list. A type that is not set up looks disabled with one "Set up" button: on
// Windows it opens the setup dialog, which calls the Windows setup route; for OpenShell it
// opens the dialog with the readiness checklist and the guided setup job.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const base = {
  platform: "darwin",
  provider: "",
  effective_provider: "direct",
  refused: "",
  providers: [
    { name: "direct", usable: true, why: "" },
    { name: "seatbelt", usable: true, why: "" },
    { name: "openshell", usable: false, why: "OpenShell is not installed" },
  ],
  windows_setup: null as any,
  network_profile: "standard",
  network_profiles: [
    { name: "standard", hosts: ["github.com", "pypi.org", "api.tavily.com"] },
    { name: "open", hosts: [] },
  ],
  network_extra_hosts: [] as string[],
  credentials: [
    { name: "ssh", path: "~/.ssh", hosts: ["github.com:22"], label: "credential", enabled: true, kind: "folder", shipped: true },
    { name: "aws", path: "~/.aws/config", hosts: ["*.amazonaws.com:443"], label: "configuration", enabled: true, kind: "file", shipped: true },
    { name: "gh", path: "~/.config/gh", hosts: ["api.github.com:443"], label: "credential", enabled: false, kind: "", shipped: true },
  ],
  credential_presets: [
    { name: "npm", path: "~/.npmrc", hosts: ["registry.npmjs.org:443"], label: "credential", enabled: false, kind: "file", shipped: true },
    { name: "gcloud", path: "~/.config/gcloud", hosts: ["*.googleapis.com:443"], label: "credential", enabled: false, kind: "", shipped: true },
  ],
  toolchains: [
    { name: "nvm", title: "nvm (Node versions)", path: "~/.nvm", enabled: true, exists: true, shipped: true },
    { name: "mytools", title: "My tools", path: "~/tools", enabled: true, exists: false, shipped: false },
  ],
  config_path: "/Users/sam/.config/coworker/config.toml",
};
let snapshot: any = { ...base };

const readiness = {
  platform: "linux",
  supported: true,
  all_ok: false,
  steps: [
    { key: "docker", what: "Docker is installed and this user can use it", ok: true, hint: "", fixable: false, command: "", docs: "" },
    // Handed over (no way to run as an administrator here): a command, and a guide.
    { key: "openshell", what: "OpenShell 0.0.116 is installed", ok: false, hint: "", fixable: false, command: "curl -LsSf https://example/install.sh | sh", docs: "https://example/guide" },
    { key: "gateway", what: "the gateway is running", ok: false, hint: "OpenShell is not installed", fixable: false, command: "", docs: "" },
    { key: "image", what: "the sandbox base image is downloaded (about 5 GB, one time)", ok: false, hint: "", fixable: true, command: "docker pull img", docs: "" },
  ],
};
let setupState: any = { status: "idle", rows: [], progress: null, error: "", elapsed_s: 0 };

// Like the backend: a provider change names the sessions it dropped for a rebuild.
const setSandboxSettings = vi.fn(async (patch: any) => ({ ok: true, ...snapshot, ...patch, ...("provider" in patch ? { rebuilt_sessions: ["s-open"] } : {}) }));
const onSandboxProviderChanged = vi.fn();
const startSandboxSetup = vi.fn(async () => setupState);
const runSandboxSetup = vi.fn(async () => ({ ok: true, checked: "the wall held", ...snapshot, provider: "windows", providers: snapshot.providers.map((p: any) => (p.name === "windows" ? { ...p, usable: true, why: "" } : p)), windows_setup: { ...snapshot.windows_setup, state: "ready", set_up_at: "2026-09-28T10:00:00Z" } }));
const runSandboxRemove = vi.fn(async () => ({ ok: true, ...snapshot, provider: "direct", windows_setup: { ...snapshot.windows_setup, state: "not_set_up", set_up_at: "" } }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getSandboxSettings: vi.fn(async () => snapshot),
    setSandboxSettings: (patch: any) => setSandboxSettings(patch),
    runSandboxSetup: () => runSandboxSetup(),
    runSandboxRemove: () => runSandboxRemove(),
    getSandboxReadiness: vi.fn(async () => readiness),
    getSandboxSetup: vi.fn(async () => setupState),
    startSandboxSetup: () => startSandboxSetup(),
    cancelSandboxSetup: vi.fn(async () => setupState),
    getMachines: vi.fn(async () => ({ machines: [] })),
    getCloudMachines: vi.fn(async () => ({ machines: [] })),
    getCloudConnections: vi.fn(async () => []),
    getConnectors: vi.fn(async () => []),
    getCloudStatus: vi.fn(async () => ({ signed_in: false })),
    isCloudMode: () => false,
  };
});

import { SettingsView } from "./SettingsView";
import { cleanHost } from "./SandboxSection";

const stripDisplay = (rows: any[]) => rows.map(({ kind: _k, shipped: _s, ...row }) => row);
const lastPatch = () => {
  const calls = setSandboxSettings.mock.calls;
  return calls[calls.length - 1]?.[0];
};
const masterSwitch = () => within(screen.getByTestId("sandbox-section")).getAllByRole("switch")[0];
const chosenSeatbelt = () => ({ ...base, provider: "seatbelt", effective_provider: "seatbelt" });

describe("Settings ▸ Sandbox", () => {
  beforeEach(() => {
    snapshot = { ...base };
    setSandboxSettings.mockClear();
    runSandboxSetup.mockClear();
    runSandboxRemove.mockClear();
    startSandboxSetup.mockClear();
    onSandboxProviderChanged.mockClear();
    setupState = { status: "idle", rows: [], progress: null, error: "", elapsed_s: 0 };
  });
  afterEach(cleanup);

  it("off: one switch and one line; on reveals the types, OpenShell disabled with one Set up button", async () => {
    render(<SettingsView initialTab="sandbox" onSandboxProviderChanged={onSandboxProviderChanged} />);
    await screen.findByTestId("sandbox-section");
    expect(screen.getByText("Manage environment restrictions for your Agent.")).toBeTruthy();
    expect(screen.getByText("Agents can only use the folders you open. The rest of your computer stays private.")).toBeTruthy();
    expect(masterSwitch().getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("sandbox-switch-status")).toBeNull(); // the switch is its own cue
    expect(screen.queryByTestId("sandbox-provider-seatbelt")).toBeNull();
    expect(screen.queryByTestId("sandbox-card-files")).toBeNull();
    fireEvent.click(masterSwitch());
    expect(screen.getByText("Built into macOS.")).toBeTruthy();
    expect((screen.getByTestId("sandbox-provider-openshell") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("sandbox-setup-openshell").textContent).toBe("Set up");
    expect(screen.queryByTestId("sandbox-provider-openshell-why")).toBeNull(); // the button says it all
    expect(screen.queryByTestId("sandbox-network-standard")).toBeNull(); // no type is chosen yet
    expect(setSandboxSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("sandbox-provider-seatbelt"));
    await waitFor(() => expect(setSandboxSettings).toHaveBeenCalledWith({ provider: "seatbelt" }));
    await waitFor(() => expect(onSandboxProviderChanged).toHaveBeenCalledWith(["s-open"])); // live sessions rebuilt under the new rule
  });

  it("OpenShell's Set up opens its dialog: the steps first, the handover command with Copy, then the job", async () => {
    snapshot = {
      ...base,
      platform: "linux",
      providers: [
        { name: "direct", usable: true, why: "", state: "ready" },
        { name: "openshell", usable: false, why: "OpenShell is not installed", state: "unavailable" },
      ],
    };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    fireEvent.click(masterSwitch());
    expect(screen.getByText("One Linux container per agent. Needs Docker.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("sandbox-setup-openshell"));
    const dialog = await screen.findByTestId("sandbox-openshell-dialog");
    await within(dialog).findByTestId("sandbox-readiness-row-openshell");
    expect(within(dialog).getByText("Set up OpenShell")).toBeTruthy();
    expect(screen.getByTestId("sandbox-readiness-row-docker").getAttribute("data-state")).toBe("ok");
    expect(screen.getByTestId("sandbox-readiness-row-openshell").getAttribute("data-state")).toBe("pending");
    expect(within(screen.getByTestId("sandbox-readiness-row-image")).getByText("to do")).toBeTruthy();
    // Only the handed-over row shows its command with Copy; the image row is the app's to
    // do, and a note (the gateway row) gets neither.
    expect(within(dialog).getByText("curl -LsSf https://example/install.sh | sh")).toBeTruthy();
    expect(within(dialog).getAllByText("Copy").length).toBe(1);
    expect(screen.queryByTestId("sandbox-readiness-command-gateway")).toBeNull();
    expect((screen.getByTestId("sandbox-readiness-docs-openshell") as HTMLAnchorElement).href).toBe("https://example/guide");
    expect(screen.queryByTestId("sandbox-readiness")).toBeTruthy();
    fireEvent.click(screen.getByTestId("sandbox-setup-start"));
    await waitFor(() => expect(startSandboxSetup).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("sandbox-openshell-close"));
    expect(screen.queryByTestId("sandbox-openshell-dialog")).toBeNull();
  });

  it("OpenShell: a running job shows progress in the dialog; needs_you offers Check again and Try again", async () => {
    snapshot = { ...base, platform: "linux", providers: [{ name: "direct", usable: true, why: "", state: "ready" }, { name: "openshell", usable: false, why: "", state: "needs_download" }] };
    setupState = {
      status: "running",
      rows: [
        { ...readiness.steps[0], state: "ok" },
        { ...readiness.steps[1], ok: true, state: "ok" },
        { ...readiness.steps[2], ok: true, state: "ok" },
        { ...readiness.steps[3], state: "fixing" },
      ],
      progress: { layers_total: 8, layers_done: 3, last_line: "x: Downloading", elapsed_s: 75 },
      error: "",
      elapsed_s: 75,
    };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    fireEvent.click(masterSwitch());
    await waitFor(() => expect(screen.getByTestId("sandbox-setup-openshell").textContent).toBe("Setting up…")); // the job was adopted
    fireEvent.click(screen.getByTestId("sandbox-setup-openshell"));
    await screen.findByTestId("sandbox-download-progress");
    expect(screen.getByText("Setting up OpenShell")).toBeTruthy();
    expect(screen.getByText("Downloading the base image: 3 of 8 layers, 1 min 15 s elapsed")).toBeTruthy();
    expect(screen.getByTestId("sandbox-setup-cancel")).toBeTruthy();
    expect(screen.getByTestId("sandbox-readiness-row-image").getAttribute("data-state")).toBe("fixing");
    cleanup();

    setupState = {
      status: "needs_you",
      rows: [
        { ...readiness.steps[0], state: "ok" },
        { ...readiness.steps[1], state: "needs_you" },
        { ...readiness.steps[2], state: "pending" },
        { ...readiness.steps[3], state: "pending" },
      ],
      progress: null,
      error: "",
      elapsed_s: 3,
    };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    fireEvent.click(masterSwitch());
    await waitFor(() => expect(screen.getByTestId("sandbox-setup-openshell")).toBeTruthy());
    fireEvent.click(screen.getByTestId("sandbox-setup-openshell"));
    await screen.findByTestId("sandbox-setup-needs_you");
    expect(screen.getByText("One step needs you")).toBeTruthy();
    expect(screen.getByTestId("sandbox-readiness-row-openshell").getAttribute("data-state")).toBe("needs_you");
    expect(screen.getByTestId("sandbox-setup-check").textContent).toBe("Check again");
    fireEvent.click(screen.getByTestId("sandbox-setup-start"));
    await waitFor(() => expect(startSandboxSetup).toHaveBeenCalled());
  });

  it("OpenShell chosen with the base image missing: selected, with the hint and the Set up button", async () => {
    snapshot = {
      ...base,
      platform: "linux",
      provider: "openshell",
      effective_provider: "",
      providers: [
        { name: "direct", usable: true, why: "", state: "ready" },
        { name: "openshell", usable: false, why: "the base image is missing", state: "needs_download" },
      ],
    };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    expect((screen.getByTestId("sandbox-provider-openshell") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("sandbox-provider-openshell-hint").textContent).toMatch(/about 5 GB/);
    expect(screen.getByTestId("sandbox-setup-openshell")).toBeTruthy();
    expect(screen.queryByTestId("sandbox-card-tools")).toBeNull(); // OpenShell mounts no home folder: no tools panel
    expect(screen.getByTestId("sandbox-card-files")).toBeTruthy();
  });

  it("a chosen type shows two network choices, Customize, and two closed panels; off writes direct", async () => {
    snapshot = chosenSeatbelt();
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    expect(document.querySelectorAll('input[name="sandbox-network"]').length).toBe(2);
    expect((screen.getByTestId("sandbox-network-standard") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Package registries and search")).toBeTruthy();
    expect(screen.getByText("Allow everything").className).toContain("text-warnInk");
    fireEvent.click(screen.getByTestId("sandbox-network-open"));
    await waitFor(() => expect(setSandboxSettings).toHaveBeenCalledWith({ network_profile: "open" }));
    expect(screen.queryByTestId("sandbox-card-files-body")).toBeNull();
    expect(screen.getByTestId("sandbox-card-files-summary").textContent).toBe("SSH keys and AWS profiles. Copies are deleted when the session ends.");
    expect(screen.queryByTestId("sandbox-card-tools-body")).toBeNull();
    expect(screen.getByTestId("sandbox-card-tools-summary").textContent).toBe("nvm (Node versions) and My tools. Agents can run them, not change them.");
    expect(screen.getByText(/config\.toml/)).toBeTruthy();
    fireEvent.click(masterSwitch());
    await waitFor(() => expect(setSandboxSettings).toHaveBeenLastCalledWith({ provider: "direct" }));
  });

  it("Customize: add a host, refuse a bad one, remove one, save the machine's list", async () => {
    snapshot = { ...chosenSeatbelt(), network_extra_hosts: ["sentry.io:443"] };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    expect(screen.getByText(/1 added/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("sandbox-network-customize"));
    const dialog = screen.getByTestId("sandbox-hosts-dialog");
    expect(within(dialog).getByText(/github\.com · pypi\.org · api\.tavily\.com/)).toBeTruthy(); // the shipped list, read-only
    const input = screen.getByTestId("sandbox-host-input");
    fireEvent.change(input, { target: { value: "not a host" } });
    fireEvent.click(screen.getByTestId("sandbox-host-add"));
    expect(within(dialog).getByText(/That is not a host name/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "Registry.Acme.dev" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("sandbox-host-registry.acme.dev:443")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("sandbox-host-sentry.io:443")).getByText("Remove"));
    fireEvent.click(screen.getByTestId("sandbox-hosts-save"));
    await waitFor(() => expect(setSandboxSettings).toHaveBeenLastCalledWith({ network_extra_hosts: ["registry.acme.dev:443"] }));
    await waitFor(() => expect(screen.queryByTestId("sandbox-hosts-dialog")).toBeNull());
  });

  it("the files panel lists only added entries: switch, tags, remove; Add… offers a CLI's login or a file", async () => {
    snapshot = chosenSeatbelt();
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    fireEvent.click(screen.getByTestId("sandbox-card-files-toggle"));
    const body = screen.getByTestId("sandbox-card-files-body");
    expect(screen.getByTestId("sandbox-credential-ssh-kind").textContent).toBe("folder");
    expect(screen.getByTestId("sandbox-credential-aws-kind").textContent).toBe("file");
    expect(within(screen.getByTestId("sandbox-credential-gh")).getByText("not on this machine")).toBeTruthy();
    expect(within(screen.getByTestId("sandbox-credential-aws")).getByText("configuration")).toBeTruthy();
    expect(within(body).getByText(/Also allows github.com:22/)).toBeTruthy();
    expect(within(body).getByText("Logins kept in the macOS Keychain are not files and cannot be added.")).toBeTruthy();
    expect(screen.queryByTestId("sandbox-credential-npm")).toBeNull(); // a preset is not listed until added
    fireEvent.click(within(screen.getByTestId("sandbox-credential-ssh")).getByRole("switch"));
    await waitFor(() => expect(lastPatch()).toEqual({ credentials: stripDisplay([{ ...base.credentials[0], enabled: false }, base.credentials[1], base.credentials[2]]) }));
    fireEvent.click(screen.getByTestId("sandbox-credential-gh-remove"));
    await waitFor(() => expect(lastPatch().credentials.map((c: any) => c.name)).toEqual(["ssh", "aws"]));

    // A CLI's login: found presets can be added, missing ones say so
    fireEvent.click(screen.getByTestId("sandbox-credential-add"));
    fireEvent.click(screen.getByTestId("sandbox-add-cli"));
    const picker = screen.getByTestId("sandbox-cli-picker");
    expect(screen.getByTestId("sandbox-preset-npm").getAttribute("data-found")).toBe("yes");
    expect(within(screen.getByTestId("sandbox-preset-npm")).getByText("~/.npmrc · Install and publish private packages")).toBeTruthy();
    expect(within(screen.getByTestId("sandbox-preset-gcloud")).getByText("not found")).toBeTruthy();
    expect(within(screen.getByTestId("sandbox-preset-gcloud")).getByText("not on this Mac")).toBeTruthy();
    fireEvent.click(screen.getByTestId("sandbox-preset-npm-add"));
    await waitFor(() => expect(lastPatch().credentials[lastPatch().credentials.length - 1]).toEqual({ name: "npm", enabled: true }));
    fireEvent.click(within(picker).getByTestId("sandbox-cli-done"));
    expect(screen.queryByTestId("sandbox-cli-picker")).toBeNull();

    // A file or folder: the modal, with a label
    fireEvent.click(screen.getByTestId("sandbox-credential-add"));
    fireEvent.click(screen.getByTestId("sandbox-add-file"));
    const editor = screen.getByTestId("sandbox-credential-editor");
    expect(within(editor).getByText("Add a file or folder")).toBeTruthy();
    fireEvent.change(screen.getByTestId("sandbox-credential-path"), { target: { value: "~/.config/acme/token" } });
    fireEvent.change(screen.getByTestId("sandbox-credential-title"), { target: { value: "Acme CLI token" } });
    fireEvent.click(screen.getByTestId("sandbox-credential-label-configuration"));
    fireEvent.change(editor.querySelector("textarea")!, { target: { value: "api.acme.dev" } });
    fireEvent.click(screen.getByTestId("sandbox-credential-save"));
    await waitFor(() =>
      expect(lastPatch().credentials[lastPatch().credentials.length - 1]).toEqual({
        name: "acme-cli-token",
        title: "Acme CLI token",
        path: "~/.config/acme/token",
        hosts: ["api.acme.dev:443"],
        does: undefined,
        label: "configuration",
        enabled: true,
      }),
    );
  });

  it("nothing added yet: the panel says so in one line and offers Add…", async () => {
    snapshot = { ...chosenSeatbelt(), credentials: [] };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    expect(screen.getByTestId("sandbox-card-files-summary").textContent).toBe("Nothing is copied into sandboxes.");
    fireEvent.click(screen.getByTestId("sandbox-card-files-toggle"));
    expect(screen.getByTestId("sandbox-files-empty").textContent).toContain("Add a CLI's login");
    expect(screen.getByTestId("sandbox-credential-add").textContent).toBe("Add…");
  });

  it("the tools panel: switch a folder off and add one, without the display-only fields", async () => {
    snapshot = chosenSeatbelt();
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    fireEvent.click(screen.getByTestId("sandbox-card-tools-toggle"));
    expect(screen.getByText("Tools shown to Agent with read-only access")).toBeTruthy();
    expect(within(screen.getByTestId("sandbox-toolchain-mytools")).getByText(/not on this machine/)).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("sandbox-toolchain-nvm")).getByRole("switch"));
    await waitFor(() =>
      expect(lastPatch()).toEqual({
        toolchains: [
          { name: "nvm", title: "nvm (Node versions)", path: "~/.nvm", enabled: false },
          { name: "mytools", title: "My tools", path: "~/tools", enabled: true },
        ],
      }),
    );
    fireEvent.click(screen.getByTestId("sandbox-toolchain-add"));
    const editor = screen.getByTestId("sandbox-toolchain-editor");
    const inputs = editor.querySelectorAll("input");
    fireEvent.change(inputs[0], { target: { value: "JDKs" } });
    fireEvent.change(inputs[1], { target: { value: "~/.jdks" } });
    fireEvent.click(within(editor).getByText("Add"));
    await waitFor(() => expect(lastPatch().toolchains[lastPatch().toolchains.length - 1]).toEqual({ name: "jdks", title: "JDKs", path: "~/.jdks", enabled: true }));
  });

  it("Windows: Set up opens the setup dialog; Set up now calls the route; Done shows the options", async () => {
    snapshot = {
      ...base,
      platform: "win32",
      providers: [
        { name: "direct", usable: true, why: "" },
        { name: "windows", usable: false, why: "the one-time setup has not run on this PC" },
        { name: "openshell", usable: false, why: "OpenShell is not available on Windows yet." },
      ],
      windows_setup: { state: "not_set_up", set_up_at: "", problem: "not run", can_elevate: true, command: "openworker machine sandbox setup" },
      network_profile: "open",
    };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    fireEvent.click(masterSwitch());
    expect(screen.getByText("Built into Windows.")).toBeTruthy();
    expect((screen.getByTestId("sandbox-provider-windows") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId("sandbox-provider-windows-why")).toBeNull(); // an administrator sees no warning
    expect(screen.queryByTestId("sandbox-setup-openshell")).toBeNull(); // nothing to set up for OpenShell on Windows
    expect(screen.getByTestId("sandbox-provider-openshell-why").textContent).toBe("OpenShell is not available on Windows yet.");
    fireEvent.click(screen.getByTestId("sandbox-setup-windows"));
    const dialog = screen.getByTestId("sandbox-setup-dialog");
    expect(within(dialog).getByText("Set up the Windows sandbox")).toBeTruthy();
    expect(setSandboxSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("sandbox-setup-now"));
    await waitFor(() => expect(runSandboxSetup).toHaveBeenCalled());
    await screen.findByTestId("sandbox-setup-done-box");
    expect(screen.getByTestId("sandbox-setup-done-box").textContent).toContain("the wall held");
    fireEvent.click(screen.getByTestId("sandbox-setup-done"));
    expect(screen.queryByTestId("sandbox-setup-dialog")).toBeNull();
    expect((screen.getByTestId("sandbox-provider-windows") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("sandbox-windows-setup-line").textContent).toContain("Set up on");
    expect((screen.getByTestId("sandbox-network-open") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("sandbox-card-files")).toBeTruthy();
    expect(screen.getByTestId("sandbox-card-tools")).toBeTruthy();
    fireEvent.click(screen.getByTestId("sandbox-card-files-toggle"));
    expect(screen.getByText("Logins kept in Windows Credential Manager are not files and cannot be added.")).toBeTruthy();
    // Remove setup: confirm, the route runs, the page collapses
    fireEvent.click(screen.getByTestId("sandbox-remove-setup"));
    fireEvent.click(screen.getByTestId("sandbox-remove-confirm"));
    await waitFor(() => expect(runSandboxRemove).toHaveBeenCalled());
    await waitFor(() => expect(masterSwitch().getAttribute("aria-checked")).toBe("false"));
    expect(screen.queryByTestId("sandbox-card-files")).toBeNull();
  });

  it("Windows, not an administrator: the row is disabled with the command and no button; Not now turns the switch off", async () => {
    snapshot = {
      ...base,
      platform: "win32",
      providers: [
        { name: "direct", usable: true, why: "" },
        { name: "windows", usable: false, why: "the one-time setup has not run on this PC" },
        { name: "openshell", usable: false, why: "OpenShell is not available on Windows yet." },
      ],
      windows_setup: { state: "not_set_up", set_up_at: "", problem: "not run", can_elevate: false, command: "openworker machine sandbox setup" },
    };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    fireEvent.click(masterSwitch());
    expect((screen.getByTestId("sandbox-provider-windows") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("sandbox-provider-windows-why").textContent).toContain("openworker machine sandbox setup");
    expect(screen.queryByTestId("sandbox-setup-windows")).toBeNull();
    // an administrator, but "Not now"
    snapshot = { ...snapshot, windows_setup: { ...snapshot.windows_setup, can_elevate: true } };
    cleanup();
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    fireEvent.click(masterSwitch());
    fireEvent.click(screen.getByTestId("sandbox-setup-windows"));
    fireEvent.click(screen.getByTestId("sandbox-setup-not-now"));
    expect(screen.queryByTestId("sandbox-setup-dialog")).toBeNull();
    expect(masterSwitch().getAttribute("aria-checked")).toBe("false");
    expect(runSandboxSetup).not.toHaveBeenCalled();
  });

  it("cleanHost follows the server's rule", () => {
    expect(cleanHost("Registry.Acme.dev")).toBe("registry.acme.dev:443");
    expect(cleanHost("https://api.acme.dev/v1")).toBe("api.acme.dev:443");
    expect(cleanHost("*.acme.dev:8443")).toBe("*.acme.dev:8443");
    for (const bad of ["", "localhost", "acme dev", "api.acme.dev:0", "a..b"]) expect(cleanHost(bad)).toBe("");
  });
});
