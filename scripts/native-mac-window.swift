import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO

// CI-only exact synthetic controls, read-only GUI inspection, and owned normal lifecycle.
let bundleID = "com.creatorworks.hub"
let termsTitle = "Terms of use and risk acknowledgement"
let termsCheckbox = "I have read and agree to these terms, including the risk assumption and liability limitations above."
let termsContinue = "Accept and continue"
let autoDownloadCheckbox = "Download verified updates automatically"
let args = Array(CommandLine.arguments.dropFirst())

func ciScope(_ synthetic: Bool = false) -> Bool {
    let env = ProcessInfo.processInfo.environment
    return env["GITHUB_ACTIONS"] == "true" && env["RUNNER_ENVIRONMENT"] == "github-hosted"
        && env["RUNNER_OS"] == "macOS" && env["GITHUB_REPOSITORY"] == "BOBWORKS-XR/CREATOR-HUB"
        && (!synthetic || env["CREATOR_MAC_SYNTHETIC_TERMS_TEST"] == "1")
}

func preferenceScope() -> Bool {
    return ciScope() && ProcessInfo.processInfo.environment["CREATOR_MAC_SYNTHETIC_PREFERENCE_TEST"] == "1"
}

func target13() -> Bool {
    guard let bundle = Bundle(url: installedURL()) else { return false }
    return bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == "0.1.13"
        && bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String == "0.1.13"
}

func installedURL() -> URL {
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Creator Hub.app")
}

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
          canonical(bundle) == canonical(installedURL()),
          canonical(executable) == canonical(installedURL().appendingPathComponent("Contents/MacOS/creator-hub")),
          canonical(bundle) == canonical(URL(fileURLWithPath: args[2])),
          canonical(executable) == canonical(URL(fileURLWithPath: args[3])) else { return nil }
    return app
}

func axTree(_ app: NSRunningApplication) -> (elements: [AXUIElement], windows: Int, truncated: Bool) {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 2)
    guard let windows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] else { return ([], 0, false) }
    var elements = [AXUIElement]()
    var truncated = false
    let end = Date(timeIntervalSinceNow: 10)
    func visit(_ element: AXUIElement, _ depth: Int) {
        if depth > 18 || elements.count >= 700 || Date() >= end { truncated = true; return }
        AXUIElementSetMessagingTimeout(element, 0.25)
        elements.append(element)
        if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
            for child in children { visit(child, depth + 1) }
        }
    }
    for window in windows { visit(window, 0) }
    return (elements, windows.count, truncated)
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func visibleWindows(_ app: NSRunningApplication) -> [[String: Any]] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    return list.filter {
        ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == app.processIdentifier
            && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
    }.map { row -> [String: Any] in
        return ["id": row[kCGWindowNumber as String] ?? 0,
                "title": row[kCGWindowName as String] ?? "",
                "bounds": row[kCGWindowBounds as String] as? [String: Any] ?? [:]]
    }
}

func inspectAX(_ app: NSRunningApplication) -> (elements: [AXUIElement], nodes: [[String: String]], windows: Int, truncated: Bool) {
    guard AXIsProcessTrusted() else { return ([], [], 0, false) }
    let tree = axTree(app)
    var elements = [AXUIElement]()
    var nodes = [[String: String]]()
    var truncated = tree.truncated
    let end = Date(timeIntervalSinceNow: 10)
    for element in tree.elements {
        if Date() >= end { truncated = true; break }
        var node = [String: String]()
        for key in [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXEnabledAttribute] {
            if Date() >= end { truncated = true; break }
            let value = attribute(element, key)
            if let text = value as? String {
                if text.count > 600 { truncated = true }
                node[key] = String(text.prefix(600))
            } else if let number = value as? NSNumber {
                if key == kAXValueAttribute { node[key] = number.stringValue }
                if key == kAXEnabledAttribute { node[key] = number.boolValue ? "true" : "false" }
            }
        }
        elements.append(element)
        nodes.append(node)
    }
    return (elements, nodes, tree.windows, truncated)
}

func windowSnapshot(_ app: NSRunningApplication) -> [String: Any] {
    var result = appIdentity(app)
    result["windows"] = visibleWindows(app)
    let tree = inspectAX(app)
    result["axReadable"] = tree.windows > 0
    result["axNodes"] = tree.nodes
    result["axTruncated"] = tree.truncated
    return result
}

func termsState(_ nodes: [[String: String]]) -> String {
    let hints = nodes.filter {
        let title = ($0[kAXTitleAttribute] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return title == termsCheckbox || title == termsContinue
    }
    if !hints.isEmpty {
        let checks = hints.filter { $0[kAXRoleAttribute] == kAXCheckBoxRole && $0[kAXTitleAttribute] == termsCheckbox }
        let buttons = hints.filter { $0[kAXRoleAttribute] == kAXButtonRole && $0[kAXTitleAttribute] == termsContinue }
        return hints.count == 2 && checks.count == 1 && buttons.count == 1 ? "terms" : "incomplete"
    }
    let legal = try! NSRegularExpression(pattern: "terms of use|risk acknowledgement|accept and continue|agree to these terms", options: [.caseInsensitive])
    return nodes.contains(where: { node in
        if node[kAXRoleAttribute] == "AXGroup" { return false }
        let text = [node[kAXTitleAttribute] ?? "", node[kAXDescriptionAttribute] ?? "", node[kAXValueAttribute] ?? ""].joined(separator: "\n")
        return legal.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }) ? "incomplete" : "none"
}

func pressSyntheticTerms(_ app: NSRunningApplication, _ action: String) {
    guard ciScope(true), AXIsProcessTrusted(), CGPreflightScreenCaptureAccess(), app.isActive else {
        emit(["error": "Synthetic terms require exact hosted CI, existing capabilities and the active owned app"])
        return
    }
    let tree = inspectAX(app)
    let text = tree.nodes.flatMap { [$0[kAXTitleAttribute] ?? "", $0[kAXDescriptionAttribute] ?? "", $0[kAXValueAttribute] ?? ""] }.joined(separator: "\n")
    let security = try! NSRegularExpression(pattern: "privacy|security|permission|allow access|damaged|cannot be opened|unidentified developer", options: [.caseInsensitive])
    guard visibleWindows(app).count == 1, tree.windows == 1, !tree.truncated,
          tree.nodes.contains(where: { $0[kAXRoleAttribute] == "AXWebArea" }), text.contains(termsTitle),
          termsState(tree.nodes) == "terms",
          security.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) == nil else {
        emit(["error": "Refusing incomplete/non-terms tree or possible security/privacy prompt"])
        return
    }
    let role = action == "test-terms-checkbox" ? kAXCheckBoxRole : kAXButtonRole
    let title = action == "test-terms-checkbox" ? termsCheckbox : termsContinue
    let matches = tree.nodes.indices.filter { tree.nodes[$0][kAXRoleAttribute] == role && tree.nodes[$0][kAXTitleAttribute] == title }
    let checks = tree.nodes.indices.filter { tree.nodes[$0][kAXRoleAttribute] == kAXCheckBoxRole && tree.nodes[$0][kAXTitleAttribute] == termsCheckbox }
    let buttons = tree.nodes.indices.filter { tree.nodes[$0][kAXRoleAttribute] == kAXButtonRole && tree.nodes[$0][kAXTitleAttribute] == termsContinue }
    guard matches.count == 1, checks.count == 1, buttons.count == 1,
          let checked = attribute(tree.elements[checks[0]], kAXValueAttribute) as? NSNumber,
          checked.intValue == (action == "test-terms-checkbox" ? 0 : 1),
          attribute(tree.elements[checks[0]], kAXRoleAttribute) as? String == kAXCheckBoxRole,
          attribute(tree.elements[checks[0]], kAXTitleAttribute) as? String == termsCheckbox else {
        emit(["error": "Exact enabled terms control/check state is missing or ambiguous"])
        return
    }
    let selected = tree.elements[matches[0]]
    var names: CFArray?
    guard AXUIElementCopyActionNames(selected, &names) == .success,
          (names as? [String])?.contains(kAXPressAction) == true,
          attribute(selected, kAXRoleAttribute) as? String == role,
          attribute(selected, kAXTitleAttribute) as? String == title,
          (attribute(selected, kAXEnabledAttribute) as? NSNumber)?.boolValue == true,
          ciScope(true), AXIsProcessTrusted(), CGPreflightScreenCaptureAccess(), app.isActive,
          target()?.processIdentifier == app.processIdentifier,
          AXUIElementPerformAction(selected, kAXPressAction as CFString) == .success else {
        emit(["error": "Normal terms AXPress refused or uncertain; no repeat attempted"])
        return
    }
    var result = appIdentity(app)
    result["action"] = action
    result["axAction"] = "AXPress"
    result["syntheticTestOnly"] = true
    result["customerConsent"] = false
    result["userMachineUsed"] = false
    emit(result)
}

func pressSyntheticAutoDownloadOff(_ app: NSRunningApplication) {
    guard preferenceScope(), target13(), AXIsProcessTrusted(), CGPreflightScreenCaptureAccess(),
          !NSScreen.screens.isEmpty, app.isActive else {
        emit(["error": "Synthetic preference test requires target 0.1.13, exact hosted CI, existing capabilities and the active owned app"])
        return
    }
    let tree = inspectAX(app)
    let text = tree.nodes.flatMap { [$0[kAXTitleAttribute] ?? "", $0[kAXDescriptionAttribute] ?? "", $0[kAXValueAttribute] ?? ""] }.joined(separator: "\n")
    let security = try! NSRegularExpression(pattern: "privacy|security|permission|allow access|damaged|cannot be opened|unidentified developer", options: [.caseInsensitive])
    guard visibleWindows(app).count == 1, tree.windows == 1, !tree.truncated,
          tree.nodes.contains(where: { $0[kAXRoleAttribute] == "AXWebArea" }),
          text.contains("Creator Works MCP"), termsState(tree.nodes) == "none",
          security.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) == nil else {
        emit(["error": "Refusing incomplete/non-body tree or possible terms/security/privacy prompt"])
        return
    }
    let matches = tree.nodes.indices.filter {
        tree.nodes[$0][kAXRoleAttribute] == kAXCheckBoxRole && tree.nodes[$0][kAXTitleAttribute] == autoDownloadCheckbox
    }
    guard matches.count == 1 else {
        emit(["error": "Exact auto-download checkbox is missing or ambiguous"])
        return
    }
    let selected = tree.elements[matches[0]]
    var names: CFArray?
    guard AXUIElementCopyActionNames(selected, &names) == .success,
          (names as? [String])?.contains(kAXPressAction) == true,
          attribute(selected, kAXRoleAttribute) as? String == kAXCheckBoxRole,
          attribute(selected, kAXTitleAttribute) as? String == autoDownloadCheckbox,
          (attribute(selected, kAXValueAttribute) as? NSNumber)?.intValue == 1,
          (attribute(selected, kAXEnabledAttribute) as? NSNumber)?.boolValue == true,
          preferenceScope(), target13(), AXIsProcessTrusted(), CGPreflightScreenCaptureAccess(),
          !NSScreen.screens.isEmpty, app.isActive,
          target()?.processIdentifier == app.processIdentifier,
          AXUIElementPerformAction(selected, kAXPressAction as CFString) == .success else {
        emit(["error": "Auto-download 1-to-0 AXPress refused or uncertain; no repeat attempted"])
        return
    }
    var result = appIdentity(app)
    result["action"] = "test-auto-download-off"
    result["axAction"] = "AXPress"
    result["controlRole"] = kAXCheckBoxRole
    result["controlTitle"] = autoDownloadCheckbox
    result["beforeValue"] = "1"
    result["requestedValue"] = "0"
    result["targetVersion"] = "0.1.13"
    result["syntheticTestOnly"] = true
    result["customerConsent"] = false
    result["userMachineUsed"] = false
    emit(result)
}

func imagePixels(_ file: String) {
    guard ciScope(), let temp = ProcessInfo.processInfo.environment["RUNNER_TEMP"] else {
        emit(["error": "Screenshot inspection requires the hosted CI evidence directory"]); return
    }
    let url = URL(fileURLWithPath: file), root = canonical(URL(fileURLWithPath: temp)) + "/"
    guard canonical(url).hasPrefix(root), url.lastPathComponent.hasPrefix("owned-gui-"), url.pathExtension == "png",
          let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0, size <= 64 * 1024 * 1024,
          let data = try? Data(contentsOf: url),
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          image.width <= 4096, image.height <= 4096,
          let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
            bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
        emit(["error": "Screenshot PNG is outside owned bounds or cannot be decoded"]); return
    }
    context.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(image.width), height: CGFloat(image.height)))
    guard let bytes = context.data?.assumingMemoryBound(to: UInt8.self) else { emit(["error": "PNG pixels unavailable"]); return }
    // Exclude title chrome, outer shadow and footer. Only sample the rendered body.
    let x = image.width * 6 / 100, y = image.height * 20 / 100
    let width = image.width * 88 / 100, height = image.height * 60 / 100
    let step = max(1, Int(ceil(sqrt(Double(width * height) / 262144.0))))
    var colors = [UInt32: Int](), samples = 0
    for row in stride(from: y, to: y + height, by: step) {
        for column in stride(from: x, to: x + width, by: step) {
            let offset = (row * image.width + column) * 4
            let color = UInt32(bytes[offset]) << 16 | UInt32(bytes[offset + 1]) << 8 | UInt32(bytes[offset + 2])
            colors[color, default: 0] += 1; samples += 1
        }
    }
    emit(["width": image.width, "height": image.height, "bodyCrop": ["x": x, "y": y, "width": width, "height": height],
          "sampledPixels": samples, "distinctColors": colors.count,
          "nonBackgroundSamples": samples - (colors.values.max() ?? 0), "chromeExcluded": true])
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
    guard ciScope(), canonical(url) == canonical(installedURL()),
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
case "test-terms-checkbox", "test-terms-accept":
    guard ciScope(true) else { emit(["error": "Synthetic terms require explicitly opted-in hosted CI"]); exit(0) }
    guard let app = target() else { emit(["error": "Synthetic terms PID/bundle/executable ownership mismatch"]); exit(0) }
    pressSyntheticTerms(app, args[0])
case "test-auto-download-off":
    guard preferenceScope(), target13() else { emit(["error": "Synthetic preference requires opted-in hosted CI and target 0.1.13"]); exit(0) }
    guard let app = target() else { emit(["error": "Synthetic preference PID/bundle/executable ownership mismatch"]); exit(0) }
    pressSyntheticAutoDownloadOff(app)
case "pixels" where args.count == 2:
    imagePixels(args[1])
case "quit" where args.count == 4:
    guard ciScope() else { emit(["error": "Normal owned quit requires exact hosted CI"]); exit(0) }
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
    emit(["error": "Expected probe/inventory, launch APP, snapshot/quit/test-terms-*/test-auto-download-off PID APP EXECUTABLE, or pixels OWNED_PNG"])
}
