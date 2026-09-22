"""`windows`: the tool runner on Windows, confined by Windows' own account boundary.

Same runner, same protocol. Two modes, chosen by whether `openworker machine sandbox
setup` has run (windows_setup.py):

FULL (after setup): the daemon is logged on as the hidden local account
`OpenWorkerSandbox` (CreateProcessWithLogonW, the secondary logon service; no privilege
needed). Windows keeps that account out of the person's profile: `.ssh`, `.aws`, documents,
OpenWorker's own state and keys cannot be read. The session's folders get one inheritable
entry each for the account (Modify for writable, Read for read-only); the sandbox's private
folder lives under `C:\\ProgramData\\OpenWorker\\sandbox\\sandboxes`. A firewall rule from
setup blocks every outbound connection for the account, so the internet is reachable only
through our allow-list proxy on loopback. Windows Firewall does not filter loopback, so
other local ports stay reachable until the WFP filters are built; `describe()` says so and
reports `partial` until then. Folders outside the profile (`C:\\work`) are readable by any
local account by default (spike finding A); that too is stated, not hidden.

SAME-USER (no setup): the daemon runs as the current user under a write-restricted token
whose restricting SID is a made-up session SID; writes are allowed only where that SID has
an entry (the session's writable folders, the private folder). Reads and the network are
the user's own. Everyone-writable places (the drive root's "new folder", `C:\\Users\\Public`,
`C:\\Windows\\Temp`) stay writable, as in every write-restricted sandbox.

In both modes the entries are removed at close, every process the daemon starts inherits
the confinement, and the daemon lives in a job object that ends with the sandbox.

Learned on the VM (2026-09-22): the restricting list must hold the LOGON SID or no process
starts at all (0xC0000142); the token's default DACL must name the session SID or the
process cannot start children (error 5); a console is fine once both hold; a process logged
on as another account needs a desktop of ours that names it, or its PowerShell prints
nothing.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Optional, Sequence

from .. import credentials as creds
from .. import netproxy, network_profiles
from ..bundle import build_runner_zipapp
from ..launch import runner_command, runner_dir, serve_arguments, spawn_kwargs, wait_for_runner
from ..runner import winpipe
from ..transport import PipeTransport, Transport
from . import windows_setup
from .seatbelt import _CACHE_VARIABLES, clean_environment

FULL, PARTIAL = "full", "partial"
_EVERYONE_WRITABLE = ("the drive root (new folders only)", r"C:\Users\Public", r"C:\Windows\Temp")
_PARTIAL_REASON = (
    "Windows write-restricted token: writes limited to the session's folders; reads and the network are NOT limited"
    " (run `openworker machine sandbox setup` for the full sandbox)"
)
_FULL_REASON = (
    "Windows sandbox account: the user's profile (keys, documents, OpenWorker's state) is out of reach; files limited to"
    " the session's folders plus what any local account may read outside profiles; outbound network blocked except the"
    " allow-list proxy; other local ports still reachable (loopback filters not built yet)"
)


class WindowsUnavailable(RuntimeError):
    """The Windows sandbox cannot be used here. The message says why."""


def preflight() -> None:
    if sys.platform != "win32":
        raise WindowsUnavailable("The Windows sandbox exists only on Windows.")
    from .. import winsec

    try:
        winsec.current_user_sid()
        winsec.logon_sid()
    except OSError as exc:
        raise WindowsUnavailable(f"cannot read this process's token: {exc}") from None


def mode() -> str:
    """`full` when setup has run and this user can read the account's credential."""
    return FULL if windows_setup.account() is not None else PARTIAL


class WindowsProvider:
    name = "windows"

    def __init__(
        self,
        *,
        roots: Sequence[dict[str, Any]],
        cwd: str | Path,
        profile: str = network_profiles.DEFAULT_PROFILE,
        network: bool = True,
        runner_path: Optional[Path] = None,
        relay_silence_seconds: Optional[float] = None,
        credentials: Sequence[creds.Grant] = (),
        force_mode: Optional[str] = None,
    ) -> None:
        """`credentials`: the grants (credentials.granted) to copy into the sandbox.
        `force_mode`: tests only; `partial` on a machine where setup has run."""
        from .. import winsec

        self.roots = _clean_roots(roots)
        self.grants = list(credentials)
        self.copied: Optional[creds.CopiedCredentials] = None
        self.cwd = os.path.realpath(str(cwd))
        self.profile = network_profiles.check(profile)
        self.network = network
        self._runner = Path(runner_path) if runner_path is not None else build_runner_zipapp()
        self._relay_silence = relay_silence_seconds
        self.sandbox = f"sb-{uuid.uuid4().hex[:12]}"
        self.mode = force_mode or mode()
        self._account = windows_setup.account() if self.mode == FULL else None
        if self.mode == FULL and self._account is None:
            raise WindowsUnavailable("the full Windows sandbox needs `openworker machine sandbox setup` first")
        # Who the entries and the pipe name: the hidden account, or the made-up session SID.
        self.session_sid = self._account[1] if self._account else winsec.session_sid()
        if self.mode == FULL:
            windows_setup.SANDBOXES.mkdir(parents=True, exist_ok=True)
            self._dir = tempfile.mkdtemp(prefix="owr-", dir=str(windows_setup.SANDBOXES))
            self.socket_path = winpipe.pipe_name(os.path.basename(self._dir))
        else:
            self._dir, self.socket_path = runner_dir()
        self._daemon: Any = None
        self._proxy: Optional[netproxy.AllowListProxy] = None
        self._token: Any = None
        self._desktop: Any = None
        self._granted: list[tuple[str, str]] = []  # (folder, "write" | "read") entries that exist right now

    # -- what it is ---------------------------------------------------------------------
    def describe(self) -> dict[str, Any]:
        if self.mode == FULL:
            network = f"the '{self.profile}' profile through the allow-list proxy; the rest is blocked by the firewall" if self.network else "blocked"
            reason = f"{_FULL_REASON}. Network: {network}"
        else:
            network = f"advisory: the '{self.profile}' profile through the proxy variables only" if self.network else "the user's own"
            reason = f"{_PARTIAL_REASON}. Network: {network}. Still writable by anyone: {', '.join(_EVERYONE_WRITABLE)}"
        return {
            "provider": self.name,
            "sandbox": self.sandbox,
            "enforcement": PARTIAL,  # `full` once the loopback filters exist; the mode says how far it goes
            "mode": self.mode,
            "reason": reason,
            "credentials": self.copied.describe() if self.copied is not None else [],
        }

    # -- start ------------------------------------------------------------------------
    def create(self) -> None:
        try:
            self._create()
        except BaseException:
            self.destroy()  # nothing of a failed sandbox stays behind (entries, folder, token)
            raise

    def _create(self) -> None:
        preflight()
        from .. import winsec

        if self.network:
            self._proxy = netproxy.shared(self.profile)
        for root in self.roots:
            self._grant(root["path"], "write" if root["writable"] else "read")
        self._grant(self._dir, "write")
        self._desktop = winsec.Desktop(self.session_sid)
        log = os.path.join(self._dir, "daemon.log")
        if self.mode == FULL:
            assert self._account is not None
            name, sid, password = self._account
            # The runner file lives in the user's state folder, which the account cannot see.
            runner = Path(self._dir) / self._runner.name
            shutil.copy2(self._runner, runner)
            env_args = [arg for k, v in self._environment(full=True).items() for arg in ("--env", f"{k}={v}")]
            serve = serve_arguments(self.socket_path, self._dir, also_sids=[sid])
            argv = [*runner_command(runner), "serve", *serve, *env_args, "--cwd", self.cwd, "--exit-with-parent"]
            self._daemon = winsec.spawn_as_account(argv, account=name, password=password, desktop=self._desktop, cwd=self.cwd, stderr_path=log)
        else:
            self._token = winsec.RestrictedToken(self.session_sid)
            serve = serve_arguments(self.socket_path, self._dir, also_sids=[self.session_sid])
            argv = [*runner_command(self._runner), "serve", *serve, "--cwd", self.cwd, "--exit-with-parent"]
            self._daemon = winsec.spawn(argv, token=self._token, desktop=self._desktop, cwd=self.cwd, env=self._environment(full=False), stderr_path=log)
        try:
            wait_for_runner(self.socket_path, self._daemon)
        except RuntimeError as exc:
            said = Path(log).read_text(errors="replace").strip() if os.path.exists(log) else ""
            raise WindowsUnavailable(f"the sandboxed tool runner did not start: {exc} {said[-400:]}".strip()) from None

    def _environment(self, *, full: bool) -> dict[str, str]:
        """Same-user mode: the server's environment without secrets, temp and caches moved
        into the private folder. Full mode: only what the account's own environment lacks
        (the proxy), because the account has a profile, temp and caches of its own."""
        env: dict[str, str] = {} if full else clean_environment()
        if not full:
            temp = os.path.join(self._dir, "tmp")
            os.makedirs(temp, exist_ok=True)
            env["TEMP"] = env["TMP"] = temp
            for name, folder in _CACHE_VARIABLES.items():
                env[name] = os.path.join(self._dir, "cache", folder)
        if self._proxy is not None:
            env.update(netproxy.environment(self._proxy))
        return env

    def open_runner(self) -> Transport:
        argv = [*runner_command(self._runner), "attach", "--socket", self.socket_path]
        if self._relay_silence is not None:
            argv += ["--silence-seconds", str(self._relay_silence)]
        return PipeTransport(
            subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, **spawn_kwargs())
        )

    def verify(self, client: Any) -> None:
        """Every folder is reachable inside, and the wall is really up. Full mode: the
        user's profile cannot be listed. Same-user mode: a file cannot be written into it."""
        from ..runner.protocol import RunnerError

        for root in self.roots:
            client.call("fs.list", {"path": root["path"], "limit": 1}, timeout=15)
        home = os.path.realpath(os.path.expanduser("~"))
        if any(home == r["path"] or home.startswith(r["path"] + os.sep) for r in self.roots):
            return  # the user granted the home folder itself; nothing to prove
        if self.mode == FULL:
            try:
                client.call("fs.list", {"path": home, "limit": 1}, timeout=15)
            except RunnerError:
                return
            raise WindowsUnavailable("the sandbox did not take effect: the home folder can be listed from inside")
        probe = os.path.join(home, f"owr-verify-{uuid.uuid4().hex[:8]}.txt")
        try:
            client.call("fs.write", {"path": probe, "text": "probe\n"}, timeout=15)
        except RunnerError:
            return
        try:
            os.remove(probe)
        except OSError:
            pass
        raise WindowsUnavailable("the sandbox did not take effect: a file could be written into the home folder from inside")

    # -- the entries ----------------------------------------------------------------------
    def _grant(self, folder: str, kind: str) -> None:
        from .. import winsec

        (winsec.grant_write if kind == "write" else winsec.grant_read)(folder, self.session_sid)
        self._granted.append((folder, kind))

    def _revoke(self, folder: str, kind: str) -> None:
        from .. import winsec

        try:
            winsec.revoke(folder, self.session_sid)
        except OSError:
            pass  # a folder that is gone has no entry to remove
        self._granted.remove((folder, kind))

    # -- changes ------------------------------------------------------------------------
    restarts_on_regrant = False

    def regrant(self, roots: Sequence[dict[str, Any]]) -> None:
        """The session's folders changed. The confinement is per sandbox, not per folder,
        so the entries move and the daemon stays: a new folder is usable at once, a removed
        one is closed at once."""
        self.roots = _clean_roots(roots)
        wanted = [(r["path"], "write" if r["writable"] else "read") for r in self.roots] + [(self._dir, "write")]
        for entry in list(self._granted):
            if entry not in wanted:
                self._revoke(*entry)
        for entry in wanted:
            if entry not in self._granted:
                self._grant(*entry)

    def restart_daemon(self) -> None:
        """Tests only: what a sandbox restart looks like from the client's side."""
        self._stop_daemon()
        for entry in list(self._granted):
            self._revoke(*entry)
        if self._desktop is not None:
            self._desktop.close()
        self._create()

    # -- stop ---------------------------------------------------------------------------
    def _stop_daemon(self) -> None:
        daemon, self._daemon = self._daemon, None
        if daemon is None:
            return
        if daemon.poll() is None:
            daemon.terminate()
            try:
                daemon.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        daemon.close()

    def destroy(self) -> None:
        self._stop_daemon()
        for entry in list(self._granted):
            self._revoke(*entry)
        for thing in (self._token, self._desktop):
            if thing is not None:
                thing.close()
        self._token = self._desktop = None
        # The job's last processes (cmd holding the log) may still be going; give them a moment.
        for _ in range(20):
            shutil.rmtree(self._dir, ignore_errors=True)
            if not os.path.exists(self._dir):
                break
            time.sleep(0.1)


def _clean_roots(roots: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"path": os.path.realpath(r["path"]), "writable": bool(r.get("writable"))} for r in roots]
