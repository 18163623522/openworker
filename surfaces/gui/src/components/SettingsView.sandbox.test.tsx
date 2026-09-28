// Settings ▸ Sandbox (UX-051 A, OPE-207): one switch, then the provider, the readiness
// checklist with its guided setup, and the sub-settings that only apply behind a wall.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const base = {
  platform: "darwin",
  provider: "",
  effective_provider: "direct",
  refused: "",
  providers: [
    { name: "direct", usable: true, why: "", state: "ready" },
    { name: "seatbelt", usable: true, why: "", state: "ready" },
    { name: "openshell", usable: false, why: "OpenShell is not installed", state: "unavailable" },
  ],
  network_profile: "strict",
  network_profiles: [
    { name: "strict", hosts: ["github.com"] },
    { name: "standard", hosts: ["github.com", "api.tavily.com"] },
  ],
  credentials: [
    { name: "ssh", path: "~/.ssh", hosts: ["github.com:22"], enabled: false },
    { name: "gh", path: "~/.config/gh", hosts: ["api.github.com:443"], enabled: true },
  ],
  config_path: "/Users/sam/.config/coworker/config.toml",
};
let snapshot: any = base;
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

// Like the backend: each save returns the whole (updated) snapshot.
const setSandboxSettings = vi.fn(async (patch: any) => {
  snapshot = { ...snapshot, ...patch };
  // Like the backend: a provider change names the sessions it dropped for a rebuild.
  return { ok: true, ...snapshot, ...("provider" in patch ? { rebuilt_sessions: ["s-open"] } : {}) };
});
const onSandboxProviderChanged = vi.fn();
const startSandboxSetup = vi.fn(async () => setupState);

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getSandboxSettings: vi.fn(async () => snapshot),
    setSandboxSettings: (patch: any) => setSandboxSettings(patch),
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

describe("Settings ▸ Sandbox", () => {
  beforeEach(() => {
    setSandboxSettings.mockClear();
    startSandboxSetup.mockClear();
    snapshot = base;
    setupState = { status: "idle", rows: [], progress: null, error: "", elapsed_s: 0 };
  });
  afterEach(cleanup);

  it("with no sandbox chosen: the switch is off and the sub-settings are not shown", async () => {
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    expect((screen.getByTestId("sandbox-switch") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/Off: commands run directly on this machine/)).toBeTruthy();
    expect(screen.queryByTestId("sandbox-network-section")).toBeNull();
    expect(screen.queryByTestId("sandbox-credentials-section")).toBeNull();
    expect(screen.queryByTestId("sandbox-readiness")).toBeNull();
    expect(screen.queryByText("ready")).toBeNull(); // no status word for "no sandbox"
    expect(screen.queryByText(/config\.toml/)).toBeNull(); // off = nothing stored: no "stored in" line
  });

  it("switching on picks the provider that needs no setup on a Mac, and off clears the key", async () => {
    render(<SettingsView initialTab="sandbox" onSandboxProviderChanged={onSandboxProviderChanged} />);
    await screen.findByTestId("sandbox-section");
    fireEvent.click(screen.getByTestId("sandbox-switch"));
    await waitFor(() => expect(setSandboxSettings).toHaveBeenCalledWith({ provider: "seatbelt" }));
    await waitFor(() => expect(onSandboxProviderChanged).toHaveBeenCalledWith(["s-open"])); // the app reconnects that session
    // Now on: the provider line (a dropdown on a Mac) and the sub-settings appear.
    expect((screen.getByTestId("sandbox-provider-select") as HTMLSelectElement).value).toBe("seatbelt");
    expect(screen.getByTestId("sandbox-network-section")).toBeTruthy();
    expect(screen.getByTestId("sandbox-credentials-section")).toBeTruthy();
    fireEvent.click(screen.getByTestId("sandbox-network-standard"));
    await waitFor(() => expect(setSandboxSettings).toHaveBeenCalledWith({ network_profile: "standard" }));
    fireEvent.click(screen.getByLabelText("SSH keys"));
    await waitFor(() =>
      expect(setSandboxSettings).toHaveBeenLastCalledWith({
        credentials: [
          { name: "ssh", path: "~/.ssh", hosts: ["github.com:22"], enabled: true },
          { name: "gh", path: "~/.config/gh", hosts: ["api.github.com:443"], enabled: true },
        ],
      }),
    );
    fireEvent.click(screen.getByTestId("sandbox-switch"));
    await waitFor(() => expect(setSandboxSettings).toHaveBeenLastCalledWith({ provider: "" })); // cleared, not "direct"
  });

  it("with OpenShell on Linux: the readiness checklist, its hints, and the setup button", async () => {
    snapshot = {
      ...base,
      platform: "linux",
      provider: "openshell",
      effective_provider: "",
      refused: "no session will start: OpenShell is not installed",
      providers: [
        { name: "direct", usable: true, why: "", state: "ready" },
        { name: "seatbelt", usable: false, why: "macOS only", state: "unavailable" },
        { name: "openshell", usable: false, why: "OpenShell is not installed", state: "unavailable" },
      ],
    };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-readiness");
    expect((screen.getByTestId("sandbox-switch") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("sandbox-provider-openshell").textContent).toBe("OpenShell (NVIDIA)");
    expect(screen.queryByTestId("sandbox-provider-select")).toBeNull(); // one provider on Linux: no dropdown
    await screen.findByTestId("sandbox-readiness-row-openshell");
    expect(screen.getByText("3 requirements missing")).toBeTruthy();
    expect(screen.getByTestId("sandbox-readiness-row-docker").getAttribute("data-state")).toBe("ok");
    expect(screen.getByTestId("sandbox-readiness-row-openshell").getAttribute("data-state")).toBe("pending");
    expect(screen.getByText("curl -LsSf https://example/install.sh | sh")).toBeTruthy(); // the command to run
    // Only the handed-over row shows its command with Copy; the image row is the app's to
    // do, and a note (the gateway row) gets neither.
    expect(screen.getAllByText("Run this in a terminal on this machine:").length).toBe(1);
    expect(screen.getAllByText("Copy").length).toBe(1);
    expect(screen.getByText("OpenShell is not installed")).toBeTruthy(); // the gateway row's note, plain
    expect(screen.queryByTestId("sandbox-readiness-command-gateway")).toBeNull();
    expect((screen.getByTestId("sandbox-readiness-docs-openshell") as HTMLAnchorElement).href).toBe("https://example/guide");
    expect((screen.getByTestId("sandbox-setup-start") as HTMLButtonElement).disabled).toBe(false);
  });

  it("running the setup: the job's rows, the download progress, and the handover verdict", async () => {
    snapshot = { ...base, platform: "linux", provider: "openshell", effective_provider: "openshell", providers: [{ name: "direct", usable: true, why: "", state: "ready" }, { name: "openshell", usable: true, why: "", state: "ready" }] };
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
    await screen.findByTestId("sandbox-readiness");
    await screen.findByTestId("sandbox-download-progress");
    expect(screen.getByText("Downloading the base image: 3 of 8 layers, 1 min 15 s elapsed")).toBeTruthy();
    expect(screen.getByTestId("sandbox-setup-cancel")).toBeTruthy();
    expect(screen.getByTestId("sandbox-readiness-row-image").getAttribute("data-state")).toBe("fixing");
    cleanup();

    // The app installing OpenShell itself: the installer's output is the progress.
    setupState = {
      status: "running",
      rows: [
        { ...readiness.steps[0], state: "ok" },
        { ...readiness.steps[1], command: "", fixable: true, state: "fixing" },
        { ...readiness.steps[2], state: "pending" },
        { ...readiness.steps[3], state: "pending" },
      ],
      progress: { layers_total: 0, layers_done: 0, last_line: "downloading v0.0.116 release checksums...", elapsed_s: 12 },
      error: "",
      elapsed_s: 12,
    };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-install-progress");
    expect(screen.getByTestId("sandbox-install-progress").textContent).toBe("Installing OpenShell… 12 s elapsed · downloading v0.0.116 release checksums...");
    expect(screen.queryByText("Copy")).toBeNull(); // nothing to hand over while it works
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
    await screen.findByTestId("sandbox-setup-needs_you");
    expect(screen.getByText(/run the command shown in a terminal on this machine, then click Check again/)).toBeTruthy();
    expect(screen.getByTestId("sandbox-readiness-row-openshell").getAttribute("data-state")).toBe("needs_you");
    expect(screen.getByTestId("sandbox-setup-start").textContent).toBe("Check again");
    fireEvent.click(screen.getByTestId("sandbox-setup-start"));
    await waitFor(() => expect(startSandboxSetup).toHaveBeenCalled());
  });

  it("on a Windows host the switch is disabled with the WSL hint", async () => {
    snapshot = { ...base, platform: "win32", providers: [{ name: "direct", usable: true, why: "", state: "ready" }, { name: "openshell", usable: false, why: "OpenShell is not installed", state: "unavailable" }] };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    expect((screen.getByTestId("sandbox-switch") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("sandbox-windows-hint").textContent).toMatch(/WSL Ubuntu/);
  });

  it("adds a credential through the editor and removes one (when the sandbox is on)", async () => {
    snapshot = { ...base, provider: "seatbelt", effective_provider: "seatbelt" };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-credentials-section");
    fireEvent.click(screen.getByTestId("sandbox-credential-add"));
    const editor = screen.getByTestId("sandbox-credential-editor");
    const inputs = editor.querySelectorAll("input, textarea");
    fireEvent.change(inputs[0], { target: { value: "npm token" } });
    fireEvent.change(inputs[1], { target: { value: "~/.npmrc" } });
    fireEvent.change(inputs[2], { target: { value: "registry.npmjs.org:443" } });
    fireEvent.click(screen.getByText("Done"));
    await waitFor(() =>
      expect(setSandboxSettings).toHaveBeenLastCalledWith({
        credentials: [
          ...base.credentials,
          { name: "npm-token", title: "npm token", path: "~/.npmrc", hosts: ["registry.npmjs.org:443"], does: undefined, enabled: true },
        ],
      }),
    );
    fireEvent.click(screen.getAllByText("Remove")[0]);
    await waitFor(() => {
      const calls = setSandboxSettings.mock.calls;
      const last = calls[calls.length - 1]?.[0];
      expect(last.credentials.map((c: any) => c.name)).toEqual(["gh", "npm-token"]);
    });
  });
});
