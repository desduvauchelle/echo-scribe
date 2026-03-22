import CoreData

@objc(CDNote)
public final class CDNote: NSManagedObject, Identifiable {
    @NSManaged public var id: UUID
    @NSManaged public var rawTranscript: String
    @NSManaged public var processedText: String?
    @NSManaged public var summary: String?
    @NSManaged public var createdAt: Date
    @NSManaged public var updatedAt: Date
    @NSManaged public var isProcessed: Bool
    @NSManaged public var project: CDProject?
    @NSManaged public var tasks: NSSet
    @NSManaged public var tags: NSSet

    @nonobjc public static func fetchRequest() -> NSFetchRequest<CDNote> {
        NSFetchRequest<CDNote>(entityName: "CDNote")
    }

    var displayText: String {
        processedText ?? rawTranscript
    }

    var tagsArray: [CDTag] {
        (tags as? Set<CDTag> ?? []).sorted { $0.name < $1.name }
    }

    var tasksArray: [CDNoteTask] {
        (tasks as? Set<CDNoteTask> ?? []).sorted { $0.createdAt < $1.createdAt }
    }

    static func insert(in context: NSManagedObjectContext,
                       rawTranscript: String) -> CDNote {
        let note = CDNote(context: context)
        note.id = UUID()
        note.rawTranscript = rawTranscript
        note.isProcessed = false
        note.createdAt = Date()
        note.updatedAt = Date()
        return note
    }
}

extension CDNote {
    @objc(addTasksObject:) @NSManaged public func addToTasks(_ value: CDNoteTask)
    @objc(removeTasksObject:) @NSManaged public func removeFromTasks(_ value: CDNoteTask)
    @objc(addTasks:) @NSManaged public func addToTasks(_ values: NSSet)
    @objc(removeTasks:) @NSManaged public func removeFromTasks(_ values: NSSet)

    @objc(addTagsObject:) @NSManaged public func addToTags(_ value: CDTag)
    @objc(removeTagsObject:) @NSManaged public func removeFromTags(_ value: CDTag)
    @objc(addTags:) @NSManaged public func addToTags(_ values: NSSet)
    @objc(removeTags:) @NSManaged public func removeFromTags(_ values: NSSet)
}
