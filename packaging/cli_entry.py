"""PyInstaller entry point for the Linux `openworker` program (build_linux.sh).

One program for the whole command line. Called as `openworker-server` (the bundle ships
that name as a link to the same file) it runs the server instead, as the pip install does.
"""

import os
import sys

if __name__ == "__main__":
    # Runner mode first, before anything else is imported (coworker/sandbox/launch.py).
    from coworker.sandbox.launch import maybe_run_runner

    maybe_run_runner(sys.argv[1:])
    if os.path.basename(sys.argv[0]) == "openworker-server":
        from coworker.server.run import main as server_main

        server_main()
    else:
        from coworker.cli import main

        main()
