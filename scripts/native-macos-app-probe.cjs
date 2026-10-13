const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const bundle = 'com.creatorworks.hub';
const acceptance = Object.freeze({ nativeGuiAccepted: false, mcpAccepted: false, migrationAccepted: false,
  updateAccepted: false, releaseReady: false });
function requireThat(value, message) { if (!value) throw Error(message); }
function admission(env, platform, arch) {
  requireThat(platform === 'darwin' && ['arm64', 'x64'].includes(arch), 'native-matching-mac-required');
  requireThat(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.RUNNER_OS === 'macOS' && env.GITHUB_REPOSITORY === 'BOBWORKS-XR/CREATOR-HUB'
    && env.CREATOR_MACOS_OWNED_GUI_TEST === '1' && env.CREATOR_MACOS_APP_PROBE === '1', 'hosted-ci-explicit-opt-in-required');
  requireThat(env.RUNNER_ARCH === (arch === 'arm64' ? 'ARM64' : 'X64'), 'runner-architecture-mismatch');
}
function options(args) {
  requireThat(args.length === 6 && args[0] === '--app' && args[2] === '--hub-sha256' && args[4] === '--output',
    'expected --app APP_PATH --hub-sha256 INDEPENDENT_SHA256 --output NEW_DIRECTORY');
  requireThat(/^[a-f0-9]{64}$/.test(args[3]), 'independent-hub-sha256-required');
  return { app: args[1], hubSha256: args[3], output: args[5] };
}
function inside(root, value) { return value.startsWith(root + path.sep); }
function canonical(value) {
  requireThat(path.isAbsolute(value) && path.normalize(value) === value && !/[\x00-\x1f]/.test(value), 'absolute-canonical-path-required');
  requireThat(fs.realpathSync(value) === value, 'linked-or-redirected-path-refused');
  return value;
}
function reserveOutput(temporary, app, output) {
  requireThat(path.isAbsolute(output) && path.normalize(output) === output && !/[\x00-\x1f]/.test(output), 'new-absolute-output-required');
  canonical(path.dirname(output)); requireThat(inside(temporary, output), 'output-outside-runner-temp');
  requireThat(output !== app && !inside(app, output) && !inside(output, app), 'output-must-not-modify-the-pinned-app');
  fs.mkdirSync(output, { mode: 0o700 });
  return canonical(output);
}
function pin(file, max = 128 * 1024 * 1024, contents = false) {
  canonical(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    requireThat(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(max)
      && (typeof process.getuid !== 'function' || before.uid === BigInt(process.getuid())), 'file-ownership-type-or-size-refused');
    const hash = crypto.createHash('sha256'), chunks = [], buffer = Buffer.alloc(65536);
    let length = 0, head;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      length += count; requireThat(length <= max, 'file-grew');
      const bytes = buffer.subarray(0, count); hash.update(bytes);
      if (!head) head = Buffer.from(bytes.subarray(0, 64));
      if (contents) chunks.push(Buffer.from(bytes));
    }
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
    for (const key of ['dev', 'ino', 'size', 'uid', 'nlink', 'mode', 'mtimeNs']) {
      requireThat(before[key] === after[key] && after[key] === named[key], 'file-identity-drift');
    }
    requireThat(length === Number(after.size), 'file-length-drift');
    return { image: { sha256: hash.digest('hex'), device: String(after.dev), inode: String(after.ino), size: length,
      modifiedSeconds: Number(after.mtimeNs / 1000000000n), modifiedNanoseconds: Number(after.mtimeNs % 1000000000n), uid: Number(after.uid) },
    head, ...(contents ? { bytes: Buffer.concat(chunks) } : {}) };
  } finally { fs.closeSync(fd); }
}
function sameImage(actual, expected) {
  return actual && Object.keys(expected).every(key => actual[key] === expected[key]);
}
function validateOwner(owner, expected) {
  const p = owner?.process, w = owner?.window, b = w?.bounds;
  requireThat(p?.pid === expected.pid && p.executablePath === expected.executable && p.bundlePath === expected.app
    && p.bundleIdentifier === bundle && Number.isSafeInteger(p.startSeconds) && p.startSeconds > 0
    && Number.isSafeInteger(p.startMicroseconds) && p.startMicroseconds >= 0 && p.startMicroseconds < 1000000
    && sameImage(p.image, expected.image) && sameImage(p.infoPlist, expected.infoPlist), 'owned-root-process-or-file-drift');
  requireThat(Number.isSafeInteger(w?.id) && w.id > 0 && w.pid === p.pid && b
    && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(b[key]))
    && Math.abs(b.x) <= 32768 && Math.abs(b.y) <= 32768 && b.width > 0 && b.height > 0
    && b.width <= 16384 && b.height <= 16384, 'owned-root-window-bounds-unverified');
}
function privateProfile(output) {
  const home = path.join(output, 'private-home');
  for (const name of ['', 'Library', 'Library/Application Support', 'Library/Caches', 'Library/Preferences', '.config', '.local', '.local/share', '.cache', 'tmp']) {
    fs.mkdirSync(path.join(home, name), { mode: 0o700 });
  }
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: path.join(home, 'tmp') + '/',
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache') };
}
function acceptedExit(close, exit, owner) {
  const before = close?.before, after = close?.after;
  const bound = !!owner && isDeepStrictEqual(before?.process, owner.process) && isDeepStrictEqual(before?.window, owner.window)
    && before.accessibilityTrusted === true && before.active === true && before.truncated === false
    && isDeepStrictEqual(after?.process, owner.process) && after.accessibilityTrusted === true && after.truncated === false
    && (isDeepStrictEqual(after.window, owner.window) || after.window === null && after.windowMissingVerified === true);
  return close?.action === 'close-window' && close.axAction === 'AXPress' && close.actionAttempted === true
    && close.postIdentityVerified === true && close.forceKillPerformed === false && close.permissionRequestsPerformed === false
    && !close.error && !close.postProcessStatus && bound && exit?.pid === owner.process.pid
    && exit.code === 0 && exit.signal === null && !exit.error;
}
function closeAssessment(close, exit, owner) {
  const p = owner?.process, status = close?.postProcessStatus;
  const callerOwnedExit0 = !!p && exit?.pid === p.pid && exit.code === 0 && exit.signal === null && !exit.error;
  const bound = !!p && status?.pid === p.pid && status.expectedStartSeconds === p.startSeconds
    && status.expectedStartMicroseconds === p.startMicroseconds;
  return { callerOwnedExit0, helperPostIdentityVerified: close?.postIdentityVerified === true,
    postProcessState: bound && ['absent', 'same-kernel-process', 'different-process', 'unavailable'].includes(status.state) ? status.state : 'unknown',
    closeAccepted: callerOwnedExit0 && acceptedExit(close, exit, owner), diagnosticOnly: true };
}
function bitmapArguments(id, file) {
  requireThat(Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff, 'bitmap-exact-window-id-required');
  requireThat(path.isAbsolute(file) && path.normalize(file) === file && file.endsWith('.png') && !/[\x00-\x1f]/.test(file), 'bitmap-owned-png-path-required');
  return ['-l', String(id), '-x', file];
}
async function windowBitmapDiagnostic(owner, io) {
  const result = { diagnosticOnly: true, attempted: false, completed: false, ...acceptance };
  const verify = receipt => requireThat(receipt?.command === 'bitmap-fence' && receipt.screenCaptureAccess === true
    && receipt.cgWindowFenceVerified === true && receipt.permissionRequestsPerformed === false && receipt.actionAttempted === false
    && isDeepStrictEqual(receipt.process, owner.process) && isDeepStrictEqual(receipt.window, owner.window), 'bitmap-owned-root-fence-unverified');
  try {
    result.before = await io.fence('before');
    if (result.before?.screenCaptureAccess === false) { result.reason = 'screen-capture-permission-unavailable'; return result; }
    verify(result.before);
    result.attempted = true;
    let captureError;
    try { result.capture = await io.capture(owner.window.id); } catch (error) { captureError = error; }
    result.after = await io.fence('after'); verify(result.after);
    if (captureError) throw captureError;
    requireThat(result.capture?.exitCode === 0 && result.capture.signal === null && !result.capture.timedOut && !result.capture.error, 'bitmap-tool-capture-unverified');
    result.image = io.image(); result.completed = true;
  } catch (error) { result.reason = error.message; }
  return result;
}
function bitmapImage(file) {
  const image = pin(file, 32 * 1024 * 1024), head = image.head;
  requireThat(head.length >= 24 && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && head.readUInt32BE(8) === 13 && head.subarray(12, 16).toString('ascii') === 'IHDR', 'bitmap-png-header-unverified');
  const width = head.readUInt32BE(16), height = head.readUInt32BE(20);
  requireThat(width > 0 && height > 0 && width <= 32768 && height <= 32768, 'bitmap-dimensions-unverified');
  return { ...image.image, width, height };
}

// A separate read-only sampler is needed because the unchanged action helper emits only fixed consent controls.
const surfaceSource = String.raw`
import Foundation
import ApplicationServices
import CoreGraphics
import Darwin
import CryptoKit
struct Denied: Error { let reason: String; init(_ reason: String) { self.reason = reason } }
var rows = [[String: Any]]()
var changedSnapshots = [[String: Any]](), readiness = [String: Any](), rootRevision = 0
var nativeRootSnapshot = [String: Any]()
func check(_ condition: Bool, _ reason: String) throws { if !condition { throw Denied(reason) } }
func emit(_ input: [String: Any]) {
    var value = input
    for key in ["nativeGuiAccepted", "mcpAccepted", "migrationAccepted", "updateAccepted", "releaseReady"] { value[key] = false }
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) { print(String(decoding: data, as: UTF8.self)) }
}
func admitted() throws {
    let env = ProcessInfo.processInfo.environment
    try check(env["GITHUB_ACTIONS"] == "true" && env["RUNNER_ENVIRONMENT"] == "github-hosted" && env["RUNNER_OS"] == "macOS"
        && env["GITHUB_REPOSITORY"] == "BOBWORKS-XR/CREATOR-HUB" && env["CREATOR_MACOS_OWNED_GUI_TEST"] == "1"
        && env["CREATOR_MACOS_APP_PROBE"] == "1", "hosted-ci-explicit-opt-in-required")
    #if arch(arm64)
    try check(env["RUNNER_ARCH"] == "ARM64", "runner-architecture-mismatch")
    #elseif arch(x86_64)
    try check(env["RUNNER_ARCH"] == "X64", "runner-architecture-mismatch")
    #else
    throw Denied("unsupported-native-architecture")
    #endif
}
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    AXUIElementSetMessagingTimeout(element, 0.2)
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func bounds(_ item: AXUIElement) throws -> [String: Double] {
    guard let position = attr(item, kAXPositionAttribute), let size = attr(item, kAXSizeAttribute),
        CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { throw Denied("ax-bounds-unavailable") }
    var point = CGPoint.zero, extent = CGSize.zero
    try check(AXValueGetValue(position as! AXValue, .cgPoint, &point) && AXValueGetValue(size as! AXValue, .cgSize, &extent), "ax-bounds-unavailable")
    return ["x": Double(point.x), "y": Double(point.y), "width": Double(extent.width), "height": Double(extent.height)]
}
func children(_ item: AXUIElement, _ name: String) throws -> [AXUIElement] {
    var count = 0
    AXUIElementSetMessagingTimeout(item, 0.2)
    let status = AXUIElementGetAttributeValueCount(item, name as CFString, &count)
    if status == .noValue || status == .attributeUnsupported { return [] }
    try check(status == .success && count >= 0 && count <= 512, "ax-children-unbounded-or-unreadable")
    if count == 0 { return [] }
    var array: CFArray?
    guard AXUIElementCopyAttributeValues(item, name as CFString, 0, count, &array) == .success,
        let result = array as? [AXUIElement], result.count == count else { throw Denied("ax-children-unreadable") }
    return result
}
func pidMatches(_ item: AXUIElement, _ expected: Int32) throws {
    var pid: pid_t = 0
    try check(AXUIElementGetPid(item, &pid) == .success && pid == expected, "foreign-ax-pid")
}
func imageMatches(_ name: String, _ expected: [String: Any], _ limit: Int) throws {
    let fd = open(name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    try check(fd >= 0, "image-open-refused"); defer { Darwin.close(fd) }
    var before = stat(), after = stat(), named = stat()
    try check(fstat(fd, &before) == 0 && before.st_mode & S_IFMT == S_IFREG && before.st_uid == getuid()
        && before.st_nlink == 1 && before.st_size > 0 && before.st_size <= Int64(limit), "image-type-owner-or-size-refused")
    var hash = SHA256(), total = 0, buffer = [UInt8](repeating: 0, count: 65536)
    while true {
        let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
        try check(count >= 0, "image-read-failed"); if count == 0 { break }
        total += count; try check(total <= limit, "image-grew"); hash.update(data: Data(buffer.prefix(count)))
    }
    try check(fstat(fd, &after) == 0 && lstat(name, &named) == 0 && before.st_dev == after.st_dev && before.st_ino == after.st_ino
        && before.st_size == after.st_size && after.st_size == Int64(total) && before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec
        && before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec && named.st_dev == after.st_dev && named.st_ino == after.st_ino
        && named.st_mode & S_IFMT == S_IFREG && after.st_uid == getuid() && after.st_nlink == 1, "image-drift")
    try check(expected["sha256"] as? String == hash.finalize().map { String(format: "%02x", $0) }.joined()
        && expected["device"] as? String == String(after.st_dev) && expected["inode"] as? String == String(after.st_ino)
        && (expected["size"] as? NSNumber)?.int64Value == after.st_size, "pinned-image-drift")
}
func fence(_ p: [String: Any], _ parent: UInt32) throws {
    guard let pid = (p["pid"] as? NSNumber)?.int32Value, let exe = p["executablePath"] as? String,
        let app = p["bundlePath"] as? String, let image = p["image"] as? [String: Any], let plist = p["infoPlist"] as? [String: Any] else { throw Denied("owner-process-invalid") }
    var info = proc_bsdinfo(), name = [CChar](repeating: 0, count: 4096)
    try check(pid > 0 && proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size)
        && info.pbi_pid == UInt32(pid) && info.pbi_ppid == parent && info.pbi_uid == getuid() && info.pbi_ruid == getuid()
        && info.pbi_start_tvsec == (p["startSeconds"] as? NSNumber)?.uint64Value
        && info.pbi_start_tvusec == (p["startMicroseconds"] as? NSNumber)?.uint64Value, "owned-process-start-drift")
    let length = name.withUnsafeMutableBytes { proc_pidpath(pid, $0.baseAddress, UInt32($0.count)) }
    try check(length > 0 && Int(length) < name.count && name[Int(length)] == 0 && String(cString: name) == exe, "kernel-executable-drift")
    try imageMatches(exe, image, 128 * 1024 * 1024)
    try imageMatches(app + "/Contents/Info.plist", plist, 65536)
}
do {
    try admitted()
    let args = Array(CommandLine.arguments.dropFirst())
    if args == ["availability"] { emit(["accessibilityTrusted": AXIsProcessTrusted(), "readOnly": true]); exit(0) }
    let bitmap = args.first == "bitmap-fence"
    if bitmap {
        try check(args.count == 3, "bitmap-fence-owner-parent-required")
        if !CGPreflightScreenCaptureAccess() {
            emit(["command": "bitmap-fence", "screenCaptureAccess": false, "cgWindowFenceVerified": false,
                  "diagnosticOnly": true, "actionAttempted": false, "permissionRequestsPerformed": false]); exit(0)
        }
    } else { try check(args.count == 2 && AXIsProcessTrusted(), "accessibility-or-owner-required") }
    guard let parent = UInt32(args[bitmap ? 2 : 1]), parent > 0 else { throw Denied("owned-parent-required") }
    let file = args[bitmap ? 1 : 0], env = ProcessInfo.processInfo.environment
    try check(file.hasPrefix((env["RUNNER_TEMP"] ?? "invalid") + "/") && URL(fileURLWithPath: file).resolvingSymlinksInPath().path == file, "owner-path-refused")
    let fd = open(file, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    try check(fd >= 0, "owner-open-refused"); let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    var meta = stat()
    try check(fstat(fd, &meta) == 0 && meta.st_mode & S_IFMT == S_IFREG && meta.st_uid == getuid() && meta.st_nlink == 1 && meta.st_size <= 8192, "owner-file-refused")
    let data = try handle.read(upToCount: 8193) ?? Data()
    guard data.count <= 8192, let owner = try JSONSerialization.jsonObject(with: data) as? [String: Any], Set(owner.keys) == Set(["process", "window"]),
        let p = owner["process"] as? [String: Any], let w = owner["window"] as? [String: Any], let expected = w["bounds"] as? [String: Double],
        let pid = (p["pid"] as? NSNumber)?.int32Value, let id = (w["id"] as? NSNumber)?.uint32Value else { throw Denied("owner-schema-refused") }
    try check((w["pid"] as? NSNumber)?.int32Value == pid && p["bundleIdentifier"] as? String == "com.creatorworks.hub"
        && ["x", "y", "width", "height"].allSatisfy { expected[$0]?.isFinite == true }
        && (expected["width"] ?? 0) > 0 && (expected["height"] ?? 0) > 0, "root-owner-refused")
    try fence(p, parent)
    func checkCG() throws {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow, .excludeDesktopElements], id) as? [[String: Any]] else { throw Denied("cg-window-unavailable") }
        let found = list.filter { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id }
        guard found.count == 1, let row = found.first, (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
            (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0, (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true,
            ((row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0) > 0,
            let raw = row[kCGWindowBounds as String] as? [String: Any], let b = CGRect(dictionaryRepresentation: raw as CFDictionary) else { throw Denied("cg-window-owner-drift") }
        try check(["x": Double(b.minX), "y": Double(b.minY), "width": Double(b.width), "height": Double(b.height)] == expected, "root-bounds-drift")
    }
    try checkCG()
    if bitmap {
        try fence(p, parent); try checkCG()
        emit(["command": "bitmap-fence", "screenCaptureAccess": true, "cgWindowFenceVerified": true,
              "process": p, "window": w, "diagnosticOnly": true, "actionAttempted": false,
              "permissionRequestsPerformed": false]); exit(0)
    }
    let root = AXUIElementCreateApplication(pid)
    let matches = try children(root, kAXWindowsAttribute).filter { item in
        try pidMatches(item, pid)
        try check(attr(item, kAXRoleAttribute) as? String == kAXWindowRole, "ax-window-role-unverified")
        return try bounds(item) == expected
    }
    try check(matches.count == 1, "ax-root-window-ambiguous")
    let window = matches[0], readinessDeadline = ProcessInfo.processInfo.systemUptime + 20
    nativeRootSnapshot = ["process": p, "window": w, "rootNativeCFReferencePinned": true]
    var deadline = ProcessInfo.processInfo.systemUptime + 4
    var seen = [AXUIElement]()
    var observer: AXObserver?
    let observerStatus = AXObserverCreate(pid, { _, _, _, _ in rootRevision += 1 }, &observer)
    var supported = [String]()
    if observerStatus == .success, let observer = observer {
        for item in [root, window] {
            for notification in [kAXLayoutChangedNotification, kAXCreatedNotification] {
                if AXObserverAddNotification(observer, item, notification as CFString, nil) == .success { supported.append(notification) }
            }
        }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), CFRunLoopMode.defaultMode)
    }
    defer {
        if let observer = observer { CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), CFRunLoopMode.defaultMode) }
    }
    readiness = ["rootWebAreaObserved": false, "notificationsSupported": supported, "observerStatus": observerStatus.rawValue,
                 "changesOnly": true, "rootNativeCFReferencePreserved": true]
    let labelRoles = Set(["AXWindow", "AXWebArea", "AXGroup", "AXHeading", "AXStaticText", "AXButton", "AXCheckBox", "AXRadioButton", "AXLink", "AXTab", "AXTabGroup"])
    func visit(_ item: AXUIElement, _ depth: Int, _ path: String) throws {
        try check(depth <= 16 && seen.count < 512 && ProcessInfo.processInfo.systemUptime < deadline, "ax-surface-incomplete")
        if seen.contains(where: { CFEqual($0, item) }) { return }
        seen.append(item); try pidMatches(item, pid)
        if !CFEqual(item, window), let linked = attr(item, kAXWindowAttribute) {
            try check(CFGetTypeID(linked) == AXUIElementGetTypeID() && CFEqual(linked as! AXUIElement, window), "foreign-ax-window")
        }
        guard let role = attr(item, kAXRoleAttribute) as? String else { throw Denied("ax-role-unreadable") }
        let b = try? bounds(item)
        let contained = b.map { $0["width"]! > 0 && $0["height"]! > 0 && $0["x"]! >= expected["x"]! && $0["y"]! >= expected["y"]!
            && $0["x"]! + $0["width"]! <= expected["x"]! + expected["width"]! && $0["y"]! + $0["height"]! <= expected["y"]! + expected["height"]! } ?? false
        var row: [String: Any] = ["path": path, "role": role, "pid": pid, "windowID": id, "withinRootBounds": contained]
        if let b = b { row["bounds"] = b }
        if contained && labelRoles.contains(role) {
            for (key, attribute) in [("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute)] {
                if let text = attr(item, attribute) as? String {
                    try check(text.utf8.count <= 2048, "ax-label-too-large"); row[key] = text
                }
            }
        }
        rows.append(row)
        for (index, child) in try children(item, kAXChildrenAttribute).enumerated() { try visit(child, depth + 1, path + "/" + String(index)) }
    }
    var previousSnapshot: Data?, observedRevision = -1, observationCount = 0
    while ProcessInfo.processInfo.systemUptime < readinessDeadline {
        if observedRevision != rootRevision {
            try check(observationCount < 32, "root-readiness-change-limit")
            observationCount += 1
            deadline = min(readinessDeadline, ProcessInfo.processInfo.systemUptime + 4)
            try fence(p, parent); try checkCG()
            let current = try children(root, kAXWindowsAttribute).filter { item in
                try pidMatches(item, pid)
                return try bounds(item) == expected
            }
            let unchanged = current.count == 1 && CFEqual(current[0], window)
            readiness["rootNativeCFReferencePreserved"] = unchanged
            try check(unchanged, "root-native-cf-reference-drift")
            rows = []; seen = []; try visit(window, 0, "root-window")
            try fence(p, parent); try checkCG(); try check(AXIsProcessTrusted() && ProcessInfo.processInfo.systemUptime < deadline, "post-capture-unverified")
            let snapshot = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
            if snapshot != previousSnapshot {
                changedSnapshots.append(["revision": rootRevision, "nodes": rows, "rootNativeCFReferencePreserved": true])
                previousSnapshot = snapshot
            }
            observedRevision = rootRevision
            if rows.contains(where: { $0["role"] as? String == "AXWebArea" }) { readiness["rootWebAreaObserved"] = true; break }
        }
        try check(!supported.isEmpty, "root-readiness-notifications-unavailable")
        let remaining = readinessDeadline - ProcessInfo.processInfo.systemUptime
        if remaining <= 0 { break }
        let outcome = CFRunLoopRunInMode(CFRunLoopMode.defaultMode, remaining, true)
        try check(outcome != .finished && outcome != .stopped, "root-readiness-runloop-unavailable")
    }
    readiness["changedSnapshotCount"] = changedSnapshots.count
    readiness["observationCount"] = observationCount
    readiness["deadlineExpired"] = readiness["rootWebAreaObserved"] as? Bool != true
    try check(readiness["rootWebAreaObserved"] as? Bool == true, "root-web-area-readiness-unverified")
    emit(["complete": true, "readOnly": true, "nodes": rows, "snapshots": changedSnapshots, "readiness": readiness, "nativeRootSnapshot": nativeRootSnapshot,
          "window": w, "process": p, "actionAttempted": false, "permissionRequestsPerformed": false])
} catch {
    emit(["complete": false, "readOnly": true, "nodes": rows, "snapshots": changedSnapshots, "readiness": readiness, "nativeRootSnapshot": nativeRootSnapshot,
          "error": (error as? Denied)?.reason ?? "surface-unverified", "actionAttempted": false, "permissionRequestsPerformed": false]); exit(2)
}
`;

async function probe(args, env) {
  admission(env, process.platform, process.arch);
  const request = options(args), temporary = canonical(env.RUNNER_TEMP || '');
  canonical(request.app); requireThat(inside(temporary, request.app) && request.app.endsWith('.app'), 'root-app-outside-runner-temp');
  const executable = path.join(request.app, 'Contents/MacOS/creator-hub'), info = path.join(request.app, 'Contents/Info.plist');
  const executablePin = pin(executable), infoPin = pin(info, 65536);
  requireThat(executablePin.image.sha256 === request.hubSha256, 'independent-hub-hash-mismatch');
  const cpu = process.arch === 'arm64' ? 0x0100000c : 0x01000007;
  requireThat(executablePin.head.length >= 8 && executablePin.head.readUInt32LE(0) === 0xfeedfacf
    && executablePin.head.readUInt32LE(4) === cpu, 'exact-native-thin-mach-o-required');
  const output = reserveOutput(temporary, request.app, request.output), report = { schemaVersion: 1, scope: 'Owned Root AX surface/window bitmap diagnostics only; not product acceptance.',
    ...acceptance, passed: false, captureCompleted: false, acceptedExit: false, cleanupUncertain: false,
    app: request.app, executable, suppliedHubSha256: request.hubSha256, runnerArchitecture: env.RUNNER_ARCH,
    childPid: null, ownedChildExit: null, tools: [],
    windowBitmap: { diagnosticOnly: true, attempted: false, completed: false, reason: 'owned-live-window-not-available', ...acceptance } };
  const write = (name, data) => fs.writeFileSync(path.join(output, name), typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  let child, owner, ownerImage, closeReceipt, ownedExit = null, toolUncertain = false, sequence = 0;
  function retainForeign(receipt, label) {
    if (receipt?.foreignElement && !report.foreignElementReceipt) {
      report.foreignElementReceipt = path.join(output, 'foreign-element.json');
      write('foreign-element.json', { sourceLabel: label, foreignElement: receipt.foreignElement, diagnosticOnly: true, ...acceptance });
    }
  }
  const toolEnv = { ...env, RUNNER_TEMP: temporary };
  async function command(file, argv, label, ms = 15000, expectedImage) {
    if (expectedImage) requireThat(sameImage(pin(file).image, expectedImage), 'compiled-tool-image-drift');
    const prefix = `${String(sequence++).padStart(2, '0')}-${label}`;
    const stdout = path.join(output, `${prefix}.stdout`), stderr = path.join(output, `${prefix}.stderr`);
    const outFD = fs.openSync(stdout, 'wx', 0o600), errFD = fs.openSync(stderr, 'wx', 0o600);
    let task;
    try { task = spawn(file, argv, { env: toolEnv, cwd: output, stdio: ['ignore', outFD, errFD] }); }
    finally { fs.closeSync(outFD); fs.closeSync(errFD); }
    const result = await new Promise(resolve => {
      const timer = setTimeout(() => { toolUncertain = true; task.unref(); resolve({ timedOut: true, exitCode: null, signal: null }); }, ms);
      task.once('error', error => { clearTimeout(timer); resolve({ exitCode: null, signal: null, error: error.code }); });
      task.once('exit', (code, signal) => { clearTimeout(timer); resolve({ exitCode: code, signal, timedOut: false }); });
    });
    const record = { label, file, argv, stdout, stderr, ...result }; report.tools.push(record); write(`${prefix}.json`, record);
    requireThat(!result.timedOut && !result.error && result.signal === null, 'tool-exit-unverified-no-termination-attempted');
    if (expectedImage) requireThat(sameImage(pin(file).image, expectedImage), 'compiled-tool-image-drift');
    const fd = fs.openSync(stdout, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let text;
    try {
      requireThat(fs.fstatSync(fd).isFile() && fs.fstatSync(fd).size <= 1024 * 1024, 'tool-output-too-large');
      const buffer = Buffer.alloc(1024 * 1024 + 1), count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      requireThat(count <= 1024 * 1024, 'tool-output-too-large'); text = buffer.subarray(0, count).toString('utf8');
    } finally { fs.closeSync(fd); }
    return { ...result, text };
  }
  const waitExit = async ms => {
    const deadline = Date.now() + ms;
    while (!ownedExit && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    return ownedExit;
  };
  try {
    write('plan.json', report);
    const source = pin(path.join(__dirname, 'native-macos-window.swift'), 1024 * 1024, true);
    write('native-macos-window.swift', source.bytes); write('root-surface.swift', surfaceSource);
    const helper = path.join(output, 'native-macos-window'), sampler = path.join(output, 'root-surface');
    for (const [sourceName, binary, label] of [['native-macos-window.swift', helper, 'compile-helper'], ['root-surface.swift', sampler, 'compile-surface']]) {
      const result = await command('/usr/bin/swiftc', [path.join(output, sourceName), '-o', binary], label, 120000);
      requireThat(result.exitCode === 0, 'native-probe-compilation-failed');
    }
    const helperImage = pin(helper).image, samplerImage = pin(sampler).image;
    report.helper = { path: helper, image: helperImage, sourceSha256: source.image.sha256 };
    report.sampler = { path: sampler, image: samplerImage };
    for (const [file, image, label] of [[helper, helperImage, 'availability-helper'], [sampler, samplerImage, 'availability-surface']]) {
      const result = await command(file, ['availability'], label, 15000, image);
      requireThat(result.exitCode === 0 && JSON.parse(result.text).accessibilityTrusted === true, 'existing-ax-trust-required-no-prompt');
    }
    requireThat(sameImage(pin(executable).image, executablePin.image) && sameImage(pin(info, 65536).image, infoPin.image), 'root-files-changed-before-launch');
    const rootEnv = privateProfile(output), logFD = fs.openSync(path.join(output, 'root.stdout'), 'wx', 0o600), errFD = fs.openSync(path.join(output, 'root.stderr'), 'wx', 0o600);
    try { child = spawn(executable, [], { cwd: rootEnv.HOME, env: rootEnv, stdio: ['ignore', logFD, errFD] }); }
    finally { fs.closeSync(logFD); fs.closeSync(errFD); }
    child.once('exit', (code, signal) => { ownedExit = { pid: child.pid, code, signal }; });
    child.once('error', error => { ownedExit = { pid: child.pid ?? null, code: null, signal: null, error: error.code }; });
    requireThat(Number.isSafeInteger(child.pid) && child.pid > 0, 'owned-root-launch-unverified');
    report.childPid = child.pid; write('launch.json', { pid: child.pid, executable, profile: rootEnv, ...acceptance });
    const expected = { pid: child.pid, executable, app: request.app, image: executablePin.image, infoPlist: infoPin.image };
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      requireThat(!ownedExit, 'owned-root-exited-before-identification');
      const result = await command(helper, ['identify', String(child.pid), request.app, executable, request.hubSha256, bundle],
        'identify', Math.min(15000, Math.max(1, deadline - Date.now())), helperImage);
      const receipt = JSON.parse(result.text);
      if (result.exitCode === 0) {
        requireThat(Array.isArray(receipt.windows) && receipt.windows.length <= 1, 'root-window-ambiguous');
        if (receipt.windows.length === 1) {
          const candidate = { process: receipt.process, window: receipt.windows[0] };
          validateOwner(candidate, expected); owner = candidate; break;
        }
      } else requireThat(receipt.error === 'native-app-not-ready', 'root-native-identification-refused');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    requireThat(owner, 'owned-root-window-readiness-expired'); write('owner.json', owner);
    const ownerPath = path.join(output, 'owner.json');
    ownerImage = pin(ownerPath, 8192).image;
    const inspected = await command(helper, ['inspect', ownerPath], 'inspect-before', 15000, helperImage);
    retainForeign(JSON.parse(inspected.text), 'inspect-before');
    requireThat(inspected.exitCode === 0, 'owned-root-inspection-refused');
    validateOwner({ process: JSON.parse(inspected.text).observation.process, window: JSON.parse(inspected.text).observation.window }, expected);
    requireThat(sameImage(pin(ownerPath, 8192).image, ownerImage), 'owner-file-drift');
    const sampled = await command(sampler, [ownerPath, String(process.pid)], 'surface', 30000, samplerImage);
    const surface = JSON.parse(sampled.text); write('surface.json', { ...surface, ...acceptance });
    requireThat(sampled.exitCode === 0 && surface.complete === true && surface.readOnly === true && surface.actionAttempted === false
      && surface.readiness?.rootWebAreaObserved === true && surface.readiness.rootNativeCFReferencePreserved === true, 'root-surface-capture-unverified');
    validateOwner({ process: surface.process, window: surface.window }, expected);
    requireThat(Array.isArray(surface.nodes) && surface.nodes.length > 0 && surface.nodes.length <= 512, 'root-surface-node-count-unverified');
    report.surfaceSummary = { nodeCount: surface.nodes.length, rootWebAreaObserved: surface.nodes.some(node => node.role === 'AXWebArea'),
      roleCounts: Object.fromEntries([...new Set(surface.nodes.map(node => node.role))].map(role => [role, surface.nodes.filter(node => node.role === role).length])) };
    requireThat(sameImage(pin(ownerPath, 8192).image, ownerImage), 'owner-file-drift');
    const after = await command(helper, ['inspect', ownerPath], 'inspect-after', 15000, helperImage);
    requireThat(after.exitCode === 0, 'post-capture-inspection-refused');
    const observation = JSON.parse(after.text).observation;
    requireThat(isDeepStrictEqual(observation.process, owner.process) && isDeepStrictEqual(observation.window, owner.window), 'post-capture-root-identity-drift');
    report.captureCompleted = true;
  } catch (error) { report.error = error.message; }
  finally {
    if (child && owner && !ownedExit && !toolUncertain) {
      try {
        const directory = path.join(output, 'window-bitmap');
        fs.mkdirSync(directory, { mode: 0o700 }); canonical(directory);
        const file = path.join(directory, 'root-window.png'), sampler = report.sampler;
        report.windowBitmap = await windowBitmapDiagnostic(owner, {
          fence: async stage => {
            requireThat(!toolUncertain && !ownedExit && ownerImage && sameImage(pin(path.join(output, 'owner.json'), 8192).image, ownerImage), 'bitmap-owner-or-tool-state-unverified');
            const result = await command(sampler.path, ['bitmap-fence', path.join(output, 'owner.json'), String(process.pid)], `bitmap-fence-${stage}`, 15000, sampler.image);
            requireThat(result.exitCode === 0, 'bitmap-native-fence-refused');
            return JSON.parse(result.text);
          },
          capture: async id => {
            requireThat(!ownedExit && !toolUncertain, 'bitmap-owned-child-not-live');
            try { fs.lstatSync(file); throw Error('bitmap-output-already-exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            return command('/usr/sbin/screencapture', bitmapArguments(id, file), 'window-bitmap', 15000);
          },
          image: () => { const image = bitmapImage(file); fs.chmodSync(file, 0o600); return { path: file, ...image }; },
        });
        write('window-bitmap/receipt.json', report.windowBitmap);
      } catch (error) { report.windowBitmap = { diagnosticOnly: true, completed: false, reason: error.message, ...acceptance }; }
    }
    if (child && owner && !ownedExit && !toolUncertain) {
      try {
        const helper = report.helper;
        requireThat(ownerImage && sameImage(pin(path.join(output, 'owner.json'), 8192).image, ownerImage), 'owner-file-drift-no-close-attempted');
        const close = await command(helper.path, ['close', path.join(output, 'owner.json')], 'normal-close', 15000, helper.image);
        closeReceipt = JSON.parse(close.text);
        retainForeign(closeReceipt, 'normal-close');
        requireThat(close.exitCode === 0, 'normal-close-refused-or-post-identity-unverified');
      } catch (error) { report.closeError = error.message; }
    }
    if (child) await waitExit(15000);
    report.ownedChildExit = ownedExit;
    report.closeAssessment = closeAssessment(closeReceipt, ownedExit, owner);
    report.acceptedExit = acceptedExit(closeReceipt, ownedExit, owner) && !report.closeError;
    report.cleanupUncertain = toolUncertain || !!child && !ownedExit;
    report.passed = report.captureCompleted && report.acceptedExit && !report.error && !report.cleanupUncertain;
    write('report.json', report);
    if (child && !ownedExit) child.unref();
  }
  return { report: path.join(output, 'report.json'), surface: fs.existsSync(path.join(output, 'surface.json')) ? path.join(output, 'surface.json') : null,
    bitmap: report.windowBitmap?.completed ? report.windowBitmap.image.path : null,
    passed: report.passed, ...acceptance };
}

if (require.main === module) {
  probe(process.argv.slice(2), process.env).then(result => {
    console.log(JSON.stringify(result)); process.exitCode = result.passed ? 0 : 2;
  }).catch(error => { console.log(JSON.stringify({ error: error.message, passed: false, ...acceptance })); process.exitCode = 2; });
}
module.exports = { admission, options, reserveOutput, pin, sameImage, validateOwner, privateProfile, acceptedExit, closeAssessment,
  bitmapArguments, bitmapImage, windowBitmapDiagnostic, acceptance, surfaceSource };
