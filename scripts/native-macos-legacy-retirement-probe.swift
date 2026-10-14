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
do {
    try admitted()
    let args = Array(CommandLine.arguments.dropFirst())
    if args.count == 2 && args[0] == "registration" {
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
