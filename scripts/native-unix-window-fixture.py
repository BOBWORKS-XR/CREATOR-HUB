"""Disposable GTK3/X11 ABI fixture, not Creator Hub or hosting acceptance.

Runner-only dependencies: python3-gi, gir1.2-gtk-3.0, gir1.2-atspi-2.0,
at-spi2-core, libx11-6, libxres1, dbus-x11, xvfb, xauth, openbox.
Run in an already owned dbus/Xvfb/Openbox session with GDK_BACKEND=x11,
NO_AT_BRIDGE=0, CREATOR_UNIX_WINDOW_TEST=1, CREATOR_UNIX_WINDOW_FIXTURE=1:
  /usr/bin/python3 scripts/native-unix-window-fixture.py --output "$RUNNER_TEMP/gtk-abi-1"

Primary APIs: https://docs.gtk.org/gtk3/class.Dialog.html
https://docs.gtk.org/gdk3-x11/method.X11Window.get_xid.html
The private pipe requests fixture retry/abort only, never clicks or approvals.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import select
import subprocess
import sys
import time

TITLE, FRAME = "Open MCP in Creator Hub?", "Owned GTK ABI Fixture"
DECLINE, APPROVE = "Not now", "Enable MCP controls"
MAX_IMAGE, MAX_LOG = 256 * 1024 * 1024, 262144


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def runner_guard(env, system, machine):
    require(system == "linux" and machine in ("x86_64", "aarch64"), "Native Linux fixture required")
    require(env.get("GITHUB_ACTIONS") == "true" and env.get("RUNNER_ENVIRONMENT") == "github-hosted"
            and env.get("RUNNER_OS") == "Linux" and env.get("CREATOR_UNIX_WINDOW_TEST") == "1"
            and env.get("CREATOR_UNIX_WINDOW_FIXTURE") == "1", "Explicit disposable GitHub-hosted fixture only")
    require(env.get("RUNNER_ARCH") == ("X64" if machine == "x86_64" else "ARM64"), "Runner architecture differs")
    require(not env.get("FLATPAK_ID"), "Not a Flatpak fixture")
    require(env.get("GDK_BACKEND") == "x11" and env.get("NO_AT_BRIDGE") == "0"
            and re.fullmatch(r":[0-9]{1,5}(?:\.[0-9]{1,2})?", env.get("DISPLAY", "")), "Owned local X11/a11y session required")


def digest(file):
    with open(file, "rb") as stream:
        require(0 < os.fstat(stream.fileno()).st_size <= MAX_IMAGE, "Fixture image exceeds bound")
        result, total = hashlib.sha256(), 0
        while chunk := stream.read(65536):
            total += len(chunk)
            require(total <= MAX_IMAGE, "Fixture image exceeds bound")
            result.update(chunk)
        return result.hexdigest()


def process_record(pid):
    with open(f"/proc/{pid}/stat", encoding="utf8") as stream:
        text = stream.read(4097)
    require(len(text) <= 4096 and text.startswith(f"{pid} ("), "Owned fixture PID differs")
    fields = text[text.rfind(")") + 2:].split()
    require(len(fields) >= 20 and fields[0] not in ("Z", "X") and fields[19].isdigit(), "Owned fixture is not live")
    return fields[19], int(fields[1])


def check_owned(child, pin):
    require(child.poll() is None, "Owned GTK fixture exited before action")
    require(process_record(child.pid) == (pin["startTime"], os.getpid()), "Owned fixture start/parent changed")
    require(os.readlink(f"/proc/{child.pid}/exe") == pin["executable"]
            and digest(f"/proc/{child.pid}/exe") == pin["sha256"], "Owned running fixture executable differs")
    require(process_record(child.pid) == (pin["startTime"], os.getpid())
            and os.readlink(f"/proc/{child.pid}/exe") == pin["executable"], "Owned fixture changed during verification")


class Events:
    def __init__(self, child):
        self.child, self.pending, self.records, self.total = child, b"", [], 0
        self.raw = bytearray()

    def capture(self, chunk):
        self.total += len(chunk)
        require(self.total <= 32768, "Owned GTK events exceed bound")
        self.raw.extend(chunk)

    def next(self, kind):
        deadline = time.monotonic() + 20
        while b"\n" not in self.pending:
            remaining = deadline - time.monotonic()
            require(remaining > 0 and select.select([self.child.stdout], [], [], max(0, remaining))[0], "Owned GTK event deadline")
            chunk = os.read(self.child.stdout.fileno(), 4096)
            require(chunk, "Owned GTK event pipe ended early")
            self.capture(chunk)
            self.pending += chunk
        line, self.pending = self.pending.split(b"\n", 1)
        value = json.loads(line)
        self.records.append(value)
        require(type(value) is dict and value.get("kind") == kind and value.get("pid") == self.child.pid,
                f"Unexpected owned GTK event: {value}")
        return value


def validate_window(value, phase, title, role):
    require(value.get("phase") == phase and value.get("title") == title and value.get("role") == role,
            "Actual GTK window phase/title/role differs")
    require(type(value.get("xid")) is int and 0 < value["xid"] <= 0xffffffff, "Invalid owned GTK resource ID")
    return value


def validate_callback(value, phase, label):
    require(type(value.get("phase")) is int and type(value.get("count")) is int
            and value.get("phase") == phase and value.get("button") == label and value.get("count") == phase
            and value.get("accepted") is (phase == 2), "Native GTK response callback differs")


def validate_helper(value, action, pin, window, label=""):
    require(type(value) is dict and "error" not in value and value.get("pid") == pin["pid"]
            and value.get("startTime") == pin["startTime"] and value.get("executable") == pin["executable"]
            and value.get("executableSha256") == pin["sha256"] and value.get("window") == str(window["xid"])
            and value.get("title") == window["title"] and value.get("role") == window["role"]
            and value.get("executableBinding") == "pathname-and-running-proc-image-hash"
            and type(value.get("xresClient")) is str and re.fullmatch(r"[1-9][0-9]*", value["xresClient"])
            and value.get("action") == action and value.get("actionCount") == (0 if action == "snapshot" else 1)
            and value.get("normalExitVerified") is False and value.get("releaseReady") is False,
            "Native helper receipt does not match the owned fixture request")
    require(action != "click" or value.get("button") == label, "Native helper clicked a different button")
    if action == "snapshot":
        nodes = value.get("nodes")
        require(type(nodes) is list and 0 < len(nodes) <= 512 and nodes[0].get("name") == window["title"],
                "Owned GTK snapshot is missing its actual root")


def failed_cleanup(report, errors):
    if errors:
        report.update(status="failed", normalExitVerified=False, cleanupErrors=errors)


def load_helper(file):
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("gtk_fixture_native_helper", file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def await_native_window(child, pin, window, api, helper):
    # Read-only readiness conditions, not repeated input or a fixed startup sleep.
    deadline, last = time.monotonic() + 20, "Accessibility not yet registered"
    x11 = helper.X11()
    try:
        while time.monotonic() < deadline:
            check_owned(child, pin)
            root = api.get_desktop(0)
            count = root.get_child_count()
            require(0 <= count <= 128, "Accessibility root exceeds fixture bound")
            apps = [root.get_child_at_index(i) for i in range(count)]
            apps = [app for app in apps if app.get_process_id() == child.pid]
            require(len(apps) <= 1, "Owned GTK accessibility application is ambiguous")
            if apps:
                count = apps[0].get_child_count()
                require(0 <= count <= 32, "Owned GTK window inventory exceeds bound")
                windows = [apps[0].get_child_at_index(i) for i in range(count)]
                matches = [node for node in windows if node.get_name() == window["title"]
                           and node.get_role() == getattr(api.Role, window["role"])]
                require(len(matches) <= 1, "Owned GTK accessibility window is ambiguous")
                if matches:
                    node = matches[0]
                    require(node.get_process_id() == child.pid, "GTK accessibility window is unowned")
                    states = node.get_state_set()
                    if all(states.contains(getattr(api.StateType, state)) for state in ("ENABLED", "SHOWING", "SENSITIVE")):
                        try:
                            x11.check_close(window["xid"])
                        except RuntimeError as error:
                            require(str(error) in ("Normal EWMH window manager required", "Window manager readiness differs",
                                                   "Normal WM close is unsupported"), str(error))
                            last = str(error)
                        else:
                            return
            time.sleep(0.05)
        raise RuntimeError(f"GTK native readiness deadline: {last}")
    finally:
        x11.dispose()


def gtk_child(expected_source):
    require(re.fullmatch(r"[a-f0-9]{64}", expected_source) and digest(__file__) == expected_source, "Fixture source changed")
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("GdkX11", "3.0")
    from gi.repository import Gtk, GLib, GdkX11

    state = {"phase": 1, "callbacks": 0, "declined": 0, "approved": 0, "dialog": None, "exit": 75}
    frame = Gtk.Window(title=FRAME)
    frame.set_default_size(460, 180)
    frame.add(Gtk.Label(label="Synthetic GTK ABI fixture"))

    def emit(kind, **values):
        print(json.dumps({"kind": kind, "pid": os.getpid(), **values}), flush=True)

    def mapped(widget, _event, phase):
        emit("window", phase=phase, title=widget.get_title(),
             role=widget.get_accessible().get_role().value_nick.upper(),
             xid=int(GdkX11.X11Window.get_xid(widget.get_window())))
        return False

    def respond(dialog, response):
        phase = state["phase"]
        valid = (phase == 1 and response == 1) or (phase == 2 and response == 2)
        if not valid:
            emit("error", error="Unexpected dialog response", phase=phase, response=int(response))
            abort()
            return
        state["callbacks"] += 1
        state["declined" if phase == 1 else "approved"] += 1
        dialog.destroy()
        state["dialog"] = None
        emit("callback", phase=phase, button=DECLINE if phase == 1 else APPROVE,
             accepted=phase == 2, count=state["callbacks"], responseId=int(response))

    def show_dialog():
        dialog = Gtk.Dialog(title=TITLE, transient_for=frame, modal=True, destroy_with_parent=True)
        state["dialog"] = dialog
        dialog.add_button(DECLINE, 1)
        dialog.add_button(APPROVE, 2)
        dialog.get_content_area().add(Gtk.Label(label="Synthetic fixture only; no product permission is granted."))
        dialog.connect("response", respond)
        dialog.connect("map-event", mapped, state["phase"])
        dialog.show_all()

    def close(_widget, _event):
        valid = state["callbacks"] == 2 and state["declined"] == state["approved"] == 1 and state["dialog"] is None
        state["exit"] = 0 if valid else 75
        emit("normal-close", callbacks=state["callbacks"], declined=state["declined"], approved=state["approved"], valid=valid)
        return False

    def abort():
        state["exit"] = 75
        if state["dialog"] is not None:
            state["dialog"].destroy()
        frame.destroy()
        return False

    def control(_source, condition):
        if condition & (GLib.IOCondition.HUP | GLib.IOCondition.ERR):
            return abort()
        data = os.read(sys.stdin.fileno(), 64)
        if data == b"retry\n" and state["phase"] == 1 and state["declined"] == 1 and state["dialog"] is None:
            state["phase"] = 2
            show_dialog()
            return True
        return abort()

    frame.connect("map-event", mapped, 0)
    frame.connect("delete-event", close)
    frame.connect("destroy", lambda _widget: Gtk.main_quit())
    GLib.io_add_watch(sys.stdin.fileno(), GLib.PRIORITY_DEFAULT,
                      GLib.IOCondition.IN | GLib.IOCondition.HUP | GLib.IOCondition.ERR, control)
    GLib.timeout_add_seconds(90, abort)
    frame.show_all()
    show_dialog()
    Gtk.main()
    return state["exit"]


def run_fixture(output):
    script = Path(__file__).resolve()
    helper_file = script.with_name("native-unix-window.py")
    root = Path(os.environ["RUNNER_TEMP"]).resolve()
    require(output.is_absolute() and str(output.resolve()) == str(output) and root in output.parents,
            "Output must be an unredirected new runner-temp directory")
    output.mkdir(mode=0o700, exist_ok=False)
    report = {"scope": "synthetic-gtk3-x11-abi-only", "status": "failed", "releaseReady": False,
              "productGuiAccepted": False, "hostingAccepted": False, "sealedBackendAccepted": False, "normalExitVerified": False,
              "phases": [], "cleanup": {}, "retry": "fixture private pipe; not a product GUI retry"}
    child, events, active_helper = None, None, None
    child_log = open(output / "gtk-child.stderr.txt", "xb")
    try:
        source_hash, helper_hash = digest(script), digest(helper_file)
        executable = os.path.realpath(sys.executable)
        expected_hash = digest(executable)
        report.update(fixtureSourceSha256=source_hash, helperSourceSha256=helper_hash)
        names = ("PATH DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR LANG LC_ALL GDK_BACKEND NO_AT_BRIDGE "
                 "GITHUB_ACTIONS RUNNER_ENVIRONMENT RUNNER_OS RUNNER_ARCH RUNNER_TEMP CREATOR_UNIX_WINDOW_TEST CREATOR_UNIX_WINDOW_FIXTURE")
        env = {name: os.environ[name] for name in names.split() if name in os.environ}
        for name in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"):
            directory = output / name.lower()
            directory.mkdir(mode=0o700)
            env[name] = str(directory)
        helper = load_helper(helper_file)
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        Atspi.set_timeout(3000, 3000)
        child = subprocess.Popen([executable, str(script), "--gtk-child", source_hash], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=child_log, env=env)
        pin = {"pid": child.pid, "startTime": process_record(child.pid)[0], "executable": executable, "sha256": expected_hash}
        report["ownedChild"] = pin
        check_owned(child, pin)
        events = Events(child)
        frame = validate_window(events.next("window"), 0, FRAME, "FRAME")
        first = validate_window(events.next("window"), 1, TITLE, "DIALOG")

        def invoke(label, action, window, button=""):
            nonlocal active_helper
            check_owned(child, pin)
            require(digest(script) == source_hash and digest(helper_file) == helper_hash, "Fixture/helper source changed")
            command = [executable, str(helper_file), action, str(child.pid), pin["startTime"], executable, expected_hash,
                       str(window["xid"]), window["title"], window["role"]]
            if button:
                command.append(button)
            stdout, stderr = output / f"{label}.stdout.json", output / f"{label}.stderr.txt"
            phase = {"label": label, "action": action, "stdout": stdout.name, "stderr": stderr.name}
            report["phases"].append(phase)
            with open(stdout, "xb") as out, open(stderr, "xb") as err:
                active_helper = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=out, stderr=err, env=env)
                phase["helperPid"] = active_helper.pid
                phase["exitCode"] = active_helper.wait(timeout=15)
            active_helper = None
            require(stdout.stat().st_size <= MAX_LOG and stderr.stat().st_size <= MAX_LOG, "Helper logs exceed bound")
            if phase["exitCode"] != 0:
                raise RuntimeError(f"Native helper {label} exit {phase['exitCode']}: {stderr.read_text(errors='replace')[:3000]}")
            value = json.loads(stdout.read_bytes())
            validate_helper(value, action, pin, window, button)
            phase["receipt"] = value
            if action != "close":
                check_owned(child, pin)
            return value

        await_native_window(child, pin, first, Atspi, helper)
        invoke("01-snapshot", "snapshot", first)
        invoke("02-decline", "click", first, DECLINE)
        validate_callback(events.next("callback"), 1, DECLINE)
        check_owned(child, pin)
        child.stdin.write(b"retry\n")
        child.stdin.flush()
        second = validate_window(events.next("window"), 2, TITLE, "DIALOG")
        await_native_window(child, pin, second, Atspi, helper)
        invoke("03-retry-snapshot", "snapshot", second)
        invoke("04-approve", "click", second, APPROVE)
        validate_callback(events.next("callback"), 2, APPROVE)
        await_native_window(child, pin, frame, Atspi, helper)
        invoke("05-frame-snapshot", "snapshot", frame)
        invoke("06-normal-close", "close", frame)
        closed = events.next("normal-close")
        require(closed.get("valid") is True and closed.get("callbacks") == 2
                and closed.get("declined") == closed.get("approved") == 1, "Normal GTK close callback differs")
        require(child.wait(timeout=10) == 0, "Owned GTK fixture did not exit zero")
        require(not Path(f"/proc/{child.pid}").exists(), "Owned GTK PID survives normal exit")
        require(digest(script) == source_hash and digest(helper_file) == helper_hash, "Fixture/helper source drifted")
        report.update(status="passed", normalExitVerified=True)
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {str(error)[:4000]}"
    finally:
        cleanup_errors = []
        if child is not None:
            if child.poll() is None:
                try:
                    child.stdin.close()  # EOF destroys only this synthetic fixture's own GTK windows.
                    report["cleanup"]["fixtureAbortExit"] = child.wait(timeout=10)
                except Exception as error:
                    cleanup_errors.append(f"Owned fixture EOF cleanup: {error}")
            report["cleanup"]["childExit"] = child.poll()
            if events is not None and child.poll() is not None:
                try:
                    while select.select([child.stdout], [], [], 0)[0]:
                        chunk = os.read(child.stdout.fileno(), 4096)
                        if not chunk:
                            break
                        events.capture(chunk)
                except Exception as error:
                    cleanup_errors.append(f"Owned fixture event capture: {error}")
            for stream in (child.stdin, child.stdout):
                try:
                    if not stream.closed:
                        stream.close()
                except Exception as error:
                    cleanup_errors.append(f"Owned fixture pipe cleanup: {error}")
        if active_helper is not None and active_helper.poll() is None:
            report["cleanup"]["survivingHelperPid"] = active_helper.pid
            cleanup_errors.append("Owned helper survived deadline; no forced kill; disposable job teardown required")
        try:
            child_log.close()
        except Exception as error:
            cleanup_errors.append(f"Owned fixture log cleanup: {error}")
        if report.get("error") or cleanup_errors:
            try:
                with open(output / "gtk-child.stderr.txt", "rb") as stream:
                    report["childStderrExcerpt"] = stream.read(4000).decode("utf8", errors="replace")
            except Exception as error:
                cleanup_errors.append(f"Owned fixture diagnostic read: {error}")
        if events is not None:
            report["events"] = events.records
            try:
                with open(output / "gtk-child.stdout.jsonl", "xb") as stream:
                    stream.write(events.raw)
            except Exception as error:
                cleanup_errors.append(f"Owned fixture event log: {error}")
        failed_cleanup(report, cleanup_errors)
        with open(output / "report.json", "x", encoding="utf8") as stream:
            json.dump(report, stream, indent=2)
    return report


def main():
    # No argument parsing, file/proc/GI inspection or child launch before this guard.
    runner_guard(os.environ, sys.platform, platform.machine())
    require('ID=ubuntu' in Path("/etc/os-release").read_text().splitlines(), "Disposable Ubuntu runner required")
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "--gtk-child":
        return gtk_child(args[1])
    require(len(args) == 2 and args[0] == "--output", "Use --output NEW_ABSOLUTE_RUNNER_TEMP_DIRECTORY")
    report = run_fixture(Path(args[1]))
    print(json.dumps({key: report[key] for key in ("scope", "status", "normalExitVerified", "releaseReady")}), flush=True)
    if report.get("error"):
        print(report["error"], file=sys.stderr)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"error": f"{type(error).__name__}: {str(error)[:2000]}", "releaseReady": False}), file=sys.stderr)
        sys.exit(1)
