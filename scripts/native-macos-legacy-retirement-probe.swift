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
    try need(environment["CREATOR_MACOS_LEGACY_STANDARD_TRASH_EXPERIMENT"] == "1", "standard-trash-experiment-opt-in-required")
    let temporary = URL(fileURLWithPath: environment["RUNNER_TEMP"] ?? "").resolvingSymlinksInPath().path
    try need(folder == temporary + "/macos-legacy-retirement-probe/mcp/standard-trash-experiment"
        && URL(fileURLWithPath: folder).resolvingSymlinksInPath().path == folder, "fixed-experiment-folder-required")
    return folder
}
func directoryImage(_ filename: String) throws -> [String: Any] {
    var value = stat()
    try need(lstat(filename, &value) == 0 && value.st_mode & S_IFMT == S_IFDIR && value.st_uid == getuid()
        && URL(fileURLWithPath: filename).resolvingSymlinksInPath().path == filename, "owned-ordinary-bundle-directory-required")
    return ["device": String(value.st_dev), "inode": String(value.st_ino), "mode": String(value.st_mode),
        "uid": value.st_uid, "links": String(value.st_nlink)]
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
    alert.messageText = "MCP standard Trash experiment"
    alert.informativeText = "Disposable runner only. Use FileManager's standard Trash operation on the complete pinned Creator Works MCP.app, verify the returned Trash URL and launch refusal, then restore the exact bundle without overwrite. Trash will NOT be emptied. Old Node/server paths will be absent. This test does NOT migrate clients; real cleanup must first back up and migrate recognized clients to the verified Hub router and stop for unknown or unmigrated connections. Cancel leaves the app unchanged."
    alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "Move to Trash")
    alert.window.title = "MCP standard Trash experiment"
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
    try need(environment["CREATOR_MACOS_LEGACY_STANDARD_TRASH_EXPERIMENT"] == "1" && ["cancel", "approve"].contains(phase), "fixed-review-phase-required")
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
            if attr(window, kAXTitleAttribute) as? String == "MCP standard Trash experiment" {
                var queue = [(window, 0)], found = [AXUIElement](), count = 0
                while !queue.isEmpty && count < 32 {
                    let (item, depth) = queue.removeFirst(); count += 1
                    var owner: pid_t = 0
                    try need(AXUIElementGetPid(item, &owner) == .success && owner == pid, "foreign-native-review-control")
                    let title = phase == "cancel" ? "Cancel" : "Move to Trash"
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
func trashExperiment(_ folder: String, receipt: String) throws {
    _ = try experimentRoot(folder)
    try need(receipt == URL(fileURLWithPath: folder).deletingLastPathComponent().path + "/owned-process.json", "fixed-old-gui-receipt-required")
    _ = try image(receipt)
    guard let old = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: receipt))) as? [String: Any],
        let pid = old["pid"] as? Int32, let expected = old["image"] as? [String: Any], let hash = old["hash"] as? String,
        old["product"] as? String == "mcp" else { throw Refusal(message: "old-mcp-receipt-invalid") }
    let app = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Creator Works MCP.app").path
    let sourceDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path
    let sourceName = "Creator Works MCP.app", source = app
    let trashRoot = try FileManager.default.url(for: .trashDirectory, in: .userDomainMask,
        appropriateFor: URL(fileURLWithPath: source), create: true)
    let targetDirectory = trashRoot.path
    _ = try directoryImage(targetDirectory)
    let guiSuffix = "/Contents/MacOS/creator-works-mcp-launcher"
    let sourceFD = open(sourceDirectory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    let targetFD = open(targetDirectory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    try need(sourceFD >= 0 && targetFD >= 0, "trash-directory-open-refused")
    defer { Darwin.close(sourceFD); Darwin.close(targetFD) }
    var sourceDir = stat(), targetDir = stat()
    try need(fstat(sourceFD, &sourceDir) == 0 && fstat(targetFD, &targetDir) == 0 && sourceDir.st_uid == getuid()
        && targetDir.st_uid == getuid() && sourceDir.st_dev == targetDir.st_dev, "trash-directory-ownership-or-volume-refused")
    func namespace() throws {
        var a = stat(), b = stat()
        try need(lstat(sourceDirectory, &a) == 0 && lstat(targetDirectory, &b) == 0
            && a.st_dev == sourceDir.st_dev && a.st_ino == sourceDir.st_ino && a.st_mode == sourceDir.st_mode
            && b.st_dev == targetDir.st_dev && b.st_ino == targetDir.st_ino && b.st_mode == targetDir.st_mode
            && URL(fileURLWithPath: sourceDirectory).resolvingSymlinksInPath().path == sourceDirectory
            && URL(fileURLWithPath: targetDirectory).resolvingSymlinksInPath().path == targetDirectory, "trash-parent-namespace-drift")
    }
    func closed() throws {
        var state = proc_bsdinfo(); errno = 0
        let count = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &state, Int32(MemoryLayout<proc_bsdinfo>.size))
        try need(count == 0 && errno == ESRCH && NSRunningApplication.runningApplications(withBundleIdentifier: "com.creatorworks.unitymcp.preview").isEmpty,
            "old-mcp-kernel-or-native-app-not-absent")
    }
    try namespace(); try closed()
    let before = try image(source + guiSuffix), beforeBundle = try directoryImage(source)
    try need(NSDictionary(dictionary: before).isEqual(to: expected) && before["sha256"] as? String == hash, "reviewed-gui-image-drift")
    NSApplication.shared.setActivationPolicy(.regular); NSApp.finishLaunching()
    try need(try review("cancel", folder: folder) == .alertFirstButtonReturn, "first-native-review-must-cancel")
    try need(NSDictionary(dictionary: try image(source + guiSuffix)).isEqual(to: before)
        && NSDictionary(dictionary: try directoryImage(source)).isEqual(to: beforeBundle), "cancel-mutated-bundle")
    try exclusiveRecord(folder + "/cancelled.json", ["nativeCancel": true, "originalGuiUnchanged": true])
    try waitForBarrier(folder + "/cancel-verified.json", seconds: 30)
    try need(try review("approve", folder: folder) == .alertSecondButtonReturn, "native-trash-approval-declined")
    try namespace(); try closed()
    try need(NSDictionary(dictionary: try image(source + guiSuffix)).isEqual(to: before)
        && NSDictionary(dictionary: try directoryImage(source)).isEqual(to: beforeBundle), "bundle-drift-after-native-review")
    try exclusiveRecord(folder + "/00-intent.json", ["nativeApproval": true, "temporaryExperiment": true, "source": source, "trashRoot": targetDirectory,
        "image": before, "bundleDirectory": beforeBundle, "originalRuntimePathsPreserved": false, "clientsMigrated": false])
    var returnedURL: URL? = nil
    func restore(_ afterFailure: Bool) throws {
        guard let trashed = returnedURL else { return }
        try namespace()
        try need(trashed.deletingLastPathComponent().path == targetDirectory
            && NSDictionary(dictionary: try image(trashed.path + guiSuffix)).isEqual(to: before)
            && NSDictionary(dictionary: try directoryImage(trashed.path)).isEqual(to: beforeBundle)
            && renameatx_np(targetFD, trashed.lastPathComponent, sourceFD, sourceName, UInt32(RENAME_EXCL)) == 0,
            "trash-experiment-restore-refused-no-overwrite")
        try need(fsync(sourceFD) == 0 && fsync(targetFD) == 0
            && NSDictionary(dictionary: try image(source + guiSuffix)).isEqual(to: before)
            && NSDictionary(dictionary: try directoryImage(source)).isEqual(to: beforeBundle), "restore-image-or-sync-refused")
        try exclusiveRecord(folder + "/02-restored.json", ["restored": true, "afterFailure": afterFailure, "image": before, "bundleDirectory": beforeBundle])
    }
    do {
        try namespace(); try closed()
        var result: NSURL? = nil
        try FileManager.default.trashItem(at: URL(fileURLWithPath: source), resultingItemURL: &result)
        guard let result = result else { throw Refusal(message: "standard-trash-returned-url-unavailable") }
        returnedURL = result as URL
        var relationship = FileManager.URLRelationship.other
        try FileManager.default.getRelationship(&relationship, of: .trashDirectory, in: .userDomainMask, toItemAt: result as URL)
        try need(relationship == .contains && returnedURL!.deletingLastPathComponent().path == targetDirectory
            && !FileManager.default.fileExists(atPath: source)
            && NSDictionary(dictionary: try image(returnedURL!.path + guiSuffix)).isEqual(to: before)
            && NSDictionary(dictionary: try directoryImage(returnedURL!.path)).isEqual(to: beforeBundle), "standard-trash-location-or-original-identity-unverified")
        try need(fsync(sourceFD) == 0 && fsync(targetFD) == 0, "standard-trash-directory-sync-refused")
        try exclusiveRecord(folder + "/01-trashed.json", ["nativeApproval": true, "standardTrash": true,
            "trashPath": returnedURL!.path, "trashURL": returnedURL!.absoluteString, "nativeTrashRelationship": "contains",
            "image": before, "bundleDirectory": beforeBundle, "originalRuntimePathsPreserved": false, "clientsMigrated": false])
        try waitForBarrier(folder + "/restore-now.json", seconds: 180)
    } catch {
        try restore(true)
        throw error
    }
    try restore(false)
    emit(["diagnosticOnly": true, "retirementMutationAttempted": true, "standardTrash": true, "restored": true, "productionAuthority": false])
}
func trashLaunch(_ folder: String, location: String) throws {
    _ = try experimentRoot(folder)
    _ = try image(folder + "/01-trashed.json")
    let old = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Creator Works MCP.app")
    try need(!FileManager.default.fileExists(atPath: old.path), "old-app-url-still-present-no-launch-measurement")
    guard let record = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: folder + "/01-trashed.json"))) as? [String: Any],
        let trashPath = record["trashPath"] as? String else { throw Refusal(message: "standard-trash-result-required") }
    let trashed = URL(fileURLWithPath: trashPath)
    var relationship = FileManager.URLRelationship.other
    try FileManager.default.getRelationship(&relationship, of: .trashDirectory, in: .userDomainMask, toItemAt: trashed)
    try need(relationship == .contains && ["old", "trash"].contains(location), "native-trash-launch-scope-refused")
    let app = location == "old" ? old : trashed
    let config = NSWorkspace.OpenConfiguration(); config.activates = false; config.createsNewApplicationInstance = true
    var result: [String: Any]? = nil
    NSWorkspace.shared.openApplication(at: app, configuration: config) { native, error in
        var value: [String: Any] = ["diagnosticOnly": true, "retirementMutationAttempted": false,
            "launchReturnedApplication": native != nil]
        if let native = native { value["pid"] = native.processIdentifier; value["bundlePath"] = native.bundleURL?.path }
        var errors = [[String: Any]](), current = error as NSError?
        while let observed = current, errors.count < 4 {
            errors.append(["domain": observed.domain, "code": observed.code, "description": observed.localizedDescription])
            current = observed.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        value["errors"] = errors; value["location"] = location; value["launchPath"] = app.path
        value["trashPolicyError"] = errors.contains { ($0["domain"] as? String) == NSOSStatusErrorDomain && ($0["code"] as? Int) == Int(kLSAppInTrashErr) }
        result = value
    }
    let deadline = Date().addingTimeInterval(10)
    while result == nil && Date() < deadline { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1)) }
    guard let result = result else { throw Refusal(message: "native-launch-measurement-deadline") }
    var receipt = result
    receipt["runningLegacyGuiPIDsAfter"] = NSRunningApplication.runningApplications(withBundleIdentifier: "com.creatorworks.unitymcp.preview").map { $0.processIdentifier }
    emit(receipt)
}
do {
    try admitted()
    let args = Array(CommandLine.arguments.dropFirst())
    if args.count == 3 && args[0] == "trash-launch" {
        try trashLaunch(args[1], location: args[2])
    } else if args.count == 5 && args[0] == "press-review", let pid = Int32(args[1]), let parent = UInt32(args[2]) {
        try pressReview(pid, parent, args[3], args[4])
    } else if args.count == 3 && args[0] == "trash-experiment" {
        try trashExperiment(args[1], receipt: args[2])
    } else if args.count == 2 && args[0] == "registration" {
        let (_, _, bundle) = try spec(args[1])
        let urls = LSCopyApplicationURLsForBundleIdentifier(bundle as CFString, nil)?.takeRetainedValue() as? [URL] ?? []
        let preferred = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle)
        try need(urls.count <= 32, "registration-inventory-unbounded")
        emit(["diagnosticOnly": true, "retirementMutationAttempted": false, "bundle": bundle,
            "registeredPaths": urls.map { $0.path }, "registeredPathExists": urls.map { FileManager.default.fileExists(atPath: $0.path) },
            "workspacePreferredPath": preferred?.path as Any? ?? NSNull(), "registrationRemovalAuthority": false])
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
