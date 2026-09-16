import Foundation

public struct ControlError: Error, CustomStringConvertible {
    public let code: String
    public let description: String
    public init(_ code: String, _ message: String) {
        self.code = code
        self.description = message
    }
}

/// Cancellation is independent of the tool queue so Stop/Escape can interrupt typing.
public final class StopToken: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    public init() {}
    public func stop() { lock.lock(); stopped = true; lock.unlock() }
    public func check() throws {
        lock.lock(); let value = stopped; lock.unlock()
        if value { throw ControlError("stopped", "Computer use stopped. Start a new session to continue.") }
    }
}

/// Every observation permits one mutation for eight seconds. No automatic retries of writes.
public struct SessionPolicy {
    public let allowActions: Bool
    private var revision: String?
    private var observedAt: TimeInterval = 0
    public init(allowActions: Bool) { self.allowActions = allowActions }
    public mutating func observe(now: TimeInterval) -> String {
        let value = UUID().uuidString
        revision = value
        observedAt = now
        return value
    }
    public mutating func consume(_ supplied: String?, now: TimeInterval,
                                 targetIsFrontmost: Bool, idleSeconds: Double) throws {
        guard allowActions else { throw ControlError("read_only", "This session only has permission to observe.") }
        guard let supplied, supplied == revision, now >= observedAt, now - observedAt <= 8 else {
            throw ControlError("stale_observation", "Observe the app again before acting.")
        }
        if targetIsFrontmost && idleSeconds < 1 {
            throw ControlError("user_active", "You are using this app. Computer use is paused; try again when idle.")
        }
        revision = nil
    }
}
