import Foundation
import EventKit

// echo-scribe-calmatch
//
// One-shot helper that bridges EventKit into Echo Scribe. Three sub-commands:
//
//   --probe              Print {"authorization":"<status>"} JSON on stdout
//                        and exit 0. Never prompts.
//   --request-access     Trigger the standard macOS calendar prompt.
//                        Exit 0 if granted, 1 if denied or unavailable.
//   match <iso_start> <iso_end> [conf_hint]
//                        Query EventKit for events overlapping [start, end],
//                        rank them by overlap + conferencing-URL match +
//                        proximity to start, and print one JSON object on
//                        stdout with `match` (top pick) plus `candidates`
//                        (next 2). Exit 0. Returns `null` match if nothing
//                        overlaps.
//
// All errors go to stderr (one JSON object per line); stdout is reserved
// for the structured response so the parent can parse a single line.

// MARK: - Logging

func logErr(_ kind: String, _ msg: String, extra: [String: Any] = [:]) {
    var dict: [String: Any] = ["kind": kind, "msg": msg]
    for (k, v) in extra {
        dict[k] = v
    }
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let line = String(data: data, encoding: .utf8) {
        FileHandle.standardError.write(Data((line + "\n").utf8))
    }
}

func writeStdoutJSON(_ obj: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          let line = String(data: data, encoding: .utf8) else {
        logErr("encode", "failed to encode response JSON")
        exit(2)
    }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

// MARK: - Authorization

func authorizationLabel(_ status: EKAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "not_determined"
    case .restricted:   return "restricted"
    case .denied:       return "denied"
    case .fullAccess:   return "full_access"
    case .writeOnly:    return "write_only"
    @unknown default:   return "unknown"
    }
}

func isFullyAuthorized(_ status: EKAuthorizationStatus) -> Bool {
    // We target macOS 14+ (see Package.swift), where the meaningful
    // read-with-attendees grant is `.fullAccess`. `.writeOnly` lets us
    // add events but not enumerate them, so it doesn't help here.
    return status == .fullAccess
}

// MARK: - Subcommands

func runProbe() -> Never {
    let status = EKEventStore.authorizationStatus(for: .event)
    writeStdoutJSON(["authorization": authorizationLabel(status)])
    exit(0)
}

func runRequestAccess() -> Never {
    let store = EKEventStore()
    let group = DispatchGroup()
    group.enter()
    var granted = false

    store.requestFullAccessToEvents { ok, err in
        if let err = err {
            logErr("request_access", err.localizedDescription)
        }
        granted = ok
        group.leave()
    }

    // Bound the wait so we never hang the parent if the system dialog is
    // dismissed in an unusual way.
    let timeout = DispatchTime.now() + .seconds(60)
    if group.wait(timeout: timeout) == .timedOut {
        logErr("request_access", "timed out waiting for user decision")
        exit(1)
    }
    exit(granted ? 0 : 1)
}

// MARK: - Match data model

struct AttendeeOut: Encodable {
    let name: String?
    let email: String?
    let self_: Bool
    let role: String?

    enum CodingKeys: String, CodingKey {
        case name, email
        case self_ = "self"
        case role
    }
}

struct CalendarMatchOut: Encodable {
    let title: String?
    let organizer: AttendeeOut?
    let attendees: [AttendeeOut]
    let starts_at: String
    let ends_at: String
    let notes: String?
    let calendar_name: String?
    let conferencing_url: String?
    let match_score: Double
    let match_reason: String
}

struct MatchResponse: Encodable {
    let match: CalendarMatchOut?
    let candidates: [CalendarMatchOut]
}

// MARK: - Scoring helpers

let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

let isoFallback: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

func parseISO(_ s: String) -> Date? {
    return isoFormatter.date(from: s) ?? isoFallback.date(from: s)
}

func isoString(_ d: Date) -> String {
    return isoFallback.string(from: d)
}

func overlapRatio(eventStart: Date, eventEnd: Date, windowStart: Date, windowEnd: Date) -> Double {
    let lo = max(eventStart, windowStart)
    let hi = min(eventEnd, windowEnd)
    let overlap = max(0.0, hi.timeIntervalSince(lo))
    let windowDuration = max(1.0, windowEnd.timeIntervalSince(windowStart))
    let eventDuration = max(1.0, eventEnd.timeIntervalSince(eventStart))
    // Normalize against the smaller of the two so a 5-min recording inside
    // a 60-min event still scores 1.0 on overlap.
    let denom = min(windowDuration, eventDuration)
    return min(1.0, overlap / denom)
}

func extractMeetingCode(_ url: String) -> String? {
    // Heuristic: pull the conference-room slug.
    // Zoom: /j/<digits>  or /j/<digits>?pwd=...
    // Meet: /<abc-defg-hij> path
    // Teams: /l/meetup-join/<guid>
    guard let u = URL(string: url) else { return nil }
    let path = u.path
    if path.contains("/j/") {
        return path.components(separatedBy: "/").last.flatMap {
            $0.split(separator: "?").first.map(String.init)
        }
    }
    if u.host?.contains("meet.google.com") == true {
        // Meet uses /abc-defg-hij at root.
        let trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return trimmed.isEmpty ? nil : trimmed
    }
    if path.contains("meetup-join") {
        return path
    }
    return nil
}

func conferencingURLMatches(eventURL: String?, hint: String?) -> Bool {
    guard let a = eventURL, let b = hint else { return false }
    if a == b { return true }
    let codeA = extractMeetingCode(a)
    let codeB = extractMeetingCode(b)
    if let ca = codeA, let cb = codeB, !ca.isEmpty, ca == cb {
        return true
    }
    // Loose fallback: host + path overlap
    if let ua = URL(string: a), let ub = URL(string: b),
       let ha = ua.host, let hb = ub.host,
       ha == hb && !ua.path.isEmpty && ua.path == ub.path {
        return true
    }
    return false
}

func startDistanceWeight(eventStart: Date, windowStart: Date) -> Double {
    let delta = abs(eventStart.timeIntervalSince(windowStart))
    let fiveMinutes: Double = 300.0
    return exp(-delta / fiveMinutes)
}

// MARK: - Event → output mapping

func mapAttendee(_ p: EKParticipant) -> AttendeeOut {
    let name = p.name?.isEmpty == false ? p.name : nil
    var email: String? = nil
    if p.url.scheme == "mailto" {
        email = p.url.absoluteString.replacingOccurrences(of: "mailto:", with: "")
    }
    let role: String?
    switch p.participantRole {
    case .required: role = "required"
    case .optional: role = "optional"
    case .chair:    role = "chair"
    case .nonParticipant: role = "non_participant"
    default: role = nil
    }
    return AttendeeOut(name: name, email: email, self_: p.isCurrentUser, role: role)
}

func conferencingURLFor(event: EKEvent) -> String? {
    // EventKit doesn't expose a structured conferencing URL on macOS the way
    // iOS does. We scan url, notes, and location for an http(s) link.
    if let u = event.url?.absoluteString, !u.isEmpty {
        return u
    }
    let haystacks: [String] = [event.notes ?? "", event.location ?? ""]
    for text in haystacks {
        if let range = text.range(of: "https?://\\S+", options: .regularExpression) {
            return String(text[range])
                .trimmingCharacters(in: CharacterSet(charactersIn: ".,;:)]>"))
        }
    }
    return nil
}

struct ScoredMatch {
    let out: CalendarMatchOut
    let score: Double
}

func buildScoredMatch(event: EKEvent, windowStart: Date, windowEnd: Date, hint: String?) -> ScoredMatch {
    let confURL = conferencingURLFor(event: event)
    let overlap = overlapRatio(
        eventStart: event.startDate,
        eventEnd: event.endDate,
        windowStart: windowStart,
        windowEnd: windowEnd
    )
    let urlMatches = conferencingURLMatches(eventURL: confURL, hint: hint)
    let proximity = startDistanceWeight(eventStart: event.startDate, windowStart: windowStart)
    let score = 0.5 * overlap + 0.4 * (urlMatches ? 1.0 : 0.0) + 0.1 * proximity

    var reasons: [String] = []
    if overlap > 0.5 { reasons.append("overlap") }
    if urlMatches { reasons.append("conf_url") }
    if proximity > 0.6 { reasons.append("proximity") }

    let attendees: [AttendeeOut] = (event.attendees ?? []).map(mapAttendee)
    let organizer: AttendeeOut? = event.organizer.map(mapAttendee)

    let out = CalendarMatchOut(
        title: event.title,
        organizer: organizer,
        attendees: attendees,
        starts_at: isoString(event.startDate),
        ends_at: isoString(event.endDate),
        notes: event.notes,
        calendar_name: event.calendar?.title,
        conferencing_url: confURL,
        match_score: (score * 100.0).rounded() / 100.0,
        match_reason: reasons.isEmpty ? "weak" : reasons.joined(separator: "+")
    )
    return ScoredMatch(out: out, score: score)
}

// MARK: - Match command

func runMatch(args: [String]) -> Never {
    guard args.count >= 2 else {
        logErr("usage", "match <iso_start> <iso_end> [conf_hint]")
        exit(2)
    }
    guard let startWin = parseISO(args[0]) else {
        logErr("parse", "invalid iso_start: \(args[0])")
        exit(2)
    }
    guard let endWin = parseISO(args[1]) else {
        logErr("parse", "invalid iso_end: \(args[1])")
        exit(2)
    }
    let hint = args.count >= 3 ? args[2] : nil

    let status = EKEventStore.authorizationStatus(for: .event)
    if !isFullyAuthorized(status) {
        logErr("unauthorized", "calendar access not granted",
               extra: ["status": authorizationLabel(status)])
        // Emit a null match on stdout so the parent has a stable schema.
        writeStdoutJSON(["match": NSNull(), "candidates": [Any]()])
        exit(0)
    }

    let store = EKEventStore()
    // Pad the predicate window by ±10 minutes so we catch events that start
    // a hair after the recording or end just before — the scoring picks the
    // best fit afterwards.
    let pad: TimeInterval = 600.0
    let predicateStart = startWin.addingTimeInterval(-pad)
    let predicateEnd = endWin.addingTimeInterval(pad)
    let predicate = store.predicateForEvents(
        withStart: predicateStart,
        end: predicateEnd,
        calendars: nil
    )
    let events = store.events(matching: predicate)

    let scored: [ScoredMatch] = events.map { ev in
        buildScoredMatch(event: ev, windowStart: startWin, windowEnd: endWin, hint: hint)
    }
    .sorted { $0.score > $1.score }

    let top = scored.first
    let nextTwo = Array(scored.dropFirst().prefix(2)).map { $0.out }

    let payload = MatchResponse(
        match: top?.out,
        candidates: nextTwo
    )

    let encoder = JSONEncoder()
    do {
        let data = try encoder.encode(payload)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        exit(0)
    } catch {
        logErr("encode", error.localizedDescription)
        exit(2)
    }
}

// MARK: - Entry

let argv = CommandLine.arguments
if argv.count < 2 {
    logErr("usage", "expected --probe | --request-access | match ...")
    exit(2)
}

switch argv[1] {
case "--probe":
    runProbe()
case "--request-access":
    runRequestAccess()
case "match":
    let rest = Array(argv.dropFirst(2))
    runMatch(args: rest)
default:
    logErr("usage", "unknown subcommand: \(argv[1])")
    exit(2)
}
