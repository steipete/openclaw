// Proof-only overlay. Run only in the reviewed disposable GitHub macOS job.
import Darwin
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct MacNodeHostWorkerProcessGroupProof {
    private struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    private struct Configuration: Decodable {
        let phase: String
        let runtime: String
        let output: String
        let sourceSHA: String
    }

    private struct Identity: Codable {
        let pid: Int32
        let ppid: Int32
        let pgid: Int32
        let uid: UInt32
        let startSeconds: UInt64
        let startMicroseconds: UInt64
        let status: UInt32
        let executable: String
        let executablePathErrno: Int32?

        func sameInstance(as other: Identity) -> Bool {
            self.pid == other.pid && self.uid == other.uid &&
                self.startSeconds == other.startSeconds &&
                self.startMicroseconds == other.startMicroseconds
        }
    }

    private struct Event: Encodable {
        let sequence: Int
        let elapsedSeconds: Double
        let name: String
        let processes: [Identity]
    }

    private struct ChildEnumeration: Encodable {
        let parentPID: Int32
        let count: Int32
        let errorNumber: Int32
    }

    private struct Observation: Encodable {
        let observerPID: Int32
        let expectedExecutable: String
        let childEnumerations: [ChildEnumeration]
        let observedDescendants: [Identity]
        let phase: String
        let sourceSHA: String
        let scenario: String
        let events: [Event]
        let directWorkerSurvivedStop: Bool?
        let cleanupComplete: Bool
        let error: String?
    }

    private static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(description: message) }
    }

    private static func identity(_ pid: pid_t) throws -> Identity? {
        try self.require(pid > 1, "Refusing an invalid process identity")
        var info = proc_bsdinfo()
        let bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
        if bytes == 0 {
            if kill(pid, 0) == -1, errno == ESRCH { return nil }
            throw Failure(description: "Cannot inspect owned PID \(pid)")
        }
        try self.require(bytes == MemoryLayout.size(ofValue: info), "Incomplete BSD process identity")
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        errno = 0
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        let pathError: Int32? = length > 0 ? nil : errno
        let executable = length > 0
            ? String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
            : ""
        return Identity(
            pid: pid,
            ppid: Int32(info.pbi_ppid),
            pgid: Int32(info.pbi_pgid),
            uid: info.pbi_uid,
            startSeconds: info.pbi_start_tvsec,
            startMicroseconds: info.pbi_start_tvusec,
            status: info.pbi_status,
            executable: executable,
            executablePathErrno: pathError)
    }

    private static func children(
        of pid: pid_t,
        onRead: ((ChildEnumeration) -> Void)? = nil
    ) throws -> [Identity] {
        var pids = [pid_t](repeating: 0, count: 128)
        errno = 0
        let count = pids.withUnsafeMutableBytes {
            proc_listchildpids(pid, $0.baseAddress, Int32($0.count))
        }
        let errorNumber = errno
        onRead?(ChildEnumeration(parentPID: pid, count: count, errorNumber: errorNumber))
        // libproc projects syscall failure to zero; distinguish it from no children.
        try self.require(count >= 0 && (count > 0 || errorNumber == 0) && count < pids.count,
                         "Child enumeration failed or filled its buffer: count=\(count), errno=\(errorNumber)")
        return try pids.prefix(Int(count)).filter { $0 > 1 }.compactMap { try self.identity($0) }
    }

    private static func descendants(
        of pid: pid_t,
        onRead: ((ChildEnumeration) -> Void)? = nil
    ) throws -> [Identity] {
        var queue = [pid]
        var visited = Set<pid_t>()
        var result: [Identity] = []
        while let parent = queue.popLast() {
            for child in try self.children(of: parent, onRead: onRead) where visited.insert(child.pid).inserted {
                try self.require(child.uid == getuid(), "Owned descendant UID changed")
                try self.require(result.count < 256, "Owned process tree exceeded the proof bound")
                result.append(child)
                queue.append(child.pid)
            }
        }
        return result.sorted { $0.pid < $1.pid }
    }

    private static func privateNodeProcesses(at path: String) throws -> [Identity] {
        var pids = [pid_t](repeating: 0, count: 8192)
        errno = 0
        let count = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
        let errorNumber = errno
        try self.require(count >= 0 && (count > 0 || errorNumber == 0) && count < pids.count,
                         "Process enumeration failed or filled its buffer: count=\(count), errno=\(errorNumber)")
        var result: [Identity] = []
        for pid in pids.prefix(Int(count)) where pid > 1 {
            var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
            guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { continue }
            let executable = String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
            guard executable == path, let identity = try self.identity(pid) else { continue }
            try self.require(identity.uid == getuid(), "Private Node has an unexpected UID")
            result.append(identity)
        }
        return result
    }

    private static func live(_ expected: Identity) throws -> Identity? {
        guard let current = try self.identity(expected.pid) else { return nil }
        // PID reuse means the original instance exited. Never signal its replacement.
        return expected.sameInstance(as: current) ? current : nil
    }

    private static func signal(_ signal: Int32, to expected: Identity, allowExit: Bool = false) throws {
        guard let current = try self.live(expected) else {
            if allowExit { return }
            throw Failure(description: "Owned PID exited before signal \(signal)")
        }
        if allowExit, current.status == UInt32(SZOMB) { return }
        try self.require(current.executable == expected.executable && !current.executable.isEmpty,
                         "Owned executable changed before signal")
        try self.require(kill(expected.pid, signal) == 0, "Signal \(signal) failed for owned PID")
    }

    private static func waitUntilGone(_ identities: [Identity]) async throws -> Bool {
        let deadline = ContinuousClock.now + .seconds(10)
        while ContinuousClock.now < deadline {
            if try identities.allSatisfy({ try self.live($0) == nil }) { return true }
            try await Task.sleep(for: .milliseconds(20))
        }
        return try identities.allSatisfy { try self.live($0) == nil }
    }

    private static func configuration() throws -> Configuration {
        var root = URL(fileURLWithPath: #filePath)
        // File -> OpenClawIPCTests -> Tests -> macos -> apps -> repository.
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let url = root.appendingPathComponent(".proof-135663/configuration.json")
        let config = try JSONDecoder().decode(Configuration.self, from: Data(contentsOf: url))
        try self.require(["baseline", "candidate"].contains(config.phase), "Unknown proof phase")
        try self.require(config.sourceSHA.count == 40, "Missing immutable source identity")
        return config
    }

    @Test(arguments: [false, true])
    func packagedWorkerLifecycle(stopWhileUnresponsive: Bool) async throws {
        let config = try Self.configuration()
        let scenario = stopWhileUnresponsive ? "unresponsive" : "normal"
        let output = URL(fileURLWithPath: config.output).appendingPathComponent(scenario)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let home = output.appendingPathComponent("home")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let runtime = URL(fileURLWithPath: config.runtime).resolvingSymlinksInPath()
        let node = runtime.appendingPathComponent("bin/node").resolvingSymlinksInPath()
        let package = runtime.appendingPathComponent("lib/node_modules/openclaw")
        let entry = package.appendingPathComponent("dist/entry.js")
        try Self.require(FileManager.default.isExecutableFile(atPath: node.path), "Bundled Node missing")
        try Self.require(FileManager.default.isReadableFile(atPath: entry.path), "Packaged entry missing")
        try Self.require(!FileManager.default.fileExists(atPath: package.appendingPathComponent("src/entry.ts").path),
                         "Source checkout is not a packaged worker")

        let worker = MacNodeHostWorker(session: GatewayNodeSession())
        let clock = ContinuousClock()
        let started = clock.now
        var events: [Event] = []
        var childEnumerations: [ChildEnumeration] = []
        var observedDescendants: [Identity] = []
        var tracked: [Identity] = []
        var survived: Bool?
        var failure: Error?
        var cleanupComplete = false
        var launchAttempted = false
        func record(_ name: String, _ processes: [Identity]) {
            let duration = started.duration(to: clock.now).components
            events.append(Event(
                sequence: events.count,
                elapsedSeconds: Double(duration.seconds) + Double(duration.attoseconds) / 1e18,
                name: name,
                processes: processes))
        }

        do {
            // This binary belongs to this job's freshly staged runtime, not a shared Node installation.
            try Self.require(try Self.privateNodeProcesses(at: node.path).isEmpty, "A prior packaged worker is still alive")
            record("before-launch", [])
            launchAttempted = true
            let manifest = try await worker.start(launch: MacNodeHostWorkerLaunch(
                command: [node.path, entry.path, "node", "worker"],
                currentDirectoryURL: package,
                environment: [
                    "HOME": home.path,
                    "TMPDIR": home.path,
                    "OPENCLAW_STATE_DIR": home.appendingPathComponent("state").path,
                    "OPENCLAW_CONFIG_PATH": home.appendingPathComponent("openclaw.json").path,
                    "OPENCLAW_NO_RESPAWN": "0",
                    "PATH": node.deletingLastPathComponent().path,
                ]))
            try Self.require(manifest.commands.contains("system.run"), "Real worker did not return its capability manifest")
            let all = try Self.descendants(of: getpid()) { childEnumerations.append($0) }
            // Preserve the actual inventory before the exact executable filter can fail.
            observedDescendants = all
            let nodes = all.filter { $0.executable == node.path }
            tracked = nodes
            let expectedCount = config.phase == "baseline" ? 2 : 1
            try Self.require(nodes.count == expectedCount, "Unexpected private-Node topology: \(nodes.count)")
            guard let launcher = nodes.first(where: { $0.ppid == getpid() }) else {
                throw Failure(description: "No directly owned packaged Node launcher")
            }
            try Self.require(launcher.pgid == launcher.pid, "Managed launcher is not its session's process-group leader")
            tracked = [launcher] + (try Self.descendants(of: launcher.pid))
            let actualWorker: Identity
            if config.phase == "baseline" {
                guard let child = nodes.first(where: { $0.pid != launcher.pid }) else {
                    throw Failure(description: "Missing respawned worker")
                }
                try Self.require(child.ppid == launcher.pid && child.pgid == child.pid && child.pgid != launcher.pgid,
                                 "Worker did not form the expected escaped process group")
                actualWorker = child
            } else {
                actualWorker = launcher
            }
            record("ready-and-identity-verified", tracked)
            if stopWhileUnresponsive {
                try Self.signal(SIGSTOP, to: actualWorker)
                let deadline = clock.now + .seconds(2)
                var stopped: Identity?
                while clock.now < deadline {
                    stopped = try Self.live(actualWorker)
                    if stopped?.status == UInt32(SSTOP) { break }
                    try await Task.sleep(for: .milliseconds(10))
                }
                try Self.require(stopped?.status == UInt32(SSTOP), "SIGSTOP was not observed on the verified worker")
                record("worker-stopped", stopped.map { [$0] } ?? [])
            }
            record("owner-stop-called", [])
            await worker.stop()
            let remaining = try tracked.compactMap { try Self.live($0) }
            record("owner-stop-returned", remaining)
            survived = try Self.live(actualWorker) != nil
            if stopWhileUnresponsive && config.phase == "baseline" {
                try Self.require(survived == true, "Current baseline did not reproduce the escaped-worker defect")
                try Self.require(try Self.live(launcher) == nil, "Baseline launcher was not reaped")
            } else {
                try Self.require(try await Self.waitUntilGone([actualWorker, launcher]), "Owned worker survived normal cleanup")
                survived = false
            }
            record("behavior-observed", try tracked.compactMap { try Self.live($0) })
        } catch {
            failure = error
            record("proof-error", [])
        }

        // Cleanup follows the observation. It cannot turn a surviving worker into a pass.
        do {
            if launchAttempted {
                // A startup failure can retire the launcher before ready. The unique binary
                // plus the pre-launch absence check still identifies this job's orphan.
                for current in try Self.privateNodeProcesses(at: node.path) where
                    !tracked.contains(where: { $0.sameInstance(as: current) })
                {
                    tracked.append(current)
                }
            }
            for identity in Array(tracked) {
                guard let current = try Self.live(identity) else { continue }
                tracked += try Self.descendants(of: current.pid).filter { next in
                    !tracked.contains { $0.sameInstance(as: next) }
                }
            }
            await worker.stop()
            for identity in tracked.reversed() {
                try Self.signal(SIGKILL, to: identity, allowExit: true)
            }
            cleanupComplete = try await Self.waitUntilGone(tracked)
            if cleanupComplete {
                cleanupComplete = try Self.privateNodeProcesses(at: node.path).isEmpty
            }
            try Self.require(cleanupComplete, "Exact-instance cleanup did not complete")
            record("cleanup-complete", [])
        } catch {
            await worker.stop()
            failure = failure ?? error
            record("cleanup-error", [])
        }
        let observation = Observation(
            observerPID: getpid(),
            expectedExecutable: node.path,
            childEnumerations: childEnumerations,
            observedDescendants: observedDescendants,
            phase: config.phase,
            sourceSHA: config.sourceSHA,
            scenario: scenario,
            events: events,
            directWorkerSurvivedStop: survived,
            cleanupComplete: cleanupComplete,
            error: failure.map { String(describing: $0) })
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(observation).write(to: output.appendingPathComponent("observation.json"), options: .atomic)
        if let failure { throw failure }
    }
}
