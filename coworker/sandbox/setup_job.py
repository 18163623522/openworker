"""The guided setup behind Settings ▸ Sandbox ▸ "Set up sandbox" (OPE-207).

One job per machine, on a worker thread. It walks `setup_cmd.steps()` top to bottom: a
step the app may fix itself (bind mounts, the config line, linger when no administrator
is needed, the image download) is fixed with its status shown; a step that needs an
administrator or an installer is handed over as a command to run, and the job stops there
until the user says "check again". The image download reports progress and can be
cancelled. The job never runs anything as root and never lowers protection: a failure
leaves the machine "not ready, here is what to do", and sessions stay refused.
"""

from __future__ import annotations

import sys
import threading
import time
from typing import Any, Callable, Optional

from . import setup_cmd


class SetupJob:
    # Step states, in the words the page shows.
    PENDING, FIXING, FIXED, OK, NEEDS_YOU, FAILED = "pending", "fixing", "fixed", "ok", "needs_you", "failed"

    def __init__(self, steps: Optional[Callable[[], list[setup_cmd.Step]]] = None) -> None:
        # Resolved at call time, not bound at import: tests swap `setup_cmd.steps` out.
        self._steps_fn = steps or (lambda: setup_cmd.steps())
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._cancel = threading.Event()
        self.status = "idle"  # idle | running | done | needs_you | failed | cancelled
        self.rows: list[dict[str, Any]] = []
        self.progress: Optional[dict[str, Any]] = None
        self.error = ""
        self.started_at = 0.0
        self.finished_at = 0.0

    # -- reading ----------------------------------------------------------------------
    def state(self) -> dict[str, Any]:
        with self._lock:
            return {
                "status": self.status,
                "rows": [dict(r) for r in self.rows],
                "progress": dict(self.progress) if self.progress else None,
                "error": self.error,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "elapsed_s": int((self.finished_at or time.time()) - self.started_at) if self.started_at else 0,
            }

    def _set_row(self, key: str, **changes: Any) -> None:
        with self._lock:
            for row in self.rows:
                if row["key"] == key:
                    row.update(changes)

    # -- control ----------------------------------------------------------------------
    def start(self) -> dict[str, Any]:
        """Start (or restart) the walk. Idempotent while running."""
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return self.state()
            self._cancel.clear()
            self.status, self.error, self.progress = "running", "", None
            self.started_at, self.finished_at = time.time(), 0.0
            self.rows = []
            self._thread = threading.Thread(target=self._run, name="sandbox-setup", daemon=True)
            self._thread.start()
        return self.state()

    def cancel(self) -> dict[str, Any]:
        self._cancel.set()
        return self.state()

    # -- the walk ---------------------------------------------------------------------
    def _run(self) -> None:
        try:
            self._walk()
        except Exception as exc:  # never leave the page without a verdict
            with self._lock:
                self.status, self.error = "failed", f"{type(exc).__name__}: {exc}"
        finally:
            with self._lock:
                self.finished_at = time.time()

    def _walk(self) -> None:
        steps = self._steps_fn()
        with self._lock:
            self.rows = [{**s.as_dict(), "state": self.OK if s.ok else self.PENDING} for s in steps]
        for step in steps:
            if self._cancel.is_set():
                with self._lock:
                    self.status = "cancelled"
                return
            if step.ok:
                continue
            if not step.fixable:
                # Needs an administrator or an installer: hand the command over and stop
                # here, so later steps (which may depend on this one) are not attempted.
                self._set_row(step.key, state=self.NEEDS_YOU)
                with self._lock:
                    self.status = "needs_you"
                return
            self._set_row(step.key, state=self.FIXING)
            problem = self._fix(step)
            if problem is None:
                self._set_row(step.key, state=self.FIXED, hint="")
                continue
            if step.key == "linger":
                # Refused without an administrator: not fatal, the command is shown; go on.
                self._set_row(step.key, state=self.NEEDS_YOU, hint=problem)
                continue
            self._set_row(step.key, state=self.FAILED, hint=problem)
            with self._lock:
                self.status = "cancelled" if self._cancel.is_set() else "failed"
                self.error = problem
            return
        # Everything fixable is fixed. Re-check, so the verdict is what `status` would say.
        final = self._steps_fn()
        with self._lock:
            done = {r["key"]: r for r in self.rows}
            for s in final:
                if s.key in done:
                    done[s.key]["ok"] = s.ok
                    if s.ok:
                        done[s.key]["state"] = self.OK if done[s.key]["state"] != self.FIXED else self.FIXED
                    elif done[s.key]["state"] not in (self.NEEDS_YOU, self.FAILED):
                        done[s.key]["state"] = self.FAILED
                        done[s.key]["hint"] = s.hint
                else:
                    self.rows.append({**s.as_dict(), "state": self.OK if s.ok else self.NEEDS_YOU})
            self.status = "done" if all(s.ok for s in final) else "needs_you"

    def _fix(self, step: setup_cmd.Step) -> Optional[str]:
        if step.key == "bind_mounts":
            return setup_cmd.apply_bind_mounts()
        if step.key == "config":
            setup_cmd.apply_config()
            return None
        if step.key == "linger":
            return setup_cmd.enable_linger() if sys.platform.startswith("linux") else None
        if step.key == "image":

            def on_progress(p: setup_cmd.PullProgress) -> None:
                with self._lock:
                    self.progress = {**p.as_dict(), "elapsed_s": int(time.time() - self.started_at)}

            return setup_cmd.pull_image(on_progress, self._cancel)
        return f"no automatic fix for {step.key}"


_job: Optional[SetupJob] = None
_job_lock = threading.Lock()


def job() -> SetupJob:
    """The machine's one setup job (the server is one machine)."""
    global _job
    with _job_lock:
        if _job is None:
            _job = SetupJob()
        return _job
