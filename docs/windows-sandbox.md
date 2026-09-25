# The Windows sandbox — run an agent's commands as an account that cannot see your files

On Windows, OpenWorker can run a session's shell commands and file tools as a hidden local
account that Windows itself keeps out of your profile. There is nothing to install: one
setup step, run once with administrator rights, creates the account and its rules. After
that every command an agent runs, and every process those commands start, runs as that
account, in a job that ends with the session. The agent loop, your model keys and every
connector stay outside, in OpenWorker's own process, as you.

The wall is the operating system's own: file permissions, the Windows Firewall, and
Windows Filtering Platform filters, all written once at setup. Nothing is enforced by
environment variables alone.

```
 your machine
 ┌──────────────────────────────────────────┐      ┌───────────────────────────────────────────┐
 │ OpenWorker (desktop app or local server) │      │ the sandbox — one per agent session       │
 │ runs as YOU                              │      │ runs as a hidden local account            │
 │                                          │      │                                           │
 │  agent loop · approvals · audit          │ named│  tool runner ── PowerShell, file tools    │
 │  model keys · connectors · policy        │ pipe │  every process it starts inherits the     │
 │  tool definitions ───────────────────────────────►  account, the job and the rules          │
 │                                          │      │                                           │
 │  Windows provider                        │      │  session folders, same paths, rw / ro     │
 │   grants the folders, starts the runner, │      │  a private folder for temp and caches     │
 │   proves the wall before the session ────┼──┐   │  your profile: invisible                  │
 │                                          │  │   │  network: by account (below)              │
 │  allow-list proxy (closed mode only)     │  │   │  no keys, no OpenWorker state, no token   │
 └──────────────────────────────────────────┘  │   └───────────────────────────────────────────┘
                                               ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Windows — permissions on your folders (one entry per session folder), the profile boundary │
 │ (another account cannot read C:\Users\you), a firewall rule and loopback filters on the    │
 │ closed account, a job object that ends every sandboxed process with the session            │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
```

A few things are true by design:

- **Files: your profile is out of reach.** `C:\Users\<you>` — `.ssh`, `.aws`, documents,
  browser profiles, OpenWorker's own state and its API token — cannot be read or listed by
  the sandbox account. A command can read and write the session's writable folders and one
  private folder of its own, and read its read-only folders.
- **Network: you choose, and the choice is an account.** Open (the default on Windows) runs
  commands as an account with no network rules. Strict and Standard run them as a second
  account whose only way out is OpenWorker's allow-list proxy: the firewall blocks its
  outbound traffic and kernel filters close every local port to it except the proxy's.
- **Secrets are absent, not denied.** The sandbox account has a profile of its own with
  nothing in it. Credentials you share on purpose are copied in for the session and
  removed with it.
- **The wall is checked before the session starts.** OpenWorker verifies from inside that
  every session folder is reachable, that your profile is **not**, and in the closed mode
  that a local port outside the proxy's range is unreachable. If any check fails the
  session is refused rather than run open.
- **Every tool result says which mode produced it.** The enforcement level is recorded on
  each tool-call event and in the audit trail.
- **Nothing changes until you choose.** OpenWorker runs commands directly, as it always
  has, until you turn the sandbox on for the machine.

## Turn it on

Settings ▸ Sandbox ▸ "Windows sandbox", or in `config.toml`:

```toml
sandbox_provider = "windows"        # or "direct": commands run in the OpenWorker process
sandbox_network_profile = "open"    # the Windows default; or "strict", "standard"
```

The setting is per machine; a project's own config cannot change it.

The first time the Windows sandbox is selected, OpenWorker asks for administrator rights
and runs the one-time setup (the command line form is `openworker machine sandbox setup`).
If you skip it, or cannot elevate on this machine, sessions still run, in a weaker mode
that is labelled as such (see "Without setup" below), and you are asked again next time.

## What the setup does

One elevated PowerShell script, one prompt. It:

1. creates two hidden local accounts with random passwords nobody sees, `OWSandboxOpenNet`
   and `OWSandboxClosedNet`, hidden from the sign-in screen, with remote, network and
   service logon denied;
2. writes one Windows Firewall rule that blocks every outbound connection for the closed
   account;
3. writes four Windows Filtering Platform filters for the closed account: on loopback it may
   reach ports 47800–47899, where OpenWorker's proxy listens, and nothing else. Windows
   Firewall does not look at loopback traffic; these filters do;
4. stores the passwords in `C:\ProgramData\OpenWorker\sandbox\account.cred`, readable by
   you, administrators and the system only;
5. makes `C:\ProgramData\OpenWorker\sandbox\sandboxes`, where each session gets a private
   folder;
6. records everything it changed in `setup.json`, so that `openworker machine sandbox
   remove` undoes exactly that.

`openworker machine sandbox status` shows each of these and what is missing.

## The network modes

```
                          Settings ▸ Sandbox ▸ Network
                                      │
             ┌────────────────────────┴────────────────────────┐
             │                                                 │
           Open (default)                             Strict / Standard
             │                                                 │
             ▼                                                 ▼
   runs as OWSandboxOpenNet                          runs as OWSandboxClosedNet
   no firewall rule, no filters                      firewall: all outbound BLOCKED
   any host, any local port                          filters: loopback closed except
   files still confined                                       the proxy's port range
             │                                                 │
             ▼                                                 ▼
          internet                     ┌──────────────────────────────────────────┐
                                       │ OpenWorker's allow-list proxy (loopback) │
                                       │ CONNECT github.com:443      ✓            │
                                       │ CONNECT pypi.org:443        ✓            │
                                       │ CONNECT attacker.example:443 ✗ 403       │
                                       └──────────────────────────────────────────┘
                                                            │
                                                            ▼
                                                     only listed hosts
```

- **Open** — any host. Nothing to configure. The files are still the wall. This is the
  default on Windows.
- **Strict** — GitHub, GitLab and the package registries (PyPI, npm, crates.io, the Go
  proxy), through the proxy. A program that ignores the proxy variables has no network at
  all, because the account's direct traffic is blocked in the kernel.
- **Standard** — Strict plus the search APIs.

Credentials shared on purpose (below) add the hosts their tools need.

Choosing a mode never touches the firewall. The rules are written once at setup; OpenWorker
picks the account. In the closed mode a sandbox can still **listen** on a local port (a dev
server your browser can open); it cannot **connect** to one, other than the proxy.

## What a command can reach

Read and write:

- the session's writable folders (one permission entry each, removed when the session ends);
- one private folder under `C:\ProgramData\OpenWorker\sandbox\sandboxes`, which holds the
  runner, temporary files and the tool caches.

Read only:

- the session's read-only folders;
- Windows itself and machine-wide installs (`C:\Windows`, `C:\Program Files`, and what any
  local account may read);
- folders **outside your profile**, such as `D:\work` or `C:\src`. Windows lets every local
  account read those by default, and so can the sandbox. Keep what the agent must not see
  under your profile.

Not readable:

- your profile, `C:\Users\<you>`, and every other account's profile. This includes
  developer tools installed per user (nvm for Windows, pyenv-win, Scoop, npm's global
  folder, Cargo). A read-only list of those, with switches in Settings, is the next
  change; until then, install the tools the agent needs machine-wide, or grant the folder
  to the session.

## Sharing a credential on purpose

By default the sandbox has none of your logins, which also means `git push` over SSH has
nothing to push with. Settings ▸ Sandbox lists files you can share, all off by default:

| Entry | Copied from | Lets the agent | Hosts added to the allow list |
|---|---|---|---|
| `ssh` | `~/.ssh` | push and pull over SSH, and log in to servers, as you | `github.com:22`, `gitlab.com:22` |
| `gh` | `~/.config/gh` | use `gh` as you: pull requests, issues, releases | `api.github.com:443`, `github.com:443` |
| `aws` | `~/.aws` | use `aws` with your profiles | `*.amazonaws.com:443` |
| `kube` | `~/.kube` | use `kubectl` with your clusters | the servers named in the kubeconfig |

A copy is written into the sandbox account's own profile by the runner, so that Windows
OpenSSH accepts the key's permissions, and removed when the runner leaves. In the closed
mode `ssh` reaches its hosts through the proxy; OpenWorker ships the tunnel command, since
Windows has no `nc`. The agent is told what it can do ("you can push over SSH as the
user"), never where a credential is kept. Short-lived cloud roles (AWS first) and an
encrypted wallet for keys that cannot be short-lived are the next additions; see the
design notes.

## Without setup

If setup has not run, the Windows sandbox still limits writes: the runner starts as you,
under a write-restricted token, and can write only where the session's folders and its
private folder carry an entry for it. Reads and the network are yours. OpenWorker labels
this mode `partial` in every tool result and in Settings, and asks for setup again at the
next start. Shared SSH keys cannot be used in this mode (Windows OpenSSH does not finish
under a write-restricted token); the agent is told.

## Every agent, one account

All sessions run under the same account (one per network mode). The goal is to keep your
data away from the agents, not to keep agents away from each other: a sandbox can read
another sandbox's private folder, including credentials copied in for it. Cloud roles that
expire on their own limit what that is worth.

## Known limits

- The `open` mode is open: any host, any local port, including services on this machine.
- `curl.exe` needs `--ssl-revoke-best-effort` in the closed mode, because Windows' own TLS
  checks certificate revocation over plain HTTP, which the firewall blocks. Git, Python and
  Node use OpenSSL and are unaffected. PowerShell 5's `Invoke-WebRequest` ignores the proxy
  variables and sees no network in the closed mode; `curl.exe` follows them.
- OpenShell is not available on Windows today (its Windows driver is a preview of
  Microsoft's execution containers). The Windows sandbox is OpenWorker's own.

## How it compares

| | Windows sandbox | macOS sandbox | OpenShell |
|---|---|---|---|
| Mechanism | a second local account, permissions, firewall and kernel filters | the Seatbelt profile built into macOS | a Linux container with Landlock and seccomp |
| Install | one administrator prompt | nothing | OpenShell and Docker |
| Files | session folders; profile invisible; outside-profile folders readable | session folders; home invisible | session folders; nothing else |
| Network | open (default), or the allow list through the proxy | the allow list through the proxy, or open | the allow list in the policy, or open |
| Default | open | strict | strict |
