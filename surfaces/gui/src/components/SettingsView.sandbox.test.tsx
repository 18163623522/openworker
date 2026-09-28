// Settings ▸ Sandbox (UX-051 A, UX-053 v3): one switch first; on reveals the type; a ready
// type reveals its options. The page shows what the machine reports and writes back the
// changes: provider, network profile, credential list, toolchain list. On Windows, choosing
// the sandbox opens the setup dialog, which calls the setup route.
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
  network_profile: "strict",
  network_profiles: [
    { name: "strict", hosts: ["github.com"] },
    { name: "standard", hosts: ["github.com", "api.tavily.com"] },
    { name: "open", hosts: [] },
  ],
  credentials: [
    { name: "ssh", path: "~/.ssh", hosts: ["github.com:22"], label: "credential", enabled: false, kind: "folder", shipped: true },
    { name: "gh", path: "~/.config/gh", hosts: ["api.github.com:443"], label: "credential", enabled: true, kind: "", shipped: true },
    { name: "aws", path: "~/.aws/config", hosts: ["*.amazonaws.com:443"], label: "configuration", enabled: false, kind: "file", shipped: true },
  ],
  toolchains: [
    { name: "nvm", title: "nvm (Node versions)", path: "~/.nvm", enabled: true, exists: true, shipped: true },
    { name: "mytools", title: "My tools", path: "~/tools", enabled: true, exists: false, shipped: false },
  ],
  config_path: "/Users/sam/.config/coworker/config.toml",
};
let snapshot: any = { ...base };

const setSandboxSettings = vi.fn(async (patch: any) => ({ ok: true, ...snapshot, ...patch }));
const runSandboxSetup = vi.fn(async () => ({ ok: true, checked: "the wall held", ...snapshot, provider: "windows", windows_setup: { ...snapshot.windows_setup, state: "ready", set_up_at: "2026-09-28T10:00:00Z" } }));
const runSandboxRemove = vi.fn(async () => ({ ok: true, ...snapshot, provider: "direct", windows_setup: { ...snapshot.windows_setup, state: "not_set_up", set_up_at: "" } }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getSandboxSettings: vi.fn(async () => snapshot),
    setSandboxSettings: (patch: any) => setSandboxSettings(patch),
    runSandboxSetup: () => runSandboxSetup(),
    runSandboxRemove: () => runSandboxRemove(),
    getMachines: vi.fn(async () => ({ machines: [] })),
    getCloudMachines: vi.fn(async () => ({ machines: [] })),
    getCloudConnections: vi.fn(async () => []),
    getConnectors: vi.fn(async () => []),
    getCloudStatus: vi.fn(async () => ({ signed_in: false })),
    isCloudMode: () => false,
  };
});

import { SettingsView } from "./SettingsView";

const stripDisplay = (rows: any[]) => rows.map(({ kind: _k, shipped: _s, ...row }) => row);

describe("Settings ▸ Sandbox", () => {
  beforeEach(() => {
    snapshot = { ...base };
    setSandboxSettings.mockClear();
    runSandboxSetup.mockClear();
    runSandboxRemove.mockClear();
  });
  afterEach(cleanup);

  it("off: one switch and nothing else; on reveals the type card only", async () => {
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("sandbox-switch-status").textContent).toBe("off");
    expect(screen.queryByTestId("sandbox-provider-seatbelt")).toBeNull();
    expect(screen.queryByTestId("sandbox-network-strict")).toBeNull();
    expect(screen.queryByTestId("sandbox-card-files")).toBeNull();
    fireEvent.click(sw);
    expect(screen.getByTestId("sandbox-switch-status").textContent).toBe("choose a type");
    expect((screen.getByTestId("sandbox-provider-openshell") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("sandbox-provider-openshell-why").textContent).toBe("OpenShell is not installed");
    expect(screen.queryByTestId("sandbox-network-strict")).toBeNull(); // no type is ready yet
    expect(setSandboxSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("sandbox-provider-seatbelt"));
    await waitFor(() => expect(setSandboxSettings).toHaveBeenCalledWith({ provider: "seatbelt" }));
  });

  it("a ready type shows its options; switching off writes direct", async () => {
    snapshot = { ...base, provider: "seatbelt", effective_provider: "seatbelt" };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    expect(screen.getByTestId("sandbox-switch-status").textContent).toBe("on · macOS sandbox");
    expect((screen.getByTestId("sandbox-network-strict") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId("sandbox-network-standard"));
    await waitFor(() => expect(setSandboxSettings).toHaveBeenCalledWith({ network_profile: "standard" }));
    // the files card is one line until opened; its chips name the entries
    expect(screen.getByTestId("sandbox-card-files")).toBeTruthy();
    expect(screen.queryByTestId("sandbox-card-files-body")).toBeNull();
    expect(within(screen.getByTestId("sandbox-card-files-toggle")).getByText("SSH keys")).toBeTruthy();
    expect(screen.getByTestId("sandbox-tools-summary").textContent).toContain("2 of 2 on");
    expect(screen.getByText(/config\.toml/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(setSandboxSettings).toHaveBeenLastCalledWith({ provider: "direct" }));
  });

  it("the files card: switch, kind and label tags, add through the editor with a label, remove", async () => {
    snapshot = { ...base, provider: "seatbelt", effective_provider: "seatbelt" };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    fireEvent.click(screen.getByTestId("sandbox-card-files-toggle"));
    const body = screen.getByTestId("sandbox-card-files-body");
    expect(screen.getByTestId("sandbox-credential-ssh-kind").textContent).toBe("folder");
    expect(screen.getByTestId("sandbox-credential-aws-kind").textContent).toBe("file");
    expect(within(screen.getByTestId("sandbox-credential-gh")).getByText("not on this machine")).toBeTruthy();
    expect(within(screen.getByTestId("sandbox-credential-aws")).getByText("configuration")).toBeTruthy();
    expect(within(body).getByText(/Also allows github.com:22/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("SSH keys"));
    await waitFor(() =>
      expect(setSandboxSettings).toHaveBeenLastCalledWith({
        credentials: stripDisplay([{ ...base.credentials[0], enabled: true }, base.credentials[1], base.credentials[2]]),
      }),
    );
    fireEvent.click(screen.getByTestId("sandbox-credential-add"));
    const editor = screen.getByTestId("sandbox-credential-editor");
    const inputs = editor.querySelectorAll("input[type=text], input:not([type]), textarea");
    fireEvent.change(inputs[0], { target: { value: "npm token" } });
    fireEvent.change(inputs[1], { target: { value: "~/.npmrc" } });
    fireEvent.click(screen.getByTestId("sandbox-credential-label-configuration"));
    fireEvent.change(inputs[2], { target: { value: "registry.npmjs.org:443" } });
    fireEvent.click(within(editor).getByText("Done"));
    await waitFor(() =>
      expect(setSandboxSettings).toHaveBeenLastCalledWith({
        credentials: [
          ...stripDisplay([{ ...base.credentials[0], enabled: true }, base.credentials[1], base.credentials[2]]),
          { name: "npm-token", title: "npm token", path: "~/.npmrc", hosts: ["registry.npmjs.org:443"], does: undefined, label: "configuration", enabled: true },
        ],
      }),
    );
    fireEvent.click(within(screen.getByTestId("sandbox-credential-ssh")).getByText("Remove"));
    await waitFor(() => {
      const calls = setSandboxSettings.mock.calls;
      const last = calls[calls.length - 1]?.[0];
      expect(last.credentials.map((c: any) => c.name)).toEqual(["gh", "aws", "npm-token"]);
    });
  });

  it("the tools card: switch a folder off and add one, without the display-only fields", async () => {
    snapshot = { ...base, provider: "seatbelt", effective_provider: "seatbelt" };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    fireEvent.click(screen.getByTestId("sandbox-card-tools-toggle"));
    expect(screen.getByText(/not on this machine/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("nvm (Node versions)"));
    await waitFor(() =>
      expect(setSandboxSettings).toHaveBeenLastCalledWith({
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
    fireEvent.click(within(editor).getByText("Done"));
    await waitFor(() => {
      const calls = setSandboxSettings.mock.calls;
      const last = calls[calls.length - 1]?.[0];
      expect(last.toolchains[last.toolchains.length - 1]).toEqual({ name: "jdks", title: "JDKs", path: "~/.jdks", enabled: true });
    });
  });

  it("Windows: choosing the sandbox opens the setup dialog; Set up now calls the route; Done shows the options", async () => {
    snapshot = {
      ...base,
      platform: "win32",
      providers: [
        { name: "direct", usable: true, why: "" },
        { name: "windows", usable: false, why: "the one-time setup has not run on this PC" },
        { name: "openshell", usable: false, why: "OpenShell is not available on Windows" },
      ],
      windows_setup: { state: "not_set_up", set_up_at: "", problem: "not run", can_elevate: true, command: "openworker machine sandbox setup" },
      network_profile: "open",
    };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByText("one-time setup")).toBeTruthy();
    expect(screen.queryByTestId("sandbox-provider-windows-why")).toBeNull(); // an administrator sees no warning
    fireEvent.click(screen.getByTestId("sandbox-provider-windows"));
    const dialog = screen.getByTestId("sandbox-setup-dialog");
    expect(within(dialog).getByText("Set up the Windows sandbox")).toBeTruthy();
    expect(setSandboxSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("sandbox-setup-now"));
    await waitFor(() => expect(runSandboxSetup).toHaveBeenCalled());
    await screen.findByTestId("sandbox-setup-done-box");
    expect(screen.getByTestId("sandbox-setup-done-box").textContent).toContain("the wall held");
    fireEvent.click(screen.getByTestId("sandbox-setup-done"));
    expect(screen.queryByTestId("sandbox-setup-dialog")).toBeNull();
    expect(screen.getByTestId("sandbox-switch-status").textContent).toBe("on · Windows sandbox");
    expect(screen.getByTestId("sandbox-windows-setup-line").textContent).toContain("Set up on");
    // Open is first and chosen on Windows; the options are visible now
    const radios = document.querySelectorAll('input[name="sandbox-network"]');
    expect(radios[0].getAttribute("data-testid")).toBe("sandbox-network-open");
    expect((screen.getByTestId("sandbox-network-open") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("sandbox-card-files")).toBeTruthy();
    expect(screen.getByTestId("sandbox-card-tools")).toBeTruthy();
    // Remove setup: confirm, the route runs, the page collapses
    fireEvent.click(screen.getByTestId("sandbox-remove-setup"));
    fireEvent.click(screen.getByTestId("sandbox-remove-confirm"));
    await waitFor(() => expect(runSandboxRemove).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("sandbox-switch-status").textContent).toBe("off"));
    expect(screen.queryByTestId("sandbox-card-files")).toBeNull();
  });

  it("Windows, not an administrator: the row is disabled with the command; Not now turns the switch off", async () => {
    snapshot = {
      ...base,
      platform: "win32",
      providers: [
        { name: "direct", usable: true, why: "" },
        { name: "windows", usable: false, why: "the one-time setup has not run on this PC" },
        { name: "openshell", usable: false, why: "OpenShell is not available on Windows" },
      ],
      windows_setup: { state: "not_set_up", set_up_at: "", problem: "not run", can_elevate: false, command: "openworker machine sandbox setup" },
    };
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByTestId("sandbox-switch-status").textContent).toBe("no type can be used yet");
    expect((screen.getByTestId("sandbox-provider-windows") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("sandbox-provider-windows-why").textContent).toContain("openworker machine sandbox setup");
    expect(screen.getByText("needs an administrator")).toBeTruthy();
    // an administrator, but "Not now"
    snapshot = { ...snapshot, windows_setup: { ...snapshot.windows_setup, can_elevate: true } };
    cleanup();
    render(<SettingsView initialTab="sandbox" />);
    await screen.findByTestId("sandbox-section");
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByTestId("sandbox-provider-windows"));
    fireEvent.click(screen.getByTestId("sandbox-setup-not-now"));
    expect(screen.queryByTestId("sandbox-setup-dialog")).toBeNull();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(runSandboxSetup).not.toHaveBeenCalled();
  });
});
