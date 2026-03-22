import SwiftUI

struct FeedView: View {
    @Bindable var feedViewModel: FeedViewModel
    @Binding var selectedNoteId: UUID?

    var body: some View {
        Group {
            if feedViewModel.notes.isEmpty {
                emptyFilterState
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
            LazyVStack(spacing: Spacing.md) {
                ForEach(feedViewModel.notes, id: \.note.id) { noteDetail in
                    NoteCardView(
                        noteDetail: noteDetail,
                        isSelected: noteDetail.note.id == selectedNoteId
                    )
                    .id(noteDetail.note.id)
                    .onTapGesture {
                        withAnimation(AppAnimation.gentle) {
                            selectedNoteId = noteDetail.note.id
                        }
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
                    .gentleAppear()
                }
            }
            .padding(.bottom, Spacing.xl)
            .onChange(of: selectedNoteId) { _, newValue in
                if let newValue {
                    withAnimation(AppAnimation.gentle) {
                        proxy.scrollTo(newValue, anchor: .center)
                    }
                }
            }
        }
    }

    private var emptyFilterState: some View {
        VStack(spacing: Spacing.md) {
            Image(systemName: "doc.text.magnifyingglass")
                .font(.system(size: 36))
                .foregroundStyle(.tertiary)
            Text("No matching notes")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 200)
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
