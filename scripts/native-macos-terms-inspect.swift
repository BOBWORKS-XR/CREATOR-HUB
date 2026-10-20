import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Darwin

let termsHeading = "Terms of use and risk acknowledgement"
let termsCheckbox = "I have read and agree to these terms, including the risk assumption and liability limitations above."
let termsContinue = "Accept and continue"
let termsFactNames = ["rootPID", "role", "title", "parentCF", "windowCF", "documentCF", "containerCF", "contained", "activationPoint", "hitPeerCF", "hitPeerPID", "pressSupported", "referencesStable", "stateTyped"]
func requireTermsFacts(_ facts: [String: Bool]) throws {
    for name in termsFactNames { try check(facts[name] == true, "terms-control-" + name + "-unverified") }
}
func termsBoolean(_ raw: CFTypeRef) throws -> Bool {
    try check(CFGetTypeID(raw) == CFBooleanGetTypeID(), "terms-boolean-type-unverified")
    return CFBooleanGetValue(raw as! CFBoolean)
}
func termsChecked(_ raw: CFTypeRef) throws -> Int {
    if CFGetTypeID(raw) == CFBooleanGetTypeID() { return try termsBoolean(raw) ? 1 : 0 }
    try check(CFGetTypeID(raw) == CFNumberGetTypeID(), "terms-checkbox-value-type-unverified")
    let number = raw as! CFNumber
    var value: Int64 = -1
    try check(!CFNumberIsFloatType(number) && CFNumberGetValue(number, .sInt64Type, &value) && (value == 0 || value == 1), "terms-checkbox-value-unverified")
    return Int(value)
}
func termsLinkMatches(_ raw: CFTypeRef, _ expected: AXUIElement) -> Bool {
    return CFGetTypeID(raw) == AXUIElementGetTypeID() && CFEqual(raw as! AXUIElement, expected)
}
func termsPoint(_ raw: CFTypeRef) throws -> CGPoint {
    try check(CFGetTypeID(raw) == AXValueGetTypeID(), "terms-activation-point-type-unverified")
    var point = CGPoint.zero
    try check(AXValueGetValue(raw as! AXValue, .cgPoint, &point) && point.x.isFinite && point.y.isFinite, "terms-activation-point-unverified")
    return point
}
func termsPointInside(_ point: CGPoint, _ bounds: [String: Double]) -> Bool {
    guard let x = bounds["x"], let y = bounds["y"], let width = bounds["width"], let height = bounds["height"] else { return false }
    let px = Double(point.x), py = Double(point.y)
    return px.isFinite && py.isFinite && px >= x && py >= y && px < x + width && py < y + height
}
struct TermsCandidate {
    let item: AXUIElement, parent: AXUIElement, container: AXUIElement, document: AXUIElement
    let path: String, role: String, title: String
}
var termsRows = [[String: Any]](), termsReads = [[String: Any]](), termsResult = [String: Any]()
var termsDeadline = Double(0)
var termsPinnedWindow: AXUIElement?, termsPinnedOwner: Data?
func termsLimit() throws {
    try check(ProcessInfo.processInfo.systemUptime < termsDeadline && termsReads.count < 256, "terms-read-bound-exceeded")
}
func termsRead(_ item: AXUIElement, _ key: String, _ phase: String, _ path: String) throws -> CFTypeRef {
    try termsLimit()
    let timeout = AXUIElementSetMessagingTimeout(item, 0.2)
    var raw: CFTypeRef?
    let started = ProcessInfo.processInfo.systemUptime
    let status = AXUIElementCopyAttributeValue(item, key as CFString, &raw)
    let detail: [String: Any] = ["operation": "AXUIElementCopyAttributeValue", "path": path, "phase": phase,
        "attribute": key, "axError": status.rawValue, "timeoutSetAXError": timeout.rawValue,
        "returnedCFTypeID": raw.map { CFGetTypeID($0) as Any } ?? NSNull(), "valuePresent": raw != nil,
        "elapsedMilliseconds": max(0, (ProcessInfo.processInfo.systemUptime - started) * 1000)]
    termsReads.append(detail)
    guard timeout == .success && status == .success, let value = raw else { throw Denied("terms-attribute-unavailable", detail: detail) }
    try termsLimit(); return value
}
func termsText(_ item: AXUIElement, _ key: String, _ phase: String, _ path: String) throws -> String {
    let raw = try termsRead(item, key, phase, path)
    guard CFGetTypeID(raw) == CFStringGetTypeID(), let text = raw as? String, text.utf8.count <= 2048 else { throw Denied("terms-text-type-or-size-unverified") }
    return text
}
func termsBounds(_ item: AXUIElement, _ phase: String, _ path: String) throws -> [String: Double] {
    let position = try termsRead(item, kAXPositionAttribute, phase, path), size = try termsRead(item, kAXSizeAttribute, phase, path)
    try check(CFGetTypeID(position) == AXValueGetTypeID() && CFGetTypeID(size) == AXValueGetTypeID(), "terms-bounds-type-unverified")
    var point = CGPoint.zero, extent = CGSize.zero
    try check(AXValueGetValue(position as! AXValue, .cgPoint, &point) && AXValueGetValue(size as! AXValue, .cgSize, &extent), "terms-bounds-unverified")
    let values = [Double(point.x), Double(point.y), Double(extent.width), Double(extent.height)]
    try check(values.allSatisfy { $0.isFinite } && extent.width > 0 && extent.height > 0 && extent.width <= 16384 && extent.height <= 16384, "terms-bounds-unverified")
    return ["x": values[0], "y": values[1], "width": values[2], "height": values[3]]
}

func captureTerms() throws {
    try admitted()
    let env = ProcessInfo.processInfo.environment, args = Array(CommandLine.arguments.dropFirst())
    try check(env["CREATOR_MACOS_TERMS_INSPECT"] == "1" && env["CREATOR_MACOS_LAUNCH_CONTROL"] == "1", "explicit-terms-inspection-required")
    #if !arch(x86_64)
    throw Denied("terms-inspection-intel-only")
    #endif
    guard args.count == 2, let parent = UInt32(args[1]), parent > 0 else { throw Denied("terms-owner-parent-required") }
    try check(AXIsProcessTrusted(), "terms-existing-ax-trust-required")
    let file = args[0]
    try check(file.hasPrefix((env["RUNNER_TEMP"] ?? "invalid") + "/") && URL(fileURLWithPath: file).resolvingSymlinksInPath().path == file, "terms-owner-path-refused")
    let fd = open(file, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    try check(fd >= 0, "terms-owner-open-refused")
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    var meta = stat()
    try check(fstat(fd, &meta) == 0 && meta.st_mode & S_IFMT == S_IFREG && meta.st_uid == getuid() && meta.st_nlink == 1 && meta.st_size > 0 && meta.st_size <= 8192, "terms-owner-file-refused")
    let bytes = try handle.read(upToCount: 8193) ?? Data()
    if let pinned = termsPinnedOwner { try check(bytes == pinned, "terms-owner-bytes-drift") } else { termsPinnedOwner = bytes }
    guard bytes.count <= 8192, let owner = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], Set(owner.keys) == Set(["process", "window"]),
        let p = owner["process"] as? [String: Any], let w = owner["window"] as? [String: Any], let expected = w["bounds"] as? [String: Double],
        let pid = (p["pid"] as? NSNumber)?.int32Value, let id = (w["id"] as? NSNumber)?.uint32Value,
        let app = p["bundlePath"] as? String, let plist = p["infoPlist"] as? [String: Any] else { throw Denied("terms-owner-schema-refused") }
    try check(pid > 0 && id > 0 && (w["pid"] as? NSNumber)?.int32Value == pid && p["bundleIdentifier"] as? String == "com.creatorworks.hub"
        && ["x", "y", "width", "height"].allSatisfy { expected[$0]?.isFinite == true }
        && (expected["width"] ?? 0) > 0 && (expected["height"] ?? 0) > 0, "terms-root-owner-refused")
    termsResult = ["command": "terms-inspect", "inspectionRevision": 2, "process": p, "window": w]
    try fence(p, parent)
    let package = try packageFields(imageMatches(app + "/Contents/Info.plist", plist, 65536, contents: true), plist)
    try check(package["bundleShortVersion"] as? String == "0.1.14", "terms-exact-version-required")
    termsResult["package"] = package
    func checkCG() throws {
        try termsLimit(); try fence(p, parent)
        guard let all = CGWindowListCopyWindowInfo([.optionIncludingWindow, .excludeDesktopElements], id) as? [[String: Any]] else { throw Denied("terms-cg-unavailable") }
        let rows = all.filter { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id }
        guard rows.count == 1, let row = rows.first, (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
            (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0, (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true,
            ((row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0) > 0,
            let raw = row[kCGWindowBounds as String] as? [String: Any], let b = CGRect(dictionaryRepresentation: raw as CFDictionary) else { throw Denied("terms-cg-owner-unverified") }
        try check(["x": Double(b.minX), "y": Double(b.minY), "width": Double(b.width), "height": Double(b.height)] == expected, "terms-root-bounds-drift")
    }
    try checkCG()
    let root = AXUIElementCreateApplication(pid), node = childrenNode(root, "root-application", -1, nil, pid, pid, id, "root-application")
    let windows = try children(root, kAXWindowsAttribute, "terms-root-discovery", node)
    termsResult["nativeWindowCount"] = windows.count
    try check(windows.count == 1, "terms-root-window-ambiguous")
    let window = windows[0]
    if let pinned = termsPinnedWindow { try check(CFEqual(pinned, window), "terms-root-cf-drift") } else { termsPinnedWindow = window }
    try pidMatches(window, pid)
    try check(try termsText(window, kAXRoleAttribute, "root", "root-window") == "AXWindow", "terms-root-role-unverified")
    try check(try termsBounds(window, "root", "root-window") == expected, "terms-root-mapping-unverified")
    func heldRoot() throws {
        try checkCG(); try check(AXIsProcessTrusted(), "terms-ax-trust-lost")
        guard let running = NSRunningApplication(processIdentifier: pid), running.isActive, !running.isHidden else { throw Denied("terms-owned-application-not-visible") }
        try pidMatches(window, pid)
        let current = try children(root, kAXWindowsAttribute, "terms-root-recheck", node)
        try check(current.count == 1 && CFEqual(current[0], window), "terms-root-cf-drift")
        try check(try termsBounds(window, "root-recheck", "root-window") == expected, "terms-root-bounds-drift")
    }
    var seen = [AXUIElement](), candidates = [TermsCandidate](), groups = [AXUIElement](), headings = [AXUIElement]()
    func links(_ item: AXUIElement, _ parentElement: AXUIElement, _ path: String, _ phase: String) throws {
        let linkedParent = try termsRead(item, kAXParentAttribute, phase, path), linkedWindow = try termsRead(item, kAXWindowAttribute, phase, path)
        let parentEqual = termsLinkMatches(linkedParent, parentElement), windowEqual = termsLinkMatches(linkedWindow, window)
        let detail: [String: Any] = ["operation": "CFEqual", "path": path, "phase": phase, "parentCFMatches": parentEqual, "windowCFMatches": windowEqual]
        try termsLimit(); termsReads.append(detail)
        if !parentEqual || !windowEqual { throw Denied("terms-native-association-unverified", detail: detail) }
    }
    func visit(_ item: AXUIElement, _ depth: Int, _ path: String, _ parentElement: AXUIElement?, _ container: AXUIElement?, _ document: AXUIElement?) throws {
        try termsLimit(); try check(depth <= 16 && seen.count < 512 && !seen.contains(where: { CFEqual($0, item) }), "terms-tree-bound-or-cycle")
        let readPID = try elementPID(item), remote = readPID != pid
        var stamp: RemoteProcess?
        if remote {
            guard let parentElement = parentElement else { throw Denied("terms-remote-parent-missing") }
            try heldRoot(); stamp = try remoteProcess(readPID); try links(item, parentElement, path, "remote-before")
        }
        let role = try termsText(item, kAXRoleAttribute, "traversal", path)
        let nextDocument = role == "AXWebArea" ? item : document
        var nextContainer = container
        if ["AXGroup", "AXHeading", "AXCheckBox", "AXButton"].contains(role) {
            let title = attr(item, kAXTitleAttribute) as? String ?? ""
            try check(title.utf8.count <= 2048, "terms-title-unbounded")
            if role == "AXGroup" && title == termsHeading { groups.append(item); nextContainer = item }
            if role == "AXHeading" && title == termsHeading && container != nil { headings.append(item) }
            if (role == "AXCheckBox" && title == termsCheckbox || role == "AXButton" && title == termsContinue),
                let parentElement = parentElement, let container = container, let document = nextDocument {
                candidates.append(TermsCandidate(item: item, parent: parentElement, container: container, document: document, path: path, role: role, title: title))
            }
        }
        let childrenMeta = childrenNode(item, path, depth, role, readPID, pid, id, "traversal-node")
        let descendants = try children(item, kAXChildrenAttribute, "terms-traversal", childrenMeta)
        if remote {
            try check(try elementPID(item) == readPID && remoteProcess(readPID) == stamp, "terms-remote-process-drift")
            try links(item, parentElement!, path, "remote-after"); try heldRoot()
        }
        seen.append(item)
        for (index, child) in descendants.enumerated() { try visit(child, depth + 1, path + "/" + String(index), item, nextContainer, nextDocument) }
    }
    try visit(window, 0, "root-window", nil, nil, nil)
    termsResult["candidateCount"] = candidates.count; termsResult["visitedNodeCount"] = seen.count
    termsResult["containerCount"] = groups.count; termsResult["headingCount"] = headings.count
    try check(groups.count == 1 && headings.count == 1 && candidates.count == 2
        && candidates.filter { $0.role == "AXCheckBox" }.count == 1 && candidates.filter { $0.role == "AXButton" }.count == 1, "terms-controls-not-unique")
    try check(CFEqual(candidates[0].container, candidates[1].container) && CFEqual(candidates[0].document, candidates[1].document), "terms-document-or-container-mismatch")
    let active = NSRunningApplication(processIdentifier: pid)?.isActive == true
    termsResult["active"] = active
    try check(active, "terms-root-not-active")
    guard let running = NSRunningApplication(processIdentifier: pid), !running.isHidden else { throw Denied("terms-owned-application-not-visible") }
    termsResult["applicationHidden"] = running.isHidden
    termsResult["applicationHiddenSource"] = "NSRunningApplication.isHidden"
    var stateFailures = [[String: Any]]()
    for candidate in candidates {
      do {
        var row: [String: Any] = ["path": candidate.path, "role": candidate.role, "title": candidate.title, "pid": pid, "windowID": id]
        defer { termsRows.append(row) }
        try heldRoot(); try pidMatches(candidate.item, pid)
        try links(candidate.item, candidate.parent, candidate.path, "control-before")
        try pidMatches(candidate.parent, pid); try pidMatches(candidate.container, pid); try pidMatches(candidate.document, pid)
        try check(try termsText(candidate.container, kAXRoleAttribute, "container", candidate.path) == "AXGroup"
            && termsText(candidate.container, kAXTitleAttribute, "container", candidate.path) == termsHeading
            && termsText(candidate.document, kAXRoleAttribute, "document", candidate.path) == "AXWebArea", "terms-context-role-drift")
        try check(termsLinkMatches(termsRead(candidate.container, kAXWindowAttribute, "container", candidate.path), window)
            && termsLinkMatches(termsRead(candidate.document, kAXWindowAttribute, "document", candidate.path), window), "terms-context-window-unverified")
        row["parentCFMatches"] = true; row["windowCFMatches"] = true
        row["parentPID"] = pid; row["documentPID"] = pid; row["containerPID"] = pid
        row["parentRole"] = try termsText(candidate.parent, kAXRoleAttribute, "parent", candidate.path)
        let role = try termsText(candidate.item, kAXRoleAttribute, "control", candidate.path), title = try termsText(candidate.item, kAXTitleAttribute, "control", candidate.path)
        try check(role == candidate.role && title == candidate.title, "terms-control-role-or-title-drift")
        let bounds = try termsBounds(candidate.item, "control", candidate.path)
        row["bounds"] = bounds
        var fieldErrors = [[String: Any]]()
        func field(_ key: String, _ read: () throws -> Any) {
            do { row[key] = try read() }
            catch {
                var failure: [String: Any] = ["field": key, "error": (error as? Denied)?.reason ?? "terms-state-unverified"]
                if let detail = (error as? Denied)?.detail { failure["errorDetail"] = detail }
                fieldErrors.append(failure)
            }
        }
        field("enabled") { try termsBoolean(termsRead(candidate.item, kAXEnabledAttribute, "control", candidate.path)) }
        // AXHidden describes the application, not arbitrary leaf controls. Do not
        // turn the observed noValue into a fabricated per-control false value.
        if role == "AXCheckBox" { field("checked") { try termsChecked(termsRead(candidate.item, kAXValueAttribute, "control", candidate.path)) } }
        var activationPoint: CGPoint?
        field("activationPoint") {
            let point = try termsPoint(termsRead(candidate.item, NSAccessibility.Attribute.activationPoint.rawValue, "control", candidate.path))
            activationPoint = point
            return ["x": Double(point.x), "y": Double(point.y)]
        }
        row["fieldErrors"] = fieldErrors
        try termsLimit()
        var actions: CFArray?
        let actionStatus = AXUIElementCopyActionNames(candidate.item, &actions)
        row["actionsAXError"] = actionStatus.rawValue
        row["actionsCFTypeID"] = actions.map { CFGetTypeID($0) as Any } ?? NSNull()
        guard actionStatus == .success, let rawActions = actions, CFGetTypeID(rawActions) == CFArrayGetTypeID(),
            let names = rawActions as? [String], names.count <= 32, names.allSatisfy({ $0.utf8.count <= 128 }) else { throw Denied("terms-actions-unverified") }
        row["actions"] = names
        let center = CGPoint(x: bounds["x"]! + bounds["width"]! / 2, y: bounds["y"]! + bounds["height"]! / 2)
        var centerPeer: AXUIElement?
        row["centerHitPeerAXError"] = AXUIElementCopyElementAtPosition(root, Float(center.x), Float(center.y), &centerPeer).rawValue
        row["centerHitPeerCFMatches"] = centerPeer.map { CFEqual($0, candidate.item) } ?? false
        let point = activationPoint ?? center
        let activationVerified = activationPoint.map { termsPointInside($0, bounds) && termsPointInside($0, expected) } ?? false
        row["hitPeerPointSource"] = activationPoint != nil ? "native-activation-point" : "unverified-center-diagnostic-only"
        row["activationPointWithinBounds"] = activationVerified
        var peer: AXUIElement?
        let peerStatus = AXUIElementCopyElementAtPosition(root, Float(point.x), Float(point.y), &peer)
        var peerPID: pid_t = 0
        let peerPIDStatus = peer.map { AXUIElementGetPid($0, &peerPID) }
        let peerEqual = peer.map { CFEqual($0, candidate.item) } ?? false
        row["hitPeerAXError"] = peerStatus.rawValue; row["hitPeerPIDAXError"] = peerPIDStatus.map { $0.rawValue as Any } ?? NSNull()
        row["hitPeerPID"] = peerPID; row["hitPeerCFMatches"] = peerEqual
        if let peer = peer, peerPIDStatus == .success && peerPID == pid {
            // Explain a refused peer without treating a child/parent peer as the target.
            if let peerRole = try? termsText(peer, kAXRoleAttribute, "hit-peer", candidate.path) { row["hitPeerRole"] = peerRole }
            if let peerWindow = try? termsRead(peer, kAXWindowAttribute, "hit-peer", candidate.path) {
                row["hitPeerWindowCFMatches"] = termsLinkMatches(peerWindow, window)
            }
            if let peerParent = try? termsRead(peer, kAXParentAttribute, "hit-peer", candidate.path) {
                row["hitPeerParentCFMatchesTarget"] = termsLinkMatches(peerParent, candidate.item)
                row["hitPeerParentCFMatchesControlParent"] = termsLinkMatches(peerParent, candidate.parent)
            }
        }
        let contained = bounds["x"]! >= expected["x"]! && bounds["y"]! >= expected["y"]!
            && bounds["x"]! + bounds["width"]! <= expected["x"]! + expected["width"]!
            && bounds["y"]! + bounds["height"]! <= expected["y"]! + expected["height"]!
        try links(candidate.item, candidate.parent, candidate.path, "control-after")
        try pidMatches(candidate.item, pid); try heldRoot()
        let parentAgain = try termsRead(candidate.item, kAXParentAttribute, "reference-recheck", candidate.path)
        let parentChildren = try children(candidate.parent, kAXChildrenAttribute, "terms-control-reference-recheck",
            childrenNode(candidate.parent, candidate.path + "/parent", 0, nil, pid, pid, id, "traversal-node"))
        let stable = termsLinkMatches(parentAgain, candidate.parent) && parentChildren.filter { CFEqual($0, candidate.item) }.count == 1
        row["nativeReferencesStable"] = stable; row["contained"] = contained
        try requireTermsFacts(["rootPID": true, "role": role == candidate.role, "title": title == candidate.title,
            "parentCF": true, "windowCF": true, "documentCF": true, "containerCF": CFEqual(candidate.container, groups[0]),
            "contained": contained, "activationPoint": activationVerified, "hitPeerCF": peerStatus == .success && peerEqual, "hitPeerPID": peerPIDStatus == .success && peerPID == pid,
            "pressSupported": names.contains(kAXPressAction), "referencesStable": stable, "stateTyped": fieldErrors.isEmpty])
      } catch let failure as Denied {
        let metadataFailures = ["stateTyped", "activationPoint", "hitPeerCF", "hitPeerPID", "pressSupported", "contained"].map { "terms-control-" + $0 + "-unverified" }
        if !metadataFailures.contains(failure.reason) { throw failure }
        stateFailures.append(["path": candidate.path, "error": failure.reason])
      }
    }
    termsResult["controlStateFailures"] = stateFailures
    try check(stateFailures.isEmpty, "terms-control-state-unverified")
    try heldRoot(); termsResult["rootNativeCFReferencePreserved"] = true
    termsResult["rootReferenceScope"] = "native-invocation"; termsResult["complete"] = true
}
func termsReadinessPending(_ reason: String, _ detail: [String: Any]?, _ result: [String: Any]) -> Bool {
    if reason == "ax-children-unbounded-or-unreadable" {
        return detail?["phase"] as? String == "terms-root-discovery" && (detail?["axError"] as? NSNumber)?.int32Value == AXError.cannotComplete.rawValue
    }
    if reason == "terms-root-window-ambiguous" { return result["nativeWindowCount"] as? Int == 0 }
    if reason == "terms-controls-not-unique" {
        return (result["containerCount"] as? Int ?? 2) <= 1 && (result["headingCount"] as? Int ?? 2) <= 1 && (result["candidateCount"] as? Int ?? 2) < 2
    }
    return false // Unknown association/state/identity is never retried into admission.
}
var termsAttempts = [[String: Any]]()
let termsReadinessStarted = ProcessInfo.processInfo.systemUptime, termsReadinessDeadline = termsReadinessStarted + 20
for attempt in 0..<32 {
    let started = ProcessInfo.processInfo.systemUptime
    if started >= termsReadinessDeadline { break }
    termsDeadline = min(termsReadinessDeadline, started + 4)
    termsRows = []; termsReads = []; termsResult = [:]
    var pending = false
    do { try captureTerms() }
    catch {
        let reason = (error as? Denied)?.reason ?? "terms-native-inspection-unverified", detail = (error as? Denied)?.detail
        termsResult["complete"] = false; termsResult["error"] = reason
        if let detail = detail { termsResult["errorDetail"] = detail }
        pending = termsReadinessPending(reason, detail, termsResult)
    }
    termsAttempts.append(["attempt": attempt + 1, "startedUptime": started,
        "elapsedMilliseconds": max(0, (ProcessInfo.processInfo.systemUptime - started) * 1000),
        "complete": termsResult["complete"] as? Bool == true, "pendingReadOnlyReadiness": pending,
        "error": termsResult["error"] ?? NSNull(), "errorDetail": termsResult["errorDetail"] ?? NSNull()])
    if let p = termsResult["process"] as? [String: Any], let seconds = p["startSeconds"] as? NSNumber, let microseconds = p["startMicroseconds"] as? NSNumber {
        termsAttempts[termsAttempts.count - 1]["rootAgeMilliseconds"] = Date().timeIntervalSince1970 * 1000 - seconds.doubleValue * 1000 - microseconds.doubleValue / 1000
    }
    if termsResult["complete"] as? Bool == true || !pending { break }
    let wait = min(0.5, termsReadinessDeadline - ProcessInfo.processInfo.systemUptime)
    if wait <= 0 { break }
    // Poll only for actual native document evidence; never repeat an action.
    let wake = Timer(timeInterval: wait, repeats: false) { _ in }
    RunLoop.current.add(wake, forMode: .default)
    RunLoop.current.run(until: Date(timeIntervalSinceNow: wait)); wake.invalidate()
}
termsResult["controls"] = termsRows; termsResult["reads"] = termsReads
termsResult["attempts"] = termsAttempts
termsResult["readinessElapsedMilliseconds"] = max(0, (ProcessInfo.processInfo.systemUptime - termsReadinessStarted) * 1000)
termsResult["limits"] = ["attempts": 32, "readinessSeconds": 20, "attemptSeconds": 4, "depth": 16, "nodes": 512, "readsPerAttempt": 256, "messageTimeoutSeconds": 0.2]
termsResult["readOnly"] = true; termsResult["actionAttempted"] = false; termsResult["permissionRequestsPerformed"] = false
termsResult["actionAuthorityEstablished"] = false; termsResult["termsAccepted"] = false
emit(termsResult)
exit(termsResult["complete"] as? Bool == true ? 0 : 2)
