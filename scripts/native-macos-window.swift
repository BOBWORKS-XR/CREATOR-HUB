import Foundation

struct Refusal: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

struct ImageIdentity: Codable, Equatable {
    let sha256: String
    let device: String
    let inode: String
    let size: UInt64
    let modifiedSeconds: Int64
    let modifiedNanoseconds: Int64
    let uid: UInt32
}

struct ProcessIdentity: Codable, Equatable {
    let pid: Int32
    let startSeconds: UInt64
    let startMicroseconds: UInt64
    let executablePath: String
    let image: ImageIdentity
    let bundlePath: String
    let bundleIdentifier: String
    let infoPlist: ImageIdentity
}

struct Bounds: Codable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct WindowIdentity: Codable, Equatable {
    let id: UInt32
    let pid: Int32
    let bounds: Bounds
}

struct Owner: Codable {
    let process: ProcessIdentity
    let window: WindowIdentity
}

struct Control: Codable, Equatable {
    let path: String
    let role: String
    let title: String
    let pid: Int32
    let windowID: UInt32
    let dialog: String?
    let enabled: Bool?
    let hidden: Bool
    let showing: Bool
    let pressSupported: Bool
}

struct Observation: Codable {
    let process: ProcessIdentity
    let window: WindowIdentity?
    let windowMissingVerified: Bool
    let accessibilityTrusted: Bool
    let active: Bool
    let truncated: Bool
    let hasDialog: Bool
    let controls: [Control]
}

enum Action: String, Codable, Equatable {
    case mcpAllow = "mcp-allow"
    case mcpDecline = "mcp-decline"
    case previewAllow = "mcp-preview-allow"
    case previewDecline = "mcp-preview-decline"
    case setupAllow = "setup-allow"
    case setupDecline = "setup-decline"
    case closeWindow = "close-window"

    var labels: (String, String)? {
        switch self {
        case .mcpAllow, .mcpDecline: return ("Enable MCP controls", "Not now")
        case .previewAllow, .previewDecline: return ("Open read-only preview", "Not now")
        case .setupAllow, .setupDecline: return ("Open in Hub", "Not now")
        case .closeWindow: return nil
        }
    }
    var selectsDecline: Bool {
        [.mcpDecline, .previewDecline, .setupDecline].contains(self)
    }
}

func hostedScope(_ env: [String: String], macOS: Bool) -> Bool {
    macOS && env["GITHUB_ACTIONS"] == "true"
        && env["RUNNER_ENVIRONMENT"] == "github-hosted"
        && env["RUNNER_OS"] == "macOS"
        && env["GITHUB_REPOSITORY"] == "BOBWORKS-XR/CREATOR-HUB"
        && env["CREATOR_MACOS_OWNED_GUI_TEST"] == "1"
}

func validateIdentity(_ owner: Owner, _ observed: Observation, allowGone: Bool = false) throws {
    guard observed.accessibilityTrusted else { throw Refusal("accessibility-denied") }
    guard observed.process == owner.process else { throw Refusal("process-identity-drift") }
    guard !observed.truncated else { throw Refusal("ax-incomplete") }
    if let window = observed.window {
        guard window == owner.window, window.pid == owner.process.pid else {
            throw Refusal("window-identity-drift")
        }
    } else if !allowGone || !observed.windowMissingVerified {
        throw Refusal("window-unverified")
    }
}

func selectControl(_ owner: Owner, _ observed: Observation, _ action: Action) throws -> Control {
    try validateIdentity(owner, observed)
    guard observed.active else { throw Refusal("owned-app-not-active") }
    let chosen: Control
    if let labels = action.labels {
        guard observed.hasDialog else { throw Refusal("native-consent-dialog-missing") }
        let approved = observed.controls.filter { $0.title == labels.0 }
        let declined = observed.controls.filter { $0.title == labels.1 }
        guard approved.count == 1, declined.count == 1,
              let dialog = approved[0].dialog, !dialog.isEmpty,
              declined[0].dialog == dialog else { throw Refusal("consent-controls-ambiguous") }
        for control in [approved[0], declined[0]] {
            try validateControl(owner, control)
        }
        chosen = action.selectsDecline ? declined[0] : approved[0]
    } else {
        let buttons = observed.controls.filter { $0.path == "close-button" }
        guard buttons.count == 1, !observed.hasDialog else {
            throw Refusal("normal-close-unverified-or-dialog-present")
        }
        chosen = buttons[0]
        try validateControl(owner, chosen)
    }
    return chosen
}

func validateControl(_ owner: Owner, _ control: Control) throws {
    guard control.role == "AXButton", control.pid == owner.process.pid,
          control.windowID == owner.window.id, control.enabled == true,
          !control.hidden, control.showing, control.pressSupported else {
        throw Refusal("control-unready-or-foreign")
    }
}

func validateAction(_ owner: Owner, _ before: Observation, _ immediate: Observation, _ action: Action) throws -> Control {
    let first = try selectControl(owner, before, action)
    let second = try selectControl(owner, immediate, action)
    guard first == second else { throw Refusal("control-drift") }
    return second
}

func emit(_ value: Any) {
    do {
        var receipt = value as? [String: Any] ?? ["error": "evidence-serialization-failed"]
        receipt["releaseReady"] = false
        receipt["nativeGuiAccepted"] = false
        let data = try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
    } catch { print("{\"error\":\"evidence-serialization-failed\",\"nativeGuiAccepted\":false,\"releaseReady\":false}") }
}

func object<T: Encodable>(_ value: T) throws -> Any {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
}

#if NATIVE_MACOS_WINDOW_FIXTURES
// This separately compiled binary has no native frameworks or action implementation.
struct Fixture: Decodable {
    let owner: Owner
    let before: Observation
    let immediate: Observation
    let after: Observation
    let action: Action
}
do {
    let data = try FileHandle.standardInput.read(upToCount: 65537) ?? Data()
    guard data.count <= 65536 else { throw Refusal("fixture-too-large") }
    let fixture = try JSONDecoder().decode(Fixture.self, from: data)
    _ = try validateAction(fixture.owner, fixture.before, fixture.immediate, fixture.action)
    try validateIdentity(fixture.owner, fixture.after, allowGone: true)
    emit(["fixtureAccepted": true, "nativeActionsAvailable": false])
} catch { emit(["error": String(describing: error), "nativeActionsAvailable": false]); exit(1) }
#elseif os(macOS)
import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Darwin

let allowedBundles = ["com.creatorworks.hub", "com.creatorworks.unitymcp.preview", "com.creatorworks.projectsetup"]
let consentLabels = Set(["Enable MCP controls", "Open read-only preview", "Open in Hub", "Not now"])
let maxImageBytes: UInt64 = 128 * 1024 * 1024
// XNU: 4 * MAXPATHLEN, MAXPATHLEN = PATH_MAX = 1024; matches host_parent_macos.rs.
let processPathBufferBytes = 4096

func admission() throws {
    guard hostedScope(ProcessInfo.processInfo.environment, macOS: true) else { throw Refusal("hosted-ci-opt-in-required") }
    #if arch(arm64)
    guard ProcessInfo.processInfo.environment["RUNNER_ARCH"] == "ARM64" else { throw Refusal("runner-architecture-mismatch") }
    #elseif arch(x86_64)
    guard ProcessInfo.processInfo.environment["RUNNER_ARCH"] == "X64" else { throw Refusal("runner-architecture-mismatch") }
    #else
    throw Refusal("unsupported-macos-architecture")
    #endif
}

func trustedAX() throws {
    guard AXIsProcessTrusted() else { throw Refusal("accessibility-denied") }
}

func canonical(_ path: String) throws -> String {
    guard path.hasPrefix("/"), path.utf8.count <= 2048 else { throw Refusal("path-unverified") }
    let url = URL(fileURLWithPath: path)
    guard url.standardizedFileURL.path == path, url.resolvingSymlinksInPath().path == path else {
        throw Refusal("linked-or-noncanonical-path")
    }
    return path
}

func allowedApp(_ app: String, _ executable: String, _ bundle: String) throws {
    _ = try canonical(app); _ = try canonical(executable)
    guard app.hasSuffix(".app"), allowedBundles.contains(bundle), executable.hasPrefix(app + "/Contents/") else {
        throw Refusal("app-scope-unverified")
    }
    let env = ProcessInfo.processInfo.environment
    guard let temporary = env["RUNNER_TEMP"] else { throw Refusal("runner-temp-unavailable") }
    let roots = [URL(fileURLWithPath: temporary).resolvingSymlinksInPath().path,
                 FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").resolvingSymlinksInPath().path]
    guard roots.contains(where: { app.hasPrefix($0 + "/") }) else { throw Refusal("app-outside-disposable-scope") }
}

func image(_ path: String, limit: UInt64 = maxImageBytes) throws -> ImageIdentity {
    _ = try canonical(path)
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard fd >= 0 else { throw Refusal("image-open-failed") }
    defer { Darwin.close(fd) }
    var before = stat()
    guard fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
          before.st_uid == getuid(), before.st_nlink == 1, before.st_size > 0,
          UInt64(before.st_size) <= limit else { throw Refusal("image-ownership-or-size-unverified") }
    var hasher = SHA256(), total: UInt64 = 0
    var bytes = [UInt8](repeating: 0, count: 65536)
    while true {
        let count = bytes.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
        guard count >= 0 else { throw Refusal("image-read-failed") }
        if count == 0 { break }
        total += UInt64(count)
        guard total <= limit else { throw Refusal("image-grew") }
        hasher.update(data: Data(bytes.prefix(count)))
    }
    var after = stat(), named = stat()
    guard fstat(fd, &after) == 0, lstat(path, &named) == 0,
          before.st_dev == after.st_dev, before.st_ino == after.st_ino,
          before.st_size == after.st_size, total == UInt64(after.st_size),
          before.st_uid == after.st_uid, before.st_nlink == after.st_nlink, before.st_mode == after.st_mode,
          before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
          before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
          named.st_dev == after.st_dev, named.st_ino == after.st_ino,
          named.st_mode & S_IFMT == S_IFREG else { throw Refusal("image-drift") }
    return ImageIdentity(sha256: hasher.finalize().map { String(format: "%02x", $0) }.joined(),
                         device: String(before.st_dev), inode: String(before.st_ino), size: total,
                         modifiedSeconds: Int64(before.st_mtimespec.tv_sec),
                         modifiedNanoseconds: Int64(before.st_mtimespec.tv_nsec), uid: before.st_uid)
}

func process(_ pid: Int32, appPath: String, executable: String, expectedHash: String, bundle: String) throws -> ProcessIdentity {
    try admission(); try trustedAX(); try allowedApp(appPath, executable, bundle)
    guard pid > 0, pid != getpid(), expectedHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
        throw Refusal("invalid-process-request")
    }
    var info = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size),
          info.pbi_pid == UInt32(pid), info.pbi_uid == getuid(), info.pbi_ruid == getuid(),
          info.pbi_start_tvsec > 0, info.pbi_start_tvusec < 1000000 else {
        throw Refusal("process-absent-or-foreign")
    }
    var path = [CChar](repeating: 0, count: processPathBufferBytes)
    let length = path.withUnsafeMutableBytes { proc_pidpath(pid, $0.baseAddress, UInt32($0.count)) }
    guard length > 0, Int(length) < path.count, path[Int(length)] == 0,
          String(cString: path) == executable else { throw Refusal("kernel-executable-path-unverified") }
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
          app.isFinishedLaunching else { throw Refusal("native-app-not-ready") }
    guard app.bundleIdentifier == bundle else { throw Refusal("native-bundle-id-unverified") }
    guard app.bundleURL?.resolvingSymlinksInPath().path == appPath else { throw Refusal("native-bundle-path-unverified") }
    guard app.executableURL?.resolvingSymlinksInPath().path == executable else { throw Refusal("native-executable-path-unverified") }
    let binary = try image(executable)
    guard binary.sha256 == expectedHash else { throw Refusal("executable-hash-mismatch") }
    let plist = try image(appPath + "/Contents/Info.plist", limit: 65536)
    guard Bundle(path: appPath)?.bundleIdentifier == bundle else { throw Refusal("bundle-identity-drift") }
    var rechecked = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &rechecked, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size),
          rechecked.pbi_pid == info.pbi_pid, rechecked.pbi_uid == info.pbi_uid,
          rechecked.pbi_start_tvsec == info.pbi_start_tvsec,
          rechecked.pbi_start_tvusec == info.pbi_start_tvusec else { throw Refusal("process-start-drift") }
    return ProcessIdentity(pid: pid, startSeconds: info.pbi_start_tvsec, startMicroseconds: info.pbi_start_tvusec,
                           executablePath: executable, image: binary, bundlePath: appPath,
                           bundleIdentifier: bundle, infoPlist: plist)
}

func process(_ expected: ProcessIdentity) throws -> ProcessIdentity {
    try process(expected.pid, appPath: expected.bundlePath, executable: expected.executablePath,
                expectedHash: expected.image.sha256, bundle: expected.bundleIdentifier)
}

func cgWindows(_ pid: Int32, id: UInt32? = nil) throws -> [WindowIdentity] {
    let options: CGWindowListOption = id == nil ? [.optionOnScreenOnly, .excludeDesktopElements] : [.optionIncludingWindow, .excludeDesktopElements]
    guard let rows = CGWindowListCopyWindowInfo(options, id ?? kCGNullWindowID) as? [[String: Any]], rows.count <= 2048 else {
        throw Refusal("cg-window-inventory-unavailable")
    }
    var result = [WindowIdentity]()
    for row in rows {
        guard let number = row[kCGWindowNumber as String] as? NSNumber,
              let owner = row[kCGWindowOwnerPID as String] as? NSNumber else { throw Refusal("cg-window-identity-unavailable") }
        if let id = id, number.uint32Value == id, owner.int32Value != pid { throw Refusal("foreign-window") }
        guard owner.int32Value == pid else { continue }
        guard (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true,
              ((row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0) > 0,
              let dictionary = row[kCGWindowBounds as String] as? [String: Any],
              let rectangle = CGRect(dictionaryRepresentation: dictionary as CFDictionary),
              rectangle.width > 0, rectangle.height > 0 else { throw Refusal("owned-window-not-showing") }
        result.append(WindowIdentity(id: number.uint32Value, pid: pid,
                                     bounds: Bounds(x: rectangle.minX, y: rectangle.minY, width: rectangle.width, height: rectangle.height)))
    }
    guard result.count <= 32 else { throw Refusal("too-many-owned-windows") }
    return result
}

func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    AXUIElementSetMessagingTimeout(element, 0.2)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
    return value
}

func element(_ value: CFTypeRef?) throws -> AXUIElement {
    guard let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { throw Refusal("ax-element-unavailable") }
    return value as! AXUIElement
}

func children(_ item: AXUIElement, _ key: String) throws -> [AXUIElement] {
    AXUIElementSetMessagingTimeout(item, 0.2)
    var count = 0
    let status = AXUIElementGetAttributeValueCount(item, key as CFString, &count)
    if status == .attributeUnsupported || status == .noValue { return [] }
    guard status == .success, count >= 0, count <= 512 else { throw Refusal("ax-children-unbounded") }
    if count == 0 { return [] }
    var array: CFArray?
    guard AXUIElementCopyAttributeValues(item, key as CFString, 0, count, &array) == .success,
          let values = array as? [AXUIElement], values.count == count else { throw Refusal("ax-children-unreadable") }
    return values
}

func axPID(_ item: AXUIElement, _ expected: Int32) throws {
    var pid: pid_t = 0
    guard AXUIElementGetPid(item, &pid) == .success, pid == expected else { throw Refusal("foreign-ax-element") }
}

func axBounds(_ item: AXUIElement) throws -> Bounds {
    guard let position = attribute(item, kAXPositionAttribute), let size = attribute(item, kAXSizeAttribute),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else {
        throw Refusal("ax-bounds-unavailable")
    }
    var point = CGPoint.zero, extent = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent),
          extent.width > 0, extent.height > 0 else { throw Refusal("ax-bounds-unavailable") }
    return Bounds(x: point.x, y: point.y, width: extent.width, height: extent.height)
}

func hitMatches(_ root: AXUIElement, _ selected: AXUIElement, _ bounds: Bounds, _ pid: Int32) -> Bool {
    var hit: AXUIElement?
    // Query only this control's center, never traverse or emit a global AX tree.
    let desktop = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(desktop, 0.2)
    guard AXUIElementCopyElementAtPosition(desktop, Float(bounds.x + bounds.width / 2), Float(bounds.y + bounds.height / 2), &hit) == .success else { return false }
    for _ in 0..<5 {
        guard let item = hit, (try? axPID(item, pid)) != nil else { return false }
        if CFEqual(item, selected) { return true }
        hit = try? element(attribute(item, kAXParentAttribute))
    }
    return false
}

struct NativeObservation {
    let value: Observation
    let elements: [String: AXUIElement]
    let axWindow: AXUIElement?
}

func observe(_ owner: Owner, controls: Bool = true, allowGone: Bool = false) throws -> NativeObservation {
    let identity = try process(owner.process)
    guard identity == owner.process else { throw Refusal("process-identity-drift") }
    try trustedAX()
    let windows = try cgWindows(identity.pid, id: owner.window.id)
    guard windows.count <= 1 else { throw Refusal("window-ambiguous") }
    let active = NSRunningApplication(processIdentifier: identity.pid)?.isActive == true
    if windows.isEmpty {
        guard allowGone else { throw Refusal("window-unverified") }
        return NativeObservation(value: Observation(process: identity, window: nil, windowMissingVerified: true,
                                                   accessibilityTrusted: true, active: active, truncated: false, hasDialog: false, controls: []), elements: [:], axWindow: nil)
    }
    let window = windows[0]
    guard window == owner.window else { throw Refusal("window-identity-drift") }
    let root = AXUIElementCreateApplication(identity.pid)
    AXUIElementSetMessagingTimeout(root, 0.2)
    let axWindows = try children(root, kAXWindowsAttribute)
    guard axWindows.count <= 32 else { throw Refusal("ax-windows-unbounded") }
    var matches = [AXUIElement]()
    for item in axWindows {
        try axPID(item, identity.pid)
        guard attribute(item, kAXRoleAttribute) as? String == kAXWindowRole else { throw Refusal("ax-window-role-unverified") }
        if try axBounds(item) == window.bounds { matches.append(item) }
    }
    guard matches.count == 1 else { throw Refusal("ax-cg-window-mapping-unverified") }
    let axWindow = matches[0]
    if !controls {
        return NativeObservation(value: Observation(process: identity, window: window, windowMissingVerified: false,
                                                   accessibilityTrusted: true, active: active, truncated: false, hasDialog: false, controls: []), elements: [:], axWindow: axWindow)
    }
    let deadline = ProcessInfo.processInfo.systemUptime + 4
    var seen = [AXUIElement](), found = [Control](), native = [String: AXUIElement](), hasDialog = false
    func append(_ item: AXUIElement, path: String, dialog: String?, title: String) throws {
        let parentWindow = try element(attribute(item, kAXWindowAttribute))
        guard CFEqual(parentWindow, axWindow) else { throw Refusal("control-window-mismatch") }
        let bounds = try axBounds(item)
        let contained = bounds.x >= window.bounds.x && bounds.y >= window.bounds.y
            && bounds.x + bounds.width <= window.bounds.x + window.bounds.width
            && bounds.y + bounds.height <= window.bounds.y + window.bounds.height
        var actions: CFArray?
        guard AXUIElementCopyActionNames(item, &actions) == .success,
              let names = actions as? [String], names.count <= 32 else { throw Refusal("ax-actions-unreadable") }
        found.append(Control(path: path, role: attribute(item, kAXRoleAttribute) as? String ?? "", title: title,
                             pid: identity.pid, windowID: window.id, dialog: dialog,
                             enabled: (attribute(item, kAXEnabledAttribute) as? NSNumber)?.boolValue,
                             hidden: (attribute(item, "AXHidden") as? NSNumber)?.boolValue == true,
                             showing: contained && hitMatches(root, item, bounds, identity.pid),
                             pressSupported: names.contains(kAXPressAction)))
        native[path] = item
    }
    func visit(_ item: AXUIElement, _ depth: Int, _ path: String, _ dialog: String?, _ web: Bool) throws {
        guard depth <= 16, seen.count < 512, ProcessInfo.processInfo.systemUptime < deadline else { throw Refusal("ax-incomplete") }
        if seen.contains(where: { CFEqual($0, item) }) { return }
        seen.append(item); try axPID(item, identity.pid)
        guard let role = attribute(item, kAXRoleAttribute) as? String else { throw Refusal("ax-role-unreadable") }
        let inWeb = web || role == "AXWebArea"
        let nativeDialog = !inWeb && (role == kAXSheetRole || attribute(item, kAXSubroleAttribute) as? String == "AXDialog")
        hasDialog = hasDialog || nativeDialog
        let scope = nativeDialog ? path : dialog
        if role == kAXButtonRole, let title = attribute(item, kAXTitleAttribute) as? String, consentLabels.contains(title) {
            try append(item, path: path, dialog: inWeb ? nil : scope, title: title)
        }
        // Public AXChildren includes contained sheets; identify them by kAXSheetRole.
        let descendants = try children(item, kAXChildrenAttribute)
        for (index, child) in descendants.enumerated() { try visit(child, depth + 1, path + "/" + String(index), scope, inWeb) }
    }
    try visit(axWindow, 0, "window", nil, false)
    if let value = attribute(axWindow, kAXCloseButtonAttribute) {
        let close = try element(value)
        try axPID(close, identity.pid)
        guard attribute(close, kAXSubroleAttribute) as? String == "AXCloseButton" else { throw Refusal("normal-close-subrole-unverified") }
        try append(close, path: "close-button", dialog: nil, title: "")
    }
    guard ProcessInfo.processInfo.systemUptime < deadline else { throw Refusal("ax-incomplete") }
    try trustedAX()
    return NativeObservation(value: Observation(process: identity, window: window, windowMissingVerified: false,
                                               accessibilityTrusted: true, active: active, truncated: false, hasDialog: hasDialog, controls: found), elements: native, axWindow: axWindow)
}

func ownerFile(_ path: String) throws -> Owner {
    _ = try canonical(path)
    guard let temporary = ProcessInfo.processInfo.environment["RUNNER_TEMP"],
          path.hasPrefix(URL(fileURLWithPath: temporary).resolvingSymlinksInPath().path + "/") else { throw Refusal("owner-file-outside-runner-temp") }
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard fd >= 0 else { throw Refusal("owner-file-unavailable") }
    let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    var meta = stat()
    guard fstat(fd, &meta) == 0, meta.st_mode & S_IFMT == S_IFREG,
          meta.st_uid == getuid(), meta.st_nlink == 1, meta.st_size <= 8192 else { throw Refusal("owner-file-unverified") }
    let data = try file.read(upToCount: 8193) ?? Data()
    guard data.count <= 8192,
          let keys = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(keys.keys) == Set(["process", "window"]) else { throw Refusal("owner-schema-unverified") }
    let owner = try JSONDecoder().decode(Owner.self, from: data)
    guard owner.window.id > 0, owner.window.pid == owner.process.pid,
          owner.process.pid > 0, owner.process.startSeconds > 0, owner.process.startMicroseconds < 1000000 else {
        throw Refusal("owner-identity-invalid")
    }
    return owner
}

func nativeMain() {
    var attempted = false
    var beforeEvidence: Any?
    var afterEvidence: Any?
    var actionStarted: Double?
    var actionReturned: Double?
    do {
        // Admission precedes all file, process, AX, display, and window inspection.
        try admission()
        let args = Array(CommandLine.arguments.dropFirst())
        guard !args.isEmpty else { throw Refusal("expected-availability-identify-inspect-press-or-close") }
        if args[0] == "availability" {
            guard args.count == 1 else { throw Refusal("availability-takes-no-target-or-options") }
            emit(["schemaVersion": 1, "command": "availability", "probeOnly": true,
                  "runnerArchitecture": ProcessInfo.processInfo.environment["RUNNER_ARCH"]!,
                  "accessibilityTrusted": AXIsProcessTrusted(), "targetInspectionPerformed": false,
                  "actionAttempted": false, "permissionRequestsPerformed": false])
            return
        }
        if args[0] == "identify", args.count == 6, let pid = Int32(args[1]) {
            try trustedAX()
            let first = try process(pid, appPath: args[2], executable: args[3], expectedHash: args[4], bundle: args[5])
            let windows = try cgWindows(pid)
            guard try process(first) == first else { throw Refusal("process-identity-drift") }
            emit(["process": try object(first), "windows": try object(windows), "permissionRequestsPerformed": false])
            return
        }
        guard ["inspect", "press", "close"].contains(args[0]),
              args.count == (args[0] == "press" ? 3 : 2) else { throw Refusal("unknown-native-command") }
        try trustedAX()
        let owner = try ownerFile(args[1])
        let before = try observe(owner)
        if args[0] == "inspect" {
            try validateIdentity(owner, before.value)
            emit(["observation": try object(before.value), "permissionRequestsPerformed": false]); return
        }
        guard let action = args[0] == "close" ? Action.closeWindow : Action(rawValue: args[2]),
              args[0] != "press" || action != .closeWindow else { throw Refusal("unknown-native-action") }
        let immediate = try observe(owner)
        beforeEvidence = try object(immediate.value)
        let selected = try validateAction(owner, before.value, immediate.value, action)
        guard let target = immediate.elements[selected.path], let original = before.elements[selected.path],
              CFEqual(target, original), let firstWindow = before.axWindow, let lastWindow = immediate.axWindow,
              CFEqual(firstWindow, lastWindow) else { throw Refusal("native-control-reference-drift") }
        // A final identity fence precedes the one allowed AXPress. No focus or retry.
        let fence = try observe(owner, controls: false)
        try validateIdentity(owner, fence.value)
        guard fence.value.active, let fenceWindow = fence.axWindow, CFEqual(fenceWindow, lastWindow) else {
            throw Refusal("native-window-reference-drift")
        }
        try axPID(target, owner.process.pid)
        let targetWindow = try element(attribute(target, kAXWindowAttribute))
        guard CFEqual(targetWindow, fenceWindow),
              attribute(target, kAXRoleAttribute) as? String == selected.role,
              (action == .closeWindow
                ? attribute(target, kAXSubroleAttribute) as? String == "AXCloseButton"
                : attribute(target, kAXTitleAttribute) as? String == selected.title),
              (attribute(target, kAXEnabledAttribute) as? NSNumber)?.boolValue == true,
              (attribute(target, "AXHidden") as? NSNumber)?.boolValue != true,
              hitMatches(AXUIElementCreateApplication(owner.process.pid), target, try axBounds(target), owner.process.pid) else {
            throw Refusal("control-state-drift")
        }
        try admission(); try trustedAX()
        actionStarted = ProcessInfo.processInfo.systemUptime
        attempted = true
        let result = AXUIElementPerformAction(target, kAXPressAction as CFString)
        actionReturned = ProcessInfo.processInfo.systemUptime
        // Capture real identity immediately after the action even if AXPress refused.
        let after = try observe(owner, controls: false, allowGone: true)
        afterEvidence = try object(after.value)
        try validateIdentity(owner, after.value, allowGone: true)
        guard result == .success else { throw Refusal("ax-action-refused") }
        emit(["action": action.rawValue, "axAction": "AXPress", "before": try object(immediate.value),
              "after": try object(after.value), "actionAttempted": true, "postIdentityVerified": true,
              "actionStartedUptime": actionStarted!, "actionReturnedUptime": actionReturned!,
              "postInspectionCompletedUptime": ProcessInfo.processInfo.systemUptime,
              "windowGone": after.value.window == nil, "forceKillPerformed": false,
              "permissionRequestsPerformed": false, "syntheticTestOnly": true, "customerConsent": false])
    } catch {
        var failure: [String: Any] = ["error": String(describing: error), "actionAttempted": attempted,
                                    "postIdentityVerified": false, "forceKillPerformed": false, "permissionRequestsPerformed": false]
        if let before = beforeEvidence { failure["before"] = before }
        if let after = afterEvidence { failure["after"] = after }
        if let started = actionStarted { failure["actionStartedUptime"] = started }
        if let returned = actionReturned { failure["actionReturnedUptime"] = returned }
        emit(failure)
        exit(attempted ? 3 : 2)
    }
}
nativeMain()
#else
emit(["error": "native-macos-required", "actionAttempted": false]); exit(2)
#endif
