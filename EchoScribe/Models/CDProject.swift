import CoreData

@objc(CDProject)
public final class CDProject: NSManagedObject, Identifiable {
    @NSManaged public var id: UUID
    @NSManaged public var name: String
    @NSManaged public var color: String
    @NSManaged public var createdAt: Date
    @NSManaged public var projectDescription: String?
    @NSManaged public var updatedAt: Date
    @NSManaged public var notes: NSSet
    @NSManaged public var tasks: NSSet

    @nonobjc public static func fetchRequest() -> NSFetchRequest<CDProject> {
        NSFetchRequest<CDProject>(entityName: "CDProject")
    }

    static func insert(in context: NSManagedObjectContext,
                       name: String,
                       color: String = "#007AFF",
                       projectDescription: String? = nil) -> CDProject {
        let project = CDProject(context: context)
        project.id = UUID()
        project.name = name
        project.color = color
        project.projectDescription = projectDescription
        project.createdAt = Date()
        project.updatedAt = Date()
        return project
    }
}

extension CDProject {
    @objc(addNotesObject:) @NSManaged public func addToNotes(_ value: CDNote)
    @objc(removeNotesObject:) @NSManaged public func removeFromNotes(_ value: CDNote)
    @objc(addNotes:) @NSManaged public func addToNotes(_ values: NSSet)
    @objc(removeNotes:) @NSManaged public func removeFromNotes(_ values: NSSet)

    @objc(addTasksObject:) @NSManaged public func addToTasks(_ value: CDNoteTask)
    @objc(removeTasksObject:) @NSManaged public func removeFromTasks(_ value: CDNoteTask)
}
