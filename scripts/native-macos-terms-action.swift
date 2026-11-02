import AppKit
import ApplicationServices
import Foundation
import Darwin

// Semantic AXPress addresses the retained element, not a hit-tested group.
// The pointer inspector and the normal consent/close helper remain separate.
func sameHeldTerms(_ before: HeldTerms, _ after: HeldTerms) throws {
    try check(before.candidates.count == 2 && after.candidates.count == 2, "terms-semantic-target-count-drift")
    try check(before.documents.count == 1 && after.documents.count == 1 && CFEqual(before.documents[0], after.documents[0]), "terms-semantic-document-drift")
    for original in before.candidates {
        let matches = after.candidates.filter { $0.role == original.role }
        guard matches.count == 1, let current = matches.first else { throw Denied("terms-semantic-target-ambiguous") }
        try check(current.path == original.path && current.title == original.title
            && CFEqual(current.item, original.item) && CFEqual(current.parent, original.parent)
            && CFEqual(current.container, original.container) && CFEqual(current.document, original.document), "terms-semantic-reference-drift")
    }
}
func semanticState(_ rows: [[String: Any]], _ checked: Int, _ enabled: Bool) throws {
    let checks = rows.filter { $0["role"] as? String == "AXCheckBox" }, buttons = rows.filter { $0["role"] as? String == "AXButton" }
    try check(rows.count == 2 && checks.count == 1 && buttons.count == 1, "terms-semantic-state-count-unverified")
    try check(checks[0]["title"] as? String == termsCheckbox && buttons[0]["title"] as? String == termsContinue
        && checks[0]["checked"] as? Int == checked && checks[0]["enabled"] as? Bool == true
        && buttons[0]["enabled"] as? Bool == enabled, "terms-semantic-state-transition-unverified")
}
func semanticReadinessPending(_ reason: String, _ detail: [String: Any]?, _ result: [String: Any]) -> Bool {
    if reason == "terms-attribute-unavailable" {
        return detail?["phase"] as? String == "remote-before" && detail?["timeoutSetAXError"] as? Int32 == 0
            && detail?["axError"] as? Int32 == AXError.cannotComplete.rawValue
            && [kAXParentAttribute, kAXWindowAttribute].contains(detail?["attribute"] as? String ?? "")
            && detail?["valuePresent"] as? Bool == false
    }
    return termsReadinessPending(reason, detail, result)
}
func semanticStatePending(_ rows: [[String: Any]]) -> Bool {
    let checks = rows.filter { $0["role"] as? String == "AXCheckBox" }, buttons = rows.filter { $0["role"] as? String == "AXButton" }
    return rows.count == 2 && checks.count == 1 && buttons.count == 1 && checks[0]["enabled"] as? Bool == true
        && [0, 1].contains(checks[0]["checked"] as? Int ?? -1) && buttons[0]["enabled"] as? Bool == false
}
var semanticActions = [[String: Any]](), semanticAttempts = [[String: Any]]()
func requireSemanticSequence(_ role: String, _ actions: [[String: Any]]) throws {
    try check(role == "AXCheckBox" && actions.isEmpty || role == "AXButton" && actions.count == 1
        && actions[0]["role"] as? String == "AXCheckBox" && actions[0]["axResult"] as? Int32 == 0, "terms-semantic-action-sequence-refused")
}
func requireSemanticPressSuccess(_ result: AXError) throws {
    try check(result == .success, "terms-semantic-press-refused-no-retry")
}
let semanticStarted = ProcessInfo.processInfo.systemUptime, semanticDeadline = semanticStarted + 20
func recordSemanticAttempt(_ fields: [String: Any], _ started: Double) {
    var attempt = fields
    attempt["attempt"] = semanticAttempts.count + 1; attempt["startedUptime"] = started
    if let process = termsResult["process"] as? [String: Any], let seconds = process["startSeconds"] as? NSNumber,
        let microseconds = process["startMicroseconds"] as? NSNumber {
        attempt["rootAgeMilliseconds"] = Date().timeIntervalSince1970 * 1000 - seconds.doubleValue * 1000 - microseconds.doubleValue / 1000
    }
    semanticAttempts.append(attempt)
}
func semanticSnapshot(_ phase: String, _ contract: TermsContract, _ predicate: (HeldTerms) throws -> Void) throws -> HeldTerms {
    while semanticAttempts.count < 32 && ProcessInfo.processInfo.systemUptime < semanticDeadline {
        let started = ProcessInfo.processInfo.systemUptime
        termsDeadline = min(semanticDeadline, started + 4)
        termsRows = []; termsReads = []; termsResult = [:]
        do {
            let held = try captureTerms(contract)
            try predicate(held)
            recordSemanticAttempt(["phase": phase, "complete": true, "elapsedMilliseconds": (ProcessInfo.processInfo.systemUptime - started) * 1000], started)
            return held
        } catch {
            let reason = (error as? Denied)?.reason ?? "terms-semantic-native-unverified", detail = (error as? Denied)?.detail
            let statePending = phase == "after-checkbox" && reason == "terms-semantic-state-transition-unverified" && semanticStatePending(termsRows)
            let dialogPending = phase == "after-continue" && reason == "terms-semantic-dialog-not-absent"
                && termsResult["containerCount"] as? Int == 1 && termsResult["headingCount"] as? Int == 1
                && termsResult["candidateCount"] as? Int == 2 && termsResult["documentCount"] as? Int == 1
            let pending = statePending || dialogPending || semanticReadinessPending(reason, detail, termsResult)
            var attempt: [String: Any] = ["phase": phase, "complete": false, "error": reason, "pendingReadOnlyReadiness": pending,
                "elapsedMilliseconds": (ProcessInfo.processInfo.systemUptime - started) * 1000]
            if let detail = detail { attempt["errorDetail"] = detail }
            recordSemanticAttempt(attempt, started)
            if !pending { throw error }
        }
        let wait = min(0.5, semanticDeadline - ProcessInfo.processInfo.systemUptime)
        if wait > 0 { RunLoop.current.run(until: Date(timeIntervalSinceNow: wait)) }
    }
    throw Denied("terms-semantic-readiness-exhausted")
}
func semanticPressOnce(_ held: HeldTerms, _ role: String, _ checked: Int, _ enabled: Bool) throws {
    try requireSemanticSequence(role, semanticActions)
    try semanticState(termsRows, checked, enabled)
    let targets = held.candidates.filter { $0.role == role }
    guard targets.count == 1, let target = targets.first,
        let pid = (termsResult["process"] as? [String: Any])?["pid"] as? NSNumber,
        let root = termsPinnedWindow else { throw Denied("terms-semantic-target-unverified") }
    try held.verifyRoot(); try pidMatches(target.item, pid.int32Value)
    try check(try termsText(target.item, kAXRoleAttribute, "immediate-before-action", target.path) == role
        && termsText(target.item, kAXTitleAttribute, "immediate-before-action", target.path) == target.title
        && termsLinkMatches(termsRead(target.item, kAXParentAttribute, "immediate-before-action", target.path), target.parent)
        && termsLinkMatches(termsRead(target.item, kAXWindowAttribute, "immediate-before-action", target.path), root)
        && termsBoolean(termsRead(target.item, kAXEnabledAttribute, "immediate-before-action", target.path)), "terms-semantic-immediate-target-drift")
    let parentChildren = try children(target.parent, kAXChildrenAttribute, "terms-semantic-immediate-membership",
        childrenNode(target.parent, target.path + "/parent", 0, nil, pid.int32Value, pid.int32Value, 0, "immediate-before-action"))
    try check(parentChildren.filter { CFEqual($0, target.item) }.count == 1, "terms-semantic-immediate-membership-drift")
    let row = termsRows.first { $0["role"] as? String == role }
    guard let previousBounds = row?["bounds"] as? [String: Double] else { throw Denied("terms-semantic-immediate-bounds-missing") }
    try check(try termsBounds(target.item, "immediate-before-action", target.path) == previousBounds, "terms-semantic-immediate-bounds-drift")
    let checks = held.candidates.filter { $0.role == "AXCheckBox" }
    try check(checks.count == 1 && termsChecked(termsRead(checks[0].item, kAXValueAttribute, "immediate-before-action", checks[0].path)) == checked, "terms-semantic-checkbox-state-drift")
    var actions: CFArray?
    let status = AXUIElementCopyActionNames(target.item, &actions)
    guard status == .success, let rawActions = actions, CFGetTypeID(rawActions) == CFArrayGetTypeID(), CFArrayGetCount(rawActions) <= 32,
        let names = rawActions as? [String], names.allSatisfy({ $0.utf8.count <= 128 }), names.contains(kAXPressAction) else { throw Denied("terms-semantic-immediate-action-unsupported") }
    try held.verifyRoot(); try termsLimit()
    try check(AXUIElementSetMessagingTimeout(target.item, 0.2) == .success, "terms-semantic-action-timeout-unverified")
    semanticActions.append(["role": role, "path": target.path, "action": "AXPress", "startedUptime": ProcessInfo.processInfo.systemUptime])
    let result = AXUIElementPerformAction(target.item, kAXPressAction as CFString)
    semanticActions[semanticActions.count - 1]["axResult"] = result.rawValue
    semanticActions[semanticActions.count - 1]["returnedUptime"] = ProcessInfo.processInfo.systemUptime
    try requireSemanticPressSuccess(result)
    try held.verifyRoot()
}
var semanticReceipt: [String: Any] = ["command": "terms-semantic", "contractRevision": 1, "diagnosticOnly": true,
    "nativeGuiAccepted": false, "mcpAccepted": false, "migrationAccepted": false, "updateAccepted": false, "releaseReady": false,
    "termsAccepted": false, "permissionRequestsPerformed": false, "pointerMethodAdmitted": false, "complete": false]
do {
    try admitted()
    try check(ProcessInfo.processInfo.environment["CREATOR_MACOS_TERMS_SEMANTIC"] == "1", "explicit-semantic-terms-required")
    let held = try semanticSnapshot("before-checkbox", .semantic) { _ in try semanticState(termsRows, 0, false) }
    try check(held.documents.count == 1, "terms-semantic-document-ambiguous")
    for key in ["process", "window", "package"] { semanticReceipt[key] = termsResult[key] }
    semanticReceipt["before"] = termsRows
    try semanticPressOnce(held, "AXCheckBox", 0, false)
    let afterCheckbox = try semanticSnapshot("after-checkbox", .semantic) { current in
        try sameHeldTerms(held, current); try semanticState(termsRows, 1, true)
    }
    semanticReceipt["afterCheckbox"] = termsRows
    try semanticPressOnce(afterCheckbox, "AXButton", 1, true)
    let absent = try semanticSnapshot("after-continue", .semanticAbsent) { current in
        try check(current.documents.count == 1 && CFEqual(held.documents[0], current.documents[0]), "terms-semantic-document-drift")
    }
    try absent.verifyRoot()
    semanticReceipt["dialogAbsentVerified"] = true; semanticReceipt["rootNativeCFReferencePreserved"] = true
    semanticReceipt["rootReferenceScope"] = "native-invocation"; semanticReceipt["complete"] = true
} catch {
    semanticReceipt["error"] = (error as? Denied)?.reason ?? "terms-semantic-native-unverified"
    if let detail = (error as? Denied)?.detail { semanticReceipt["errorDetail"] = detail }
}
semanticReceipt["actions"] = semanticActions; semanticReceipt["attempts"] = semanticAttempts
semanticReceipt["actionAttempted"] = !semanticActions.isEmpty
semanticReceipt["lastCapture"] = termsResult; semanticReceipt["lastControls"] = termsRows
semanticReceipt["lastReads"] = termsReads
semanticReceipt["elapsedMilliseconds"] = (ProcessInfo.processInfo.systemUptime - semanticStarted) * 1000
emit(semanticReceipt)
exit(semanticReceipt["complete"] as? Bool == true ? 0 : 2)
