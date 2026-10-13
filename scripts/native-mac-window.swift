import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// Only read-only GUI inspection and normal LaunchServices open / owned-process quit.
let bundleID = "com.creatorworks.hub"
let args = Array(CommandLine.arguments.dropFirst())

func emit(_ value: [String: Any]) {
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
    } catch {
        print("{\"error\":\"Cannot serialize native GUI evidence\"}")
    }
}

func canonical(_ url: URL) -> String {
    return url.standardizedFileURL.resolvingSymlinksInPath().path
}

func capability() -> [String: Any] {
    return ["accessibilityTrusted": AXIsProcessTrusted(),
            "screenCaptureAllowed": CGPreflightScreenCaptureAccess(),
            "hasDisplay": !NSScreen.screens.isEmpty,
            "permissionRequestsPerformed": false]
}

func appIdentity(_ app: NSRunningApplication) -> [String: Any] {
    return ["pid": Int(app.processIdentifier), "bundleIdentifier": app.bundleIdentifier ?? "",
            "bundlePath": app.bundleURL.map(canonical) ?? "",
            "executablePath": app.executableURL.map(canonical) ?? "",
            "finishedLaunching": app.isFinishedLaunching]
}

func target() -> NSRunningApplication? {
    guard args.count == 4, let pid = Int32(args[1]), pid > 0,
          let app = NSRunningApplication(processIdentifier: pid),
          app.bundleIdentifier == bundleID,
          let bundle = app.bundleURL, let executable = app.executableURL,
          canonical(bundle) == canonical(URL(fileURLWithPath: args[2])),
          canonical(executable) == canonical(URL(fileURLWithPath: args[3])) else { return nil }
    return app
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func windowSnapshot(_ app: NSRunningApplication) -> [String: Any] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    let windows = list.filter {
        ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == app.processIdentifier
            && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
    }.map { row -> [String: Any] in
        return ["id": row[kCGWindowNumber as String] ?? 0,
                "title": row[kCGWindowName as String] ?? "",
                "bounds": row[kCGWindowBounds as String] as? [String: Any] ?? [:]]
    }
    var result = appIdentity(app)
    result["windows"] = windows
    result["axReadable"] = false
    result["axNodes"] = [[String: String]]()
    result["axTruncated"] = false
    guard AXIsProcessTrusted() else { return result }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 2)
    guard let axWindows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] else { return result }
    var nodes = [[String: String]]()
    var truncated = false
    let inspectionEnd = Date(timeIntervalSinceNow: 10)
    func visit(_ element: AXUIElement, _ depth: Int) {
        if depth > 18 || nodes.count >= 700 || Date() >= inspectionEnd { truncated = true; return }
        var node = [String: String]()
        for key in [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
            if let text = attribute(element, key) as? String {
                if text.count > 600 { truncated = true }
                node[key] = String(text.prefix(600))
            }
        }
        nodes.append(node)
        if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
            for child in children { visit(child, depth + 1) }
        }
    }
    for window in axWindows { visit(window, 0) }
    result["axReadable"] = !axWindows.isEmpty
    result["axNodes"] = nodes
    result["axTruncated"] = truncated
    return result
}

func tick() {
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
}

switch args.first ?? "" {
case "probe" where args.count == 1:
    emit(capability())
case "inventory" where args.count == 1:
    emit(["running": NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).map(appIdentity)])
case "launch" where args.count == 2:
    let url = URL(fileURLWithPath: args[1])
    let expected = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Applications/Creator Hub.app")
    guard canonical(url) == canonical(expected),
          Bundle(url: url)?.bundleIdentifier == bundleID,
          NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty else {
        emit(["error": "Refusing non-installed path or existing unowned Hub process"])
        exit(0)
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    configuration.createsNewApplicationInstance = false
    // Do not set prompts, debug flags, authorization or quarantine overrides.
    var completed = false
    var application: NSRunningApplication?
    var failure: String?
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
        application = app
        failure = error.map { String(describing: $0) }
        completed = true
    }
    let end = Date(timeIntervalSinceNow: 30)
    while !completed && Date() < end { tick() }
    if let app = application {
        emit(appIdentity(app))
    } else {
        emit(["error": failure ?? "Normal GUI launch did not complete; prompts were not accepted"])
    }
case "snapshot" where args.count == 4:
    guard let app = target() else {
        emit(["error": "PID/bundle/executable ownership mismatch"])
        exit(0)
    }
    emit(windowSnapshot(app))
case "quit" where args.count == 4:
    // If the exact owned PID has already exited, there is nothing to terminate.
    if let pid = Int32(args[1]), NSRunningApplication(processIdentifier: pid) == nil {
        emit(["exited": true, "alreadyExited": true, "forceKillPerformed": false])
        exit(0)
    }
    guard let app = target() else {
        emit(["error": "Refusing quit: PID/bundle/executable ownership mismatch"])
        exit(0)
    }
    let requested = app.terminate()
    let end = Date(timeIntervalSinceNow: 20)
    while !app.isTerminated && Date() < end { tick() }
    emit(["normalQuitRequested": requested, "exited": app.isTerminated, "forceKillPerformed": false])
default:
    emit(["error": "Expected probe, inventory, launch APP, or snapshot/quit PID APP EXECUTABLE"])
}
