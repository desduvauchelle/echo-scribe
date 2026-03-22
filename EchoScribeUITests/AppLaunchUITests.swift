import XCTest

@MainActor
final class AppLaunchUITests: XCTestCase {

    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    override func tearDownWithError() throws {
        if let app = app {
            app.terminate()
        }
        app = nil
    }

    func testAppLaunchesSuccessfully() throws {
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 10), "Main window should appear on launch")
    }

    func testMainWindowHasExpectedElements() throws {
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 10))
        XCTAssertTrue(window.frame.width > 0)
        XCTAssertTrue(window.frame.height > 0)
    }
}
