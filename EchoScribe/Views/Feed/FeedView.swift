import SwiftUI

struct FeedView: View {
    @Bindable var feedViewModel: FeedViewModel
    @Binding var selectedNoteId: String?

    var body: some View {
        Group {
            if feedViewModel.notes.isEmpty {
                emptyState
            } else {
                notesList
            }
        }
        .onKeyPress(.upArrow) {
            moveSelection(by: -1)
            return .handled
        }
        .onKeyPress(.downArrow) {
            moveSelection(by: 1)
            return .handled
        }
        .onKeyPress(.return) {
            if selectedNoteId != nil {
                return .handled
            }
            return .ignored
        }
    }

    private var notesList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(feedViewModel.notes, id: \.note.id) { noteDetail in
                        NoteCardView(
                            noteDetail: noteDetail,
                            isSelected: noteDetail.note.id == selectedNoteId
                        )
                        .id(noteDetail.note.id)
                        .onTapGesture {
                            selectedNoteId = noteDetail.note.id
                        }
                        .contextMenu {
                            Button("Open") {
                                selectedNoteId = noteDetail.note.id
                            }
                            Divider()
                            Button("Delete", role: .destructive) {
                                feedViewModel.deleteNote(noteDetail)
                            }
                        }
                    }
                }
                .padding()
            }
            .onChange(of: selectedNoteId) { _, newValue in
                if let newValue {
                    withAnimation {
                        proxy.scrollTo(newValue, anchor: .center)
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "mic.badge.plus")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("No notes yet")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("Press Cmd+R or click the mic button to start recording")
                .font(.body)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func moveSelection(by offset: Int) {
        let notes = feedViewModel.notes
        guard !notes.isEmpty else { return }

        if let currentId = selectedNoteId,
           let currentIndex = notes.firstIndex(where: { $0.note.id == currentId }) {
            let newIndex = min(max(currentIndex + offset, 0), notes.count - 1)
            selectedNoteId = notes[newIndex].note.id
        } else {
            selectedNoteId = notes[0].note.id
        }
    }
}
