# Runs the local Hindsight memory service, tuned for Chinese.
# Used both by the desktop app and by scripts/start-hindsight.ps1.
#
# The caller passes the model API key as HINDSIGHT_API_LLM_API_KEY, and the app also passes the
# provider, model and base URL from its settings page; everything else is set here.
#
# With --exit-on-stdin-close, the service shuts down cleanly once stdin closes. That is how the
# app stops it: Windows has no SIGTERM, and killing the process outright leaves the embedded
# PostgreSQL running. A crashed app closes the pipe too, so the service never outlives it.

import os
import signal
import sys
import threading
from pathlib import Path

project = Path(__file__).resolve().parent.parent

# Hindsight listens on 0.0.0.0 by default and has no authentication, which would expose
# every memory to the local network.
os.environ["HINDSIGHT_API_HOST"] = "127.0.0.1"
os.environ.setdefault("HINDSIGHT_API_PORT", "8888")

# The app passes the model the user chose in its settings page. Started by hand
# (npm.cmd run hindsight) without them, it falls back to DeepSeek as before.
os.environ.setdefault("HINDSIGHT_API_LLM_PROVIDER", "deepseek")
os.environ.setdefault("HINDSIGHT_API_LLM_MODEL", "deepseek-v4-flash")
os.environ["HINDSIGHT_API_LLM_OUTPUT_LANGUAGE"] = "Chinese"

# The defaults are English-only. Changing the embedding model later means re-embedding
# every stored memory, so this has to be right from the first run.
os.environ["HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL"] = "BAAI/bge-m3"
os.environ["HINDSIGHT_API_RERANKER_LOCAL_MODEL"] = "BAAI/bge-reranker-v2-m3"

# The English dictionary would stem and drop words; it cannot segment Chinese either way.
os.environ["HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE"] = "simple"

# The first start downloads about 6 GB of models.
os.environ["HINDSIGHT_API_MODEL_INIT_TIMEOUT"] = "3600"
os.environ["HF_HOME"] = str(project / ".hindsight" / "models")

# Once both are downloaded, asking the Hub about updates on every start takes over a minute.
hub = project / ".hindsight" / "models" / "hub"
if all((hub / f"models--BAAI--{name}" / "snapshots").is_dir()
       for name in ("bge-m3", "bge-reranker-v2-m3")):
    os.environ.setdefault("HF_HUB_OFFLINE", "1")


def wait_for_stdin_to_close() -> None:
    if sys.platform != "win32":
        sys.stdin.buffer.read()
        return
    # A blocking read would hang startup: while it is pending, Windows also blocks every
    # other call on the handle, and something during startup queries stdin.
    import ctypes
    import msvcrt
    import time
    from ctypes import wintypes

    peek = ctypes.windll.kernel32.PeekNamedPipe
    peek.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p,
                     ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    handle = msvcrt.get_osfhandle(sys.stdin.fileno())
    available = wintypes.DWORD()
    while peek(handle, None, 0, None, ctypes.byref(available), None):
        time.sleep(0.5)


def exit_when_stdin_closes() -> None:
    wait_for_stdin_to_close()
    # Handled like Ctrl+C: uvicorn finishes its requests, then Hindsight stops PostgreSQL.
    signal.raise_signal(signal.SIGINT)


if "--exit-on-stdin-close" in sys.argv:
    sys.argv.remove("--exit-on-stdin-close")
    threading.Thread(target=exit_when_stdin_closes, daemon=True).start()

if not os.environ.get("HINDSIGHT_API_LLM_API_KEY"):
    sys.exit("HINDSIGHT_API_LLM_API_KEY is not set")


def stop_orphaned_database() -> None:
    """Hindsight only stops the PostgreSQL it started itself, so one left behind by a
    crash would otherwise keep running until the next reboot."""
    import socket

    import pg0

    port = int(os.environ["HINDSIGHT_API_PORT"])
    with socket.socket() as probe:
        probe.settimeout(1)
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            # A Hindsight may be using it. Starting fails on the port anyway, and says so.
            return
    if pg0.info("hindsight").running:
        print("Stopping PostgreSQL left running by an earlier Hindsight...", flush=True)
        pg0.stop("hindsight")


try:
    stop_orphaned_database()
except Exception as error:  # Cleanup only: never a reason not to start.
    print(f"Could not check for a leftover PostgreSQL: {error}", flush=True)

from hindsight_api.main import main  # noqa: E402  (the settings above must come first)

sys.argv[0] = "hindsight-api"
main()
