import CoreSpotlight
import UniformTypeIdentifiers

@MainActor
@Observable
final class SpotlightIndexer {

    func indexNotes(_ notes: [NoteWithDetails]) {
        // Extract value types before crossing thread boundary —
        // NSManagedObject is not thread-safe.
        let snapshots = notes.map { detail in
            SpotlightSnapshot(
                uniqueId: "note-\(detail.note.id.uuidString)",
                title: detail.note.summary ?? String(detail.note.displayText.prefix(80)),
                content: detail.note.displayText,
                keywords: detail.tags.map(\.name),
                projectName: detail.project?.name,
                createdAt: detail.note.createdAt,
                updatedAt: detail.note.updatedAt
            )
        }

        Task.detached {
            let items = snapshots.map { snapshot -> CSSearchableItem in
                let attrs = CSSearchableItemAttributeSet(contentType: .text)
                attrs.title = snapshot.title
                attrs.contentDescription = snapshot.content
                attrs.keywords = snapshot.keywords
                if let projectName = snapshot.projectName {
                    attrs.authorNames = [projectName]
                }
                attrs.contentCreationDate = snapshot.createdAt
                attrs.contentModificationDate = snapshot.updatedAt

                return CSSearchableItem(
                    uniqueIdentifier: snapshot.uniqueId,
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

private struct SpotlightSnapshot: Sendable {
    let uniqueId: String
    let title: String
    let content: String
    let keywords: [String]
    let projectName: String?
    let createdAt: Date
    let updatedAt: Date
}
