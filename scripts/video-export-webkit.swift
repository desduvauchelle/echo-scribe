// Native WKWebView regression runner; invoked by test-video-export-webkit.ts.
import Cocoa
import WebKit

final class ExportCheck: NSObject, WKScriptMessageHandler {
    var web: WKWebView!
    var window: NSWindow!

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let text = message.body as? String else { return }
        print(text)
        fflush(stdout)
        if text.hasPrefix("RESULT ") {
            exit(text.hasPrefix("RESULT PASS") ? 0 : 1)
        }
    }

    func start(url: URL) {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "result")
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 360), configuration: config)
        window = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Tucky video export check"
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        web.load(URLRequest(url: url))
        DispatchQueue.main.asyncAfter(deadline: .now() + 90) {
            print("RESULT FAIL: export did not finish within 90s")
            exit(1)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let check = ExportCheck()
check.start(url: URL(string: CommandLine.arguments[1])!)
app.run()
