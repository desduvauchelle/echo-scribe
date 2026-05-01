import Foundation
import Combine
import os

struct CoreStatusPayload: Codable {
    let healthy: Bool
    let uptimeSec: Int
}

struct PortPayload: Codable {
    let port: Int
}

@MainActor
final class CoreSupervisor: ObservableObject {
    private let logger = Logger(subsystem: "com.echoscribe.app", category: "CoreSupervisor")

    @Published var port: Int? = nil
    @Published var coreStatus: CoreStatusPayload? = nil

    private var process: Process?
    private var restartTask: Task<Void, Never>?
    private var backoffDelay: TimeInterval = 1.0

    init() {
        Task { await self.start() }
    }

    func start() async {
        // Find the sidecar binary or fall back to bun
        let binaryPath = Bundle.main.path(forResource: "core-runtime", ofType: nil, inDirectory: "Resources")
        let launchURL: URL
        let arguments: [String]

        if let binaryPath {
            launchURL = URL(fileURLWithPath: binaryPath)
            arguments = []
        } else {
            // Dev fallback: run via bun from repo root
            guard let bunPath = findBun() else {
                logger.error("Neither core-runtime binary nor bun found")
                return
            }
            launchURL = URL(fileURLWithPath: bunPath)
            // Determine repo root (go up from bundle or CWD)
            let repoRoot = findRepoRoot() ?? FileManager.default.currentDirectoryPath
            arguments = ["run", "\(repoRoot)/apps/core-runtime/src/main.ts"]
        }

        let proc = Process()
        proc.executableURL = launchURL
        proc.arguments = arguments

        let stdoutPipe = Pipe()
        proc.standardOutput = stdoutPipe

        proc.terminationHandler = { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.handleUnexpectedExit()
            }
        }

        do {
            try proc.run()
            self.process = proc
            self.backoffDelay = 1.0

            // Read the port from first line of stdout.
            // Contract: the sidecar must write exactly one JSON line `{"port":<n>}` to stdout
            // before any other output. This is the port-discovery protocol between supervisor and sidecar.
            if let line = readFirstLine(from: stdoutPipe),
               let data = line.data(using: .utf8),
               let payload = try? JSONDecoder().decode(PortPayload.self, from: data) {
                self.port = payload.port
                logger.info("Core sidecar started on port \(payload.port)")
            } else {
                logger.error("Failed to read port from sidecar stdout")
            }
        } catch {
            logger.error("Failed to launch sidecar: \(error.localizedDescription)")
        }
    }

    func stop() {
        restartTask?.cancel()
        guard let proc = process, proc.isRunning else { return }
        proc.terminate()
        // Wait up to 2s for graceful exit, then force-kill
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [weak proc] in
            proc?.interrupt()
        }
        process = nil
    }

    private func handleUnexpectedExit() {
        port = nil
        process = nil
        let delay = backoffDelay
        logger.warning("Sidecar exited unexpectedly. Restarting in \(delay)s")
        restartTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            await self.start()
        }
        backoffDelay = min(backoffDelay * 2, 30.0)
    }

    // Blocking read of the pipe until the first newline is found.
    // Acceptable in Phase 0 since this runs inside a Task off the main thread.
    private func readFirstLine(from pipe: Pipe) -> String? {
        var result = ""
        let handle = pipe.fileHandleForReading
        while true {
            let data = handle.availableData
            if data.isEmpty { continue }
            guard let str = String(data: data, encoding: .utf8) else { return nil }
            result += str
            if let newlineRange = result.range(of: "\n") {
                return String(result[..<newlineRange.lowerBound])
            }
        }
    }

    private func findBun() -> String? {
        let candidates = [
            "/Users/\(NSUserName())/.bun/bin/bun",
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun"
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0) }
    }

    private func findRepoRoot() -> String? {
        // Walk up from the app bundle until BUILD_PLAN.md is found (marks the repo root)
        var url = Bundle.main.bundleURL
        for _ in 0..<10 {
            url = url.deletingLastPathComponent()
            if FileManager.default.fileExists(atPath: url.appendingPathComponent("BUILD_PLAN.md").path) {
                return url.path
            }
        }
        return nil
    }
}
