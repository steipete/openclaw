import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CLIInstallerSelectionProofTests {
    private enum Scenario: String {
        case discoveryInspection, emptyInspection, updateSuccess, updateRejected
    }

    private enum ProofError: Error {
        case invalidFixture(String)
    }

    @Test func discoveryInspection() async throws { try await self.check(.discoveryInspection) }
    @Test func emptyInspection() async throws { try await self.check(.emptyInspection) }
    @Test func updateSuccess() async throws { try await self.check(.updateSuccess) }
    @Test func updateRejected() async throws { try await self.check(.updateRejected) }

    private func check(_ scenario: Scenario) async throws {
        let env = ProcessInfo.processInfo.environment
        let launcherHome = try URL(fileURLWithPath: #require(env["CFFIXED_USER_HOME"]))
        let launcherRoot = launcherHome.deletingLastPathComponent()
        let fileManager = FileManager.default
        let home = fileManager.homeDirectoryForCurrentUser
        let resolvedHome = home.resolvingSymlinksInPath()
        let canonicalTmp = URL(fileURLWithPath: "/tmp").resolvingSymlinksInPath()
        try #require(env["CI"] == "true")
        try #require(env["HOME"] == env["CFFIXED_USER_HOME"])
        try #require(launcherHome.lastPathComponent == "home")
        try #require(launcherRoot.deletingLastPathComponent().resolvingSymlinksInPath().path == canonicalTmp.path)
        try #require(launcherRoot.lastPathComponent.hasPrefix("oc-test-"))
        try #require(env["OPENCLAW_PROFILE"] == "default")
        try #require(env["OPENCLAW_STATE_DIR"] == launcherRoot.appendingPathComponent("state").path)
        try #require(env["OPENCLAW_CONFIG_PATH"] == launcherRoot.appendingPathComponent("state/openclaw.json").path)
        try #require(env["TMP"] == launcherRoot.appendingPathComponent("tmp").path)
        var isHomeDirectory: ObjCBool = false
        try #require(fileManager.fileExists(atPath: home.path, isDirectory: &isHomeDirectory))
        try #require(isHomeDirectory.boolValue)
        try #require(resolvedHome.path == launcherHome.resolvingSymlinksInPath().path)
        try #require(GatewayEnvironment.expectedGatewayVersionString() == nil)
        let external = home.appendingPathComponent("campaign140131-external/bin/openclaw")
        let managed = URL(fileURLWithPath: CLIInstaller.managedExecutableLocation())
        try #require(managed.path.hasPrefix(home.path + "/"))
        var files: [URL] = []
        var directories: [URL] = []

        func createParent(_ directory: URL) throws {
            guard directory.path.hasPrefix(home.path + "/") else {
                throw ProofError.invalidFixture("parent escaped disposable home")
            }
            if !fileManager.fileExists(atPath: directory.path) {
                let parent = directory.deletingLastPathComponent()
                if parent.path != home.path { try createParent(parent) }
                try fileManager.createDirectory(at: directory, withIntermediateDirectories: false)
                directories.append(directory)
            }
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: directory.path, isDirectory: &isDirectory),
                  isDirectory.boolValue,
                  directory.resolvingSymlinksInPath().path.hasPrefix(resolvedHome.path + "/") else {
                throw ProofError.invalidFixture("fixture parent is not an owned directory")
            }
        }

        func createCLI(_ url: URL, version: String) throws {
            let parent = url.deletingLastPathComponent()
            try createParent(parent)
            guard !(try fileManager.contentsOfDirectory(atPath: parent.path)).contains(url.lastPathComponent) else {
                throw ProofError.invalidFixture("refusing existing fixture executable")
            }
            let script = """
            #!/bin/sh
            if [ "$1" = "--version" ]; then
              printf 'OpenClaw \(version)\\n'
            else
              printf '{"status":"ok","before":{"version":"2026.8.1"}}\\n'
            fi

            """
            try script.write(to: url, atomically: true, encoding: .utf8)
            files.append(url)
            try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        }

        func selection(resolve: Bool) -> [String: String] {
            var result = [
                "executable": AppDefaults.standard.string(forKey: cliValidatedExecutableKey) ?? "",
                "version": AppDefaults.standard.string(forKey: cliValidatedVersionKey) ?? "",
            ]
            if resolve { result["resolved"] = CommandResolver.openclawExecutable() ?? "" }
            return result
        }

        var observation: [String: Any]?
        var matches = false
        var bodyError: Error?
        do {
            try createCLI(external, version: "2026.9.2")
            try createCLI(managed, version: "2026.9.1")
            try await TestIsolation.withIsolatedState(defaults: [
                cliValidatedExecutableKey: external.path,
                cliValidatedVersionKey: "2026.9.2",
                cliInstallPolicyKey: nil,
                "openclaw.gatewayProjectRootPath": home.path,
            ]) {
                let externalSelection = [
                    "executable": external.path, "version": "2026.9.2", "resolved": external.path,
                ]
                let managedSelection = [
                    "executable": managed.path, "version": "2026.9.1", "resolved": managed.path,
                ]
                var expected = externalSelection
                var actual: [String: String]
                switch scenario {
                case .discoveryInspection:
                    try #require(await CLIInstaller.status() == .ready(location: external.path, version: "2026.9.2"))
                    try #require(await CLIInstaller.managedStatus() == .ready(location: managed.path, version: "2026.9.1"))
                    actual = selection(resolve: true)
                case .emptyInspection:
                    AppDefaults.standard.removeObject(forKey: cliValidatedExecutableKey)
                    AppDefaults.standard.removeObject(forKey: cliValidatedVersionKey)
                    try #require(await CLIInstaller.managedStatus() == .ready(location: managed.path, version: "2026.9.1"))
                    expected = ["executable": "", "version": ""]
                    actual = selection(resolve: false)
                case .updateSuccess, .updateRejected:
                    let succeeds = scenario == .updateSuccess
                    let outcome = await CLIInstaller.updateManaged(
                        targetVersion: succeeds ? "2026.9.1" : "2026.9.2",
                        restartGateway: false,
                        statusHandler: { _ in })
                    if succeeds {
                        try #require(outcome == .success(fromVersion: "2026.8.1", toVersion: "2026.9.1"))
                        expected = managedSelection
                    } else {
                        guard case .failure = outcome else {
                            throw ProofError.invalidFixture("update bypassed failed version verification")
                        }
                    }
                    actual = selection(resolve: true)
                }
                matches = actual == expected
                observation = ["case": scenario.rawValue, "actual": actual, "expected": expected,
                               "matches": matches, "launcherHome": home.path,
                               "foundationHomeMatches": true, "expectedGatewayVersionNil": true]
            }
        } catch {
            bodyError = error
        }
        var cleanupErrors: [String] = []
        for file in files.reversed() {
            do { try fileManager.removeItem(at: file) } catch { cleanupErrors.append(String(describing: error)) }
        }
        for directory in directories.reversed() {
            do {
                guard try fileManager.contentsOfDirectory(atPath: directory.path).isEmpty else {
                    throw ProofError.invalidFixture("fixture directory contains unowned paths")
                }
                try fileManager.removeItem(at: directory)
            } catch { cleanupErrors.append(String(describing: error)) }
        }
        guard cleanupErrors.isEmpty else {
            throw ProofError.invalidFixture("fixture cleanup failed: \(cleanupErrors.joined(separator: "; "))")
        }
        if let bodyError { throw bodyError }
        var completed = try #require(observation)
        completed["fixturesRemoved"] = true
        let data = try JSONSerialization.data(withJSONObject: completed, options: [.sortedKeys])
        FileHandle.standardOutput.write(Data("MANAGED_CLI_SELECTION_PROOF ".utf8) + data + Data("\n".utf8))
        #expect(matches, "MANAGED_INSPECTION_SELECTION_CHANGED")
    }
}
