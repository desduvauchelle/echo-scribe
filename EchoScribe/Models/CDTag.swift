import CoreData

@objc(CDTag)
public final class CDTag: NSManagedObject, Identifiable {
    @NSManaged public var id: UUID
    @NSManaged public var name: String
    @NSManaged public var notes: NSSet

    @nonobjc public static func fetchRequest() -> NSFetchRequest<CDTag> {
        NSFetchRequest<CDTag>(entityName: "CDTag")
    }

    /// Finds an existing tag by name (case-insensitive) or creates a new one.
    static func findOrCreate(name: String, in context: NSManagedObjectContext) -> CDTag {
        let normalizedName = name.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        let request: NSFetchRequest<CDTag> = NSFetchRequest(entityName: "CDTag")
        request.predicate = NSPredicate(format: "name ==[cd] %@", normalizedName)
        request.fetchLimit = 1
        if let existing = try? context.fetch(request).first {
            return existing
        }
        let tag = CDTag(context: context)
        tag.id = UUID()
        tag.name = normalizedName
        return tag
    }
}

extension CDTag {
    @objc(addNotesObject:) @NSManaged public func addToNotes(_ value: CDNote)
    @objc(removeNotesObject:) @NSManaged public func removeFromNotes(_ value: CDNote)
}
