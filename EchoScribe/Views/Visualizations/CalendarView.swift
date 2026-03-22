import SwiftUI

struct CalendarView: View {
    @Bindable var feedViewModel: FeedViewModel

    @State private var displayedMonth = Date()
    private let calendar = Calendar.current

    private var daysInMonth: [Date] {
        guard let range = calendar.range(of: .day, in: .month, for: displayedMonth),
              let firstDay = calendar.date(from: calendar.dateComponents([.year, .month], from: displayedMonth))
        else { return [] }

        return range.compactMap { day in
            calendar.date(byAdding: .day, value: day - 1, to: firstDay)
        }
    }

    private var firstWeekday: Int {
        guard let firstDay = daysInMonth.first else { return 0 }
        return (calendar.component(.weekday, from: firstDay) - calendar.firstWeekday + 7) % 7
    }

    private var notesByDay: [String: (noteCount: Int, taskCount: Int)] {
        var result: [String: (noteCount: Int, taskCount: Int)] = [:]
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"

        for noteDetail in feedViewModel.notes {
            let key = formatter.string(from: noteDetail.note.createdAt)
            let existing = result[key] ?? (0, 0)
            result[key] = (existing.noteCount + 1, existing.taskCount + noteDetail.tasks.count)
        }
        return result
    }

    var body: some View {
        VStack(spacing: 12) {
            // Month navigation
            HStack {
                Button {
                    displayedMonth = calendar.date(byAdding: .month, value: -1, to: displayedMonth) ?? displayedMonth
                } label: {
                    Image(systemName: "chevron.left")
                }
                .buttonStyle(.plain)

                Spacer()

                Text(displayedMonth.formatted(.dateTime.month(.wide).year()))
                    .font(.title2)
                    .fontWeight(.semibold)

                Spacer()

                Button {
                    displayedMonth = calendar.date(byAdding: .month, value: 1, to: displayedMonth) ?? displayedMonth
                } label: {
                    Image(systemName: "chevron.right")
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal)

            // Weekday headers
            let weekdays = calendar.shortWeekdaySymbols
            let reordered = Array(weekdays[calendar.firstWeekday - 1...]) + Array(weekdays[..<calendar.firstWeekday - 1])

            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 7), spacing: 4) {
                ForEach(reordered, id: \.self) { day in
                    Text(day)
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }

                // Empty cells before first day
                ForEach(0..<firstWeekday, id: \.self) { _ in
                    Color.clear.frame(height: 60)
                }

                // Day cells
                ForEach(daysInMonth, id: \.self) { date in
                    dayCell(date: date)
                }
            }
            .padding(.horizontal)

            Spacer()
        }
        .padding(.top)
    }

    private func dayCell(date: Date) -> some View {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        let key = formatter.string(from: date)
        let counts = notesByDay[key]
        let isToday = calendar.isDateInToday(date)

        return Button {
            let startOfDay = calendar.startOfDay(for: date)
            let endOfDay = calendar.date(byAdding: .day, value: 1, to: startOfDay)!
            feedViewModel.dateRange = startOfDay...endOfDay
            feedViewModel.startObservation()
        } label: {
            VStack(spacing: 2) {
                Text("\(calendar.component(.day, from: date))")
                    .font(.body)
                    .fontWeight(isToday ? .bold : .regular)
                    .foregroundStyle(isToday ? .accentColor : .primary)

                if let counts {
                    HStack(spacing: 2) {
                        if counts.noteCount > 0 {
                            Circle()
                                .fill(.blue)
                                .frame(width: 5, height: 5)
                        }
                        if counts.taskCount > 0 {
                            Circle()
                                .fill(.orange)
                                .frame(width: 5, height: 5)
                        }
                    }

                    Text("\(counts.noteCount)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                } else {
                    Spacer().frame(height: 12)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 60)
            .background(
                isToday ? Color.accentColor.opacity(0.08) : Color.clear,
                in: RoundedRectangle(cornerRadius: 6)
            )
        }
        .buttonStyle(.plain)
    }
}
