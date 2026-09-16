import XCTest
@testable import ComputerUseCore

final class SessionPolicyTests: XCTestCase {
    func testObservationCannotGrantWritePermission() {
        var policy = SessionPolicy(allowActions: false)
        let revision = policy.observe(now: 1)
        XCTAssertThrowsError(try policy.consume(revision, now: 2, targetIsFrontmost: false, idleSeconds: 0)) {
            XCTAssertEqual(($0 as? ControlError)?.code, "read_only")
        }
    }
    func testOldAndReplayedActionsAreRejected() throws {
        var policy = SessionPolicy(allowActions: true)
        let first = policy.observe(now: 1)
        let next = policy.observe(now: 2)
        XCTAssertThrowsError(try policy.consume(first, now: 3, targetIsFrontmost: false, idleSeconds: 2))
        try policy.consume(next, now: 3, targetIsFrontmost: false, idleSeconds: 0)
        XCTAssertThrowsError(try policy.consume(next, now: 3, targetIsFrontmost: false, idleSeconds: 2))
        let expired = policy.observe(now: 5)
        XCTAssertThrowsError(try policy.consume(expired, now: 14, targetIsFrontmost: false, idleSeconds: 2))
    }
    func testYieldsOnlyWhenHumanIsUsingTargetApp() throws {
        var policy = SessionPolicy(allowActions: true)
        let revision = policy.observe(now: 1)
        XCTAssertThrowsError(try policy.consume(revision, now: 2, targetIsFrontmost: true, idleSeconds: 0.1)) {
            XCTAssertEqual(($0 as? ControlError)?.code, "user_active")
        }
        try policy.consume(revision, now: 2, targetIsFrontmost: false, idleSeconds: 0.1)
    }
    func testStopIsLatched() throws {
        let token = StopToken()
        try token.check()
        token.stop()
        XCTAssertThrowsError(try token.check())
        token.stop()
        XCTAssertThrowsError(try token.check())
    }
}
