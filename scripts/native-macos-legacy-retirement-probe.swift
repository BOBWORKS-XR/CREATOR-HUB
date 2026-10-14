import Foundation
import AppKit
import CoreServices
import CryptoKit
import Darwin

// Dedicated diagnostic, not a reusable retirement or input helper.
struct Refusal: Error { let message: String }
func need(_ value: Bool, _ message: String) throws { if !value { throw Refusal(message: message) } }
let environment = ProcessInfo.processInfo.environment
func admitted() throws {
    try need(environment["GITHUB_ACTIONS"] == "true" && environment["RUNNER_ENVIRONMENT"] == "github-hosted"
        && environment["GITHUB_REPOSITORY"] == "BOBWORKS-XR/CREATOR-HUB" && environment["RUNNER_OS"] == "macOS"
        && environment["GITHUB_REF"] == "refs/heads/validation/mac-legacy-retirement-014"
        && environment["CREATOR_MACOS_LEGACY_RETIREMENT_PROBE"] == "1", "fixed-disposable-runner-opt-in-required")
}
func spec(_ product: String) throws -> (String, String, String) {
    if product == "setup" { return ("Creator Project Setup", "creator-project-setup", "com.creatorworks.projectsetup") }
    if product == "mcp" { return ("Creator Works MCP", "creator-works-mcp-launcher", "com.creatorworks.unitymcp.preview") }
    throw Refusal(message: "unknown-product")
}
func image(_ filename: String) throws -> [String: Any] {
    let fd = open(filename, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    try need(fd >= 0, "image-open-refused"); defer { Darwin.close(fd) }
    var before = stat(), after = stat(), named = stat()
    try need(fstat(fd, &before) == 0 && before.st_mode & S_IFMT == S_IFREG && before.st_uid == getuid()
        && before.st_nlink == 1 && before.st_size > 0 && before.st_size <= 160 * 1024 * 1024, "image-unowned-linked-or-unbounded")
    var digest = SHA256(), bytes = [UInt8](repeating: 0, count: 65536), total = 0
    while true {
        let count = bytes.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
        try need(count >= 0, "image-read-refused"); if count == 0 { break }
        total += count; try need(total <= 160 * 1024 * 1024, "image-grew"); digest.update(data: Data(bytes.prefix(count)))
    }
    try need(fstat(fd, &after) == 0 && lstat(filename, &named) == 0 && before.st_dev == after.st_dev
        && before.st_ino == after.st_ino && before.st_size == after.st_size && total == before.st_size
        && before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec && before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec
        && before.st_mode == after.st_mode && before.st_uid == after.st_uid && before.st_nlink == after.st_nlink
        && named.st_dev == after.st_dev && named.st_ino == after.st_ino && named.st_mode == after.st_mode, "image-drift")
    return ["device": String(before.st_dev), "inode": String(before.st_ino), "bytes": total,
        "sha256": digest.finalize().map { String(format: "%02x", $0) }.joined()]
}
func inspect(_ product: String, _ pid: Int32, _ parent: UInt32, _ hash: String) throws -> [String: Any] {
    try admitted()
    let (name, exe, bundle) = try spec(product)
    let app = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/\(name).app").path
    let executable = app + "/Contents/MacOS/" + exe
    try need(URL(fileURLWithPath: app).resolvingSymlinksInPath().path == app
        && URL(fileURLWithPath: executable).resolvingSymlinksInPath().path == executable, "linked-app-refused")
    var info = proc_bsdinfo(); errno = 0
    let count = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
    try need(count == Int32(MemoryLayout<proc_bsdinfo>.size) && info.pbi_pid == UInt32(pid)
        && info.pbi_ppid == parent && info.pbi_uid == getuid() && info.pbi_ruid == getuid()
        && info.pbi_start_tvsec > 0, "owned-kernel-process-unverified")
    var buffer = [CChar](repeating: 0, count: 4096)
    let length = buffer.withUnsafeMutableBytes { proc_pidpath(pid, $0.baseAddress, UInt32($0.count)) }
    try need(length > 0 && Int(length) < buffer.count && buffer[Int(length)] == 0
        && String(cString: buffer) == executable, "kernel-executable-path-unverified")
    let binary = try image(executable)
    try need(hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
        && binary["sha256"] as? String == hash, "public-executable-hash-mismatch")
    guard let native = NSRunningApplication(processIdentifier: pid) else { throw Refusal(message: "native-app-unavailable") }
    try need(!native.isTerminated && native.bundleIdentifier == bundle
        && native.bundleURL?.resolvingSymlinksInPath().path == app
        && native.executableURL?.resolvingSymlinksInPath().path == executable, "native-app-identity-unverified")
    let peers = NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
    try need(peers.count == 1 && peers[0].processIdentifier == pid, "duplicate-old-gui-refused")
    return ["diagnosticOnly": true, "retirementMutationAttempted": false, "product": product, "pid": pid, "parent": parent,
        "startSeconds": info.pbi_start_tvsec, "startMicroseconds": info.pbi_start_tvusec, "app": app,
        "executable": executable, "hash": hash, "image": binary, "ready": native.isFinishedLaunching,
        "externalBusyProtocolAvailable": false, "ownerProtocolAvailable": false]
}
func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
func experimentRoot(_ folder: String) throws -> String {
    try admitted()
    try need(environment["CREATOR_MACOS_LEGACY_ARCHIVE_EXPERIMENT"] == "1", "archive-experiment-opt-in-required")
    let temporary = URL(fileURLWithPath: environment["RUNNER_TEMP"] ?? "").resolvingSymlinksInPath().path
    try need(folder == temporary + "/macos-legacy-retirement-probe/mcp/gui-archive-experiment"
        && URL(fileURLWithPath: folder).resolvingSymlinksInPath().path == folder, "fixed-experiment-folder-required")
    return folder
}
func exclusiveRecord(_ filename: String, _ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    let fd = open(filename, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    try need(fd >= 0, "journal-no-overwrite-open-refused"); defer { Darwin.close(fd) }
    let written = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
    try need(written == data.count && fsync(fd) == 0, "journal-write-or-sync-refused")
    let directory = open(URL(fileURLWithPath: filename).deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    try need(directory >= 0, "journal-directory-refused"); defer { Darwin.close(directory) }
    try need(fsync(directory) == 0, "journal-directory-sync-refused")
}
func waitForBarrier(_ file: String, seconds: Double) throws {
    let deadline = ProcessInfo.processInfo.systemUptime + seconds
    while !FileManager.default.fileExists(atPath: file) {
        try need(ProcessInfo.processInfo.systemUptime < deadline, "experiment-barrier-deadline")
        Thread.sleep(forTimeInterval: 0.1)
    }
    _ = try image(file)
}
func review(_ phase: String, folder: String) throws -> NSApplication.ModalResponse {
    let alert = NSAlert()
    alert.messageText = "MCP GUI-only archival experiment"
    alert.informativeText = "Disposable runner only. Temporarily archive only Creator Works MCP's GUI executable, leaving all original Node/server paths in place, measure signatures and connections, then restore the exact executable. No settings migration or security bypass. Cancel leaves the app unchanged."
    alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "Archive GUI")
    alert.window.title = "MCP GUI-only archival experiment"
    NSApp.activate(ignoringOtherApps: true)
    DispatchQueue.main.async {
        do { try exclusiveRecord(folder + "/review-\(phase)-ready.json", ["phase": phase, "pid": getpid(), "nativeModal": true]) }
        catch { NSApp.abortModal() }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 25) { if NSApp.modalWindow === alert.window { NSApp.abortModal() } }
    return alert.runModal()
}
func helperIdentity(_ pid: Int32, _ parent: UInt32, _ hash: String) throws {
    try admitted()
    try need(parent == UInt32(getppid()) && pid != getpid() && pid > 0, "owned-review-parent-required")
    var info = proc_bsdinfo()
    try need(proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size)
        && info.pbi_pid == UInt32(pid) && info.pbi_ppid == parent && info.pbi_uid == getuid() && info.pbi_ruid == getuid(), "review-kernel-identity-refused")
    var buffer = [CChar](repeating: 0, count: 4096)
    let length = buffer.withUnsafeMutableBytes { proc_pidpath(pid, $0.baseAddress, UInt32($0.count)) }
    let own = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
    try need(length > 0 && Int(length) < buffer.count && buffer[Int(length)] == 0 && String(cString: buffer) == own
        && (try image(own))["sha256"] as? String == hash, "review-helper-image-refused")
}
func pressReview(_ pid: Int32, _ parent: UInt32, _ hash: String, _ phase: String) throws {
    try need(environment["CREATOR_MACOS_LEGACY_ARCHIVE_EXPERIMENT"] == "1" && ["cancel", "approve"].contains(phase), "fixed-review-phase-required")
    try helperIdentity(pid, parent, hash)
    try need(AXIsProcessTrusted(), "native-review-accessibility-unavailable")
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.2)
    func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        AXUIElementSetMessagingTimeout(element, 0.2)
        var value: CFTypeRef?; return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    var selected: AXUIElement?, selectedWindow: AXUIElement?
    let deadline = ProcessInfo.processInfo.systemUptime + 8
    while selected == nil && ProcessInfo.processInfo.systemUptime < deadline {
        if let windows = attr(app, kAXWindowsAttribute) as? [AXUIElement], windows.count == 1 {
            let window = windows[0]
            if attr(window, kAXTitleAttribute) as? String == "MCP GUI-only archival experiment" {
                var queue = [(window, 0)], found = [AXUIElement](), count = 0
                while !queue.isEmpty && count < 32 {
                    let (item, depth) = queue.removeFirst(); count += 1
                    var owner: pid_t = 0
                    try need(AXUIElementGetPid(item, &owner) == .success && owner == pid, "foreign-native-review-control")
                    let title = phase == "cancel" ? "Cancel" : "Archive GUI"
                    if attr(item, kAXRoleAttribute) as? String == kAXButtonRole && attr(item, kAXTitleAttribute) as? String == title { found.append(item) }
                    if depth < 4, let children = attr(item, kAXChildrenAttribute) as? [AXUIElement] {
                        try need(children.count <= 32, "review-children-unbounded"); queue += children.map { ($0, depth + 1) }
                    }
                }
                if found.count == 1 { selected = found[0]; selectedWindow = window }
            }
        }
        if selected == nil { Thread.sleep(forTimeInterval: 0.1) }
    }
    guard let button = selected, let window = selectedWindow else { throw Refusal(message: "native-review-button-unverified") }
    try need((attr(window, kAXModalAttribute) as? NSNumber)?.boolValue == true, "native-review-modal-unverified")
    let rootWindow = attr(button, kAXWindowAttribute)
    try need(rootWindow != nil && CFGetTypeID(rootWindow!) == AXUIElementGetTypeID()
        && CFEqual(rootWindow!, window) && (attr(button, kAXEnabledAttribute) as? NSNumber)?.boolValue == true, "native-review-window-or-enabled-refused")
    var actions: CFArray?
    try need(AXUIElementCopyActionNames(button, &actions) == .success && (actions as? [String])?.contains(kAXPressAction) == true, "native-review-press-unavailable")
    try helperIdentity(pid, parent, hash)
    let result = AXUIElementPerformAction(button, kAXPressAction as CFString)
    try need(result == .success, "native-review-press-refused-no-retry")
    emit(["diagnosticOnly": true, "retirementMutationAttempted": false, "nativeAXPress": true, "nativeModalVerified": true, "phase": phase, "pid": pid])
}
func archiveExperiment(_ folder: String, receipt: String) throws {
    _ = try experimentRoot(folder)
    try need(receipt == URL(fileURLWithPath: folder).deletingLastPathComponent().path + "/owned-process.json", "fixed-old-gui-receipt-required")
    _ = try image(receipt)
    guard let old = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: receipt))) as? [String: Any],
        let pid = old["pid"] as? Int32, let expected = old["image"] as? [String: Any], let hash = old["hash"] as? String,
        old["product"] as? String == "mcp" else { throw Refusal(message: "old-mcp-receipt-invalid") }
    let app = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Creator Works MCP.app").path
    let sourceDirectory = app + "/Contents/MacOS", sourceName = "creator-works-mcp-launcher", source = sourceDirectory + "/" + sourceName
    let archivedName = "creator-works-mcp-launcher.retained", archived = folder + "/" + archivedName
    let sourceFD = open(sourceDirectory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    let targetFD = open(folder, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    try need(sourceFD >= 0 && targetFD >= 0, "archive-directory-open-refused")
    defer { Darwin.close(sourceFD); Darwin.close(targetFD) }
    var sourceDir = stat(), targetDir = stat()
    try need(fstat(sourceFD, &sourceDir) == 0 && fstat(targetFD, &targetDir) == 0 && sourceDir.st_uid == getuid()
        && targetDir.st_uid == getuid() && sourceDir.st_dev == targetDir.st_dev, "archive-directory-ownership-or-volume-refused")
    func namespace() throws {
        var a = stat(), b = stat()
        try need(lstat(sourceDirectory, &a) == 0 && lstat(folder, &b) == 0
            && a.st_dev == sourceDir.st_dev && a.st_ino == sourceDir.st_ino && a.st_mode == sourceDir.st_mode
            && b.st_dev == targetDir.st_dev && b.st_ino == targetDir.st_ino && b.st_mode == targetDir.st_mode
            && URL(fileURLWithPath: sourceDirectory).resolvingSymlinksInPath().path == sourceDirectory, "archive-parent-namespace-drift")
    }
    func closed() throws {
        var state = proc_bsdinfo(); errno = 0
        let count = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &state, Int32(MemoryLayout<proc_bsdinfo>.size))
        try need(count == 0 && errno == ESRCH && NSRunningApplication.runningApplications(withBundleIdentifier: "com.creatorworks.unitymcp.preview").isEmpty,
            "old-mcp-kernel-or-native-app-not-absent")
    }
    try namespace(); try closed()
    let before = try image(source)
    try need(NSDictionary(dictionary: before).isEqual(to: expected) && before["sha256"] as? String == hash, "reviewed-gui-image-drift")
    NSApplication.shared.setActivationPolicy(.regular); NSApp.finishLaunching()
    try need(try review("cancel", folder: folder) == .alertFirstButtonReturn, "first-native-review-must-cancel")
    try need(NSDictionary(dictionary: try image(source)).isEqual(to: before), "cancel-mutated-gui")
    try exclusiveRecord(folder + "/cancelled.json", ["nativeCancel": true, "originalGuiUnchanged": true])
    try waitForBarrier(folder + "/cancel-verified.json", seconds: 30)
    try need(try review("approve", folder: folder) == .alertSecondButtonReturn, "native-archive-approval-declined")
    try namespace(); try closed()
    try need(NSDictionary(dictionary: try image(source)).isEqual(to: before), "gui-drift-after-native-review")
    try exclusiveRecord(folder + "/00-intent.json", ["nativeApproval": true, "temporaryExperiment": true, "source": source, "archive": archived, "image": before])
    var moved = false, restored = false
    do {
        let sentinel = try image(folder + "/collision-sentinel.bin")
        errno = 0
        let collision = renameatx_np(sourceFD, sourceName, targetFD, "collision-sentinel.bin", UInt32(RENAME_EXCL)), code = errno
        try need(collision == -1 && code == EEXIST && NSDictionary(dictionary: try image(source)).isEqual(to: before)
            && NSDictionary(dictionary: try image(folder + "/collision-sentinel.bin")).isEqual(to: sentinel), "native-no-overwrite-collision-refusal-unverified")
        try namespace(); try closed()
        try need(renameatx_np(sourceFD, sourceName, targetFD, archivedName, UInt32(RENAME_EXCL)) == 0, "exclusive-gui-only-archive-refused")
        moved = true
        try need(fsync(sourceFD) == 0 && fsync(targetFD) == 0 && NSDictionary(dictionary: try image(archived)).isEqual(to: before), "archived-gui-identity-or-sync-refused")
        try exclusiveRecord(folder + "/01-archived.json", ["nativeApproval": true, "guiOnlyArchived": true, "collisionRefused": true, "image": before])
        try waitForBarrier(folder + "/restore-now.json", seconds: 180)
    } catch {
        if moved {
            try namespace()
            try need(NSDictionary(dictionary: try image(archived)).isEqual(to: before)
                && renameatx_np(targetFD, archivedName, sourceFD, sourceName, UInt32(RENAME_EXCL)) == 0, "experiment-restore-refused-no-overwrite")
            restored = true; _ = fsync(sourceFD); _ = fsync(targetFD)
            try exclusiveRecord(folder + "/02-restored.json", ["restored": true, "afterFailure": true, "image": try image(source)])
        }
        throw error
    }
    if moved && !restored {
        try namespace()
        try need(NSDictionary(dictionary: try image(archived)).isEqual(to: before)
            && renameatx_np(targetFD, archivedName, sourceFD, sourceName, UInt32(RENAME_EXCL)) == 0, "experiment-restore-refused-no-overwrite")
        try need(fsync(sourceFD) == 0 && fsync(targetFD) == 0 && NSDictionary(dictionary: try image(source)).isEqual(to: before), "restore-image-or-sync-refused")
        try exclusiveRecord(folder + "/02-restored.json", ["restored": true, "afterFailure": false, "image": before])
    }
    emit(["diagnosticOnly": true, "retirementMutationAttempted": true, "temporaryGuiOnlyArchive": true, "restored": true, "productionAuthority": false])
}
func archivedLaunch(_ folder: String) throws {
    _ = try experimentRoot(folder)
    _ = try image(folder + "/01-archived.json")
    let app = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Creator Works MCP.app")
    try need(!FileManager.default.fileExists(atPath: app.path + "/Contents/MacOS/creator-works-mcp-launcher"), "gui-not-archived-no-launch-measurement")
    let config = NSWorkspace.OpenConfiguration(); config.activates = false; config.createsNewApplicationInstance = true
    var result: [String: Any]? = nil
    NSWorkspace.shared.openApplication(at: app, configuration: config) { native, error in
        var value: [String: Any] = ["diagnosticOnly": true, "retirementMutationAttempted": false,
            "launchReturnedApplication": native != nil]
        if let native = native { value["pid"] = native.processIdentifier; value["bundlePath"] = native.bundleURL?.path }
        if let error = error as NSError? { value["errorDomain"] = error.domain; value["errorCode"] = error.code; value["errorDescription"] = error.localizedDescription }
        result = value
    }
    let deadline = Date().addingTimeInterval(10)
    while result == nil && Date() < deadline { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1)) }
    guard let result = result else { throw Refusal(message: "native-launch-measurement-deadline") }
    emit(result)
}
do {
    try admitted()
    let args = Array(CommandLine.arguments.dropFirst())
    if args.count == 2 && args[0] == "archived-launch" {
        try archivedLaunch(args[1])
    } else if args.count == 5 && args[0] == "press-review", let pid = Int32(args[1]), let parent = UInt32(args[2]) {
        try pressReview(pid, parent, args[3], args[4])
    } else if args.count == 3 && args[0] == "archive-experiment" {
        try archiveExperiment(args[1], receipt: args[2])
    } else if args.count == 2 && args[0] == "registration" {
        let (_, _, bundle) = try spec(args[1])
        let urls = LSCopyApplicationURLsForBundleIdentifier(bundle as CFString, nil)?.takeRetainedValue() as? [URL] ?? []
        try need(urls.count <= 32, "registration-inventory-unbounded")
        emit(["diagnosticOnly": true, "retirementMutationAttempted": false, "bundle": bundle,
            "registeredPaths": urls.map { $0.path }, "registrationRemovalAuthority": false])
    } else if args.count == 5 && args[0] == "inspect", let pid = Int32(args[2]), let parent = UInt32(args[3]) {
        emit(try inspect(args[1], pid, parent, args[4]))
    } else if args.count == 2 && args[0] == "close" {
        let filename = args[1], temporary = URL(fileURLWithPath: environment["RUNNER_TEMP"] ?? "").resolvingSymlinksInPath().path
        try need(filename.hasPrefix(temporary + "/macos-legacy-retirement-probe/") && filename.hasSuffix("/owned-process.json")
            && URL(fileURLWithPath: filename).resolvingSymlinksInPath().path == filename, "receipt-outside-owned-probe")
        _ = try image(filename)
        let data = try Data(contentsOf: URL(fileURLWithPath: filename)); try need(data.count <= 8192, "receipt-unbounded")
        guard let original = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let product = original["product"] as? String, let pid = original["pid"] as? Int32,
            let parent = original["parent"] as? UInt32, let hash = original["hash"] as? String else {
            throw Refusal(message: "receipt-invalid")
        }
        let observed = try inspect(product, pid, parent, hash)
        try need(NSDictionary(dictionary: observed).isEqual(to: original) && observed["ready"] as? Bool == true,
            "owned-process-or-image-drift-no-close")
        guard let native = NSRunningApplication(processIdentifier: pid) else { throw Refusal(message: "native-app-absent") }
        // Normal AppKit Quit only. Both public tags guard RunEvent::ExitRequested.
        let accepted = native.terminate()
        emit(["diagnosticOnly": true, "retirementMutationAttempted": false, "requestAccepted": accepted,
            "method": "NSRunningApplication.terminate", "pid": pid, "exitNotYetVerified": true])
    } else { throw Refusal(message: "fixed-operation-required") }
} catch {
    emit(["diagnosticOnly": true, "retirementMutationAttempted": false,
        "error": (error as? Refusal)?.message ?? String(describing: error)])
    exit(1)
}
