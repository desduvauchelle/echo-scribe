import Foundation
import AppKit
import UserNotifications
import os

@MainActor
final class VoiceToTextPipeline: ObservableObject {
    private let logger = Logger(subsystem: "com.echoscribe.app", category: "VoiceToTextPipeline")
    let hotkeyManager = HotkeyManager()
    private let recorder = MicRecorder()
    private let transcriber = AppleTranscriber()
    private let inserter = CursorInserter()
    let rpcClient = SidecarRpcClient()

    @Published var isRecording = false

    func setup(port: Int) {
        rpcClient.connect(to: port)

        hotkeyManager.onPressDown = { [weak self] in
            Task { @MainActor [weak self] in
                await self?.startRecording()
            }
        }
        hotkeyManager.onPressUp = { [weak self] in
            Task { @MainActor [weak self] in
                await self?.stopAndProcess()
            }
        }
    }

    private func startRecording() async {
        guard !isRecording else { return }
        do {
            _ = try await recorder.start()
            isRecording = true
            logger.info("Recording started")
        } catch {
            logger.error("Failed to start recording: \(error.localizedDescription)")
            showNotification(title: "Recording failed", body: error.localizedDescription)
        }
    }

    private func stopAndProcess() async {
        guard isRecording else { return }
        isRecording = false

        let audioURL: URL
        do {
            audioURL = try recorder.stop()
        } catch {
            logger.error("Failed to stop recording: \(error.localizedDescription)")
            return
        }

        // Transcribe
        let text: String
        do {
            text = try await transcriber.transcribe(audioURL: audioURL)
        } catch TranscriptionError.noSpeechDetected {
            logger.info("No speech detected")
            try? FileManager.default.removeItem(at: audioURL)
            return
        } catch {
            logger.error("Transcription failed: \(error.localizedDescription)")
            showNotification(title: "Transcription failed", body: error.localizedDescription)
            try? FileManager.default.removeItem(at: audioURL)
            return
        }

        // Delete audio (transient per decision 001)
        try? FileManager.default.removeItem(at: audioURL)

        // Paste at cursor
        do {
            try inserter.insert(text: text)
        } catch {
            logger.error("Paste failed: \(error.localizedDescription)")
        }

        // Log to core as hidden item
        Task {
            do {
                _ = try await rpcClient.voiceCaptured(text: text, capturedAt: Date())
            } catch {
                logger.error("voice.captured RPC failed: \(error.localizedDescription)")
            }
        }
    }

    private func showNotification(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
