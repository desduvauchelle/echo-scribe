import SwiftUI

struct ShortcutConflictView: View {
    let conflicts: [ShortcutConflict]
    let onDisableSystemShortcut: ((Int) -> Void)?

    var body: some View {
        if !conflicts.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                ForEach(conflicts) { conflict in
                    conflictRow(conflict)
                }
            }
            .padding(Spacing.sm)
            .background(
                RoundedRectangle(cornerRadius: Radius.sm)
                    .fill(Color.orange.opacity(0.1))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Radius.sm)
                    .strokeBorder(Color.orange.opacity(0.3), lineWidth: 1)
            )
        }
    }

    @ViewBuilder
    private func conflictRow(_ conflict: ShortcutConflict) -> some View {
        HStack(alignment: .top, spacing: Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .font(.caption)

            VStack(alignment: .leading, spacing: 2) {
                Text("Conflicts with: \(conflict.displayName)")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if let systemID = conflict.systemShortcutID, systemID != -1 {
                    HStack(spacing: Spacing.xs) {
                        Button("Open Keyboard Settings") {
                            openKeyboardSettings()
                        }
                        .font(.caption)
                        .controlSize(.mini)

                        Button("Disable System Shortcut") {
                            onDisableSystemShortcut?(systemID)
                        }
                        .font(.caption)
                        .controlSize(.mini)
                        .foregroundStyle(.orange)
                    }
                }
            }

            Spacer()
        }
    }

    private func openKeyboardSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension") {
            NSWorkspace.shared.open(url)
        }
    }
}
