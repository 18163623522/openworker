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
    { key: "docker", what: "Docker is installed and this user can use it", ok: true, hint: "", fixable: false },
    { key: "openshell", what: "OpenShell 0.0.116 is installed", ok: false, hint: "curl -LsSf https://example/install.sh | sh", fixable: false },
    { key: "image", what: "the sandbox base image is downloaded (about 5 GB, one time)", ok: false, hint: "docker pull img", fixable: true },
  ],
};
let setupState: any = { status: "idle", rows: [], progress: null, error: "", elapsed_s: 0 };

// Like the backend: each save returns the whole (updated) snapshot.
const setSandboxSettings = vi.fn(async (patch: any) => {
  snapshot = { ...snapshot, ...patch };
  return { ok: true, ...snapshot };
});
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
    expect(screen.getByText(/Off: commands run as you/)).toBeTruthy();
    expect(screen.queryByTestId("sandbox-network-section")).toBeNull();
    expect(screen.queryByTestId("sandbox-credentials-section")).toBeNull();
    expect(screen.queryByTestId("sandbox-readiness")).toBeNull();
    expect(screen.queryByText("ready")).toBeNull(); // no status word for "no sandbox"
    expect(screen.getByText(/config\.toml/)).toBeTruthy();
  });

  it("switching on picks the provider that needs no setup on a Mac, and off clears the key", async () => {
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    fireEvent.click(screen.getByTestId("sandbox-switch"));
    await waitFor(() => expect(setSandboxSettings).toHaveBeenCalledWith({ provider: "seatbelt" }));
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
    expect(screen.getByText("2 requirements missing")).toBeTruthy();
    expect(screen.getByTestId("sandbox-readiness-row-docker").getAttribute("data-state")).toBe("ok");
    expect(screen.getByTestId("sandbox-readiness-row-openshell").getAttribute("data-state")).toBe("pending");
    expect(screen.getByText("curl -LsSf https://example/install.sh | sh")).toBeTruthy(); // the command to run
    expect(screen.getAllByText("Copy").length).toBe(2);
    expect((screen.getByTestId("sandbox-setup-start") as HTMLButtonElement).disabled).toBe(false);
  });

  it("running the setup: the job's rows, the download progress, and the handover verdict", async () => {
    snapshot = { ...base, platform: "linux", provider: "openshell", effective_provider: "openshell", providers: [{ name: "direct", usable: true, why: "", state: "ready" }, { name: "openshell", usable: true, why: "", state: "ready" }] };
    setupState = {
      status: "running",
      rows: [
        { ...readiness.steps[0], state: "ok" },
        { ...readiness.steps[1], ok: true, state: "ok" },
        { ...readiness.steps[2], state: "fixing" },
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

    setupState = {
      status: "needs_you",
      rows: [
        { ...readiness.steps[0], state: "ok" },
        { ...readiness.steps[1], state: "needs_you" },
        { ...readiness.steps[2], state: "pending" },
      ],
      progress: null,
      error: "",
      elapsed_s: 3,
    };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-setup-needs_you");
    expect(screen.getByText(/Run the command shown, then check again/)).toBeTruthy();
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
