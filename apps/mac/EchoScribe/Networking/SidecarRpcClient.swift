import Foundation
import Combine
import os

// Matches the voice.captured params expected by the TypeScript core
struct VoiceCapturedParams: Encodable {
    let text: String
    let source: String       // "voice_at_cursor"
    let visibility: String   // "hidden"
    let capturedAt: String   // ISO-8601
}

struct VoiceCapturedResult: Decodable {
    let itemId: String
}

// Settings pushed from core
struct SettingsPayload: Decodable {
    let hotkeyBinding: String
}

final class SidecarRpcClient: NSObject, URLSessionWebSocketDelegate {
    private let logger = Logger(subsystem: "com.echoscribe.app", category: "SidecarRpcClient")
    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private var nextId: Int = 1
    private var pendingCalls: [Int: CheckedContinuation<Data, Error>] = [:]
    private var port: Int = 0

    // Publish when settings arrive
    let settingsChanged = PassthroughSubject<SettingsPayload, Never>()

    override init() {
        super.init()
        session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    func connect(to port: Int) {
        self.port = port
        let url = URL(string: "ws://127.0.0.1:\(port)")!
        task = session.webSocketTask(with: url)
        task?.resume()
        receive()
        logger.info("SidecarRpcClient connecting to port \(port)")
    }

    func disconnect() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handle(data: Data(text.utf8))
                case .data(let data):
                    self.handle(data: data)
                @unknown default: break
                }
                self.receive()
            case .failure(let error):
                self.logger.error("WebSocket receive error: \(error.localizedDescription)")
                // Reconnect after a short delay
                DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [weak self] in
                    self?.connect(to: self?.port ?? 0)
                }
            }
        }
    }

    private func handle(data: Data) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        // Response to a call (has "id")
        if let id = json["id"] as? Int {
            let cont = pendingCalls.removeValue(forKey: id)
            cont?.resume(returning: data)
            return
        }

        // Notification (no "id", has "method")
        if let method = json["method"] as? String, method == "settings.changed",
           let params = json["params"],
           let paramsData = try? JSONSerialization.data(withJSONObject: params),
           let payload = try? JSONDecoder().decode(SettingsPayload.self, from: paramsData) {
            settingsChanged.send(payload)
        }
    }

    /// Call voice.captured on the sidecar. Returns the assigned item ID.
    func voiceCaptured(text: String, capturedAt: Date) async throws -> String {
        let params = VoiceCapturedParams(
            text: text,
            source: "voice_at_cursor",
            visibility: "hidden",
            capturedAt: ISO8601DateFormatter().string(from: capturedAt)
        )
        let paramsData = try JSONEncoder().encode(params)
        let paramsObj = try JSONSerialization.jsonObject(with: paramsData)

        let id = nextId
        nextId += 1

        let request: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "method": "voice.captured",
            "params": paramsObj
        ]
        let requestData = try JSONSerialization.data(withJSONObject: request)

        let responseData: Data = try await withCheckedThrowingContinuation { continuation in
            pendingCalls[id] = continuation
            task?.send(.data(requestData)) { [weak self] error in
                if let error {
                    self?.pendingCalls.removeValue(forKey: id)
                    continuation.resume(throwing: error)
                }
            }
        }

        struct ResponseShape: Decodable {
            struct Result: Decodable { let itemId: String }
            let result: Result?
        }
        let response = try JSONDecoder().decode(ResponseShape.self, from: responseData)
        return response.result?.itemId ?? ""
    }
}
