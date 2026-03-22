import CoreSpotlight
import UniformTypeIdentifiers

@MainActor
@Observable
final class SpotlightIndexer {
    private let index = CSSearchableIndex.default()

    func indexNotes(_ notes: [NoteWithDetails]) {
        Task.detached { [notes] in
            let items = notes.map { detail -> CSSearchableItem in
                let attrs = CSSearchableItemAttributeSet(contentType: .text)
                attrs.title = detail.note.summary ?? String(detail.note.displayText.prefix(80))
                attrs.contentDescription = detail.note.displayText
                attrs.keywords = detail.tags.map(\.name)
                if let project = detail.project {
                    attrs.authorNames = [project.name]
                }
                attrs.contentCreationDate = detail.note.createdAt
                attrs.contentModificationDate = detail.note.updatedAt

                return CSSearchableItem(
                    uniqueIdentifier: "note-\(detail.note.id)",
                    domainIdentifier: "com.echoscribe.notes",
                    attributeSet: attrs
                )
            }

            do {
                try await CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: ["com.echoscribe.notes"])
                try await CSSearchableIndex.default().indexSearchableItems(items)
            } catch {
                print("Spotlight indexing failed: \(error)")
            }
        }
    }

    func removeAllIndexedItems() {
        Task.detached {
            try? await CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: ["com.echoscribe.notes"])
        }
    }
}
