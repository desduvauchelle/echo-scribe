#!/usr/bin/env python3
"""Native computer-use acceptance test. No browser DOM, CDP, or search-URL shortcut.

Launches a disposable Chrome profile, then drives the address bar and Google search
through the native helper. Each mutation uses a fresh observation. Results are
verified from the actual app's Accessibility tree and saved with a window screenshot.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "src-tauri/computer-use/.build/debug/tucky-computer-use"
CHROME = Path("/Applications/Google Chrome.app")


class ToolFailure(RuntimeError):
    pass


class Session:
    def __init__(self, pid, output, helper=HELPER):
        self.events = []
        self.state = None
        self.log = (output / "helper.log").open("w")
        self.process = subprocess.Popen(
            [str(helper), "--pid", str(pid), "--allow-actions"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log,
            text=True, bufsize=1,
        )

    def call(self, tool, **arguments):
        request = {"id": str(len(self.events) + 1), "tool": tool, **arguments}
        self.process.stdin.write(json.dumps(request) + "\n")
        self.process.stdin.flush()
        if not select.select([self.process.stdout], [], [], 15)[0]:
            self.process.terminate()
            raise ToolFailure(f"{tool}: helper timed out; stopped without retrying the action")
        line = self.process.stdout.readline()
        if not line:
            raise ToolFailure(f"{tool}: helper exited; see helper.log")
        response = json.loads(line)
        if response.get("id") != request["id"]:
            raise ToolFailure("Unexpected response ID")
        event = {"tool": tool, "ok": response["ok"]}
        if not response["ok"]:
            event["error"] = response["error"]
            self.events.append(event)
            raise ToolFailure(f"{tool}: {response['error']['code']}: {response['error']['message']}")
        result = response["result"]
        if tool == "observe":
            self.state = result
        if "state" in result:
            self.state = result["state"]
            event.update({key: result[key] for key in ("delivery", "focus_changed", "cursor_changed")})
        self.events.append(event)
        return result

    def action(self, tool, **arguments):
        self.call("observe")
        return self.call(tool, revision=self.state["revision"], **arguments)

    def wait_for(self, predicate, description, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            state = self.call("observe")
            if predicate(state):
                return state
            time.sleep(0.4)
        raise ToolFailure(f"Timed out waiting for {description}")

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.log.close()


def values(state):
    return "\n".join(str(node.get(key, "")) for node in state["nodes"]
                     for key in ("title", "label", "value", "url"))


def is_google_results(state, query):
    if query.casefold() not in state.get("window", "").casefold() or "google" not in state.get("window", "").casefold():
        return False
    if any(phrase in values(state).lower() for phrase in ("unusual traffic", "before you continue to google")):
        return False
    for node in state["nodes"]:
        for key in ("url", "value"):
            raw = node.get(key, "")
            parsed = urlparse(raw if "://" in raw else "https://" + raw)
            if parsed.hostname in ("google.com", "www.google.com") and parsed.path == "/search":
                if parse_qs(parsed.query).get("q") == [query]:
                    # URL alone isn't proof that a results page rendered.
                    return any(n["role"] == "AXLink" and n.get("url", "").startswith("http")
                               and urlparse(n["url"]).hostname
                               and not urlparse(n["url"]).hostname.endswith("google.com")
                               for n in state["nodes"])
    return False


def launch_browser(profile):
    subprocess.run(["open", "-g", "-n", "-a", str(CHROME), "--args",
                    "--user-data-dir=" + str(profile), "--no-first-run", "--no-default-browser-check",
                    "--disable-search-engine-choice-screen", "--force-renderer-accessibility",
                    "--new-window", "about:blank"], check=True)
    for _ in range(40):
        listing = subprocess.check_output(["ps", "-axo", "pid=,command="], text=True)
        for line in listing.splitlines():
            if str(CHROME / "Contents/MacOS/Google Chrome") in line and "--user-data-dir=" + str(profile) in line and "--type=" not in line:
                return int(line.strip().split(maxsplit=1)[0])
        time.sleep(0.25)
    raise ToolFailure("Could not identify the disposable browser process")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--query", default="Word")
    parser.add_argument("--helper", type=Path, default=HELPER, help="Path to the native helper")
    parser.add_argument("--close", action="store_true", help="Close only the disposable browser after testing")
    options = parser.parse_args()
    if not options.query or len(options.query) > 100 or any(c in options.query for c in "\r\n\t"):
        parser.error("query must be 1–100 characters without newlines or tabs")
    if not options.helper.exists():
        parser.error("Build first: swift build --package-path src-tauri/computer-use")
    output = Path(tempfile.mkdtemp(prefix="tucky-computer-use-"))
    os.chmod(output, 0o700)
    print(f"Evidence: {output}", flush=True)
    session = None
    pid = None
    report = {"query": options.query, "success": False, "background_verified": False,
              "scope": "native controller acceptance test; deterministic driver, no AI model"}
    try:
        pid = launch_browser(output / "chrome-profile")
        report["browser_pid"] = pid
        session = Session(pid, output, options.helper)
        status = session.call("status")
        report["permissions"] = status
        if not status["accessibility"]:
            raise ToolFailure("Accessibility permission is missing for the host. No UI actions were attempted.")
        session.wait_for(lambda state: len(state["nodes"]) > 1, "browser window")
        print("Opening Google through the address bar…", flush=True)
        session.action("key", key="address_bar")
        session.wait_for(lambda state: any(n["focused"] and n["role"] in ("AXTextField", "AXComboBox") for n in state["nodes"]), "focused address bar")
        session.action("type", text="https://www.google.com")
        session.action("key", key="return")
        session.wait_for(lambda state: any(n["role"] == "AXWebArea" and "google.com" in n.get("url", "") for n in state["nodes"]), "Google home page")
        # Search field must be in web content, not the address bar.
        def search_field(state):
            nodes = {n["id"]: n for n in state["nodes"]}
            for node in nodes.values():
                if node["role"] not in ("AXTextField", "AXComboBox", "AXTextArea"):
                    continue
                parent = nodes.get(node.get("parent"))
                while parent:
                    if parent["role"] == "AXWebArea":
                        label = (node["title"] + " " + node["label"]).lower()
                        if "search" in label:
                            return node
                    parent = nodes.get(parent.get("parent"))
            return None
        session.wait_for(lambda state: search_field(state) is not None, "Google search field (consent/CAPTCHA may require a person)")
        node = search_field(session.state)
        print(f"Entering {options.query!r} in Google's search field…", flush=True)
        # Use the exact observation's element ID; don't refresh between choosing and acting.
        session.call("set_value", revision=session.state["revision"], element=node["id"], text=options.query)
        # Semantic AXPress may not exist on text controls, so locate the actual submit button.
        session.wait_for(lambda state: any(n["role"] == "AXButton" and (n["title"] == "Google Search" or n["label"] == "Google Search") for n in state["nodes"]), "Google Search button")
        button = next(n for n in session.state["nodes"] if n["role"] == "AXButton" and (n["title"] == "Google Search" or n["label"] == "Google Search"))
        session.call("click", revision=session.state["revision"], element=button["id"])
        session.wait_for(lambda state: is_google_results(state, options.query), "rendered Google results")
        (output / "results-state.json").write_text(json.dumps(session.state, indent=2))
        report["success"] = True
        mutations = [e for e in session.events if "delivery" in e]
        report["background_verified"] = bool(mutations) and all(not e["focus_changed"] and not e["cursor_changed"] for e in mutations)
        try:
            shot = session.call("screenshot")
            (output / "results.png").write_bytes(base64.b64decode(shot["png_base64"]))
            report["screenshot"] = str(output / "results.png")
        except ToolFailure as error:
            report["screenshot_error"] = str(error)
        print("PASS: Google results verified from native app state.", flush=True)
    except (ToolFailure, OSError, subprocess.SubprocessError, KeyboardInterrupt) as error:
        report["error"] = str(error)
        if session and session.state:
            (output / "last-state.json").write_text(json.dumps(session.state, indent=2))
        print(f"NOT PASSED: {error}", file=sys.stderr, flush=True)
    finally:
        if session:
            report["events"] = session.events
            session.close()
        if options.close and pid:
            try:
                os.kill(pid, 15)
            except ProcessLookupError:
                pass
        (output / "report.json").write_text(json.dumps(report, indent=2))
        print(f"Report: {output / 'report.json'}", flush=True)
    return 0 if report["success"] and report["background_verified"] else 1


if __name__ == "__main__":
    def stop_run(_signum, _frame):
        raise KeyboardInterrupt("Stopped by user")
    signal.signal(signal.SIGTERM, stop_run)
    sys.exit(main())
