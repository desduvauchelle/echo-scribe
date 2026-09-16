import AppKit
import ComputerUseCore
import Foundation

@main
struct Main {
    @MainActor static func main() async {
        let args = CommandLine.arguments
        if args.count == 1 {
            let panel = DemoPanel()
            NSApplication.shared.setActivationPolicy(.regular)
            panel.show()
            NSApplication.shared.run()
            withExtendedLifetime(panel) {}
            return
        }
        guard let index = args.firstIndex(of: "--pid"), args.indices.contains(index + 1), let pid = Int32(args[index + 1]) else {
            fputs("Usage: tucky-computer-use --pid PID [--allow-actions]\nNDJSON stdin/stdout. One app per session; no foreground fallback. Escape or stop cancels.\n", stderr)
            exit(2)
        }
        let stop = StopToken()
        do {
            let controller = try Controller(pid: pid, allowActions: args.contains("--allow-actions"), stop: stop)
            let requests = AsyncStream<String> { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    while let line = readLine() {
                        if let request = try? JSONDecoder().decode(ToolRequest.self, from: Data(line.utf8)), request.tool == "stop" {
                            stop.stop()
                        }
                        continuation.yield(line)
                    }
                    stop.stop()
                    continuation.finish()
                }
            }
            for await line in requests {
                var id = "invalid"
                var tool = "invalid"
                let response: [String: Any]
                do {
                    guard line.utf8.count <= 32_768 else { throw ControlError("request_too_large", "Request exceeds 32KB.") }
                    let request = try JSONDecoder().decode(ToolRequest.self, from: Data(line.utf8))
                    id = request.id; tool = request.tool
                    response = ["id": id, "ok": true, "result": try await controller.handle(request)]
                    fputs("[computer_use] tool=\(tool) result=ok\n", stderr)
                } catch {
                    let failure = error as? ControlError ?? ControlError("tool_failed", String(describing: error))
                    response = ["id": id, "ok": false, "error": ["code": failure.code, "message": failure.description]]
                    fputs("[computer_use] tool=\(tool) error=\(failure.code)\n", stderr)
                }
                let data = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
                FileHandle.standardOutput.write(data)
                FileHandle.standardOutput.write(Data([10]))
            }
        } catch {
            fputs("[computer_use] startup failed: \(error)\n", stderr)
            exit(1)
        }
    }
}
