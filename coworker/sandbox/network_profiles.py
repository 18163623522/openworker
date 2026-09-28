"""Where an agent's commands may connect, in OUR words. Every provider renders these lists
into its own mechanism: OpenShell into `network_policies`, Seatbelt into the allow-list
proxy, Windows into the account it runs as. HTTPS (port 443) only.

`open` is the profile with no list at all: files stay isolated, the network is the
machine's own (ruling of 2026-09-25). It is the default on Windows for now.

`strict` (code hosts and registries, no search) was folded into `standard` (UX-053 v5): the
name is still accepted and means `standard`. A machine may add its own hosts to the list
(`sandbox_network_extra_hosts`, see `clean_host`).
"""

from __future__ import annotations

import sys

CODE_HOSTS = ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "gitlab.com"]
PACKAGE_REGISTRIES = ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org", "crates.io", "static.crates.io", "index.crates.io", "proxy.golang.org", "sum.golang.org"]
SEARCH_APIS = ["api.search.brave.com", "api.tavily.com", "html.duckduckgo.com", "duckduckgo.com"]

# name of the group -> hosts, per profile
PROFILES: dict[str, dict[str, list[str]]] = {
    # git, the package registries and the search APIs: enough to clone, install, push and search.
    "standard": {"code-hosts": CODE_HOSTS, "package-registries": PACKAGE_REGISTRIES, "search-apis": SEARCH_APIS},
    # any host: no proxy, no list. Files are still confined.
    "open": {},
}
OPEN = "open"
DEFAULT_PROFILE = "standard"
ALIASES = {"strict": "standard"}


def default_profile(platform: str = sys.platform) -> str:
    """The profile a machine uses until it chooses one: `open` on Windows, `standard` elsewhere."""
    return OPEN if platform == "win32" else DEFAULT_PROFILE


def is_open(profile: str) -> bool:
    return check(profile) == OPEN


def check(profile: str) -> str:
    """The profile's name, with an old name mapped to its current one."""
    profile = ALIASES.get(profile, profile)
    if profile not in PROFILES:
        raise ValueError(f"unknown network profile {profile!r} (known: {', '.join(sorted(PROFILES))})")
    return profile


def clean_host(item: str) -> str:
    """One entry of a machine's own host list as "host:port": a bare host means port 443,
    `*.example.com` any subdomain. Raises ValueError for anything else."""
    text = str(item or "").strip().lower().rstrip(".")
    if "://" in text:
        text = text.split("://", 1)[1].split("/", 1)[0]
    host, sep, port = text.rpartition(":")
    if not sep:
        host, port = text, "443"
    name = host[2:] if host.startswith("*.") else host
    labels = name.split(".")
    if not port.isdigit() or not 0 < int(port) < 65536 or len(labels) < 2 or not all(l and all(c.isalnum() or c == "-" for c in l) for l in labels):
        raise ValueError(f"not a host name: {item!r} (for example api.example.com:443)")
    return f"{host}:{int(port)}"


def clean_hosts(items) -> list[str]:
    """A machine's own host list, cleaned and without repeats; bad entries are dropped."""
    out: list[str] = []
    for item in items or []:
        try:
            host = clean_host(item)
        except ValueError:
            continue
        if host not in out:
            out.append(host)
    return out


def hosts(profile: str) -> list[str]:
    return [h for group in PROFILES[check(profile)].values() for h in group]
