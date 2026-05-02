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

            // Read port on a background thread — readFirstLine blocks and must not run on MainActor.
            // Contract: sidecar writes `{"port":<n>}\n` as its first stdout line.
            Task.detached { [weak self] in
                guard let self else { return }
                let line = self.readFirstLine(from: stdoutPipe)
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    if let line,
                       let data = line.data(using: .utf8),
                       let payload = try? JSONDecoder().decode(PortPayload.self, from: data) {
                        self.port = payload.port
                        self.logger.info("Core sidecar started on port \(payload.port)")
                    } else {
                        self.logger.error("Failed to read port from sidecar stdout")
                    }
                }
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

    // Read from the pipe until a newline is found.
    // nonisolated so it can be called from Task.detached without crossing the MainActor boundary.
    // Uses readData(ofLength:) which blocks until data is available — no spin-wait.
    nonisolated private func readFirstLine(from pipe: Pipe) -> String? {
        let handle = pipe.fileHandleForReading
        var accumulated = Data()
        while true {
            // readData(ofLength:) blocks until data arrives or EOF
            let chunk = handle.readData(ofLength: 512)
            if chunk.isEmpty { return nil } // EOF before newline
            accumulated.append(chunk)
            if let str = String(data: accumulated, encoding: .utf8),
               let newlineRange = str.range(of: "\n") {
                return String(str[..<newlineRange.lowerBound])
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

    nonisolated private func findRepoRoot() -> String? {
        let fm = FileManager.default
        let marker = "BUILD_PLAN.md"

        // Strategy 1: walk up from app bundle (works when running from repo DerivedData)
        var url = Bundle.main.bundleURL
        for _ in 0..<15 {
            url = url.deletingLastPathComponent()
            if fm.fileExists(atPath: url.appendingPathComponent(marker).path) {
                return url.path
            }
        }

        // Strategy 2: check common dev locations under the user home directory
        let home = NSHomeDirectory()
        let candidates = [
            "\(home)/Documents/code/echo-scribe",
            "\(home)/code/echo-scribe",
            "\(home)/dev/echo-scribe",
            "\(home)/projects/echo-scribe",
            "\(home)/src/echo-scribe",
        ]
        return candidates.first { fm.fileExists(atPath: "\($0)/\(marker)") }
    }
}
