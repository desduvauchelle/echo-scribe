import SwiftUI

struct RecordingOverlayView: View {
    @Bindable var viewModel: RecordingViewModel
    var onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            // Title
            HStack {
                Circle()
                    .fill(.red)
                    .frame(width: 10, height: 10)
                    .opacity(pulseOpacity)
                Text("Recording...")
                    .font(.headline)
                Spacer()
                Button {
                    Task { await viewModel.stopRecording() }
                    onDismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }

            // Waveform
            WaveformView(level: viewModel.audioLevel)
                .frame(height: 60)

            // Live transcript
            ScrollView {
                Text(viewModel.liveTranscript.isEmpty ? "Listening..." : viewModel.liveTranscript)
                    .font(.body)
                    .foregroundStyle(viewModel.liveTranscript.isEmpty ? .secondary : .primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 200)

            // Stop button
            Button {
                Task { await viewModel.stopRecording() }
                onDismiss()
            } label: {
                Label("Stop & Save", systemImage: "stop.circle.fill")
                    .font(.headline)
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .controlSize(.large)

            if let error = viewModel.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(24)
        .frame(width: 400, height: 350)
    }

    @State private var pulseOpacity: Double = 1.0

    init(viewModel: RecordingViewModel, onDismiss: @escaping () -> Void) {
        self.viewModel = viewModel
        self.onDismiss = onDismiss
    }
}
