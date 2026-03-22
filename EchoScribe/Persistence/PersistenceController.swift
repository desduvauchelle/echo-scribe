import CoreData

final class PersistenceController: @unchecked Sendable {
    static let shared = PersistenceController()

    let container: NSPersistentCloudKitContainer

    var viewContext: NSManagedObjectContext {
        container.viewContext
    }

    init(inMemory: Bool = false) {
        let model = Self.buildModel()
        container = NSPersistentCloudKitContainer(name: "EchoScribe", managedObjectModel: model)

        if inMemory {
            container.persistentStoreDescriptions.first?.url = URL(fileURLWithPath: "/dev/null")
            container.persistentStoreDescriptions.first?.cloudKitContainerOptions = nil
        } else {
            // Disable CloudKit — no Apple Developer account yet.
            // When you add one, remove these two lines and add iCloud entitlements.
            container.persistentStoreDescriptions.first?.cloudKitContainerOptions = nil
        }

        container.loadPersistentStores { _, error in
            if let error {
                print("Core Data failed to load: \(error)")
            }
        }

        container.viewContext.automaticallyMergesChangesFromParent = true
        container.viewContext.mergePolicy = NSMergePolicy.mergeByPropertyObjectTrump
        container.viewContext.name = "viewContext"
    }

    /// Background context for pipeline writes — automatically merges into viewContext
    func newBackgroundContext() -> NSManagedObjectContext {
        let ctx = container.newBackgroundContext()
        ctx.mergePolicy = NSMergePolicy.mergeByPropertyObjectTrump
        return ctx
    }

    func save(context: NSManagedObjectContext? = nil) {
        let ctx = context ?? viewContext
        guard ctx.hasChanges else { return }
        do {
            try ctx.save()
        } catch {
            print("Core Data save error: \(error)")
        }
    }

    /// In-memory store for previews and tests
    nonisolated(unsafe) static var preview: PersistenceController = {
        let controller = PersistenceController(inMemory: true)
        let ctx = controller.viewContext

        let project = CDProject.insert(in: ctx, name: "Work", color: "#007AFF")
        let note = CDNote.insert(in: ctx, rawTranscript: "Schedule meeting with design team about the new onboarding flow")
        note.processedText = "Schedule meeting with design team about the new onboarding flow"
        note.summary = "Meeting scheduling"
        note.isProcessed = true
        note.project = project

        let tag = CDTag.findOrCreate(name: "meeting", in: ctx)
        note.addToTags(tag)

        let task = CDNoteTask(context: ctx)
        task.id = UUID()
        task.title = "Schedule design meeting"
        task.isCompleted = false
        task.createdAt = Date()
        task.note = note
        task.project = project

        controller.save()
        return controller
    }()

    // MARK: - Programmatic Model Definition
    // SPM cannot compile .xcdatamodeld → .momd (only Xcode's build system does).
    // This builds the identical schema in code so it works in both SPM and Xcode builds.

    private static func buildModel() -> NSManagedObjectModel {
        let model = NSManagedObjectModel()

        // --- CDProject ---
        let projectEntity = NSEntityDescription()
        projectEntity.name = "CDProject"
        projectEntity.managedObjectClassName = "CDProject"

        let projectId = NSAttributeDescription()
        projectId.name = "id"
        projectId.attributeType = .UUIDAttributeType
        projectId.isOptional = false

        let projectName = NSAttributeDescription()
        projectName.name = "name"
        projectName.attributeType = .stringAttributeType
        projectName.isOptional = false

        let projectColor = NSAttributeDescription()
        projectColor.name = "color"
        projectColor.attributeType = .stringAttributeType
        projectColor.isOptional = false
        projectColor.defaultValue = "#007AFF"

        let projectDescription = NSAttributeDescription()
        projectDescription.name = "projectDescription"
        projectDescription.attributeType = .stringAttributeType
        projectDescription.isOptional = true

        let projectCreatedAt = NSAttributeDescription()
        projectCreatedAt.name = "createdAt"
        projectCreatedAt.attributeType = .dateAttributeType
        projectCreatedAt.isOptional = false

        let projectUpdatedAt = NSAttributeDescription()
        projectUpdatedAt.name = "updatedAt"
        projectUpdatedAt.attributeType = .dateAttributeType
        projectUpdatedAt.isOptional = false

        // --- CDNote ---
        let noteEntity = NSEntityDescription()
        noteEntity.name = "CDNote"
        noteEntity.managedObjectClassName = "CDNote"

        let noteId = NSAttributeDescription()
        noteId.name = "id"
        noteId.attributeType = .UUIDAttributeType
        noteId.isOptional = false

        let noteRawTranscript = NSAttributeDescription()
        noteRawTranscript.name = "rawTranscript"
        noteRawTranscript.attributeType = .stringAttributeType
        noteRawTranscript.isOptional = false

        let noteProcessedText = NSAttributeDescription()
        noteProcessedText.name = "processedText"
        noteProcessedText.attributeType = .stringAttributeType
        noteProcessedText.isOptional = true

        let noteSummary = NSAttributeDescription()
        noteSummary.name = "summary"
        noteSummary.attributeType = .stringAttributeType
        noteSummary.isOptional = true

        let noteCreatedAt = NSAttributeDescription()
        noteCreatedAt.name = "createdAt"
        noteCreatedAt.attributeType = .dateAttributeType
        noteCreatedAt.isOptional = false

        let noteUpdatedAt = NSAttributeDescription()
        noteUpdatedAt.name = "updatedAt"
        noteUpdatedAt.attributeType = .dateAttributeType
        noteUpdatedAt.isOptional = false

        let noteIsProcessed = NSAttributeDescription()
        noteIsProcessed.name = "isProcessed"
        noteIsProcessed.attributeType = .booleanAttributeType
        noteIsProcessed.isOptional = false
        noteIsProcessed.defaultValue = false

        // --- CDNoteTask ---
        let taskEntity = NSEntityDescription()
        taskEntity.name = "CDNoteTask"
        taskEntity.managedObjectClassName = "CDNoteTask"

        let taskId = NSAttributeDescription()
        taskId.name = "id"
        taskId.attributeType = .UUIDAttributeType
        taskId.isOptional = false

        let taskTitle = NSAttributeDescription()
        taskTitle.name = "title"
        taskTitle.attributeType = .stringAttributeType
        taskTitle.isOptional = false

        let taskDueDate = NSAttributeDescription()
        taskDueDate.name = "dueDate"
        taskDueDate.attributeType = .dateAttributeType
        taskDueDate.isOptional = true

        let taskIsCompleted = NSAttributeDescription()
        taskIsCompleted.name = "isCompleted"
        taskIsCompleted.attributeType = .booleanAttributeType
        taskIsCompleted.isOptional = false
        taskIsCompleted.defaultValue = false

        let taskCreatedAt = NSAttributeDescription()
        taskCreatedAt.name = "createdAt"
        taskCreatedAt.attributeType = .dateAttributeType
        taskCreatedAt.isOptional = false

        // --- CDTag ---
        let tagEntity = NSEntityDescription()
        tagEntity.name = "CDTag"
        tagEntity.managedObjectClassName = "CDTag"

        let tagId = NSAttributeDescription()
        tagId.name = "id"
        tagId.attributeType = .UUIDAttributeType
        tagId.isOptional = false

        let tagName = NSAttributeDescription()
        tagName.name = "name"
        tagName.attributeType = .stringAttributeType
        tagName.isOptional = false

        // --- Relationships ---

        // CDProject.notes ↔ CDNote.project
        let projectNotesRel = NSRelationshipDescription()
        projectNotesRel.name = "notes"
        projectNotesRel.destinationEntity = noteEntity
        projectNotesRel.minCount = 0
        projectNotesRel.maxCount = 0 // to-many
        projectNotesRel.deleteRule = .cascadeDeleteRule
        projectNotesRel.isOptional = true

        let noteProjectRel = NSRelationshipDescription()
        noteProjectRel.name = "project"
        noteProjectRel.destinationEntity = projectEntity
        noteProjectRel.minCount = 0
        noteProjectRel.maxCount = 1 // to-one
        noteProjectRel.deleteRule = .nullifyDeleteRule
        noteProjectRel.isOptional = true

        projectNotesRel.inverseRelationship = noteProjectRel
        noteProjectRel.inverseRelationship = projectNotesRel

        // CDProject.tasks ↔ CDNoteTask.project
        let projectTasksRel = NSRelationshipDescription()
        projectTasksRel.name = "tasks"
        projectTasksRel.destinationEntity = taskEntity
        projectTasksRel.minCount = 0
        projectTasksRel.maxCount = 0
        projectTasksRel.deleteRule = .nullifyDeleteRule
        projectTasksRel.isOptional = true

        let taskProjectRel = NSRelationshipDescription()
        taskProjectRel.name = "project"
        taskProjectRel.destinationEntity = projectEntity
        taskProjectRel.minCount = 0
        taskProjectRel.maxCount = 1
        taskProjectRel.deleteRule = .nullifyDeleteRule
        taskProjectRel.isOptional = true

        projectTasksRel.inverseRelationship = taskProjectRel
        taskProjectRel.inverseRelationship = projectTasksRel

        // CDNote.tasks ↔ CDNoteTask.note
        let noteTasksRel = NSRelationshipDescription()
        noteTasksRel.name = "tasks"
        noteTasksRel.destinationEntity = taskEntity
        noteTasksRel.minCount = 0
        noteTasksRel.maxCount = 0
        noteTasksRel.deleteRule = .cascadeDeleteRule
        noteTasksRel.isOptional = true

        let taskNoteRel = NSRelationshipDescription()
        taskNoteRel.name = "note"
        taskNoteRel.destinationEntity = noteEntity
        taskNoteRel.minCount = 0
        taskNoteRel.maxCount = 1
        taskNoteRel.deleteRule = .nullifyDeleteRule
        taskNoteRel.isOptional = true

        noteTasksRel.inverseRelationship = taskNoteRel
        taskNoteRel.inverseRelationship = noteTasksRel

        // CDNote.tags ↔ CDTag.notes (many-to-many)
        let noteTagsRel = NSRelationshipDescription()
        noteTagsRel.name = "tags"
        noteTagsRel.destinationEntity = tagEntity
        noteTagsRel.minCount = 0
        noteTagsRel.maxCount = 0
        noteTagsRel.deleteRule = .nullifyDeleteRule
        noteTagsRel.isOptional = true

        let tagNotesRel = NSRelationshipDescription()
        tagNotesRel.name = "notes"
        tagNotesRel.destinationEntity = noteEntity
        tagNotesRel.minCount = 0
        tagNotesRel.maxCount = 0
        tagNotesRel.deleteRule = .nullifyDeleteRule
        tagNotesRel.isOptional = true

        noteTagsRel.inverseRelationship = tagNotesRel
        tagNotesRel.inverseRelationship = noteTagsRel

        // --- Assign properties to entities ---
        projectEntity.properties = [projectId, projectName, projectColor, projectDescription, projectCreatedAt, projectUpdatedAt,
                                    projectNotesRel, projectTasksRel]

        noteEntity.properties = [noteId, noteRawTranscript, noteProcessedText, noteSummary,
                                 noteCreatedAt, noteUpdatedAt, noteIsProcessed,
                                 noteProjectRel, noteTasksRel, noteTagsRel]

        taskEntity.properties = [taskId, taskTitle, taskDueDate, taskIsCompleted, taskCreatedAt,
                                 taskNoteRel, taskProjectRel]

        tagEntity.properties = [tagId, tagName, tagNotesRel]

        // --- Unique constraint on CDTag.name ---
        tagEntity.uniquenessConstraints = [[tagName]]

        model.entities = [projectEntity, noteEntity, taskEntity, tagEntity]
        return model
    }
}
