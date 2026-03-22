import Foundation
import GRDB

extension AppDatabase {

    // MARK: - Tasks

    func saveTask(_ task: inout NoteTask) throws {
        try dbQueue.write { db in
            try task.save(db)
        }
    }

    func toggleTaskCompletion(id: String) throws {
        try dbQueue.write { db in
            guard var task = try NoteTask.fetchOne(db, id: id) else { return }
            task.isCompleted.toggle()
            try task.update(db)
        }
    }

    func fetchTasks(
        projectId: String? = nil,
        isCompleted: Bool? = nil,
        dueBefore: Date? = nil
    ) throws -> [NoteTask] {
        try dbQueue.read { db in
            var request = NoteTask.all().order(Column("createdAt").desc)

            if let projectId {
                request = request.filter(Column("projectId") == projectId)
            }
            if let isCompleted {
                request = request.filter(Column("isCompleted") == isCompleted)
            }
            if let dueBefore {
                request = request.filter(Column("dueDate") != nil && Column("dueDate") <= dueBefore)
            }

            return try request.fetchAll(db)
        }
    }

    func updateTask(id: String, title: String, dueDate: Date?, projectId: String?) throws {
        try dbQueue.write { db in
            guard var task = try NoteTask.fetchOne(db, id: id) else { return }
            task.title = title
            task.dueDate = dueDate
            task.projectId = projectId
            try task.update(db)
        }
    }

    func deleteTask(id: String) throws {
        try dbQueue.write { db in
            _ = try NoteTask.deleteOne(db, id: id)
        }
    }

    func fetchTasksDueToday() throws -> [NoteTask] {
        let calendar = Calendar.current
        let startOfDay = calendar.startOfDay(for: Date())
        let endOfDay = calendar.date(byAdding: .day, value: 1, to: startOfDay)!

        return try dbQueue.read { db in
            try NoteTask
                .filter(Column("dueDate") >= startOfDay && Column("dueDate") < endOfDay)
                .filter(Column("isCompleted") == false)
                .order(Column("dueDate"))
                .fetchAll(db)
        }
    }
}
