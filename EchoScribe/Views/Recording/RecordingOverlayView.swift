import SwiftUI

struct RecordingOverlayView: View {
    @Bindable var viewModel: RecordingViewModel
    var onDismiss: () -> Void

    var body: some View {
        VStack(spacing: Spacing.lg) {
            if viewModel.isTranscribing {
                HStack {
                    ProgressView()
                        .controlSize(.small)
                    Text("Transcribing...")
                        .font(.headline)
                    Spacer()
                }

                Spacer()

                ScrollView {
                    Text(viewModel.liveTranscript.isEmpty ? "Processing audio..." : viewModel.liveTranscript)
                        .font(.body)
                        .foregroundStyle(viewModel.liveTranscript.isEmpty ? .tertiary : .primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 200)

                Spacer()
            } else {
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
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                }

                WaveformView(level: viewModel.audioLevel)
                    .frame(height: 60)

                ScrollView {
                    Text(viewModel.liveTranscript.isEmpty ? "Listening..." : viewModel.liveTranscript)
                        .font(.body)
                        .foregroundStyle(viewModel.liveTranscript.isEmpty ? .tertiary : .primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 200)

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
            }

            if let error = viewModel.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(Spacing.lg)
        .frame(width: 400, height: 350)
    }

    @State private var pulseOpacity: Double = 1.0

    init(viewModel: RecordingViewModel, onDismiss: @escaping () -> Void) {
        self.viewModel = viewModel
        self.onDismiss = onDismiss
    }
}
