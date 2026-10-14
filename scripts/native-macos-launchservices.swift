import AppKit
import Foundation

func emit(_ value: [String: Any], _ code: Int32) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
    exit(code)
}
let env = ProcessInfo.processInfo.environment
guard env["GITHUB_ACTIONS"] == "true", env["RUNNER_ENVIRONMENT"] == "github-hosted",
      env["RUNNER_OS"] == "macOS", env["GITHUB_REPOSITORY"] == "BOBWORKS-XR/CREATOR-HUB",
      env["CREATOR_MACOS_APP_PROBE"] == "1", env["CREATOR_MACOS_OWNED_GUI_TEST"] == "1",
      env["CREATOR_MACOS_LAUNCH_CONTROL"] == "1" else { emit(["error": "disposable-explicit-launch-control-required"], 2) }
let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 2, let temporary = env["RUNNER_TEMP"] else { emit(["error": "bounded-launch-inputs-required"], 2) }
let app = URL(fileURLWithPath: args[0]), settings = URL(fileURLWithPath: args[1])
guard app.path.hasPrefix(temporary + "/"), app.path.hasSuffix(".app"), settings.path.hasPrefix(temporary + "/"),
      app.resolvingSymlinksInPath().path == app.path, settings.resolvingSymlinksInPath().path == settings.path,
      let attributes = try? FileManager.default.attributesOfItem(atPath: settings.path),
      ((attributes[.size] as? NSNumber)?.intValue ?? 16385) > 0,
      ((attributes[.size] as? NSNumber)?.intValue ?? 16385) <= 16384,
      let bytes = try? Data(contentsOf: settings), let profile = try? JSONSerialization.jsonObject(with: bytes) as? [String: String]
else { emit(["error": "launch-input-path-or-size-refused"], 2) }
let allowed = Set(["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"])
guard !profile.isEmpty, Set(profile.keys).isSubset(of: allowed), profile["HOME"]?.hasPrefix("/Users/runner") == true,
      profile["PATH"] == "/usr/bin:/bin:/usr/sbin:/sbin", profile["TMPDIR"]?.hasPrefix("/") == true,
      profile.values.allSatisfy({ $0.utf8.count <= 512 && !$0.unicodeScalars.contains(where: { $0.value < 32 }) })
else { emit(["error": "launch-environment-refused"], 2) }
let configuration = NSWorkspace.OpenConfiguration()
configuration.environment = profile
configuration.createsNewApplicationInstance = true
configuration.activates = true
configuration.addsToRecentItems = false
NSWorkspace.shared.openApplication(at: app, configuration: configuration) { running, error in
    if let error = error as NSError? {
        emit(["error": "launchservices-native-error", "errorDomain": String(error.domain.prefix(128)),
              "errorCode": error.code, "diagnosticOnly": true, "nativeGuiAccepted": false, "releaseReady": false], 2)
    }
    guard error == nil, let running = running, !running.isTerminated, running.processIdentifier > 0,
          running.bundleIdentifier == "com.creatorworks.hub", running.bundleURL?.path == app.path,
          running.executableURL?.path == app.appendingPathComponent("Contents/MacOS/creator-hub").path
    else { emit(["error": "launchservices-result-unverified"], 2) }
    // This is launch metadata, not kernel ownership, GUI acceptance or an exit status.
    emit(["diagnosticOnly": true, "method": "native-launchservices-open-application", "pid": running.processIdentifier,
          "app": app.path, "executable": running.executableURL!.path, "bundleIdentifier": "com.creatorworks.hub",
          "rootExitStatusKnown": false, "nativeGuiAccepted": false, "releaseReady": false], 0)
}
RunLoop.main.run(until: Date(timeIntervalSinceNow: 15))
emit(["error": "launchservices-completion-unavailable"], 2)
