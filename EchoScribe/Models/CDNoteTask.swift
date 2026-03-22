import CoreData

@objc(CDNoteTask)
public final class CDNoteTask: NSManagedObject, Identifiable {
    @NSManaged public var id: UUID
    @NSManaged public var title: String
    @NSManaged public var dueDate: Date?
    @NSManaged public var isCompleted: Bool
    @NSManaged public var createdAt: Date
    @NSManaged public var note: CDNote?
    @NSManaged public var project: CDProject?

    @nonobjc public static func fetchRequest() -> NSFetchRequest<CDNoteTask> {
        NSFetchRequest<CDNoteTask>(entityName: "CDNoteTask")
    }

    static func insert(in context: NSManagedObjectContext,
                       title: String,
                       note: CDNote? = nil,
                       project: CDProject? = nil,
                       dueDate: Date? = nil) -> CDNoteTask {
        let task = CDNoteTask(context: context)
        task.id = UUID()
        task.title = title
        task.isCompleted = false
        task.createdAt = Date()
        task.dueDate = dueDate
        task.note = note
        task.project = project
        return task
    }
}
